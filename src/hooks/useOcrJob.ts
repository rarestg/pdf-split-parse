import { useCallback, useRef, useState } from 'react';
import {
  actualCost,
  buildOutputMarkdown,
  DEFAULT_MEDIA_RESOLUTION,
  DEFAULT_MODEL,
  loadPdf,
  runOcrPipeline,
  type MediaResolution,
  type OcrOptions,
  type PageResult,
} from '../core';

export type JobStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

/**
 * Accumulate-only billed tokens per model, across the original run AND every retry. This is the
 * source of truth for cost: a retry replaces a failed page in `results`, but its original billed
 * tokens (e.g. a MAX_TOKENS failure that still got charged) stay counted here.
 */
export type CostByModel = Record<string, { inputTokens: number; outputTokens: number; billedPages: number }>;

export interface JobState {
  status: JobStatus;
  total: number;
  completed: number;
  failed: number;
  /** Live results in completion order while running; page order once settled. */
  results: PageResult[];
  markdown: string;
  error: string | null;
  /** Set when a retry (not the main run) failed without losing the existing document. */
  actionError: string | null;
  /** The primary model + image detail the original run used (drives the markdown + cost-summary header). */
  model: string;
  mediaResolution: MediaResolution;
  /** performance.now() at the start of the current operation; null until a run begins. */
  startedAt: number | null;
  /** Wall-clock time of the original run, in ms (stays fixed across retries). */
  elapsedMs: number;
  /** Cumulative wall-clock time spent on re-OCR retries, in ms (0 until the first retry). */
  retryElapsedMs: number;
  costByModel: CostByModel;
  /** Summary of the most recent manual retry (null until one runs; reset by a fresh run). */
  lastRetry: { pages: number[]; model: string; mediaResolution: MediaResolution; fixed: number; remaining: number } | null;
}

const INITIAL: JobState = {
  status: 'idle',
  total: 0,
  completed: 0,
  failed: 0,
  results: [],
  markdown: '',
  error: null,
  actionError: null,
  model: '',
  mediaResolution: DEFAULT_MEDIA_RESOLUTION,
  startedAt: null,
  elapsedMs: 0,
  retryElapsedMs: 0,
  costByModel: {},
  lastRetry: null,
};

export type RunOptions = Omit<OcrOptions, 'signal' | 'onProgress'>;

/** Fired when a run or retry finalizes, so the caller can keep a lifetime spend tally. */
export interface CompletionSummary {
  costUsd: number;
  /** Pages produced by this invocation (0 for a retry — those pages were already counted by the run). */
  pages: number;
  isRetry: boolean;
}

/** Add one result's billed tokens to the per-model ledger (immutably). */
function addTokens(ledger: CostByModel, model: string, result: PageResult): CostByModel {
  const current = ledger[model] ?? { inputTokens: 0, outputTokens: 0, billedPages: 0 };
  const billed = (result.inputTokens ?? 0) + (result.outputTokens ?? 0) > 0;
  return {
    ...ledger,
    [model]: {
      inputTokens: current.inputTokens + (result.inputTokens ?? 0),
      outputTokens: current.outputTokens + (result.outputTokens ?? 0),
      billedPages: current.billedPages + (billed ? 1 : 0),
    },
  };
}

/** USD cost of just these results at one model's rate; 0 for an unpriced model (so it can't poison a running total). */
function invocationCost(model: string, results: PageResult[]): number {
  const inputTokens = results.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
  const outputTokens = results.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
  return actualCost(model, inputTokens, outputTokens) ?? 0;
}

/** Overlay `updates` onto `base` by page number, returning a page-ordered list. */
function mergeResults(base: PageResult[], updates: PageResult[]): PageResult[] {
  const byPage = new Map(base.map((r) => [r.pageNumber, r]));
  for (const update of updates) byPage.set(update.pageNumber, update);
  return [...byPage.values()].sort((a, b) => a.pageNumber - b.pageNumber);
}

