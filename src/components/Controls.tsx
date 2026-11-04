import { useState } from 'react';
import { DEFAULT_PROMPT, estimateCost, formatCost, type GeminiModel, type MediaResolution } from '../core';
import { ModelTable } from './ModelTable';

export interface Settings {
  model: string;
  concurrency: number;
  /** Per-page request timeout, in seconds. */
  timeoutSec: number;
  mediaResolution: MediaResolution;
  startPage: number;
  endPage: number;
  prompt: string;
}

/** Integer field that can be fully cleared/retyped; normalizes (clamps, empty → fallback) on blur. */
function NumberField({
  id,
  label,
  min,
  max,
  value,
  fallback,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  fallback: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        className="text-input"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = Number(event.target.value);
          if (Number.isInteger(parsed) && parsed >= min) onCommit(Math.min(max, parsed));
        }}
        onBlur={() => {
          const normalized = clampInt(text, min, max, fallback);
          setText(String(normalized));
          onCommit(normalized);
        }}
      />
    </div>
  );
}

interface Props {
  settings: Settings;
  onChange: (partial: Partial<Settings>) => void;
  pageCount: number;
  /** Selected page count (drives the model table's cost estimate). */
  selectedPages: number;
  disabled?: boolean;
  models: GeminiModel[];
  /** True once a successful key Test has loaded the key's real models. */
  keyTested: boolean;
}

export function Controls({ settings, onChange, pageCount, selectedPages, disabled, models, keyTested }: Props) {
  const [showPrompt, setShowPrompt] = useState(false);
  const maxPage = pageCount || undefined;
  const needsTest = !keyTested; // stays put during a run, so Convert doesn't shift the page

  // Midpoint cost estimate for the selected model at a given image detail, so the
  // cost impact of low/medium/high is visible right on the options.
  const detailCost = (resolution: MediaResolution): string => {
    if (selectedPages <= 0) return '';
    const est = estimateCost(settings.model, selectedPages, resolution);
    if (est.costLow === null || est.costHigh === null) return '';
    return ` (~${formatCost((est.costLow + est.costHigh) / 2)})`;
  };

  return (
    <section className="panel">
      <div className={`field${needsTest ? ' is-locked' : ''}`}>
        <span className="field-label">Model</span>
        {needsTest ? (
          <p id="model-lock" className="lock-note" role="note">
            <svg className="lock-note-icon" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z"
              />
            </svg>
            <span>
              <strong>Test your key above</strong> to load the models it supports.
            </span>
          </p>
        ) : (
          <ModelTable
            models={models}
            selected={settings.model}
            onSelect={(model) => onChange({ model })}
            pages={selectedPages}
            mediaResolution={settings.mediaResolution}
            disabled={disabled}
          />
        )}
      </div>

      <div className="grid">
        <NumberField
          id="concurrency"
          label="Parallel pages"
          min={1}
          max={128}
          value={settings.concurrency}
          fallback={4}
          disabled={disabled}
          onCommit={(value) => onChange({ concurrency: value })}
        />

        <div className="field">
          <label className="field-label" htmlFor="media">
            Image detail
          </label>
          <select
            id="media"
            className="text-input"
            value={settings.mediaResolution}
            disabled={disabled}
            onChange={(event) => onChange({ mediaResolution: event.target.value as MediaResolution })}
          >
            <option value="low">Low{detailCost('low')}</option>
            <option value="medium">Medium{detailCost('medium')}</option>
            <option value="high">High{detailCost('high')}</option>
          </select>
        </div>

        <NumberField
          id="timeout"
          label="Page timeout (s)"
          min={5}
          max={600}
          value={settings.timeoutSec}
          fallback={30}
          disabled={disabled}
          onCommit={(value) => onChange({ timeoutSec: value })}
        />

        <div className="field">
          <span className="field-label">Pages</span>
          <div className="key-row">
            <input
              type="number"
              min={1}
              max={maxPage}
              className="text-input narrow"
              aria-label="First page"
              value={settings.startPage}
              disabled={disabled}
              onChange={(event) => onChange({ startPage: clampInt(event.target.value, 1, pageCount || 1, 1) })}
            />
            <span className="muted">to</span>
            <input
              type="number"
              min={1}
              max={maxPage}
              className="text-input narrow"
              aria-label="Last page"
              value={settings.endPage}
              disabled={disabled}
              onChange={(event) =>
                onChange({ endPage: clampInt(event.target.value, 1, pageCount || 1, pageCount || 1) })
              }
            />
            <span className="muted">/ {pageCount || '—'}</span>
          </div>
        </div>
      </div>

      <div className="prompt-head">
        <button
          type="button"
          className="link-btn disclosure"
          aria-expanded={showPrompt}
          onClick={() => setShowPrompt((value) => !value)}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Advanced: OCR prompt
        </button>
        {showPrompt && settings.prompt.trim() !== DEFAULT_PROMPT.trim() && (
          <button type="button" className="link-btn" onClick={() => onChange({ prompt: DEFAULT_PROMPT })}>
            Reset to default
          </button>
        )}
      </div>
      {showPrompt && (
        <textarea
          className="prompt-area"
          rows={16}
          disabled={disabled}
          placeholder="Empty = the built-in OCR prompt is used"
          value={settings.prompt}
          onChange={(event) => onChange({ prompt: event.target.value })}
        />
      )}
    </section>
  );
}

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
