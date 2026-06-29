# PDF → Markdown (client-side Gemini OCR)

Convert PDFs to clean Markdown **entirely in your browser**, using your **own**
Google Gemini API key. There is no backend: your key and your documents never
touch any server except Google's.

- Splits each PDF page in the browser with [`pdf-lib`](https://pdf-lib.js.org/).
- OCRs pages in parallel with Gemini (configurable model, concurrency, page range).
- Merges everything into one Markdown document with a live preview, copy, and download.

The OCR pipeline lives in [`src/core/`](src/core) and is framework-agnostic — it
runs in the browser (the React app) and in Node (see `npm run smoke`), so it can
double as a reusable library.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Build the static site:

```bash
npm run build      # outputs to dist/
npm run preview    # serve the build locally
```

## Bring your own key

1. Create a key at **https://aistudio.google.com/apikey**. Create a *new* key —
   older unrestricted "standard" keys started being rejected on 2026‑06‑19.
2. Paste it into the app. It is held in memory by default, or in `sessionStorage`
   for the current tab if you tick "Remember in this browser tab".
3. For a public deployment, restrict the key by **HTTP referrer** in Google
   Cloud / AI Studio so it only works from your site's origin. (The deploy sends
   `Referrer-Policy: strict-origin-when-cross-origin`, so Google still receives
   your origin for the referrer check.)

Use the **Load** button next to the model field to list the models your key can
actually use, instead of guessing a model name.

> Free-tier Google AI Studio keys may have submitted content retained by Google
> per their data-use policy. Use a paid-tier key for sensitive documents.

The default model is `gemini-2.5-flash` (a current GA model) — intentionally a
stable default rather than the preview model the Python reference targets.
Thinking is disabled for the 2.5 Flash family since this is deterministic OCR.

## Privacy / no backend

- The app only ever calls `https://generativelanguage.googleapis.com`.
- [`public/_headers`](public/_headers) ships a `Content-Security-Policy` whose
  `connect-src` allows **only** that endpoint. The page therefore cannot send your
  key or documents anywhere else, even if a dependency tried to.

## Deploy to Cloudflare Pages

- **Build command:** `npm run build` · **Output directory:** `dist`
- Or from the CLI: `npm run build && npx wrangler pages deploy dist`
  (config is in [`wrangler.toml`](wrangler.toml)).
- `public/_headers` is applied automatically by Cloudflare Pages.
- `base: './'` in `vite.config.ts` keeps the build origin-agnostic (works on
  `*.pages.dev`, a custom domain, or a subpath).
- `.nvmrc` pins Node 22 for the Pages build image (Cloudflare reads `.nvmrc` /
  `.node-version`, not `package.json` `engines`).

## Project layout

```
src/core/     framework-agnostic OCR pipeline (browser + Node)
src/          React UI (Vite + React)
public/       static assets + _headers (CSP) + sample.pdf (served to the app)
reference/    the original Python CLI — run locally (see reference/README.md)
samples/      the same sample PDF, used by scripts/smoke.ts
scripts/      npm run smoke — exercises the core end-to-end
_local/       gitignored; your own PDFs and keys live here, never committed
```

## The core API

```ts
import { runOcrPipeline } from './src/core';

const { markdown, results } = await runOcrPipeline(pdfBytes, 'doc.pdf', {
  apiKey,                  // your Gemini key
  model: 'gemini-2.5-flash',
  concurrency: 4,
  startPage: 1,
  endPage: 10,
  onProgress: (r, done, total) => console.log(`${done}/${total}`),
  signal: abortController.signal,
});
```

Also exported: `splitPdf`, `getPageCount`, `ocrPage`, `listModels`,
`buildOutputMarkdown`, `stripOuterMarkdownFence`.

## Verify

```bash
npm run typecheck
npm run smoke      # splits the sample; runs a live Gemini call if _local/.env has a key
```

## License

[MIT](LICENSE).
