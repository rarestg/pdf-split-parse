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
  const warned = results.filter((r) => r.warning && !r.error);

  for (const result of results) {
    lines.push(`## Page ${result.pageNumber}\n\n`);
    // Re-OCR'd pages (a manual retry) get a provenance note, using the per-result model.
    const pageModel = result.model?.replace(/^models\//, '').trim();
    if (pageModel && result.retried) {
      lines.push(`_Re-OCR'd with ${pageModel}._\n\n`);
    }
    if (!result.error) {
      // Soft anomaly note so the degenerate output is flagged inline, not just in the summary.
      if (result.warning) lines.push(`_Possible OCR anomaly: ${result.warning}. Consider re-OCR._\n\n`);
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

  if (warned.length) {
    lines.push('## Warnings\n\n');
    for (const result of warned) {
      lines.push(`- Page ${result.pageNumber}: ${result.warning}\n`);
    }
    lines.push('\n');
  }

  return lines.join('').replace(/\s+$/, '') + '\n';
}