export function useOcrJob(onComplete?: (summary: CompletionSummary) => void) {
  const [state, setState] = useState<JobState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  // Retained so a retry can re-run a failed subset on the same PDF with the same base options,
  // reusing the already-parsed document (`source`) instead of re-parsing the whole PDF each retry.
  const ctxRef = useRef<{
    pdfBytes: Uint8Array;
    fileName: string;
    options: RunOptions;
    source: Awaited<ReturnType<typeof loadPdf>>;
  } | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const fireComplete = useCallback((isRetry: boolean, pages: number, costUsd: number) => {
    if (costUsd > 0 || pages > 0) onCompleteRef.current?.({ costUsd, pages, isRetry });
  }, []);

  const run = useCallback(
    async (pdfBytes: Uint8Array, fileName: string, options: RunOptions) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      ctxRef.current = null; // cleared until we have a parsed source to retry from
      const model = options.model?.trim() || DEFAULT_MODEL;
      const startedAt = performance.now();
      setState({
        ...INITIAL,
        status: 'running',
        model,
        mediaResolution: options.mediaResolution ?? DEFAULT_MEDIA_RESOLUTION,
        startedAt,
      });

      const collected: PageResult[] = [];
      try {
        // Parse the PDF once and retain it so retries don't re-parse the whole document.
        const source = await loadPdf(pdfBytes);
        ctxRef.current = { pdfBytes, fileName, options, source };
        const { markdown, results } = await runOcrPipeline(
          pdfBytes,
          fileName,
          {
            ...options,
            signal: controller.signal,
            onProgress: (result, completed, total) => {
              collected.push(result);
              setState((prev) => ({
                ...prev,
                status: 'running',
                total,
                completed,
                failed: prev.failed + (result.error ? 1 : 0),
                results: [...prev.results, result],
                costByModel: addTokens(prev.costByModel, model, result),
              }));
            },
          },
          source,
        );
        setState((prev) => ({
          ...prev,
          status: 'done',
          total: results.length,
          completed: results.length,
          failed: results.filter((r) => r.error).length,
          results,
          markdown,
          error: null,
          elapsedMs: performance.now() - (prev.startedAt ?? startedAt),
        }));
        fireComplete(false, results.length, invocationCost(model, results));
      } catch (error) {
        if (controller.signal.aborted) {
          // Keep whatever pages finished before the cancel so work isn't lost.
          const ordered = [...collected].sort((a, b) => a.pageNumber - b.pageNumber);
          const markdown = ordered.length ? buildOutputMarkdown(fileName, model, ordered) : '';
          setState((prev) => ({
            ...prev,
            status: 'cancelled',
            results: ordered,
            markdown,
            failed: ordered.filter((r) => r.error).length,
            elapsedMs: performance.now() - (prev.startedAt ?? startedAt),
          }));
          fireComplete(false, ordered.length, invocationCost(model, ordered));
        } else {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            elapsedMs: performance.now() - (prev.startedAt ?? startedAt),
          }));
          fireComplete(false, collected.length, invocationCost(model, collected));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [fireComplete],
  );

  /** Re-OCR a failed subset of pages (optionally on a different model / image detail) and merge the results in. */
  const retry = useCallback(
    async (pageNumbers: number[], overrides: { model: string; mediaResolution: MediaResolution }) => {
      const ctx = ctxRef.current;
      if (!ctx || pageNumbers.length === 0) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const retryModel = overrides.model.trim() || DEFAULT_MODEL;
      const startedAt = performance.now();
      // Show progress over just the subset; keep the prior document until the merge.
      setState((prev) => ({
        ...prev,
        status: 'running',
        error: null,
        actionError: null,
        completed: 0,
        total: pageNumbers.length,
        startedAt,
      }));

      // Tag results as retried at capture time so every merge path (settle, cancel, fatal) carries it.
      const retryResults: PageResult[] = [];
      // How many of the requested pages this retry fixed vs. left flagged, for the "last retry" line.
      const computeLastRetry = (prevResults: PageResult[], merged: PageResult[]): JobState['lastRetry'] => {
        const flaggedBefore = new Set(prevResults.filter((r) => r.error || r.warning).map((r) => r.pageNumber));
        const byPage = new Map(merged.map((r) => [r.pageNumber, r]));
        let fixed = 0;
        let remaining = 0;
        for (const p of pageNumbers) {
          const m = byPage.get(p);
          if (m && (m.error || m.warning)) remaining += 1;
          else if (flaggedBefore.has(p)) fixed += 1;
        }
        return {
          pages: [...pageNumbers].sort((a, b) => a - b),
          model: retryModel,
          mediaResolution: overrides.mediaResolution,
          fixed,
          remaining,
        };
      };
      const settle = (status: 'done' | 'cancelled') =>
        setState((prev) => {
          const merged = mergeResults(prev.results, retryResults);
          return {
            ...prev,
            status,
            results: merged,
            // Header stays the ORIGINAL model; only re-OCR'd pages get a provenance note.
            markdown: buildOutputMarkdown(ctx.fileName, prev.model, merged),
            failed: merged.filter((r) => r.error).length,
            completed: merged.length,
            total: merged.length,
            // The original run's time stays fixed; retry time accrues in its own cumulative counter.
            retryElapsedMs: prev.retryElapsedMs + (performance.now() - startedAt),
            lastRetry: computeLastRetry(prev.results, merged),
          };
        });

      try {
        const { results } = await runOcrPipeline(ctx.pdfBytes, ctx.fileName, {
          ...ctx.options,
          model: retryModel,
          mediaResolution: overrides.mediaResolution,
          pages: pageNumbers,
          signal: controller.signal,
          onProgress: (result, completed, total) => {
            retryResults.push({ ...result, retried: true });
            setState((prev) => ({
              ...prev,
              status: 'running',
              completed,
              total,
              costByModel: addTokens(prev.costByModel, retryModel, result),
            }));
          },
        }, ctx.source);
        settle('done');
        fireComplete(true, 0, invocationCost(retryModel, results));
      } catch (error) {
        if (controller.signal.aborted) {
          settle('cancelled');
        } else {
          // A fatal retry error (e.g. the chosen model isn't available on this key) must NOT wipe the
          // existing document — keep it, merge any pages that did come back, and surface the error inline.
          setState((prev) => {
            const merged = mergeResults(prev.results, retryResults);
            return {
              ...prev,
              status: 'done',
              results: merged,
              markdown: buildOutputMarkdown(ctx.fileName, prev.model, merged),
              failed: merged.filter((r) => r.error).length,
              completed: merged.length,
              total: merged.length,
              actionError: error instanceof Error ? error.message : String(error),
              retryElapsedMs: prev.retryElapsedMs + (performance.now() - startedAt),
              lastRetry: computeLastRetry(prev.results, merged),
            };
          });
        }
        fireComplete(true, 0, invocationCost(retryModel, retryResults));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [fireComplete],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort(new DOMException('Cancelled by user', 'AbortError'));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    ctxRef.current = null;
    setState(INITIAL);
  }, []);

  return { state, run, retry, cancel, reset };
}
