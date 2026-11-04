import type { MediaResolution } from './types';
import { currentPrice } from './models';

/**
 * APPROXIMATE rough-estimate constants. These are not authoritative — Gemini
 * pricing and tokenization change over time. Always show users the disclaimer
 * and link to https://ai.google.dev/gemini-api/docs/pricing.
 *
 * Pricing: USD per 1,000,000 tokens (paid tier, standard, non-batch, ≤200k context),
 * verified against Google's pricing docs (2026-11-03); model prices live in models.ts.
 */

/** Approximate input tokens per PDF page by image detail (media resolution). */
const PAGE_INPUT_TOKENS: Record<MediaResolution, number> = {
  low: 280,
  medium: 560,
  high: 1120,
};

const PROMPT_TOKENS_PER_PAGE = 250;
const OUTPUT_TOKENS_PER_PAGE_LOW = 200;
const OUTPUT_TOKENS_PER_PAGE_HIGH = 1200;

export interface CostEstimate {
  pages: number;
  inputTokens: number;
  outputTokensLow: number;
  outputTokensHigh: number;
  /** USD; null when the model isn't in the built-in price table. */
  costLow: number | null;
  costHigh: number | null;
  priced: boolean;
}

/** A deliberately rough cost estimate (input from a per-page token heuristic). */
export function estimateCost(model: string, pages: number, mediaResolution: MediaResolution): CostEstimate {
  const inputTokens = pages * (PAGE_INPUT_TOKENS[mediaResolution] + PROMPT_TOKENS_PER_PAGE);
  const outputTokensLow = pages * OUTPUT_TOKENS_PER_PAGE_LOW;
  const outputTokensHigh = pages * OUTPUT_TOKENS_PER_PAGE_HIGH;
  const pricing = currentPrice(model);
  const usd = (outputTokens: number): number | null =>
    pricing ? (inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output : null;

  return {
    pages,
    inputTokens,
    outputTokensLow,
    outputTokensHigh,
    costLow: usd(outputTokensLow),
    costHigh: usd(outputTokensHigh),
    priced: pricing !== null,
  };
}

/** Exact USD cost from measured token counts, or null if the model isn't in the price table. */
export function actualCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = currentPrice(model);
  if (!pricing) return null;
  return (inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output;
}

/**
 * A single cost: dollars when ≥ $1, otherwise cents (¢). Most per-job OCR costs are
 * a fraction of a cent to tens of cents, where "0.72¢" reads far better than "$0.0072".
 * Below 0.1¢ a third decimal keeps nearby numbers distinct — at 2 decimals a one-page
 * job's actual (0.014¢ → "0.01¢") and estimate low (0.016¢ → "0.02¢") round apart and
 * look 2× apart next to an "in line with estimate" verdict.
 */
export function formatCost(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  const cents = amount * 100;
  return `${cents.toFixed(cents >= 10 ? 0 : cents >= 0.1 ? 2 : 3)}¢`;
}

/**
 * A cost range, in dollars when the high end is ≥ $1, otherwise in cents with adaptive
 * precision (whole cents from 10¢, 2 decimals under, 3 under 0.1¢ — matching formatCost
 * so an actual cost never looks outside a range it's actually inside).
 */
export function formatCostRange(low: number, high: number): string {
  if (high >= 1) return `$${low.toFixed(2)}–$${high.toFixed(2)}`;
  const lo = low * 100;
  const hi = high * 100;
  const dp = hi >= 10 ? 0 : hi >= 0.1 ? 2 : 3;
  return `${lo.toFixed(dp)}–${hi.toFixed(dp)}¢`;
}
