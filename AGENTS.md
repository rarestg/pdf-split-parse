# AGENTS.md

This is a static, client-side PDF-to-Markdown OCR app. See `README.md` for the data flow and Project Map. Read its Deploy section before changing hosting config, because some of that config lives only in the Cloudflare dashboard.

## Boundaries

- Keep the app static. It sends PDF pages and the key only to Google's Gemini API. The only other third party is Cloudflare Web Analytics. Cloudflare injects its beacon at the edge, and it reports to this site's own domain. Ask before adding a backend, proxy, or another external request.
- Egress is CSP-locked in two files — keep the policy in `index.html` and `public/_headers` in sync. Only `frame-ancestors` differs, because it works only as a header. Keep `https://static.cloudflareinsights.com` in `script-src`, or the CSP blocks the beacon and analytics stop.
- Put OCR behavior in `src/core/`; keep React state and presentation in `src/hooks/` and `src/components/`. `src/core/` must also run in Node, because `npm test` and `npm run smoke` import it there; `npm run build` fails if it uses browser-only globals.
- Every change to `main` goes through a PR, because pushing to `main` deploys to production through Cloudflare Workers Builds. Pull requests get preview URLs.
- Send the Gemini key in the `x-goog-api-key` header, never in a URL. A URL saves about 140 ms on the first Test click, which doesn't justify the risk of the key being logged.
- Only 429 and 503 responses retry automatically. Other failures go to the user for a manual redo, because automatic retries cost money and rarely help.
- To add a model, add its entry to `src/core/models.ts`, check its price on Google's pricing page, and run one real OCR call. Thinking settings vary by model: `gemini-3.8-flash` rejects `minimal`, and `gemini-3.5-flash-lite` rejects `thinkingBudget`.
- `reference/` holds the original Python CLI. Active development is in the TypeScript app, but `reference/` may be changed.
- Use `_local/` for scratch PDFs, local keys, and throwaway env files; it is gitignored.

## Verify

- Before pushing, run `npm run lint`, `npm test` and `npm run build`. CI runs the same checks plus a syntax check of `reference/pdf_processor.py`. `npm run build` includes the typecheck, and `npm run format` fixes most lint and formatting findings.
- Keep tests minimal. Add one only when it catches a failure that lint, types and the smoke test can't.
- CI has no Gemini key, so run `npm run smoke` with a key after changing how the app calls Gemini.
- `npm run smoke` fails only if a step throws, the key has no supported model, or live OCR returns an error; it does not check output quality. With no API key it skips the live Gemini call and still exits 0, so read its output before saying Gemini was tested. With a key it makes one billed OCR call.
- `npm run build` warns that `theme-init.js` can't be bundled. This is expected: the script must stay blocking and same-origin, because the CSP forbids inline scripts and `type="module"` would delay it past first paint.

## Todo

- Upgrade to React 19 in one hand-made PR. `react`, `react-dom`, `@types/react` and `@types/react-dom` must move together, because `npm ci` rejects mismatched versions. `.github/dependabot.yml` ignores their major versions until then; remove those entries in the same PR.
- Require a successful key Test before Convert, so people choose their model. Today a remembered key lets Convert run without a Test, and the job silently uses `DEFAULT_MODEL`.
- Run `/impeccable` on this project to review the design, and check whether some fonts are too small.
- Rework the "within estimate" cost badge, and add a better metrics overview: total cost, plus cost and total tokens per model.
