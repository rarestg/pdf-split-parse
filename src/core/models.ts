/**
 * Source: https://ai.google.dev/gemini-api/docs/pricing (verified 2026-11-03).
 * This catalog is the single source of truth; adding a model means adding an entry here.
 */
export interface PriceTier {
  input: number;
  output: number;
  /** Last day (inclusive, YYYY-MM-DD) this tier applies; omit on the final tier. */
  until?: string;
}

export interface CatalogModel {
  id: string;
  label: string;
  prices: PriceTier[];
  thinking: Record<string, unknown>;
  /** Not available on the free tier (generateContent 429s with limit: 0). */
  paidOnly?: boolean;
}

export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    prices: [{ input: 0.1, output: 0.4 }],
    thinking: { thinkingBudget: 0 },
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite',
    prices: [{ input: 0.25, output: 1.5 }],
    thinking: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    prices: [{ input: 0.3, output: 2.5 }],
    thinking: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    prices: [
      { input: 0.75, output: 3.75, until: '2026-12-31' },
      { input: 1.5, output: 7.5 },
    ],
    thinking: { thinkingLevel: 'minimal' },
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    prices: [
      { input: 0.75, output: 3.75, until: '2026-12-31' },
      { input: 1.5, output: 7.5 },
    ],
    thinking: { thinkingLevel: 'low' },
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    prices: [{ input: 2, output: 12 }],
    thinking: { thinkingLevel: 'low' },
    paidOnly: true,
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    prices: [
      { input: 2, output: 10, until: '2026-11-30' },
      { input: 4, output: 20 },
    ],
    thinking: { thinkingLevel: 'low' },
    paidOnly: true,
  },
];

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export function catalogEntry(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((model) => model.id === id.replace(/^models\//, ''));
}

export function currentPrice(id: string, now = new Date()): { input: number; output: number } | null {
  const entry = catalogEntry(id);
  if (!entry) return null;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const tier = entry.prices.find((price) => !price.until || today <= price.until);
  return tier ? { input: tier.input, output: tier.output } : null;
}
