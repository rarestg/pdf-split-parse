import { useCallback, useRef, useState } from 'react';
import { buildOutputMarkdown, DEFAULT_MODEL, runOcrPipeline, type OcrOptions, type PageResult } from '../core';

export type JobStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobState {
  status: JobStatus;
  total: number;
  completed: number;
  failed: number;
  /** Live results in completion order while running; page order once done. */
  results: PageResult[];
  markdown: string;
  error: string | null;
}

const INITIAL: JobState = {
  status: 'idle',
  total: 0,
  completed: 0,
  failed: 0,
  results: [],
  markdown: '',
  error: null,
};

export type RunOptions = Omit<OcrOptions, 'signal' | 'onProgress'>;

export function useOcrJob() {
  const [state, setState] = useState<JobState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (pdfBytes: Uint8Array, fileName: string, options: RunOptions) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ ...INITIAL, status: 'running' });

      const collected: PageResult[] = [];
      try {
        const { markdown, results } = await runOcrPipeline(pdfBytes, fileName, {
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
            }));
          },
        });
        const failed = results.filter((r) => r.error).length;
        setState({
          status: 'done',
          total: results.length,
          completed: results.length,
          failed,
          results,
          markdown,
          error: null,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          // Keep whatever pages finished before the cancel so work isn't lost.
          const ordered = [...collected].sort((a, b) => a.pageNumber - b.pageNumber);
          const markdown = ordered.length
            ? buildOutputMarkdown(fileName, options.model?.trim() || DEFAULT_MODEL, ordered)
            : '';
          setState((prev) => ({ ...prev, status: 'cancelled', results: ordered, markdown }));
        } else {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort(new DOMException('Cancelled by user', 'AbortError'));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(INITIAL);
  }, []);

  return { state, run, cancel, reset };
}
