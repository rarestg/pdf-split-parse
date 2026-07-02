// Rasterizes the SEO/share assets into public/ (committed, so the site build
// needs none of this): og.png from scripts/og/og.svg, favicon-96.png from
// public/favicon.svg (the live favicon is the single source of the mark), and
// apple-touch-icon.png from its full-bleed variant. Run: npm run assets:og
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const jobs = [
  { svg: 'scripts/og/og.svg', out: 'public/og.png', width: 1200 },
  { svg: 'public/favicon.svg', out: 'public/favicon-96.png', width: 96 },
  { svg: 'scripts/og/apple-touch-icon.svg', out: 'public/apple-touch-icon.png', width: 180 },
];

for (const { svg, out, width } of jobs) {
  const png = new Resvg(readFileSync(join(root, svg), 'utf8'), {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng();
  writeFileSync(join(root, out), png);
  console.log(`${out}: ${(png.length / 1024).toFixed(1)} KB`);
}
