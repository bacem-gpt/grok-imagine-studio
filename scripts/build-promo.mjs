// Builds the promo media from the recorded scenes (scripts/record-demos.mjs):
//   brand/demo/<scene>.mp4 / .webm / .jpg   trimmed feature loops + posters (website)
//   brand/demo/promo.mp4                    ~70 s promo: intro card, captioned scenes, outro (1280×800)
//   brand/demo/promo-1080p.mp4              the same on a 1920×1080 canvas (YouTube / X / LinkedIn)
//   brand/demo/teaser.gif                   short GIF for the README
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'brand', 'demo', 'raw');
const OUT = join(ROOT, 'brand', 'demo');
const CARDS = join(OUT, 'cards');
mkdirSync(CARDS, { recursive: true });
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

const SCENES = [
  { id: 'collect', kicker: '01 · Collect & pick', title: 'Every Grok video, one bin', sub: 'Hover to scrub · pick, reject, rate · fast keyboard review', len: 12 },
  { id: 'edit', kicker: '02 · Edit', title: 'A real timeline, right inside Grok', sub: 'Trim · transitions · picture in picture · titles · music', len: 14 },
  { id: 'dialogue', kicker: '03 · Long dialogues', title: 'One part per 15-second video', sub: 'Paste a dialogue · auto-split · each video knows its lines', len: 15 },
  { id: 'phrases', kicker: '04 · Prompts', title: 'Your phrases, one click away', sub: '“nobody speaks” · “camera angle from top” · phrase sets', len: 7.5 },
  { id: 'export', kicker: '05 · Export', title: 'MP4 in seconds, in your browser', sub: 'No upload · no account · no watermark', len: 10 },
];

const logo = readFileSync(join(ROOT, 'brand', 'logo-512.png')).toString('base64');
const hero = readFileSync(join(ROOT, 'brand', 'hero.jpg')).toString('base64');
const card = (inner) => `<html><head><style>
  body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:Inter,'Segoe UI',system-ui,sans-serif;color:#f3f3f7;
    background:#0b0d1a url(data:image/jpeg;base64,${hero}) center/cover;display:flex;align-items:center}
  .w{padding:0 110px;max-width:900px}
  .k{color:#a99bff;font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:20px;margin-bottom:18px}
  h1{font-size:68px;line-height:1.05;margin:0 0 22px;font-weight:800;letter-spacing:-.02em}
  p{font-size:27px;color:#c3c3d2;margin:0;line-height:1.4}
  .grad{background:linear-gradient(90deg,#a99bff,#4cc9f0);-webkit-background-clip:text;color:transparent}
  .logo{display:flex;align-items:center;gap:22px;margin-bottom:36px}
  .logo img{width:96px;height:96px}
  .logo b{font-size:34px;font-weight:800}
  .pill{display:inline-block;margin-top:34px;padding:14px 26px;border-radius:999px;background:linear-gradient(90deg,#8f7dff,#4cc9f0);color:#0b0d1a;font-weight:800;font-size:24px}
  .fine{margin-top:22px;font-size:17px;color:#8a8aa0}
</style></head><body><div class="w">${inner}</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const shot = async (name, html) => {
  await page.setContent(html);
  await page.screenshot({ path: join(CARDS, `${name}.png`) });
};
await shot('intro', card(`<div class="logo"><img src="data:image/png;base64,${logo}"><b>Imagine Studio <span class="grad">for Grok</span></b></div>
  <h1>Stop downloading.<br><span class="grad">Edit your Grok videos in place.</span></h1>
  <p>Pick the best takes, cut them together, add sound and transitions — without leaving grok.com.</p>`));
for (const s of SCENES) await shot(s.id, card(`<div class="k">${s.kicker}</div><h1>${s.title}</h1><p>${s.sub}</p>`));
await shot('outro', card(`<div class="logo"><img src="data:image/png;base64,${logo}"><b>Imagine Studio <span class="grad">for Grok</span></b></div>
  <h1>Free. Open source.<br><span class="grad">100% in your browser.</span></h1>
  <div class="pill">bacem-gpt.github.io/grok-imagine-studio</div>
  <div class="fine">Independent project — not affiliated with xAI. Demo footage generated with Grok Imagine.</div>`));
await browser.close();

const ENC = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-r', '30'];
// 1. Feature loops + posters.
for (const s of SCENES) {
  const raw = join(RAW, `${s.id}.webm`);
  if (!existsSync(raw)) throw new Error(`missing ${raw} — run scripts/record-demos.mjs first`);
  const { start } = JSON.parse(readFileSync(join(RAW, `${s.id}.json`), 'utf8'));
  ff('-ss', String(start), '-i', raw, '-t', String(s.len), '-an', '-vf', 'scale=1280:800', ...ENC, '-crf', '24', '-movflags', '+faststart', join(OUT, `${s.id}.mp4`));
  ff('-i', join(OUT, `${s.id}.mp4`), '-an', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', join(OUT, `${s.id}.webm`));
  ff('-ss', String(Math.min(s.len - 1, s.len * 0.6)), '-i', join(OUT, `${s.id}.mp4`), '-frames:v', '1', '-q:v', '3', join(OUT, `${s.id}.jpg`));
}
// 2. Promo: intro, (caption card + scene) × 5, outro, with short cross-fades.
const parts = [['intro', 3.2]];
for (const s of SCENES) parts.push([`card:${s.id}`, 2.2], [s.id, s.len]);
parts.push(['outro', 4.5]);
const inputs = [];
for (const [name, len] of parts) {
  if (name === 'intro' || name === 'outro' || name.startsWith('card:')) inputs.push('-loop', '1', '-t', String(len), '-i', join(CARDS, `${name.replace('card:', '')}.png`));
  else inputs.push('-i', join(OUT, `${name}.mp4`));
}
const X = 0.45; // cross-fade
let chain = parts.map((_, i) => `[${i}:v]scale=1280:800,setsar=1,fps=30,format=yuv420p[v${i}]`).join(';');
let prev = 'v0';
let offset = parts[0][1] - X;
for (let i = 1; i < parts.length; i++) {
  const out = i === parts.length - 1 ? 'vout' : `x${i}`;
  chain += `;[${prev}][v${i}]xfade=transition=fade:duration=${X}:offset=${offset.toFixed(3)}[${out}]`;
  prev = out;
  offset += parts[i][1] - X;
}
ff(...inputs, '-filter_complex', chain, '-map', '[vout]', ...ENC, '-crf', '22', '-movflags', '+faststart', join(OUT, 'promo.mp4'));
ff('-i', join(OUT, 'promo.mp4'), '-vf', 'scale=1728:1080,pad=1920:1080:96:0:color=0x0b0d1a', ...ENC, '-crf', '22', '-movflags', '+faststart', join(OUT, 'promo-1080p.mp4'));
ff('-i', join(OUT, 'promo.mp4'), '-frames:v', '1', '-q:v', '3', join(OUT, 'promo.jpg'));
// 3. README GIF: the dialogue scene, small.
ff('-ss', '1', '-t', '9', '-i', join(OUT, 'dialogue.mp4'), '-vf', 'fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', join(OUT, 'teaser.gif'));
console.log('promo built');
