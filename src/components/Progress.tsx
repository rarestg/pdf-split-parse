import { useEffect, useState } from 'react';
import type { PageResult } from '../core';
import type { JobStatus } from '../hooks/useOcrJob';

interface Props {
  status: JobStatus;
  completed: number;
  total: number;
  failed: number;
  results: PageResult[];
  startedAt: number | null;
  /** Wall-clock of the original run (fixed across retries). */
  elapsedMs: number;
  /** Cumulative re-OCR time across retries (drives the live timer while a retry runs). */
  retryElapsedMs: number;
  /** A retry is in flight: relabel the timer and hide the (now-stale) failure list. */
  retrying: boolean;
  onCancel: () => void;
}

export function Progress({
  status,
  completed,
  total,
  failed,
  results,
  startedAt,
  elapsedMs,
  retryElapsedMs,
  retrying,
  onCancel,
}: Props) {
  // Tick a local clock while running so the elapsed time updates live; freezes on finish.
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (status !== 'running') return;
    setNow(performance.now());
    const id = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(id);
  }, [status]);

  if (status === 'idle') return null;

  const pct = total ? Math.round((completed / total) * 100) : 0;
  // While running, the live timer counts from the right base: a fresh run from 0, a retry from the
  // cumulative re-OCR time (so it keeps incrementing across retries, not from the original run's total).
  // Clamp the delta so a stale `now` (before the effect ticks) can't flash negative. Once settled it
  // shows the original run's wall-clock; retry time is reported separately.
  const base = retrying ? retryElapsedMs : elapsedMs;
  const elapsed = status === 'running' && startedAt != null ? base + Math.max(0, now - startedAt) : elapsedMs;
  const seconds = `${(elapsed / 1000).toFixed(1)}s`;
  const retryNote = retryElapsedMs > 0 ? ` (+${(retryElapsedMs / 1000).toFixed(1)}s re-OCR)` : '';
  const suspect = results.filter((r) => r.warning && !r.error).length;
  // Error and suspect rows only — successes are summarized by the count + bar, so the card
  // doesn't grow a line per page on a large document. Stale during a retry, so hidden then.
  const flagged = results.filter((r) => r.error || r.warning);

  return (
    <>
      <div className="row-between">
        <strong className="progress-status" aria-live="polite">
          {status === 'running' && `${retrying ? 'Re-OCR-ing' : 'OCR-ing…'} ${completed}/${total} · ${seconds}`}
          {status === 'done' &&
            `Done · ${total} page${total === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}${suspect ? `, ${suspect} suspect` : ''} · ${seconds}${retryNote}`}
          {status === 'cancelled' && `Cancelled · ${seconds}${retryNote}`}
          {status === 'error' && 'Failed'}
        </strong>
        {status === 'running' && (
          <button type="button" className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-valuenow={completed}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {!retrying && flagged.length > 0 && (
        <ul className="page-log">
          {flagged.map((result, index) => (
            <li key={`${result.pageNumber}-${index}`} className={result.error ? 'err' : 'warn'}>
              {result.error
                ? `page ${result.pageNumber}: ${result.error}`
                : `page ${result.pageNumber}: suspect — ${result.warning}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
