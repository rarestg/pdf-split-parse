import type { MediaResolution, PageInput, PageResult } from './types';
import { catalogEntry, currentPrice, DEFAULT_MODEL, MODEL_CATALOG } from './models';
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
    /** A 429 whose quota limit is 0: this key's tier can't use the model at all. */
    readonly zeroQuota = false,
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

/** List models the key can use with generateContent (follows pagination). */
export async function listModels(apiKey: string, signal?: AbortSignal): Promise<GeminiModel[]> {
  const models: GeminiModel[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API_BASE}/models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal });
    if (!response.ok) throw await readHttpError(response);
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

/** Choose the preferred model when available, otherwise the lowest-priced listed model. */
export function pickDefaultModel(models: GeminiModel[]): string | undefined {
  if (models.some((model) => normalizeModel(model.name) === DEFAULT_MODEL)) return DEFAULT_MODEL;
  return models
    .map((model) => ({ name: normalizeModel(model.name), price: currentPrice(model.name) }))
    .filter((model): model is { name: string; price: { input: number; output: number } } => model.price !== null)
    .sort((a, b) => a.price.input + a.price.output - (b.price.input + b.price.output))[0]?.name;
}

/**
 * The model one step up the price ladder from `current`, to default a retry of failed pages to:
 * the cheapest loaded model that still costs strictly more than `current` (by combined in+out
 * per-1M rate). Falls back to `current` if it's already the priciest or isn't in the price table.
 */
export function pickSmarterModel(models: GeminiModel[], current: string): string {
  const cur = normalizeModel(current);
  const priceOf = (name: string): number | undefined => {
    const pricing = currentPrice(name);
    return pricing ? pricing.input + pricing.output : undefined;
  };
  const currentRate = priceOf(cur);
  if (currentRate === undefined) return cur; // can't rank an unpriced model — leave the default as-is
  const next = models
    .map((model) => ({ name: model.name, price: priceOf(model.name) }))
    .filter((m): m is { name: string; price: number } => m.price !== undefined && m.price > currentRate)
    .sort((a, b) => a.price - b.price)[0];
  return next?.name ?? cur;
}

/** Validate a key and find models available for this key without running inference. */
export async function checkApiKey(apiKey: string, signal?: AbortSignal): Promise<GeminiModel[]> {
  let available: GeminiModel[];
  try {
    available = await listModels(apiKey, signal);
  } catch (error) {
    if (error instanceof GeminiHttpError) throw new GeminiFatalError(fatalMessage(error));
    throw error;
  }
  const availableIds = new Set(available.map((model) => normalizeModel(model.name)));
  const candidates = MODEL_CATALOG.filter((entry) => availableIds.has(entry.id));
  const probed = await Promise.all(
    candidates.map(async (entry) => (await probeModel(apiKey, entry.id, signal) ? entry : null)),
  );
  return probed
    .filter((entry): entry is (typeof MODEL_CATALOG)[number] => entry !== null)
    .map((entry) => ({ name: entry.id, displayName: entry.label }));
}

/** False only when Gemini says this key can't use the model; a timeout or other error still lists it. */
async function probeModel(apiKey: string, model: string, signal?: AbortSignal): Promise<boolean> {
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:countTokens`;
  try {
    await postJson(url, apiKey, '{"contents":[{"parts":[{"text":"hi"}]}]}', 3000, signal);
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return !(error instanceof GeminiHttpError && (error.status === 404 || error.status === 403));
  }
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
 * - Every other failure (timeout, network, 500, content block, MAX_TOKENS truncation, early stop,
 *   empty reply, malformed request) is recorded immediately as a page-level `error` — no blind retries;
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
  const thinking = catalogEntry(model)?.thinking;
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
      if (error instanceof GeminiHttpError && error.zeroQuota) {
        throw new GeminiFatalError(`${model} isn't available on the free tier. Use a paid key or pick another model.`);
      }
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
      // Blank pages return the prompt's "[Blank page]" marker, so no text at all means something went wrong.
      if (!text) throw new PageError('Gemini returned no text.');
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
  // SAFETY, RECITATION, OTHER, etc. can cut the text short or remove it, so don't pass it off as a full page.
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new PageError(`Gemini stopped early (${candidate.finishReason}); try another model.`);
  }
  const parts = candidate.content?.parts;
  // Skip thought parts (only present if thinking summaries are enabled); join the rest.
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
    if (!response.ok) throw await readHttpError(response);
    return await response.json();
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function readHttpError(response: Response): Promise<GeminiHttpError> {
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
  detail = detail.replace(/\s+/g, ' ').trim();
  const zeroQuota = response.status === 429 && /limit:\s*0\b/i.test(detail);
  detail = detail.slice(0, 300);
  const message = `HTTP ${response.status} ${response.statusText}`.trim() + (detail ? `: ${detail}` : '');
  return new GeminiHttpError(response.status, apiStatus, message, retryAfterMs, zeroQuota);
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
