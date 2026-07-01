import type { PageResult } from './types';

/** Strip a single outer ```markdown ... ``` fence if the model wrapped its output. */
export function stripOuterMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/**
 * Merge per-page OCR results into one markdown document, page order preserved.
 * Faithful to the source: only the OCR'd text of each page, blank-line separated,
 * with a minimal marker where a page failed so gaps aren't silent. Nothing else is
 * injected — no title, model line, page headings, rules, or provenance notes.
 */
export function buildOutputMarkdown(results: PageResult[]): string {
  const parts: string[] = [];
  for (const result of results) {
    if (result.error) parts.push(`[OCR failed: ${result.error}]`);
    else if (result.text && result.text.trim()) parts.push(result.text);
  }
  return parts.join('\n\n').replace(/\s+$/, '') + '\n';
}
