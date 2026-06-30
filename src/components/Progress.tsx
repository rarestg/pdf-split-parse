import { useEffect, useState } from 'react';
import type { PageResult } from '../core';
import type { JobStatus } from '../hooks/useOcrJob';

interface Props {
  status: JobStatus;
  completed: number;
  total: number;
  failed: number;
  /** Live: requests currently out to Gemini. */
  inFlight: number;
  /** Live: pages currently in a 429/503 back-off wait. */
  retrying: number;
  results: PageResult[];
  startedAt: number | null;
  /** Wall-clock of the original run (fixed across retries). */
  elapsedMs: number;
  /** Cumulative re-OCR time across retries (drives the live timer while a retry runs). */
  retryElapsedMs: number;
  /** This job is a manual re-OCR of a subset: relabel the timer and hide the (now-stale) failure list. */
  reOcr: boolean;
  onCancel: () => void;
}

export function Progress({
  status,
  completed,
  total,
  failed,
  inFlight,
  retrying,
  results,
  startedAt,
  elapsedMs,
  retryElapsedMs,
  reOcr,
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
  // While running, the live timer counts from the right base: a fresh run from 0, a re-OCR from the
  // cumulative re-OCR time (so it keeps incrementing across retries, not from the original run's total).
  // Clamp the delta so a stale `now` (before the effect ticks) can't flash negative. Once settled it
  // shows the original run's wall-clock; re-OCR time is reported separately.
  const base = reOcr ? retryElapsedMs : elapsedMs;
  const elapsed = status === 'running' && startedAt != null ? base + Math.max(0, now - startedAt) : elapsedMs;
  const seconds = `${(elapsed / 1000).toFixed(1)}s`;
  const retryNote = retryElapsedMs > 0 ? ` (+${(retryElapsedMs / 1000).toFixed(1)}s re-OCR)` : '';
  const suspect = results.filter((r) => r.warning && !r.error).length;
  // Error and suspect rows only — successes are summarized by the count + bar, so the card
  // doesn't grow a line per page on a large document. Stale during a re-OCR, so hidden then.
  const flagged = results.filter((r) => r.error || r.warning);

  return (
    <>
      <div className="row-between">
        {/* Only the stable "{label} {completed}/{total}" is announced; the volatile live counts and
            ticking seconds are aria-hidden so a screen reader isn't narrated on every tick. */}
        <strong className="progress-status" aria-live="polite">
          {status === 'running' && (
            <>
              {reOcr ? 'Re-OCR-ing' : 'OCR-ing…'} {completed}/{total}
              {inFlight > 0 && <span aria-hidden="true"> · {inFlight} in flight</span>}
              {retrying > 0 && (
                <span className="stat-retry" aria-hidden="true">
                  {' '}
                  · {retrying} retrying
                </span>
              )}
              {/* `failed` is the whole-doc count; it's stale for a re-OCR subset, so show it only on a fresh run. */}
              {!reOcr && failed > 0 && (
                <span className="stat-fail" aria-hidden="true">
                  {' '}
                  · {failed} failed
                </span>
              )}
              <span aria-hidden="true"> · {seconds}</span>
            </>
          )}
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
      {!reOcr && flagged.length > 0 && (
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
