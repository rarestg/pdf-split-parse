import type { MediaResolution, PageInput, PageResult } from './types';
import { stripOuterMarkdownFence } from './markdown';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const MEDIA_RESOLUTION_MAP: Record<MediaResolution, string> = {
  low: 'MEDIA_RESOLUTION_LOW',
  medium: 'MEDIA_RESOLUTION_MEDIUM',
  high: 'MEDIA_RESOLUTION_HIGH',
};

/** A non-OK HTTP response from the Gemini API. */
export class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly apiStatus: string | undefined,
    message: string,
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
    if (!response.ok) throw new Error((await readHttpError(response)).message);
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

export interface OcrPageParams {
  apiKey: string;
  model: string;
  prompt: string;
  mediaResolution: MediaResolution;
  retries: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * OCR a single-page PDF via Gemini generateContent.
 *
 * - Transient errors (network, timeout, 429, 5xx) are retried with backoff,
 *   then recorded as a page-level `error`.
 * - Deterministic page failures (content block, MAX_TOKENS truncation, malformed
 *   request) are recorded immediately without burning retries.
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
    mediaResolution: MEDIA_RESOLUTION_MAP[params.mediaResolution],
  };
  // 2.5 Flash uses dynamic thinking by default; thinking tokens bill as output and
  // can trigger MAX_TOKENS truncation. Disable it for deterministic OCR. Gate on the
  // model id — sending thinkingConfig to a model without thinking support errors.
  if (/gemini-2\.5-flash/i.test(model)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const body = JSON.stringify({
    contents: [
      {
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: bytesToBase64(page.pdfBytes) } },
          { text: params.prompt },
        ],
      },
    ],
    generationConfig,
  });

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= params.retries + 1; attempt++) {
    const startedAt = performance.now();
    try {
      const data = await postJson(url, params.apiKey, body, params.timeoutMs, params.signal);
      return {
        pageNumber: page.pageNumber,
        text: stripOuterMarkdownFence(interpretResponse(data)),
        elapsedMs: performance.now() - startedAt,
        attempts: attempt,
      };
    } catch (error) {
      if (params.signal?.aborted) throw error; // user cancelled — abort the whole job
      const kind = classify(error);
      if (kind === 'fatal') throw new GeminiFatalError(fatalMessage(error));
      if (kind === 'page') {
        return failed(page.pageNumber, attempt, performance.now() - startedAt, errorToString(error));
      }
      lastError = errorToString(error);
      if (attempt > params.retries) {
        return failed(page.pageNumber, attempt, performance.now() - startedAt, lastError);
      }
      await delay(Math.min(2 ** (attempt - 1), 8) * 1000, params.signal);
    }
  }
  return failed(page.pageNumber, params.retries + 1, 0, lastError);
}

function failed(pageNumber: number, attempts: number, elapsedMs: number, error: string): PageResult {
  return { pageNumber, text: '', elapsedMs, attempts, error };
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

type ErrorKind = 'fatal' | 'page' | 'retry';

function classify(error: unknown): ErrorKind {
  if (error instanceof PageError) return 'page';
  if (error instanceof GeminiHttpError) {
    if (httpIsFatal(error)) return 'fatal';
    if (error.status === 400) return 'page'; // other bad request: deterministic, don't retry
    return 'retry'; // 429, 5xx, etc.
  }
  return 'retry'; // network error, timeout
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
      return `Model not available for this key: ${error.message}. Use "Load" to pick a supported model.`;
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
      const { status, apiStatus, message } = await readHttpError(response);
      throw new GeminiHttpError(status, apiStatus, message);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

async function readHttpError(
  response: Response,
): Promise<{ status: number; apiStatus?: string; message: string }> {
  let detail = '';
  let apiStatus: string | undefined;
  try {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string; status?: string } };
      detail = parsed?.error?.message ?? raw;
      apiStatus = parsed?.error?.status;
    } catch {
      detail = raw;
    }
  } catch {
    /* body unavailable */
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  const message = `HTTP ${response.status} ${response.statusText}`.trim() + (detail ? `: ${detail}` : '');
  return { status: response.status, apiStatus, message };
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
