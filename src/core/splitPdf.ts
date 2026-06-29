import { PDFDocument } from 'pdf-lib';
import type { PageInput } from './types';

const LOAD_OPTS = { updateMetadata: false, ignoreEncryption: true } as const;

/** Load a PDF once; reuse it to extract pages lazily (bounds memory). */
export async function loadPdf(pdfBytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(pdfBytes, LOAD_OPTS);
}

/** Number of pages in a PDF, without splitting it. */
export async function getPageCount(pdfBytes: Uint8Array): Promise<number> {
  const doc = await loadPdf(pdfBytes);
  return doc.getPageCount();
}

/**
 * Validate a 1-based inclusive page window. Mirrors the Python reference's
 * resolve_page_window: rejects out-of-bounds ranges rather than silently clamping.
 */
export function validatePageRange(total: number, startPage: number, endPage: number): void {
  if (total < 1) throw new Error('The PDF has no pages.');
  if (!Number.isInteger(startPage) || startPage < 1) {
    throw new Error(`startPage must be an integer ≥ 1 (got ${startPage}).`);
  }
  if (!Number.isInteger(endPage) || endPage < startPage) {
    throw new Error(`endPage must be an integer ≥ startPage (got ${startPage}–${endPage}).`);
  }
  if (endPage > total) {
    throw new Error(`endPage ${endPage} exceeds the document's ${total} page(s).`);
  }
}

/** Extract a single page (1-based) into a standalone single-page PDF. */
export async function extractPage(source: PDFDocument, pageNumber: number): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(source, [pageNumber - 1]);
  out.addPage(copied);
  return out.save();
}

/**
 * Eagerly extract pages [startPage, endPage] (1-based, inclusive) into standalone
 * single-page PDFs. Convenience for callers/tests; the pipeline extracts lazily.
 */
export async function splitPdf(
  pdfBytes: Uint8Array,
  startPage: number,
  endPage: number,
): Promise<PageInput[]> {
  const source = await loadPdf(pdfBytes);
  validatePageRange(source.getPageCount(), startPage, endPage);

  const pages: PageInput[] = [];
  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber++) {
    pages.push({ pageNumber, pdfBytes: await extractPage(source, pageNumber) });
  }
  return pages;
}
