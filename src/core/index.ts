/**
 * Public API of the framework-agnostic OCR core.
 *
 * Runs in the browser and in Node. The React app is one consumer; this module
 * is the part that could later be published as a standalone package.
 */
export * from './types';
export { detectRepetition } from './anomaly';
export {
  getPageCount,
  splitPdf,
  loadPdf,
  extractPage,
  validatePageRange,
  parsePageSpec,
  type ParsedPageSpec,
} from './splitPdf';
export {
  ocrPage,
  listModels,
  curateModels,
  checkApiKey,
  pickCheapestModel,
  pickSmarterModel,
  GeminiHttpError,
  GeminiFatalError,
  type GeminiModel,
  type KeyCheckResult,
  type OcrPageParams,
} from './gemini';
export { stripOuterMarkdownFence, buildOutputMarkdown } from './markdown';
export { runOcrPipeline } from './pipeline';
export {
  estimateCost,
  actualCost,
  formatCost,
  formatCostRange,
  modelPricing,
  type CostEstimate,
  type ModelPricing,
} from './cost';
