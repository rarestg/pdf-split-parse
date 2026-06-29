/**
 * Public API of the framework-agnostic OCR core.
 *
 * Runs in the browser and in Node. The React app is one consumer; this module
 * is the part that could later be published as a standalone package.
 */
export * from './types';
export { getPageCount, splitPdf, loadPdf, extractPage, validatePageRange } from './splitPdf';
export {
  ocrPage,
  listModels,
  GeminiHttpError,
  GeminiFatalError,
  type GeminiModel,
  type OcrPageParams,
} from './gemini';
export { stripOuterMarkdownFence, buildOutputMarkdown } from './markdown';
export { runOcrPipeline } from './pipeline';
