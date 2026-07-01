import { Fragment } from 'react';
import {
  actualCost,
  estimateCost,
  formatCost,
  formatCostRange,
  type MediaResolution,
  type PageResult,
} from '../core';
import type { CostByModel } from '../hooks/useOcrJob';

interface Props {
  results: PageResult[];
  /** Accumulate-only billed tokens per model — the source of truth for cost (survives merged retries). */
  costByModel: CostByModel;
  /** The model + image detail the original run used (for the estimate comparison + failure pricing fallback). */
  model: string;
  mediaResolution: MediaResolution;
}

/** Does this amount round to zero at the formatter's precision? (Then a delta of it is just rounding noise.) */
function rendersZero(amount: number): boolean {
  return /^0(\.0+)?¢$/.test(formatCost(Math.abs(amount)));
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// Small chip/note glyphs (decorative; text carries the meaning).
const CheckMini = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 8.4l3 3 7-7.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const AlertMini = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2l6 11H2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M8 6.4v3M8 11.3v.05" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/** Real cost of a finished job (from measured tokens per model), compared to the pre-run estimate. */
export function CostSummary({ results, costByModel, model, mediaResolution }: Props) {
  const entries = Object.entries(costByModel).filter(([, t]) => t.inputTokens + t.outputTokens > 0);

  // Failure annotations come from the live failed set, independent of the (accumulate-only) cost total.
  const failures = results.filter((r) => r.error);
  const billedFailures = failures.filter((r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0) > 0);
  const unmeasuredFailures = failures.length - billedFailures.length;

  if (entries.length === 0) {
    if (unmeasuredFailures === 0) return null; // nothing measured, nothing failed → nothing to say
    return (
      <div className="cost-summary">
        <p className="cost-note">
          <AlertMini /> {unmeasuredFailures} page{unmeasuredFailures === 1 ? '' : 's'} failed before any
          billable response (no cost reported).
        </p>
      </div>
    );
  }

  const inputTokens = entries.reduce((sum, [, t]) => sum + t.inputTokens, 0);
  const outputTokens = entries.reduce((sum, [, t]) => sum + t.outputTokens, 0);
  const totalTokens = inputTokens + outputTokens;
  const tokenBreakdown = `${totalTokens.toLocaleString()} tokens (${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out)`;

  const perModel = entries.map(([m, t]) => ({
    model: m,
    billedPages: t.billedPages,
    tokens: t.inputTokens + t.outputTokens,
    cost: actualCost(m, t.inputTokens, t.outputTokens),
  }));
  const priced = perModel.filter((p) => p.cost !== null);
  const total = priced.reduce((sum, p) => sum + (p.cost ?? 0), 0);
  const multiModel = entries.length > 1;

  // Estimate verdict only when a single (priced) model ran — a mixed-model retry makes it apples-to-oranges.
  let verdict: { kind: 'ok' | 'warn'; text: string } | null = null;
  if (!multiModel && priced.length === 1) {
    // Use the model's billed page-attempts (grows with retries) so a same-model retry's extra spend is
    // compared against an estimate for that many attempts, not the unique page count (else it reads "over").
    const billedPages = priced[0].billedPages;
    const { costLow, costHigh } = estimateCost(model, billedPages, mediaResolution);
    if (costLow !== null && costHigh !== null) {
      const range = formatCostRange(costLow, costHigh);
      if (total >= costLow && total <= costHigh) {
        verdict = { kind: 'ok', text: `within estimate ${range}` };
      } else {
        const over = total > costHigh;
        const delta = over ? total - costHigh : costLow - total;
        verdict = rendersZero(delta)
          ? { kind: 'ok', text: `in line with estimate ${range}` }
          : { kind: 'warn', text: `${formatCost(delta)} ${over ? 'over' : 'under'} estimate ${range}` };
      }
    }
  }
  const totalBilledPages = perModel.reduce((sum, p) => sum + p.billedPages, 0);
  // In a mixed run, `total` sums PRICED rows only; flag when unpriced models are excluded.
  const unpricedModels = perModel.length - priced.length;

  // Failure note (annotation only — never added to the total above).
  const noteParts: string[] = [];
  const billedFailCost = billedFailures.reduce(
    (sum, r) => sum + (actualCost(r.model ?? model, r.inputTokens ?? 0, r.outputTokens ?? 0) ?? 0),
    0,
  );
  if (billedFailures.length > 0 && billedFailCost > 0) {
    noteParts.push(
      `${formatCost(billedFailCost)} of that went to ${billedFailures.length} failed page${billedFailures.length === 1 ? '' : 's'}`,
    );
  }
  if (unmeasuredFailures > 0) {
    noteParts.push(
      `${unmeasuredFailures} page${unmeasuredFailures === 1 ? '' : 's'} failed with no billable response`,
    );
  }
  const note = noteParts.length ? noteParts.join('; ').replace(/^./, (c) => c.toUpperCase()) + '.' : '';

  // Per-page timing over SUCCESSFUL pages only (a timed-out page would otherwise inflate "slowest").
  const times = results.filter((r) => !r.error && r.elapsedMs > 0).map((r) => r.elapsedMs);
  let timing = '';
  if (times.length === 1) timing = `1 page in ${seconds(times[0])}`;
  else if (times.length > 1) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    timing = `${times.length} pages · avg ${seconds(avg)} · fastest ${seconds(Math.min(...times))} · slowest ${seconds(Math.max(...times))}`;
  }

  return (
    <div className="cost-summary">
      {priced.length > 0 ? (
        <div className="cost-hero">
          <span className="cost-eyebrow">Actual cost</span>
          <div className="cost-hero-row">
            <span className="cost-amount">{formatCost(total)}</span>
            {verdict && (
              <span className={`verdict-chip ${verdict.kind}`}>
                {verdict.kind === 'ok' ? <CheckMini /> : <AlertMini />}
                {verdict.text}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="cost-hero">
          <span className="cost-eyebrow">Tokens used</span>
          <div className="cost-hero-row">
            <span className="cost-amount unpriced">{tokenBreakdown}</span>
          </div>
          <p className="mixed-note">
            On {entries.map(([m]) => m).join(', ')} — no price in the table to cost it.
          </p>
        </div>
      )}

      {note && (
        <p className="cost-note">
          <AlertMini /> {note}
        </p>
      )}

      {multiModel && (
        <>
          <p className="mixed-note">
            Mixed models — no single estimate comparison.
            {unpricedModels > 0 &&
              ` Cost excludes ${unpricedModels} unpriced model${unpricedModels === 1 ? '' : 's'}.`}
          </p>
          <div className="cost-by-model">
            <span className="cbm-head">Model</span>
            <span className="cbm-head cbm-num">Pages</span>
            <span className="cbm-head cbm-num">Tokens</span>
            <span className="cbm-head cbm-num">Cost</span>
            {perModel.map((p) => (
              <Fragment key={p.model}>
                <span className="cbm-model">{p.model}</span>
                <span className="cbm-num">{p.billedPages.toLocaleString()}</span>
                <span className="cbm-num">{p.tokens.toLocaleString()}</span>
                <span className="cbm-num">{p.cost !== null ? formatCost(p.cost) : '—'}</span>
              </Fragment>
            ))}
            <span className="cbm-total-lbl">Total</span>
            <span className="cbm-num cbm-total">{totalBilledPages.toLocaleString()}</span>
            <span className="cbm-num cbm-total">{totalTokens.toLocaleString()}</span>
            <span className="cbm-num cbm-total">{formatCost(total)}</span>
          </div>
        </>
      )}

      {((!multiModel && priced.length > 0) || timing) && (
        <dl className="cost-rows">
          {!multiModel && priced.length > 0 && (
            <>
              <dt>Tokens</dt>
              <dd>
                {totalTokens.toLocaleString()}{' '}
                <span className="sub">
                  · {inputTokens.toLocaleString()} in / {outputTokens.toLocaleString()} out
                </span>
              </dd>
            </>
          )}
          {timing && (
            <>
              <dt>Per page</dt>
              <dd>{timing}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
