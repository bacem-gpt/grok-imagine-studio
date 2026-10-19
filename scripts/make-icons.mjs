// Renders the extension icons (PNG) from an inline SVG using headless Chromium.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(out, { recursive: true });
const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9b8aff"/><stop offset="1" stop-color="#3fb8e6"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#g)"/>
  <rect x="22" y="40" width="84" height="58" rx="10" fill="#0d0d14" opacity="0.92"/>
  <path d="M22 40 L30 22 Q32 18 36 19 L104 30 Q108 31 107 35 L106 40 Z" fill="#0d0d14" opacity="0.92"/>
  <path d="M44 24 L52 38 M66 27 L74 40 M88 30 L95 40" stroke="url(#g)" stroke-width="5" stroke-linecap="round"/>
  <path d="M56 56 L80 69 L56 82 Z" fill="#fff"/>
</svg>`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  await page.locator('svg').screenshot({ path: join(out, `icon${size}.png`), omitBackground: true });
}
await browser.close();
console.log('icons written to', out);
