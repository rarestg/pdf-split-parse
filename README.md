# PDF → Markdown

Super-parallel, fully client-side PDF-to-Markdown OCR powered by your own Google Gemini API key: no backend, with documents and key sent only from your browser directly to Google.

Vite + React wraps a framework-agnostic OCR core that merges the per-page results into a single Markdown document.

## Features

- **Super-parallel OCR.** Bounded worker pool, default 4 pages at once, configurable up to 64.
- **BYO key model picker.** **Test** validates the key, lists usable Gemini models, and shows them in a cost-sorted table.
- **Cost tracking.** Up-front estimate, measured actual cost from API token counts, per-model retry breakdown, and localStorage lifetime aggregate tally.
- **No blind retries.** Only 429 rate limits and 503 overloads auto-retry, with back-off and server `RetryInfo`; timeouts, truncation, and other errors surface fast.
- **Targeted Re-OCR.** Failed and suspect pages can be rerun by page spec (`14, 15, 19-22`) on another model/detail, then merged back by page number.
- **Useful output controls.** Page range, image detail, timeout, editable prompt, friendly PDF errors, live progress, Markdown preview/source, copy, and download.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

Scripts:

```bash
npm run build      # tsc --noEmit && vite build -> dist/
npm run preview
npm run typecheck
npm run smoke      # core checks; live Gemini call if _local/.env has GEMINI_API_KEY
```

Requires Node 20+ from `package.json`. Cloudflare Pages builds are pinned to Node 22 via `.nvmrc`.

## Bring Your Own Key

Create a Gemini API key at <https://aistudio.google.com/apikey>, paste it into the app, then click **Test**. The key stays in memory unless **Remember in this browser tab** is checked, which stores it in `sessionStorage` for that tab.

For public deploys, restrict the key by HTTP referrer. Free-tier keys may have submitted content retained by Google; use a paid-tier key for sensitive documents.

## How It Works

Two layers:

1. `src/core/` is framework-agnostic OCR logic that runs in browser and Node.
2. `src/` is the React UI for controls, progress, retries, costs, and result viewing.

Data flow:

```text
PDF bytes
  -> load once with pdf-lib
  -> selected page numbers
  -> bounded worker pool
  -> serialized lazy page extraction into one-page PDFs
  -> base64 PDF page + prompt to Gemini generateContent
  -> PageResult[]
  -> Markdown in page order
```

The parsed `PDFDocument` is reused across the initial run and manual retries. Extraction is serialized so `pdf-lib` is not run concurrently on the shared document; Gemini requests are the parallel part, with only about `concurrency` single-page PDFs resident at once.

`src/core/gemini.ts` keeps OCR deterministic: temperature 0, explicit `maxOutputTokens`, and minimal thinking config per supported model family. `src/core/anomaly.ts` flags long repeated-character runs as suspect output.

`useOcrJob` is the UI state machine: run/retry/cancel/reset, merged results, cumulative per-model token ledger, live in-flight/back-off stats, and retry merge-by-page. Core-to-UI communication is `onProgress` per completed page and `onStats` for live activity counts.

## Project Map

- `src/core/types.ts` - shared types and defaults.
- `src/core/splitPdf.ts` - PDF load/extract, page ranges/specs, PDF error messages.
- `src/core/gemini.ts` - Gemini REST, OCR retry classification, model listing, key test, generation config.
- `src/core/pipeline.ts` - `runOcrPipeline`, bounded workers, lazy extraction callbacks.
- `src/core/markdown.ts` - page results to final Markdown, errors, warnings, retry notes.
- `src/core/cost.ts` - pricing table, estimates, actual costs, formatting.
- `src/core/anomaly.ts` - suspect repeated-character detection.
- `src/core/debug.ts` - opt-in console logging.
- `src/core/index.ts` - public core exports.
- `src/App.tsx` - top-level layout and state wiring.
- `src/components/*` - API key, file drop, controls, model table, progress, retry, cost, result UI.
- `src/hooks/useOcrJob.ts` - job state machine, parsed-PDF reuse, cost ledger, merge logic.
- `src/hooks/useLifetimeStats.ts` - localStorage aggregate spend/page/PDF tally.
- `index.html` - CSP `<meta>` egress lock to self + Google's endpoint.
- `public/_headers` - Cloudflare headers, including `frame-ancestors`.
- `vite.config.ts` - Vite config with `base: './'`.
- `.nvmrc` - Node 22 for Cloudflare Pages.
- `wrangler.toml` - Cloudflare Pages output config.
- `scripts/smoke.ts` - Node smoke test for the core.
- `reference/` - original Python CLI porting reference.
- `_local/` - gitignored scratch for PDFs, keys, and `.env`.

## Core Usage

```ts
import { runOcrPipeline, DEFAULT_PROMPT } from './src/core';

const result = await runOcrPipeline(pdfBytes, 'document.pdf', {
  apiKey: geminiApiKey,
  model: 'gemini-2.5-flash',
  prompt: DEFAULT_PROMPT,
  mediaResolution: 'medium',
  concurrency: 4,
  timeoutMs: 30_000,
  startPage: 1,
  endPage: 10,
});

console.log(result.markdown);
```

The core uses browser/Node globals such as `fetch`, `btoa`, `AbortController`, and `performance`.

## Privacy And No Backend

The built app is static: no app server, upload endpoint, database, or proxy. A CSP egress lock holds browser connections to `'self'` and `https://generativelanguage.googleapis.com`, so PDF pages and the API key can only reach Google; it ships in the `index.html` `<meta>` and again in `public/_headers` (which also adds `frame-ancestors 'none'`).

Persisted data is limited to optional tab-scoped key storage in `sessionStorage` and the localStorage lifetime aggregate tally. The tally stores no key, filename, or document content.

## Deploy

```bash
npm run build
npx wrangler pages deploy dist
```

Cloudflare Pages settings: build command `npm run build`, output directory `dist`. `public/_headers` is applied automatically; `base: './'` keeps the build origin-agnostic.

## Develop And Verify

- Put OCR behavior in `src/core/`; keep React state and presentation in `src/hooks/` and `src/components/`.
- Use `_local/` for scratch PDFs, local keys, and throwaway env files; it is gitignored.
- Enable request lifecycle logs with `localStorage.setItem('pdf-debug', '1')`, then reload. Disable with `localStorage.removeItem('pdf-debug')`.
- Verify changes with `npm run typecheck` and `npm run smoke`; run `npm run build` before deploying or after Vite/CSP changes.
- Egress is CSP-locked in two files — keep `connect-src` in `index.html` and `public/_headers` in sync.

## License

MIT. See `LICENSE`.
