import { type MediaResolution, type PageInput, type PageResult } from './types';
import { modelPricing } from './cost';
import { debugLog, debugTime } from './debug';
import { stripOuterMarkdownFence } from './markdown';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const MEDIA_RESOLUTION_MAP: Record<MediaResolution, string> = {
  low: 'MEDIA_RESOLUTION_LOW',
  medium: 'MEDIA_RESOLUTION_MEDIUM',
  high: 'MEDIA_RESOLUTION_HIGH',
};

/** Output-token ceiling shared by every model we offer (all cap at 65,536). */
const MAX_OUTPUT_TOKENS = 65536;

/** A non-OK HTTP response from the Gemini API. */
export class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly apiStatus: string | undefined,
    message: string,
    /** Server-suggested back-off in ms, parsed from a 429's RetryInfo (when present). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GeminiHttpError';
  }
}

/** An error that should abort the whole job (e.g. bad key, model not available). */
export class GeminiFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiFatalError';
  }
}

/** A deterministic, page-level failure that should NOT be retried (block, truncation). */
class PageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageError';
  }
}

export interface GeminiModel {
  /** Bare model id, e.g. "gemini-2.5-flash". */
  name: string;
  displayName?: string;
}

function normalizeModel(model: string): string {
  return model.trim().replace(/^models\//, '');
}

/**
 * Minimal-thinking generationConfig for a model, or undefined for models we don't tune.
 * Thinking can't always be fully disabled (2.5-pro / 3.x), so we use each family's floor:
 *  - 2.5 flash & flash-lite: thinkingBudget 0 (off)
 *  - 2.5-pro: thinkingBudget 128 (its minimum)
 *  - 3.x: thinkingLevel "minimal" (or "low" for 3.1-pro, which has no "minimal")
 * Verified live that all of these are accepted (HTTP 200). Unknown models get nothing,
 * since sending thinkingConfig to a non-thinking model errors.
 */
function thinkingConfigFor(model: string): Record<string, unknown> | undefined {
  const id = model.toLowerCase();
  if (/gemini-3/.test(id)) return { thinkingLevel: /3\.1-pro/.test(id) ? 'low' : 'minimal' };
  if (/gemini-2\.5-pro/.test(id)) return { thinkingBudget: 128 };
  if (/gemini-2\.5-flash/.test(id)) return { thinkingBudget: 0 };
  return undefined;
}

/** List models the key can use with generateContent (follows pagination). */
export async function listModels(apiKey: string, signal?: AbortSignal): Promise<GeminiModel[]> {
  const models: GeminiModel[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API_BASE}/models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal });
    if (!response.ok) {
      const { status, apiStatus, message, retryAfterMs } = await readHttpError(response);
      throw new GeminiHttpError(status, apiStatus, message, retryAfterMs);
    }
    const data = (await response.json()) as {
      models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
      nextPageToken?: string;
    };
    for (const model of data.models ?? []) {
      if ((model.supportedGenerationMethods ?? []).includes('generateContent')) {
        models.push({ name: normalizeModel(model.name), displayName: model.displayName });
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return models;
}

/**
 * Trim Google's full model list down to the Gemini *text* models worth showing.
 * models.list returns ~37 generateContent-capable entries cluttered with other
 * families and modalities; this keeps just the usable OCR candidates:
 *  - drop non-Gemini families (gemma / lyria / nano-banana / antigravity / deep-research),
 *  - drop non-text modalities (image / tts / audio / embedding / robotics / computer-use / customtools / omni realtime),
 *  - drop legacy generations (1.x, 2.0),
 *  - drop version-pinned dupes (-001) and moving "-latest" aliases,
 *  - collapse a "<base>-preview" when its stable "<base>" is also listed.
 */
export function curateModels(models: GeminiModel[]): GeminiModel[] {
  const isGeminiText = (id: string): boolean =>
    /^gemini-/i.test(id) &&
    !/-(image|tts|audio|embedding)\b|nano-banana|robotics|computer-use|customtools|omni/i.test(id);
  const isLegacy = (id: string): boolean => /gemini-(1\.0|1\.5|2\.0)\b/i.test(id);
  const isAliasOrPinned = (id: string): boolean => /-latest$|-\d{3}$/i.test(id);
  // Models that models.list still returns but that are retired and 404 on use.
  const isRetired = (id: string): boolean => /^gemini-3-pro-preview$/i.test(id); // shut down 2026-03-09

  const kept = models.filter(
    (model) =>
      isGeminiText(model.name) &&
      !isLegacy(model.name) &&
      !isAliasOrPinned(model.name) &&
      !isRetired(model.name),
  );
  // Collapse "<base>-preview" when a stable "<base>" is present (keep the stable one).
  const baseOf = (id: string): string => id.replace(/-preview.*$/i, '');
  const stableBases = new Set(kept.filter((model) => !/-preview/i.test(model.name)).map((model) => model.name));
  return kept.filter((model) => !/-preview/i.test(model.name) || !stableBases.has(baseOf(model.name)));
}

/**
 * Rank models cheapest/fastest-first for a quick test or default selection:
 * prefer names with both "flash" and "lite", then "flash", then anything;
 * sink deprecated generations (Google still LISTS models that 404 on use) and
 * de-prioritize preview/exp and non-text (image/tts/audio) variants.
 */
export function rankModels(models: GeminiModel[]): GeminiModel[] {
  const tier = (name: string): number => {
    const n = name.toLowerCase();
    if (n.includes('flash') && n.includes('lite')) return 0;
    if (n.includes('flash')) return 1;
    return 2;
  };
  // Legacy families that are deprecated for generateContent — keep them out of
  // the cheapest slot even though models.list still returns them.
  const deprecated = (name: string): number =>
    /gemini-(1\.0|1\.5|2\.0)|gemini-pro-vision|^models\/gemini-pro$|^gemini-pro$/i.test(name) ? 1 : 0;
  const penalty = (name: string): number =>
    /preview|exp|image|tts|audio|live|native|thinking/i.test(name) ? 1 : 0;
  return [...models].sort(
    (a, b) =>
      tier(a.name) - tier(b.name) ||
      deprecated(a.name) - deprecated(b.name) ||
      penalty(a.name) - penalty(b.name) ||
      a.name.localeCompare(b.name),
  );
}

/** The single cheapest/fastest usable model, or undefined if the list is empty. */
export function pickCheapestModel(models: GeminiModel[]): string | undefined {
  return rankModels(models)[0]?.name;
}

/**
 * The model one step up the price ladder from `current`, to default a retry of failed pages to:
 * the cheapest loaded model that still costs strictly more than `current` (by combined in+out
 * per-1M rate). Falls back to `current` if it's already the priciest or isn't in the price table.
 */
export function pickSmarterModel(models: GeminiModel[], current: string): string {
  const cur = normalizeModel(current);
  const priceOf = (name: string): number | undefined => {
    const pricing = modelPricing(name);
    return pricing ? pricing.input + pricing.output : undefined;
  };
  const currentPrice = priceOf(cur);
  if (currentPrice === undefined) return cur; // can't rank an unpriced model — leave the default as-is
  const next = models
    .map((model) => ({ name: model.name, price: priceOf(model.name) }))
    .filter((m): m is { name: string; price: number } => m.price !== undefined && m.price > currentPrice)
    .sort((a, b) => a.price - b.price)[0];
  return next?.name ?? cur;
}

export interface KeyCheckResult {
  models: GeminiModel[];
  testedModel: string;
  elapsedMs: number;
  reply: string;
  /** True if a live generateContent round-trip succeeded. */
  tested: boolean;
  /** Present when `tested` is false: why the live test didn't complete (the key is still valid). */
  note?: string;
}

/**
 * Validate a key and load its models in one shot: list the key's models (proves
 * the key works, no inference cost), then do one tiny generateContent as an
 * end-to-end round-trip. Throws GeminiFatalError only on a genuinely bad key.
 *
 * Google's models.list returns models that are deprecated for generateContent
 * (e.g. gemini-2.0-flash-lite -> 404 "no longer available"), so we try the
 * cheapest usable models in order and skip any that 404. If none can run a live
 * test, we still return the loaded models with `tested: false` — the key is
 * valid and the dropdown should populate regardless.
 */
export async function checkApiKey(apiKey: string, signal?: AbortSignal): Promise<KeyCheckResult> {
  let models: GeminiModel[];
  try {
    const all = await listModels(apiKey, signal);
    const curated = curateModels(all);
    models = curated.length ? curated : all; // never strand the user with an empty list
  } catch (error) {
    // A failed list means the key itself is bad/unauthorized.
    if (error instanceof GeminiHttpError) throw new GeminiFatalError(fatalMessage(error));
    throw error;
  }

  const candidates = rankModels(models)
    .slice(0, 4)
    .map((model) => model.name);
  let lastUnavailable = '';
  for (const model of candidates) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const startedAt = performance.now();
    try {
      const reply = await quickGenerate(apiKey, model, 'Reply with the single word: OK', signal);
      return { models, testedModel: model, elapsedMs: performance.now() - startedAt, reply: reply.trim().slice(0, 40), tested: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      // listModels already proved the key is valid, so a failure here is model-scoped,
      // not key-scoped: a 404/NOT_FOUND or a per-model 403/PERMISSION_DENIED just means
      // this model is unusable for this key — skip to the next cheapest candidate.
      if (error instanceof GeminiHttpError && isModelUnavailable(error)) {
        lastUnavailable = error.message;
        continue;
      }
      // Transient (429/5xx/network): the key is valid and models loaded; skip the live test.
      return {
        models,
        testedModel: model,
        elapsedMs: 0,
        reply: '',
        tested: false,
        note: `Key valid · ${models.length} models loaded. Couldn't run a live test: ${errorToString(error)}`,
      };
    }
  }

  return {
    models,
    testedModel: candidates[0] ?? '',
    elapsedMs: 0,
    reply: '',
    tested: false,
    note: `Key valid · ${models.length} models loaded. No test-eligible model responded${lastUnavailable ? ` (last: ${lastUnavailable})` : ''} — pick one from the list.`,
  };
}

/** A minimal text generateContent call (used by the key test). */
async function quickGenerate(apiKey: string, model: string, text: string, signal?: AbortSignal): Promise<string> {
  const id = normalizeModel(model);
  const data = await postJson(
    `${API_BASE}/models/${encodeURIComponent(id)}:generateContent`,
    apiKey,
    JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { temperature: 0, maxOutputTokens: 32 } }),
    30_000,
    signal,
  );
  const payload = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return (payload?.candidates?.[0]?.content?.parts ?? []).map((part) => part?.text ?? '').join('');
}

