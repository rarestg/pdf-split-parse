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

// Settled status affordance: a filled disc in the status color with the glyph
// knocked out in the panel color (matches the ApiKeyInput status icons).
function StatusIcon({ kind }: { kind: 'ok' | 'warn' | 'danger' }) {
  const glyph =
    kind === 'ok' ? (
      <path
        className="glyph"
        d="M4.5 8.2l2.2 2.2 4.6-4.8"
        fill="none"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ) : kind === 'warn' ? (
      <path className="glyph" d="M8 4.4v4.2M8 11.1v.05" fill="none" strokeWidth="1.6" strokeLinecap="round" />
    ) : (
      <path className="glyph" d="M5.5 5.5l5 5M10.5 5.5l-5 5" fill="none" strokeWidth="1.6" strokeLinecap="round" />
    );
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      {glyph}
    </svg>
  );
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
  const retryNote = retryElapsedMs > 0 ? ` (+${(retryElapsedMs / 1000).toFixed(1)}s redo)` : '';
  const suspect = results.filter((r) => r.warning && !r.error).length;
  // Error and suspect rows only — successes are summarized by the count + bar, so the card
  // doesn't grow a line per page on a large document. Stale during a re-OCR, so hidden then.
  const flagged = results.filter((r) => r.error || r.warning);

  return (
    <>
      {(() => {
        // Status tone: failures dominate, then suspects, else clean; cancelled=warn, error=danger.
        const doneKind = failed > 0 ? 'danger' : suspect > 0 ? 'warn' : 'ok';
        const kind = status === 'error' ? 'danger' : status === 'cancelled' ? 'warn' : doneKind;
        // Co-headline meta beside the status word (pages · time), truthful per state.
        const meta =
          status === 'done'
            ? `${total} page${total === 1 ? '' : 's'} · ${seconds}${retryNote}`
            : status === 'cancelled'
              ? `${completed}/${total} pages · ${seconds}${retryNote}`
              : status === 'error' && total
                ? `${completed}/${total} pages · ${seconds}`
                : '';
        return (
          <div className="row-between">
            {/* Only the stable status/label is announced; volatile live counts and ticking
                seconds are aria-hidden so a screen reader isn't narrated on every tick. */}
            <div className={`report-status ${status === 'running' ? '' : kind}`} aria-live="polite">
              {status === 'running' ? (
                <span className="progress-status">
                  {reOcr ? 'Redoing' : 'Converting'} {completed}/{total}
                  {inFlight > 0 && <span aria-hidden="true"> · {inFlight} in flight</span>}
                  {retrying > 0 && (
                    <span className="stat-retry" aria-hidden="true">
                      {' '}
                      · {retrying} retrying
                    </span>
                  )}
                  {!reOcr && failed > 0 && (
                    <span className="stat-fail" aria-hidden="true">
                      {' '}
                      · {failed} failed
                    </span>
                  )}
                  <span aria-hidden="true"> · {seconds}</span>
                </span>
              ) : (
                <>
                  <StatusIcon kind={kind} />
                  <span>
                    {status === 'done' &&
                      `Done${failed ? `, ${failed} failed` : ''}${suspect ? `, ${suspect} suspect` : ''}`}
                    {status === 'cancelled' && 'Cancelled'}
                    {status === 'error' && 'Failed'}
                  </span>
                  {meta && <span className="report-meta">{meta}</span>}
                </>
              )}
            </div>
            {status === 'running' && (
              <button type="button" className="ghost-btn" onClick={onCancel}>
                Cancel
              </button>
            )}
          </div>
        );
      })()}
      <div
        className="bar"
        role="progressbar"
        aria-label="Conversion progress"
        aria-valuenow={completed}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {!reOcr && flagged.length > 0 && (
        <ul className="page-log">
          {flagged.map((result) => (
            <li key={result.pageNumber} className={result.error ? 'err' : 'warn'}>
              {result.error
                ? `page ${result.pageNumber} failed: ${result.error}`
                : `page ${result.pageNumber} suspect: ${result.warning}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
