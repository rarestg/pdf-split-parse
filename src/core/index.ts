/**
 * Public API of the framework-agnostic OCR core.
 *
 * Runs in the browser and in Node. The React app is one consumer; this module
 * is the part that could later be published as a standalone package.
 */
export * from './types';
export { MODEL_CATALOG, DEFAULT_MODEL, catalogEntry, currentPrice, type PriceTier, type CatalogModel } from './models';
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
  checkApiKey,
  pickDefaultModel,
  pickSmarterModel,
  GeminiHttpError,
  GeminiFatalError,
  type GeminiModel,
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