export interface OcrPageParams {
  apiKey: string;
  model: string;
  prompt: string;
  mediaResolution: MediaResolution;
  retries: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Live activity signal: a request is out (+1)/settled (-1), or a back-off began (+1)/ended (-1). */
  onActivity?: (kind: 'request' | 'retry', delta: 1 | -1) => void;
}

/**
 * OCR a single-page PDF via Gemini generateContent.
 *
 * - A 429 rate-limit or 503 overload is retried with back-off (server-suggested delay when present).
 * - Every other failure (timeout, network, 500, content block, MAX_TOKENS truncation,
 *   malformed request) is recorded immediately as a page-level `error` — no blind retries;
 *   the user surfaces these and retries the subset by hand (optionally on a smarter model).
 * - Fatal errors (bad/unauthorized key, model not available) throw
 *   `GeminiFatalError` so the caller can abort the whole job.
 * - A user abort via `signal` propagates.
 */
export async function ocrPage(page: PageInput, params: OcrPageParams): Promise<PageResult> {
  const model = normalizeModel(params.model);
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;

  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    responseMimeType: 'text/plain',
    // Use the model's full output budget (all our models cap at 65,536). Explicit so a
    // client/library default (some inject 8,192) can't silently truncate a dense page.
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    mediaResolution: MEDIA_RESOLUTION_MAP[params.mediaResolution],
  };
  // Thinking tokens share the output budget and bill as output, so minimize them for
  // deterministic OCR (less cost/latency, no thinking-induced MAX_TOKENS). The knob
  // differs by family; every model we offer accepts a thinkingConfig (verified live).
  const thinking = thinkingConfigFor(model);
  if (thinking) generationConfig.thinkingConfig = thinking;

  const doneB64 = debugTime(`base64 p${page.pageNumber} (${page.pdfBytes.length}b)`);
  const pdfBase64 = bytesToBase64(page.pdfBytes);
  doneB64();
  const body = JSON.stringify({
    contents: [
      {
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
          { text: params.prompt },
        ],
      },
    ],
    generationConfig,
  });

  const tag = `p${page.pageNumber}`;
  const pageStartedAt = performance.now(); // whole-page wall clock (incl. back-offs), for the debug log
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= params.retries + 1; attempt++) {
    const startedAt = performance.now();
    let data: unknown;
    params.onActivity?.('request', 1);
    try {
      data = await postJson(url, params.apiKey, body, params.timeoutMs, params.signal);
    } catch (error) {
      params.onActivity?.('request', -1); // the request settled (failed)
      if (params.signal?.aborted) throw error; // user cancelled — abort the whole job
      const kind = classify(error);
      if (kind === 'fatal') throw new GeminiFatalError(fatalMessage(error));
      if (kind === 'fail') {
        debugLog(`${tag} ✗ try${attempt} ${errorToString(error)}`);
        return failed(page.pageNumber, attempt, performance.now() - startedAt, errorToString(error), model);
      }
      // backoff: a 429/503 — the only kind we auto-retry, with back-off.
      lastError = errorToString(error);
      if (attempt > params.retries) {
        const tries = `${params.retries} ${params.retries === 1 ? 'retry' : 'retries'}`;
        debugLog(`${tag} ✗ gave up after ${tries} of back-off (${((performance.now() - pageStartedAt) / 1000).toFixed(1)}s): ${lastError}`);
        const note = `${lastError} — still failing after ${tries} of back-off; wait and retry, or lower "Parallel pages".`;
        return failed(page.pageNumber, attempt, performance.now() - startedAt, note, model);
      }
      const ms = backoffMs(error, attempt);
      const httpDesc =
        error instanceof GeminiHttpError ? `${error.status}${error.apiStatus ? ` ${error.apiStatus}` : ''}` : errorToString(error);
      debugLog(`${tag} ⏳ try${attempt} ${httpDesc} → backoff ${(ms / 1000).toFixed(1)}s`);
      params.onActivity?.('retry', 1);
      try {
        await delay(ms, params.signal);
      } finally {
        params.onActivity?.('retry', -1);
      }
      continue;
    }
    // The request settled successfully — interpret it.
    params.onActivity?.('request', -1);
    const usage = readUsage(data);
    const elapsedMs = performance.now() - startedAt;
    try {
      const text = stripOuterMarkdownFence(interpretResponse(data));
      const totalSecs = ((performance.now() - pageStartedAt) / 1000).toFixed(1);
      debugLog(`${tag} ✓ try${attempt} in ${totalSecs}s · ${usage.inputTokens}→${usage.outputTokens} tok`);
      return {
        pageNumber: page.pageNumber,
        text,
        elapsedMs,
        attempts: attempt,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    } catch (interpretError) {
      // A deterministic page failure (MAX_TOKENS, block) still got billed — keep its tokens so the cost
      // tracker isn't under-counted, and surface it as a page error (never let it abort the whole job).
      const message = errorToString(interpretError);
      debugLog(`${tag} ✗ try${attempt} ${message}`);
      return {
        ...failed(page.pageNumber, attempt, elapsedMs, message, model),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    }
  }
  return failed(page.pageNumber, params.retries + 1, 0, lastError, model);
}

function failed(pageNumber: number, attempts: number, elapsedMs: number, error: string, model: string): PageResult {
  return { pageNumber, text: '', elapsedMs, attempts, error, model };
}

/** Billed token counts from the response's usageMetadata (0 if absent). Output bills
 *  candidates plus any thinking tokens; we don't use context caching, so input = prompt. */
function readUsage(data: unknown): { inputTokens: number; outputTokens: number } {
  const usage = (
    data as {
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    }
  ).usageMetadata;
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  };
}

