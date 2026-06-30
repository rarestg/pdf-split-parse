import { GeminiFatalError, ocrPage } from './gemini';
import { buildOutputMarkdown } from './markdown';
import { extractPage, loadPdf, validatePageRange } from './splitPdf';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MEDIA_RESOLUTION,
  DEFAULT_MODEL,
  DEFAULT_PROMPT,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type OcrOptions,
  type OcrPipelineResult,
  type PageResult,
} from './types';

/**
 * Split a PDF into pages, OCR them with a bounded worker pool, and merge the
 * results into one markdown document. Faithful port of the Python reference's
 * asyncio queue + bounded workers: pages are extracted lazily (only ~concurrency
 * single-page PDFs resident at once) and output order follows page order.
 */
export async function runOcrPipeline(
  pdfBytes: Uint8Array,
  fileName: string,
  options: OcrOptions,
): Promise<OcrPipelineResult> {
  if (!options.apiKey?.trim()) throw new Error('A Gemini API key is required.');

  const model = options.model?.trim() || DEFAULT_MODEL;
  const prompt = options.prompt?.trim() || DEFAULT_PROMPT;
  const mediaResolution = options.mediaResolution ?? DEFAULT_MEDIA_RESOLUTION;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const source = await loadPdf(pdfBytes);
  const total = source.getPageCount();

  // Either an explicit page subset (e.g. a retry of the failed pages) or a contiguous range.
  let pageNumbers: number[];
  if (options.pages?.length) {
    pageNumbers = [...new Set(options.pages)]
      .filter((p) => Number.isInteger(p) && p >= 1 && p <= total)
      .sort((a, b) => a - b);
    if (pageNumbers.length === 0) throw new Error('No valid pages to process.');
  } else {
    const startPage = options.startPage ?? 1;
    const endPage = options.endPage ?? total;
    validatePageRange(total, startPage, endPage);
    pageNumbers = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
  }

  const count = pageNumbers.length;
  const results: PageResult[] = new Array(count);
  let completed = 0;
  let nextIndex = 0;

  // Internal controller so a fatal error in one worker cancels the others.
  const internal = new AbortController();
  const onExternalAbort = () => internal.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) internal.abort(options.signal.reason);
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Serialize extraction so we never run concurrent pdf-lib copyPages on the
  // shared source document, and to cap resident single-page PDFs at ~concurrency.
  let extractChain: Promise<unknown> = Promise.resolve();
  const extractNext = (pageNumber: number): Promise<Uint8Array> => {
    const run = extractChain.then(() => extractPage(source, pageNumber));
    extractChain = run.catch(() => undefined);
    return run;
  };

  const runWorker = async (): Promise<void> => {
    while (true) {
      if (internal.signal.aborted) throw internal.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const index = nextIndex++;
      if (index >= count) return;
      const pageNumber = pageNumbers[index];
      try {
        const pdf = await extractNext(pageNumber);
        if (internal.signal.aborted) throw internal.signal.reason ?? new DOMException('Aborted', 'AbortError');
        const result = await ocrPage(
          { pageNumber, pdfBytes: pdf },
          { apiKey: options.apiKey, model, prompt, mediaResolution, retries, timeoutMs, signal: internal.signal },
        );
        results[index] = result;
        completed += 1;
        options.onProgress?.(result, completed, count);
      } catch (error) {
        internal.abort(error); // fatal error or user cancel — stop sibling workers
        throw error;
      }
    }
  };

  try {
    const workerCount = Math.min(concurrency, count);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  } catch (error) {
    // Prefer the original fatal reason over a sibling worker's abort error.
    const reason = internal.signal.reason;
    if (reason instanceof GeminiFatalError) throw reason;
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  const markdown = buildOutputMarkdown(fileName, model, results);
  return { results, markdown, fileName, model };
}
