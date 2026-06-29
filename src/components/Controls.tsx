import { useState } from 'react';
import type { GeminiModel, MediaResolution } from '../core';

export interface Settings {
  model: string;
  concurrency: number;
  mediaResolution: MediaResolution;
  startPage: number;
  endPage: number;
  prompt: string;
}

interface Props {
  settings: Settings;
  onChange: (partial: Partial<Settings>) => void;
  pageCount: number;
  disabled?: boolean;
  models: GeminiModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  onLoadModels: () => void;
}

export function Controls({
  settings,
  onChange,
  pageCount,
  disabled,
  models,
  modelsLoading,
  modelsError,
  onLoadModels,
}: Props) {
  const [showPrompt, setShowPrompt] = useState(false);
  const maxPage = pageCount || undefined;

  return (
    <section className="panel">
      <div className="grid">
        <div className="field">
          <label className="field-label" htmlFor="model">
            Model
          </label>
          <div className="key-row">
            <input
              id="model"
              className="text-input"
              list="model-list"
              value={settings.model}
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => onChange({ model: event.target.value })}
            />
            <button type="button" className="ghost-btn" onClick={onLoadModels} disabled={disabled || modelsLoading}>
              {modelsLoading ? '…' : 'Load'}
            </button>
          </div>
          <datalist id="model-list">
            {models.map((model) => (
              <option key={model.name} value={model.name}>
                {model.displayName}
              </option>
            ))}
          </datalist>
          {modelsError && <span className="error-text">{modelsError}</span>}
          {!modelsError && !modelsLoading && models.length > 0 && (
            <span className="muted">{models.length} models available</span>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="concurrency">
            Parallel pages
          </label>
          <input
            id="concurrency"
            type="number"
            min={1}
            max={16}
            className="text-input"
            value={settings.concurrency}
            disabled={disabled}
            onChange={(event) => onChange({ concurrency: clampInt(event.target.value, 1, 16, 4) })}
          />
        </div>

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
            <option value="low">Low (cheapest)</option>
            <option value="medium">Medium</option>
            <option value="high">High (dense scans)</option>
          </select>
        </div>

        <div className="field">
          <label className="field-label">Pages</label>
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

      <button type="button" className="link-btn" onClick={() => setShowPrompt((value) => !value)}>
        {showPrompt ? '▾' : '▸'} Advanced: OCR prompt
      </button>
      {showPrompt && (
        <textarea
          className="prompt-area"
          rows={6}
          disabled={disabled}
          placeholder="Leave blank to use the built-in OCR prompt"
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