/** Extract OCR text, or throw a PageError for deterministic page failures. */
function interpretResponse(data: unknown): string {
  const payload = data as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
  };
  const candidate = payload?.candidates?.[0];
  if (!candidate) {
    const blockReason = payload?.promptFeedback?.blockReason;
    if (blockReason) throw new PageError(`Request blocked by Gemini (${blockReason}).`);
    return '';
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new PageError('OCR output was truncated (MAX_TOKENS); the page may be too dense — try another model.');
  }
  const parts = candidate.content?.parts;
  // Skip thought parts (only present if thinking summaries are enabled); join the rest.
  // Empty text (e.g. a SAFETY-blocked page) falls through to a [Blank page], matching the reference.
  return Array.isArray(parts)
    ? parts.filter((part) => part?.thought !== true).map((part) => part?.text ?? '').join('')
    : '';
}

type ErrorKind = 'fatal' | 'backoff' | 'fail';

/**
 * Bucket a thrown request error into how the page should react:
 *  - fatal:   bad/unauthorized key or unavailable model — abort the whole job.
 *  - backoff: "server says wait" — a 429 rate-limit or a 503 transient overload. The ONLY things we
 *             auto-retry, because only waiting fixes them (a smarter model can't).
 *  - fail:    everything else (timeout, network, 500, 400, content block, MAX_TOKENS) — fail fast and
 *             surface for a manual retry, since blindly re-running won't help.
 * (PageError from interpretResponse never reaches here; it's handled at the call site.)
 */
