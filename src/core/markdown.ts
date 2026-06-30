import type { PageResult } from './types';

/** Strip a single outer ```markdown ... ``` fence if the model wrapped its output. */
export function stripOuterMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/** Merge per-page results into a single markdown document (page order preserved). */
export function buildOutputMarkdown(
  fileName: string,
  model: string,
  results: PageResult[],
): string {
  const headerModel = model.replace(/^models\//, '').trim();
  const lines: string[] = [`# OCR: ${fileName}\n\n`, `_Model: ${headerModel}_\n\n`];
  const failed = results.filter((r) => r.error);

  for (const result of results) {
    lines.push(`## Page ${result.pageNumber}\n\n`);
    // Pages re-OCR'd on a different model (a manual retry) get a provenance note.
    const pageModel = result.model?.replace(/^models\//, '').trim();
    if (pageModel && pageModel !== headerModel) {
      lines.push(`_Re-OCR'd with ${pageModel}._\n\n`);
    }
    if (!result.error) {
      lines.push(result.text || '[Blank page]');
      lines.push('\n\n');
    } else {
      lines.push(`[OCR failed: ${result.error}]\n\n`);
    }
    lines.push('---\n\n');
  }

  if (failed.length) {
    lines.push('## Errors\n\n');
    for (const result of failed) {
      lines.push(`- Page ${result.pageNumber}: ${result.error}\n`);
    }
    lines.push('\n');
  }

  return lines.join('').replace(/\s+$/, '') + '\n';
}
