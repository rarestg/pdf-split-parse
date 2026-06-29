import type { PageResult } from '../core';
import type { JobStatus } from '../hooks/useOcrJob';

interface Props {
  status: JobStatus;
  completed: number;
  total: number;
  failed: number;
  results: PageResult[];
  onCancel: () => void;
}

export function Progress({ status, completed, total, failed, results, onCancel }: Props) {
  if (status === 'idle') return null;
  const pct = total ? Math.round((completed / total) * 100) : 0;

  return (
    <section className="panel">
      <div className="row-between">
        <strong aria-live="polite">
          {status === 'running' && `OCR-ing… ${completed}/${total}`}
          {status === 'done' &&
            `Done · ${total} page${total === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`}
          {status === 'cancelled' && 'Cancelled'}
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
      {results.length > 0 && (
        <ul className="page-log">
          {results.slice(-8).map((result, index) => (
            <li key={`${result.pageNumber}-${index}`} className={result.error ? 'err' : 'ok'}>
              page {result.pageNumber}:{' '}
              {result.error ? `error — ${result.error}` : `ok (${(result.elapsedMs / 1000).toFixed(1)}s)`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