function classify(error: unknown): ErrorKind {
  if (error instanceof GeminiHttpError) {
    if (httpIsFatal(error)) return 'fatal';
    if (
      error.status === 429 ||
      error.status === 503 ||
      error.apiStatus === 'RESOURCE_EXHAUSTED' ||
      error.apiStatus === 'UNAVAILABLE'
    ) {
      return 'backoff';
    }
    return 'fail'; // 400 (deterministic), 500, anything else: don't retry blindly
  }
  return 'fail'; // network error, timeout
}

/** Back-off before a retry: honor the server's RetryInfo when present, else exponential (per-wait cap 16s, hard cap 30s). */
function backoffMs(error: unknown, attempt: number): number {
  const exponential = Math.min(2 ** (attempt - 1), 16) * 1000;
  const suggested = error instanceof GeminiHttpError ? error.retryAfterMs : undefined;
  return Math.min(suggested ?? exponential, 30_000);
}

function httpIsFatal(error: GeminiHttpError): boolean {
  if (error.status === 401 || error.status === 403 || error.status === 404) return true;
  if (error.apiStatus === 'UNAUTHENTICATED' || error.apiStatus === 'PERMISSION_DENIED') return true;
  if (error.status === 400 && /api[_ ]?key[_ ]?(not valid|invalid)|api_key_invalid|unauthenticat|permission|\bmodel\b/i.test(error.message)) {
    return true;
  }
  return false;
}

