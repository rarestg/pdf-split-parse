import type { PDFDocument } from 'pdf-lib';
import { debugTime } from './debug';
import type { PageInput } from './types';

const LOAD_OPTS = { updateMetadata: false, ignoreEncryption: true } as const;

const ENCRYPTED_PDF_MESSAGE =
  'This PDF is protected (password- or permission-encrypted), which the in-browser reader can’t open. ' +
  'Re-save an unprotected copy — open it and choose Print → Save as PDF (or in macOS Preview, File → Export without encryption) — then upload that copy.';

const MALFORMED_PDF_MESSAGE =
  'This PDF couldn’t be read — it may be damaged or use an unusual structure. ' +
  'Try re-saving it (Print → Save as PDF) and uploading again.';

const CHUNK_FAILED_MESSAGE = 'This page couldn’t finish loading. Please reload it and try again.';

/** Load a PDF once; reuse it to extract pages lazily (bounds memory). */
export async function loadPdf(pdfBytes: Uint8Array): Promise<PDFDocument> {
  // Loaded on demand because pdf-lib is over half of the app's JavaScript. Outside the try below,
  // so a failed download isn't reported as a damaged PDF.
  const { PDFDocument } = await import('pdf-lib').catch((cause) => {
    throw new Error(CHUNK_FAILED_MESSAGE, { cause });
  });
  // pdf-lib can't decrypt and is a strict parser, so its raw failures (e.g.
  // "Expected instance of PDFDict, but got undefined") are meaningless to users.
  let doc: PDFDocument;
  const done = debugTime('loadPdf');
  try {
    doc = await PDFDocument.load(pdfBytes, LOAD_OPTS);
    done();
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

export interface ParsedPageSpec {
  pages: number[];
  ignored: string[];
}

/** Parse a free-text page spec ("14, 15, 19-22, 32") against a known page count. Lenient: commas
 *  and/or whitespace; inclusive ranges (- or –, with or without surrounding spaces); reversed ranges
 *  swapped; out-of-range clamped/dropped; junk collected into `ignored`. Result deduped + sorted
 *  ascending. Parse against the DOCUMENT's pageCount so any real page can be requested after a subset run. */
export function parsePageSpec(spec: string, pageCount: number): ParsedPageSpec {
  const pages = new Set<number>();
  const ignored: string[] = [];
  // Collapse spaces around a dash so "19 - 22" reads as one range token, not "19", "-", "22".
  const normalized = spec.replace(/\s*[-–]\s*/g, '-');
  for (const raw of normalized.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(raw);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
      let added = false;
      for (let p = Math.max(1, a); p <= Math.min(pageCount, b); p++) {
        pages.add(p);
        added = true;
      }
      if (!added) ignored.push(raw);
    } else if (/^\d+$/.test(raw)) {
      const p = Number(raw);
      if (p >= 1 && p <= pageCount) pages.add(p);
      else ignored.push(raw);
    } else {
      ignored.push(raw);
    }
  }
  return { pages: [...pages].sort((x, y) => x - y), ignored };
}

/** Extract a single page (1-based) into a standalone single-page PDF. */
export async function extractPage(source: PDFDocument, pageNumber: number): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const done = debugTime(`extractPage ${pageNumber}`);
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(source, [pageNumber - 1]);
  out.addPage(copied);
  const bytes = await out.save();
  done();
  return bytes;
}

/**
 * Eagerly extract pages [startPage, endPage] (1-based, inclusive) into standalone
 * single-page PDFs. Convenience for callers/tests; the pipeline extracts lazily.
 */
export async function splitPdf(pdfBytes: Uint8Array, startPage: number, endPage: number): Promise<PageInput[]> {
  const source = await loadPdf(pdfBytes);
  validatePageRange(source.getPageCount(), startPage, endPage);

  const pages: PageInput[] = [];
  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber++) {
    pages.push({ pageNumber, pdfBytes: await extractPage(source, pageNumber) });
  }
  return pages;
}
