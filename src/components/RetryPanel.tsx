import { useEffect, useRef, useState } from 'react';
import { parsePageSpec, pickSmarterModel, type GeminiModel, type MediaResolution } from '../core';

interface Props {
  /** Models the key can use (for the retry dropdown). */
  models: GeminiModel[];
  /** The model the run used (used to default to something more capable). */
  usedModel: string;
  /** The image detail the run used (the default — not auto-escalated). */
  usedDetail: MediaResolution;
  /** 1-based pages that are flagged (failed or suspect) — the default selection. */
  flaggedPages: number[];
  /** 1-based pages that failed outright. */
  failedPages: number[];
  /** 1-based pages that succeeded but look degenerate. */
  suspectPages: number[];
  /** Page count of the source document, so any real page can be requested. */
  pageCount: number;
  disabled?: boolean;
  /** A retry-specific error (e.g. the chosen model isn't available on this key) — shown without losing the document. */
  error?: string | null;
  onRetry: (pages: number[], model: string, detail: MediaResolution) => void;
}

const DETAILS: MediaResolution[] = ['low', 'medium', 'high'];
const PREVIEW_CAP = 40;
const title = (s: string) => s[0].toUpperCase() + s.slice(1);

export function RetryPanel({
  models,
  usedModel,
  usedDetail,
  flaggedPages,
  failedPages,
  suspectPages,
  pageCount,
  disabled,
  error,
  onRetry,
}: Props) {
  const flaggedSpec = flaggedPages.join(', ');
  const [spec, setSpec] = useState(flaggedSpec);
  // Default to the next model up the price ladder, but keep the SAME image detail — bumping detail
  // raises input → output and makes MAX_TOKENS truncation more likely, not less.
  const [model, setModel] = useState(() => pickSmarterModel(models, usedModel));
  const [detail, setDetail] = useState<MediaResolution>(usedDetail);
  const [userExpanded, setUserExpanded] = useState(false);

  // Re-sync the field as retries change the flagged set (e.g. a retry fixes some pages), so the next
  // default action targets what's still flagged — but don't clobber a spec the user has edited.
  const prevFlaggedRef = useRef(flaggedSpec);
  useEffect(() => {
    setSpec((current) => (current === prevFlaggedRef.current ? flaggedSpec : current));
    prevFlaggedRef.current = flaggedSpec;
  }, [flaggedSpec]);

  // With nothing flagged, don't loom as a full card — collapse to a quiet link that expands on demand.
  const expanded = flaggedPages.length > 0 || userExpanded;
  if (!expanded) {
    return (
      <button type="button" className="link-btn retry-expand" disabled={disabled} onClick={() => setUserExpanded(true)}>
        Re-OCR specific pages…
      </button>
    );
  }

  const parsed = parsePageSpec(spec, pageCount);
  const failed = failedPages.length;
  const suspect = suspectPages.length;

  // Adaptive header: a bold lead naming what's flagged, then a sentence inviting a free choice.
  let lead: string;
  let rest: string;
  if (failed > 0 && suspect > 0) {
    lead = `${failed} failed, ${suspect} suspect`;
    rest = ' — re-OCR them, or any pages you choose, with a different model or image detail.';
  } else if (failed > 0) {
    lead = `${failed} page${failed === 1 ? '' : 's'} failed`;
    rest = ` (page${failed === 1 ? '' : 's'} ${failedPages.join(', ')}). Re-OCR them, or any pages you choose, with a different model or image detail.`;
  } else if (suspect > 0) {
    lead = `${suspect} page${suspect === 1 ? '' : 's'} look${suspect === 1 ? 's' : ''} suspect`;
    rest = ` (page${suspect === 1 ? '' : 's'} ${suspectPages.join(', ')}). Re-OCR them, or any pages you choose, with a different model or image detail.`;
  } else {
    lead = 'Re-OCR specific pages';
    rest = ' — redo individual pages with a different model or image detail.';
  }

  const n = parsed.pages.length;
  const list =
    n > PREVIEW_CAP
      ? `${parsed.pages.slice(0, PREVIEW_CAP).join(', ')}… (+${n - PREVIEW_CAP} more)`
      : parsed.pages.join(', ');
  const preview = n === 0 ? 'Nothing to re-OCR' : `Will re-OCR ${n} page${n === 1 ? '' : 's'}: ${list}`;
  const showReset = flaggedPages.length > 0 && spec !== flaggedSpec;

  return (
    <section className="panel retry-panel">
      <p className="retry-head">
        <strong>{lead}</strong>
        {rest}
      </p>

      <div className="retry-field">
        <label className="field-label" htmlFor="retry-spec">
          Pages to re-OCR
        </label>
        <input
          id="retry-spec"
          className="text-input"
          type="text"
          placeholder="e.g. 14, 15, 19-22, 32"
          value={spec}
          disabled={disabled}
          onChange={(event) => setSpec(event.target.value)}
        />
        <p className="hint retry-preview">{preview}</p>
        {parsed.ignored.length > 0 && <p className="hint retry-ignored">Ignored: {parsed.ignored.join(', ')}.</p>}
        {showReset && (
          <button type="button" className="link-btn" disabled={disabled} onClick={() => setSpec(flaggedSpec)}>
            Reset to flagged ({flaggedPages.length})
          </button>
        )}
      </div>

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
        <button
          type="button"
          className="primary-btn"
          disabled={n === 0 || disabled}
          onClick={() => onRetry(parsed.pages, model, detail)}
        >
          Re-OCR {n} page{n === 1 ? '' : 's'}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      <p className="hint retry-hint">
        Rate-limit (429) and overload (503) errors retry on their own; timeouts and dense (MAX_TOKENS) pages are left
        here for you to retry.
      </p>
    </section>
  );
}
