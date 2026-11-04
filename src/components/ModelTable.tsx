import { useState } from 'react';
import {
  estimateCost,
  formatCostRange,
  modelPricing,
  catalogEntry,
  type GeminiModel,
  type MediaResolution,
} from '../core';

/** Map a normalized cost 0..1 (cheap→expensive) to a green→yellow→red hue. */
function costColor(t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  return `hsl(${(120 * (1 - clamped)).toFixed(0)}, 75%, 50%)`;
}

interface Props {
  models: GeminiModel[];
  selected: string;
  onSelect: (model: string) => void;
  /** Selected page count (0 when no PDF is loaded yet). */
  pages: number;
  mediaResolution: MediaResolution;
  disabled?: boolean;
}

const PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing';

/**
 * Sortable model picker. The "Est. cost" column is the estimated total for the
 * current job (selected pages × image detail); before a PDF is loaded it reads
 * "—" and the sort falls back to list price. Unpriced models always sort last.
 */
export function ModelTable({ models, selected, onSelect, pages, mediaResolution, disabled }: Props) {
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const rows = models.map((model) => {
    const pricing = modelPricing(model.name);
    const est = pages > 0 ? estimateCost(model.name, pages, mediaResolution) : null;
    // Sort by the midpoint of the job estimate (output dominates OCR cost, so the
    // low-end alone misranks), else by list price; unpriced rows sort last.
    const sortKey =
      est && est.costLow !== null && est.costHigh !== null
        ? (est.costLow + est.costHigh) / 2
        : pricing
          ? pricing.input
          : Number.POSITIVE_INFINITY;
    return {
      name: model.name,
      displayName: model.displayName,
      paidOnly: catalogEntry(model.name)?.paidOnly ?? false,
      pricing,
      est,
      sortKey,
    };
  });

  rows.sort((a, b) => {
    const aUnpriced = !Number.isFinite(a.sortKey);
    const bUnpriced = !Number.isFinite(b.sortKey);
    if (aUnpriced !== bUnpriced) return aUnpriced ? 1 : -1; // unpriced always last
    if (aUnpriced && bUnpriced) return a.name.localeCompare(b.name);
    return (sortDir === 'asc' ? a.sortKey - b.sortKey : b.sortKey - a.sortKey) || a.name.localeCompare(b.name);
  });

  // Color scale endpoints: cheapest priced model = green, most expensive = red.
  // Linear in price, so equal price jumps = equal color jumps.
  const finiteKeys = rows.map((row) => row.sortKey).filter(Number.isFinite);
  const minKey = finiteKeys.length ? Math.min(...finiteKeys) : 0;
  const span = (finiteKeys.length ? Math.max(...finiteKeys) : 0) - minKey;

  return (
    <div className={`model-table-wrap${disabled ? ' is-disabled' : ''}`}>
      <table className="model-table" aria-label="Choose a model">
        <thead>
          <tr>
            <th scope="col" className="pick-col">
              <span className="sr-only">Select</span>
            </th>
            <th scope="col">Model</th>
            <th scope="col" className="num price-col">
              $/1M in
            </th>
            <th scope="col" className="num price-col">
              $/1M out
            </th>
            <th scope="col" className="num" aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}>
              <button
                type="button"
                className="sort-btn"
                onClick={() => setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))}
                aria-label="Sort by estimated cost"
              >
                Est. cost <span aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>
              </button>
            </th>
            <th scope="col" className="dot-col">
              <span className="sr-only">Relative cost</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isSelected = row.name === selected;
            const cost =
              row.est && row.est.costLow !== null && row.est.costHigh !== null
                ? formatCostRange(row.est.costLow, row.est.costHigh)
                : '—';
            const dotColor = Number.isFinite(row.sortKey)
              ? costColor(span > 0 ? (row.sortKey - minKey) / span : 0)
              : 'var(--muted)';
            return (
              <tr
                key={row.name}
                className={isSelected ? 'selected' : undefined}
                onClick={() => !disabled && onSelect(row.name)}
              >
                <td className="pick-col">
                  <input
                    type="radio"
                    name="model-pick"
                    checked={isSelected}
                    disabled={disabled}
                    onChange={() => onSelect(row.name)}
                    aria-label={`Select ${row.name}`}
                  />
                </td>
                <td className="model-id">
                  <span className="model-primary">{row.displayName ?? row.name}</span>
                  {row.paidOnly && <span className="model-badge">Paid key</span>}
                  {row.displayName && row.displayName !== row.name && (
                    <small className="model-name-id">{row.name}</small>
                  )}
                </td>
                <td className="num price-col">{row.pricing ? row.pricing.input.toFixed(2) : '—'}</td>
                <td className="num price-col">{row.pricing ? row.pricing.output.toFixed(2) : '—'}</td>
                <td className="num">{cost}</td>
                <td className="dot-col">
                  <span className="cost-dot" style={{ background: dotColor }} aria-hidden="true" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint model-table-note">
        {pages > 0
          ? `Estimate for ${pages} selected page${pages === 1 ? '' : 's'} at ${mediaResolution} detail`
          : 'Load a PDF to estimate cost'}
        <span className="price-col"> · prices per 1M tokens</span>
        {' · verify on '}
        <a href={PRICING_URL} target="_blank" rel="noreferrer">
          Google&rsquo;s pricing
        </a>
        .
      </p>
    </div>
  );
}