/**
 * This specific model is listed but unusable for this key (deprecated, not found,
 * or not permitted). Only meaningful AFTER listModels has proven the key valid,
 * so a 403/PERMISSION_DENIED here is model-scoped, not a bad key.
 */
function isModelUnavailable(error: GeminiHttpError): boolean {
  if (error.status === 404 || error.status === 403) return true;
  if (error.apiStatus === 'NOT_FOUND' || error.apiStatus === 'PERMISSION_DENIED') return true;
  return /no longer available|not found|is not supported|does not (exist|support)|unsupported model/i.test(error.message);
}

function fatalMessage(error: unknown): string {
  if (error instanceof GeminiHttpError) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.apiStatus === 'UNAUTHENTICATED' ||
      error.apiStatus === 'PERMISSION_DENIED' ||
      /api[_ ]?key|api_key_invalid/i.test(error.message)
    ) {
      return 'Invalid or unauthorized API key. Create a new key at aistudio.google.com/apikey and check it has Gemini API access.';
    }
    if (error.status === 404 || /\bmodel\b/i.test(error.message)) {
      return `Model not available for this key: ${error.message}. Use "Test" to pick a supported model.`;
    }
    return error.message;
  }
  return errorToString(error);
}

async function postJson(
  url: string,
  apiKey: string,
  body: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const { status, apiStatus, message, retryAfterMs } = await readHttpError(response);
      throw new GeminiHttpError(status, apiStatus, message, retryAfterMs);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function readHttpError(
  response: Response,
): Promise<{ status: number; apiStatus?: string; message: string; retryAfterMs?: number }> {
  let detail = '';
  let apiStatus: string | undefined;
  let retryAfterMs: number | undefined;
  try {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; status?: string; details?: Array<{ retryDelay?: string }> };
      };
      detail = parsed?.error?.message ?? raw;
      apiStatus = parsed?.error?.status;
      // A 429 carries a RetryInfo detail like { retryDelay: "27s" }. We only read it from the
      // JSON body — the Retry-After header isn't reliably exposed to browser fetch via CORS.
      const delay = parsed?.error?.details?.find((d) => typeof d?.retryDelay === 'string')?.retryDelay;
      const match = delay ? /([\d.]+)s/.exec(delay) : null;
      if (match) retryAfterMs = Math.round(parseFloat(match[1]) * 1000);
    } catch {
      detail = raw;
    }
  } catch {
    /* body unavailable */
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  const message = `HTTP ${response.status} ${response.statusText}`.trim() + (detail ? `: ${detail}` : '');
  return { status: response.status, apiStatus, message, retryAfterMs };
}

/** Base64-encode bytes in chunks (browser- and Node-safe via global btoa). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** A timeout that rejects early if the signal aborts (keeps cancel responsive during backoff). */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorToString(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'TimeoutError') {
    return 'Request timed out';
  }
  if (error instanceof Error) return error.message || error.name;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}
