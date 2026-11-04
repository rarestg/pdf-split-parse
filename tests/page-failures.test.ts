import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { GeminiFatalError, runOcrPipeline } from '../src/core/index';

const pdf = new Uint8Array(readFileSync(new URL('../samples/sample.pdf', import.meta.url)));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function runWithReply(status: number, reply: unknown) {
  globalThis.fetch = async () => new Response(JSON.stringify(reply), { status });
  return runOcrPipeline(pdf, 'sample.pdf', { apiKey: 'test', model: 'gemini-3.5-flash-lite' });
}

const usageMetadata = { promptTokenCount: 500, candidatesTokenCount: 7, thoughtsTokenCount: 3 };
const textReply = (text: string, finishReason: string) => ({
  candidates: [{ finishReason, content: { parts: [{ text }] } }],
  usageMetadata,
});

for (const [name, reply] of [
  ['an empty reply', textReply('', 'STOP')],
  ['a fence-only reply', textReply('```markdown\n```', 'STOP')],
  ['no candidates', { usageMetadata }],
  ['a SAFETY stop', { candidates: [{ finishReason: 'SAFETY' }], usageMetadata }],
  ['a RECITATION stop with partial text', textReply('Half a sen', 'RECITATION')],
] as const) {
  test(`${name} fails the page, keeps its tokens, and is marked in the document`, async () => {
    const { results, markdown } = await runWithReply(200, reply);
    assert.ok(results[0].error);
    assert.equal(results[0].inputTokens, 500);
    assert.equal(results[0].outputTokens, 10);
    assert.match(markdown, /^\[OCR failed: /);
  });
}

test('a normal reply succeeds', async () => {
  const { results, markdown } = await runWithReply(200, textReply('# Page', 'STOP'));
  assert.equal(results[0].error, undefined);
  assert.equal(markdown, '# Page\n');
});

// Messages below are real Gemini 400 responses, captured 2026-11-04.
const http400 = (message: string) => ({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } });

for (const message of [
  'Request contains an invalid argument.', // what a corrupt PDF or oversized page returns
  'The input token count exceeds the maximum number of tokens allowed (1048576).',
]) {
  test(`a page-level 400 fails only that page: ${message}`, async () => {
    const { results } = await runWithReply(400, http400(message));
    assert.match(results[0].error ?? '', /HTTP 400/);
  });
}

for (const message of [
  'API key not valid. Please pass a valid API key.',
  'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.',
]) {
  test(`a job-wide 400 aborts the job: ${message}`, async () => {
    await assert.rejects(runWithReply(400, http400(message)), GeminiFatalError);
  });
}
