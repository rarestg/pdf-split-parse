import { PDFDocument } from 'pdf-lib';
import type { PageInput } from './types';

const LOAD_OPTS = { updateMetadata: false, ignoreEncryption: true } as const;

const ENCRYPTED_PDF_MESSAGE =
  'This PDF is protected (password- or permission-encrypted), which the in-browser reader can’t open. ' +
  'Re-save an unprotected copy — open it and choose Print → Save as PDF (or in macOS Preview, File → Export without encryption) — then upload that copy.';

const MALFORMED_PDF_MESSAGE =
  'This PDF couldn’t be read — it may be damaged or use an unusual structure. ' +
  'Try re-saving it (Print → Save as PDF) and uploading again.';

/** Load a PDF once; reuse it to extract pages lazily (bounds memory). */
export async function loadPdf(pdfBytes: Uint8Array): Promise<PDFDocument> {
  // pdf-lib can't decrypt and is a strict parser, so its raw failures (e.g.
  // "Expected instance of PDFDict, but got undefined") are meaningless to users.
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, LOAD_OPTS);
  } catch {
    // Encrypted docs sometimes fail outright; otherwise it's a malformed/unsupported file.
    throw new Error(looksEncrypted(pdfBytes) ? ENCRYPTED_PDF_MESSAGE : MALFORMED_PDF_MESSAGE);
  }
  // ignoreEncryption lets an encrypted doc load, but its content is undecipherable —
  // fail early with a clear reason instead of a cryptic error in getPageCount/copyPages.
  if (doc.isEncrypted) throw new Error(ENCRYPTED_PDF_MESSAGE);
  return doc;
}

/** Heuristic fallback (when load throws outright): an /Encrypt entry marks a protected doc. */
function looksEncrypted(pdfBytes: Uint8Array): boolean {
  const needle = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  outer: for (let i = pdfBytes.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (pdfBytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
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
