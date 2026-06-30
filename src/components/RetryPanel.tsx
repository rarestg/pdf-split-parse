import { useState } from 'react';
import { pickSmarterModel, type GeminiModel, type MediaResolution } from '../core';

interface Props {
  /** Models the key can use (for the retry dropdown). */
  models: GeminiModel[];
  /** The model the failed pages were produced with (used to default to something more capable). */
  usedModel: string;
  /** The image detail the failed pages were produced with (the default — not auto-escalated). */
  usedDetail: MediaResolution;
  /** 1-based page numbers that failed. */
  failedPages: number[];
  disabled?: boolean;
  /** A retry-specific error (e.g. the chosen model isn't available on this key) — shown without losing the document. */
  error?: string | null;
  onRetry: (model: string, detail: MediaResolution) => void;
}

const DETAILS: MediaResolution[] = ['low', 'medium', 'high'];
const title = (s: string) => s[0].toUpperCase() + s.slice(1);

export function RetryPanel({ models, usedModel, usedDetail, failedPages, disabled, error, onRetry }: Props) {
  // Default to the next model up the price ladder (what the user asked for), but keep the SAME image
  // detail — bumping detail raises input → output and makes MAX_TOKENS truncation more likely, not less.
  const [model, setModel] = useState(() => pickSmarterModel(models, usedModel));
  const [detail, setDetail] = useState<MediaResolution>(usedDetail);

  const count = failedPages.length;
  if (count === 0) return null;
  const pageWord = count === 1 ? 'page' : 'pages';

  return (
    <section className="panel retry-panel">
      <p className="retry-head">
        <strong>
          {count} {pageWord} failed
        </strong>{' '}
        (page{count === 1 ? '' : 's'} {failedPages.join(', ')}). Re-OCR with a different model or image detail.
      </p>
      <div className="retry-controls">
        <label className="field">
          <span className="field-label">Retry model</span>
          <select
            className="text-input"
            value={model}
            disabled={disabled}
            onChange={(event) => setModel(event.target.value)}
          >
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Image detail</span>
          <select
            className="text-input"
            value={detail}
            disabled={disabled}
            onChange={(event) => setDetail(event.target.value as MediaResolution)}
          >
            {DETAILS.map((d) => (
              <option key={d} value={d}>
                {title(d)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="primary-btn" disabled={disabled} onClick={() => onRetry(model, detail)}>
          Retry {count} {pageWord}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <p className="hint retry-hint">
        Rate-limit (429) and overload (503) errors retry on their own; timeouts and dense (MAX_TOKENS) pages
        are left here for you to retry.
      </p>
    </section>
  );
}
