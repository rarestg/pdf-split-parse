/**
 * Shared types and defaults for the client-side OCR pipeline.
 *
 * This module is framework-agnostic and runs in both the browser and Node.
 */

export type MediaResolution = 'low' | 'medium' | 'high';

/** A single page extracted from the source document as its own one-page PDF. */
export interface PageInput {
  /** 1-based page number in the source document. */
  pageNumber: number;
  /** Bytes of a standalone single-page PDF. */
  pdfBytes: Uint8Array;
}

/** Result of OCR-ing one page. `error` is set only when the page failed. */
export interface PageResult {
  pageNumber: number;
  text: string;
  elapsedMs: number;
  attempts: number;
  error?: string;
}

export interface OcrOptions {
  /** Google Gemini API key (BYO — stays in the browser). */
  apiKey: string;
  model?: string;
  prompt?: string;
  mediaResolution?: MediaResolution;
  /** Max pages processed in parallel. */
  concurrency?: number;
  /** Retries per page after the first attempt fails. */
  retries?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** 1-based first page to process (inclusive). */
  startPage?: number;
  /** 1-based last page to process (inclusive). */
  endPage?: number;
  /** Abort the whole job (cancels in-flight requests and stops the queue). */
  signal?: AbortSignal;
  /** Called once per finished page, in completion order. */
  onProgress?: (result: PageResult, completed: number, total: number) => void;
}

export interface OcrPipelineResult {
  results: PageResult[];
  markdown: string;
  fileName: string;
  model: string;
}

export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_RETRIES = 3;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_MEDIA_RESOLUTION: MediaResolution = 'medium';

export const DEFAULT_PROMPT = `You are a precise OCR engine.

Transcribe this PDF page into clean markdown.

Rules:
- Preserve the visible text faithfully.
- Preserve headings, lists, paragraphs, and reading order.
- Convert tables into standard markdown tables with exactly one header row.
- If a complex table cannot be represented cleanly as one markdown table, split it into multiple titled tables.
- If the page contains important diagrams or visual callouts, describe them briefly in brackets.
- If the page is blank or has no useful text, return [Blank page].
- Return only the page transcription, with no preamble or commentary.`;
