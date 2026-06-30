import type { MediaResolution } from './types';

/**
 * APPROXIMATE rough-estimate constants. These are not authoritative — Gemini
 * pricing and tokenization change over time. Always show users the disclaimer
 * and link to https://ai.google.dev/gemini-api/docs/pricing.
 *
 * Pricing: USD per 1,000,000 tokens (paid tier, standard, non-batch, ≤200k context),
 * verified against Google's pricing docs (2026-06-29). Matched by model-id pattern;
 * order matters — every *-flash-lite pattern precedes its *-flash sibling, and the
 * versioned *-flash patterns precede the bare /3-flash/ catch.
 * (gemini-3-pro-preview was shut down 2026-03-09 and has no price → unpriced.)
 */
const PRICING: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /3\.1-flash-lite/i, input: 0.25, output: 1.5 },
  { match: /2\.5-flash-lite/i, input: 0.1, output: 0.4 },
  { match: /3\.5-flash/i, input: 1.5, output: 9.0 },
  { match: /3-flash/i, input: 0.5, output: 3.0 }, // gemini-3-flash-preview
  { match: /2\.5-flash/i, input: 0.3, output: 2.5 },
  { match: /3\.1-pro/i, input: 2.0, output: 12.0 },
  { match: /2\.5-pro/i, input: 1.25, output: 10.0 },
];

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

function pricingFor(model: string) {
  const id = model.replace(/^models\//, '');
  return PRICING.find((entry) => entry.match.test(id));
}

/** A deliberately rough cost estimate (input from a per-page token heuristic). */
export function estimateCost(model: string, pages: number, mediaResolution: MediaResolution): CostEstimate {
  const inputTokens = pages * (PAGE_INPUT_TOKENS[mediaResolution] + PROMPT_TOKENS_PER_PAGE);
  const outputTokensLow = pages * OUTPUT_TOKENS_PER_PAGE_LOW;
  const outputTokensHigh = pages * OUTPUT_TOKENS_PER_PAGE_HIGH;
  const pricing = pricingFor(model);
  const usd = (outputTokens: number): number | null =>
    pricing ? (inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output : null;

  return {
    pages,
    inputTokens,
    outputTokensLow,
    outputTokensHigh,
    costLow: usd(outputTokensLow),
    costHigh: usd(outputTokensHigh),
    priced: pricing !== undefined,
  };
}

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/** The per-1M-token list price for a model, or null if it isn't in the price table. */
export function modelPricing(model: string): ModelPricing | null {
  const pricing = pricingFor(model);
  return pricing ? { input: pricing.input, output: pricing.output } : null;
}

/** Exact USD cost from measured token counts, or null if the model isn't in the price table. */
export function actualCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = pricingFor(model);
  if (!pricing) return null;
  return (inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output;
}

/**
 * A single cost: dollars when ≥ $1, otherwise cents (¢). Most per-job OCR costs are
 * a fraction of a cent to tens of cents, where "0.72¢" reads far better than "$0.0072".
 */
export function formatCost(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  const cents = amount * 100;
  return `${cents.toFixed(cents >= 10 ? 0 : 2)}¢`;
}

/**
 * A cost range, in dollars when the high end is ≥ $1, otherwise in cents with adaptive
 * precision (2 decimals under 10¢, whole cents above) so the column stays readable.
 */
export function formatCostRange(low: number, high: number): string {
  if (high >= 1) return `$${low.toFixed(2)}–$${high.toFixed(2)}`;
  const lo = low * 100;
  const hi = high * 100;
  const dp = hi >= 10 ? 0 : 2;
  return `${lo.toFixed(dp)}–${hi.toFixed(dp)}¢`;
}
