/**
 * End-to-end smoke test for the OCR core, runnable from Node (the core is
 * browser+Node safe). Offline checks always run; the live Gemini call runs only
 * when GEMINI_API_KEY is set in the environment or _local/.env.
 *
 *   npm run smoke
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOutputMarkdown,
  DEFAULT_PROMPT,
  checkApiKey,
  getPageCount,
  ocrPage,
  pickDefaultModel,
  splitPdf,
} from '../src/core/index';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadKey(): string | null {
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();
  try {
    const env = readFileSync(join(root, '_local/.env'), 'utf8');
    const match = env.match(/^GEMINI_API_KEY=(.*)$/m);
    return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
  } catch {
    return null;
  }
}

const bytes = new Uint8Array(readFileSync(join(root, 'samples/sample.pdf')));

console.log('— offline checks —');
const pageCount = await getPageCount(bytes);
console.log('page count:', pageCount);

const pages = await splitPdf(bytes, 1, pageCount);
console.log('split pages:', pages.length, '· first page is', pages[0].pdfBytes.length, 'bytes');

const sampleMarkdown = buildOutputMarkdown([{ pageNumber: 1, text: '# Hello\n\nWorld', elapsedMs: 120, attempts: 1 }]);
console.log(`merged markdown:\n${sampleMarkdown.split('\n').slice(0, 4).join('\n')}`);

const key = loadKey();
if (!key) {
  console.log('\nNo GEMINI_API_KEY in the environment or _local/.env — skipping the live Gemini call.');
  process.exit(0);
}

console.log('\n— live Gemini check —');
try {
  const models = await checkApiKey(key);
  console.log('models usable with this key:', models.length);
  const model = pickDefaultModel(models);
  if (!model) {
    console.log('No supported model is available to this key.');
    process.exit(1);
  }
  console.log('using model:', model);

  const result = await ocrPage(pages[0], {
    apiKey: key,
    model,
    prompt: DEFAULT_PROMPT,
    mediaResolution: 'medium',
    retries: 1,
    timeoutMs: 60_000,
  });

  if (result.error) {
    console.log('OCR error:', result.error);
    process.exit(1);
  }
  console.log(`OCR ok in ${(result.elapsedMs / 1000).toFixed(1)}s:\n`);
  console.log(result.text.slice(0, 1000));
} catch (error) {
  console.log('live check failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
