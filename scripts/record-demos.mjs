// Records the website / store demo clips by driving the real extension (standalone studio tab) in Chromium.
// Media: the Grok-generated sample clips in brand/demo-clips/ (served through the test harness asset route).
//   node scripts/record-demos.mjs [scene…]      → brand/demo/raw/<scene>.webm
import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, renameSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeAssets, routeGrok, EXTENSION_DIR, FIXTURES } from '../tests/e2e/harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIPS = join(ROOT, 'brand', 'demo-clips');
const OUT = join(ROOT, 'brand', 'demo', 'raw');
const SIZE = { width: 1280, height: 800 };
mkdirSync(OUT, { recursive: true });
mkdirSync(join(FIXTURES, 'media'), { recursive: true });
for (const f of readdirSync(CLIPS)) copyFileSync(join(CLIPS, f), join(FIXTURES, 'media', `demo-${f}`));

const MEDIA = [
  { file: 'lighthouse.mp4', name: 'Lighthouse at golden hour', prompt: 'A lone lighthouse on a rocky cliff at golden hour, waves crashing, slow cinematic drone push-in' },
  { file: 'pier.mp4', name: 'Maya on the pier', prompt: 'A young woman with a scarf on a windy pier at dusk, speaking softly toward the camera, 35mm film look' },
  { file: 'box.mp4', name: 'Leo and the box of letters', prompt: 'Close-up of a weathered man holding an old wooden box of letters, lighthouse blurred behind him' },
  { file: 'letter.mp4', name: 'The first letter', prompt: 'Extreme close-up of hands unfolding an old handwritten letter by candlelight, slow motion' },
  { file: 'beam.mp4', name: 'Storm night', prompt: 'A lighthouse beam sweeping across a stormy sea at night, rain, dramatic clouds' },
];

const DIALOGUE = `MAYA: You came back. I didn't think you would.
LEO: I promised, didn't I? Even if it took me ten years.
MAYA: Ten years, and not a single letter.
LEO (quietly): I wrote every week. I just never had the courage to send them.
(She looks at the old box in his hands.)
MAYA: Then read me the first one. Right here, right now.
LEO: Dear Maya, the sea is loud tonight, and all I can hear is your laugh.`;

/** A visible cursor with click ripples (headless recordings have no pointer). */
const CURSOR = () => {
  if (document.getElementById('demo-cursor')) return;
  const st = document.createElement('style');
  st.textContent = `#demo-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);transition:transform .02s}
  #demo-cursor svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))}
  .demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #a99bff;z-index:2147483646;pointer-events:none;animation:demo-r .5s ease-out forwards}
  @keyframes demo-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}`;
  document.head.appendChild(st);
  const c = document.createElement('div');
  c.id = 'demo-cursor';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 9-7 1.5L8.5 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  addEventListener('mousemove', (e) => (c.style.left = `${e.clientX}px`, c.style.top = `${e.clientY}px`), true);
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div');
    r.className = 'demo-ripple';
    r.style.left = `${e.clientX}px`;
    r.style.top = `${e.clientY}px`;
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 600);
  }, true);
};

async function open(name) {
  const dir = mkdtempSync(join(tmpdir(), 'gis-demo-'));
  const vdir = mkdtempSync(join(tmpdir(), 'gis-demo-v-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: SIZE,
    deviceScaleFactor: 1,
    recordVideo: { dir: vdir, size: SIZE },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`, '--autoplay-policy=no-user-gesture-required'],
  });
  await routeAssets(context);
  await routeGrok(context);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const first = context.pages();
  const t = await context.newPage();
  for (const p of first) await p.close().catch(() => {});
  const t0 = Date.now(); // ≈ the start of the page's video
  let start = 0;
  await t.goto(`chrome-extension://${id}/studio/studio.html?mode=tab`);
  await t.locator('.app-header').waitFor();
  await t.evaluate(CURSOR);
  await t.mouse.move(640, 420);
  return {
    t,
    /** The demo proper starts here (the setup before it is trimmed off). */
    mark() {
      start = (Date.now() - t0) / 1000;
    },
    async finish() {
      const video = t.video();
      await t.close();
      await context.close();
      const src = await video.path();
      renameSync(src, join(OUT, `${name}.webm`));
      writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ start }));
      rmSync(dir, { recursive: true, force: true });
      rmSync(vdir, { recursive: true, force: true });
      console.log('recorded', name);
    },
  };
}

/** Imports the sample clips (names, prompts) and waits until they are ready. */
async function seed(t, files = MEDIA) {
  const ids = await t.evaluate(async (list) => {
    const out = [];
    for (const m of list) out.push(await window.__gis.media.importUrl(`https://assets.grok.com/test/demo-${m.file}`));
    return out;
  }, files);
  await t.waitForFunction((w) => w.every((id) => window.__gis.projectStore.get().media[id]?.status === 'ready'), ids, { timeout: 60000 });
  await t.evaluate(({ ids, list }) => {
    window.__gis.projectStore.update((p) => {
      let q = window.__gis.model.renameProject(p, 'The Lighthouse Letters');
      ids.forEach((id, i) => (q = window.__gis.model.updateMedia(q, id, { name: list[i].name, prompt: list[i].prompt, origin: 'grok' })));
      return q;
    }, { label: 'seed', history: false });
  }, { ids, list: files });
  await t.waitForTimeout(800);
  return ids;
}

const glide = async (t, locator, { dx = 0, dy = 0, steps = 18 } = {}) => {
  const b = await locator.boundingBox();
  await t.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps });
  return b;
};
const click = async (t, locator, opts) => {
  await glide(t, locator, opts);
  await t.waitForTimeout(180);
  await locator.click(opts?.button ? { button: opts.button } : undefined);
};
const tab = (t, name) => click(t, t.locator('.app-tabs .tab', { hasText: name }));

const SCENES = {
  // Collect & pick: the bin, hover-scrub, pick / reject, fast review with the keyboard.
  async collect() {
    const { t, finish, mark } = await open('collect');
    await seed(t);
    await t.waitForTimeout(1500);
    mark();
    const cards = t.locator('.bin-card');
    const b = await glide(t, cards.nth(0), { dx: -60 });
    for (let x = -60; x <= 60; x += 6) await t.mouse.move(b.x + b.width / 2 + x, b.y + 60, { steps: 2 });
    await click(t, cards.nth(1).locator('.bin-flag.is-pick'));
    await click(t, cards.nth(3).locator('.bin-flag.is-reject'));
    await click(t, cards.nth(4).locator('.bin-flag.is-pick'));
    await t.waitForTimeout(500);
    await click(t, t.locator('.bin-toolbar .btn', { hasText: 'Review' }));
    await t.waitForTimeout(1500);
    for (const k of ['p', 'ArrowRight', 'p', 'ArrowRight', 'x', 'ArrowRight']) {
      await t.keyboard.press(k);
      await t.waitForTimeout(900);
    }
    await t.keyboard.press('Escape');
    await t.waitForTimeout(1000);
    await finish();
  },

  // Edit: picks on the timeline, a dissolve, picture in picture, a title, play.
  async edit() {
    const { t, finish, mark } = await open('edit');
    const ids = await seed(t);
    await t.evaluate((ids) => {
      const M = window.__gis.model;
      window.__gis.projectStore.update((p) => {
        let q = M.appendMediaToTimeline(p, [ids[0], ids[1], ids[2]], { transition: { type: 'crossfade', duration: 0.8 } }).project;
        q = M.addOverlayClip(q, ids[3], { start: 7, mode: 'pip' }).project;
        q = M.addTextClip(q, { text: 'The Lighthouse Letters', start: 0.3, duration: 3, animation: 'fade' }).project;
        return q;
      }, { label: 'seed' });
    }, ids);
    await tab(t, 'Edit');
    await t.waitForTimeout(2500);
    mark();
    await click(t, t.locator('.tl-clip-video').nth(1));
    await t.waitForTimeout(900);
    await click(t, t.locator('.tl-trbadge').first());
    await t.waitForTimeout(700);
    await click(t, t.locator('.tl-pop .tl-tr-opt[data-transition="slide-left"]'));
    await t.keyboard.press('Escape');
    await t.waitForTimeout(400);
    await click(t, t.locator('button.mon-play'));
    await t.waitForTimeout(9500);
    await t.keyboard.press('Space');
    await t.waitForTimeout(800);
    await finish();
  },

  // Dialogue: paste → parts that fit 15 s clips → one shot per part → videos recognised by part.
  async dialogue() {
    const { t, finish, mark } = await open('dialogue');
    const ids = await seed(t, MEDIA.slice(1, 4));
    await t.evaluate(() => window.__gis.uiStore.set((s) => ({ ...s, tab: 'dialogue' })));
    await t.waitForTimeout(1200);
    mark();
    const ta = t.locator('[data-testid="dlg-start-text"]');
    await click(t, ta);
    await t.keyboard.type(DIALOGUE.slice(0, 120), { delay: 18 });
    await ta.fill(DIALOGUE);
    await t.waitForTimeout(700);
    await click(t, t.locator('[data-testid="dlg-start-split"]'));
    await t.waitForTimeout(1500);
    await click(t, t.locator('[data-testid="dlg-scene"]'));
    await t.keyboard.type('A windy pier at dusk, cinematic, 35mm', { delay: 22 });
    await t.locator('[data-testid="dlg-scene"]').blur();
    await click(t, t.locator('.dlg-setup .pr-chip', { hasText: 'no music' }));
    await t.waitForTimeout(500);
    await click(t, t.locator('[data-testid="dlg-create-shots"]'));
    await t.waitForTimeout(1200);
    // The generated videos come back linked to their parts.
    await t.evaluate(async (ids) => {
      const S = await import('/studio/prompts/shots.js');
      const d = window.__gis.projectStore.get().dialogue;
      window.__gis.projectStore.update((p) => {
        let q = p;
        d.parts.forEach((part, i) => ids[i] && (q = S.linkTake(q, part.shotId, ids[i])));
        return q;
      }, { label: 'takes' });
    }, ids);
    await t.waitForTimeout(1500);
    await click(t, t.locator('[data-testid="dlg-part"]').first().locator('.pr-link-btn', { hasText: 'Prompt' }));
    await t.waitForTimeout(1800);
    await click(t, t.locator('[data-testid="dlg-assemble"]'));
    await t.waitForTimeout(1500);
    await finish();
  },

  // Quick phrases: one click in, one click out.
  async phrases() {
    const { t, finish, mark } = await open('phrases');
    await t.evaluate(async () => {
      const P = await import('/studio/prompts/phrases.js');
      const S = await import('/studio/prompts/shots.js');
      window.__gis.libraryStore.set((s) => ({ ...s, phrases: P.addPhrases([], P.STARTER_PHRASES), phraseSets: [P.createPhraseSet({ name: 'Talking scene', texts: ['the character speaks directly to the camera', 'static camera'] })] }));
      window.__gis.projectStore.update((p) => S.addShots(window.__gis.model.renameProject(p, 'The Lighthouse Letters'), [
        { title: 'Arrival', prompt: 'A man in a wool coat walks up the lighthouse stairs at dusk, holding an old wooden box' },
        { title: 'Reunion', prompt: 'Maya turns around on the windy pier and sees him' },
      ]).project, { label: 'seed' });
    });
    await t.evaluate(() => window.__gis.uiStore.set((s) => ({ ...s, tab: 'prompts' })));
    await t.waitForTimeout(1500);
    mark();
    for (const ph of ['nobody speaks', 'camera angle from top', 'slow push-in', 'no text on screen']) {
      await click(t, t.locator(`.pr-phrase[data-phrase="${ph}"]`));
      await t.waitForTimeout(650);
    }
    await click(t, t.locator('.pr-phrase[data-phrase="camera angle from top"]'));
    await t.waitForTimeout(700);
    await click(t, t.locator('.pr-set-chip', { hasText: 'Talking scene' }));
    await t.waitForTimeout(1500);
    await finish();
  },

  // Export: one click to MP4, rendered in the browser.
  async export() {
    const { t, finish, mark } = await open('export');
    const ids = await seed(t, MEDIA.slice(0, 2));
    await t.evaluate((ids) => window.__gis.projectStore.update((p) => window.__gis.model.appendMediaToTimeline(p, ids, { transition: { type: 'fade-black', duration: 0.8 } }).project, { label: 'seed' }), ids);
    await t.evaluate(() => window.__gis.uiStore.set((s) => ({ ...s, tab: 'edit' })));
    await t.waitForTimeout(2500);
    mark();
    await click(t, t.locator('.export-btn'));
    await t.waitForTimeout(1200);
    await click(t, t.locator('.modal .btn-primary').last());
    await t.waitForSelector('.modal :text("Done"), .modal :text("Download"), .ex-done', { timeout: 120000 }).catch(() => {});
    await t.waitForTimeout(2500);
    await finish();
  },
};

const wanted = process.argv.slice(2);
for (const [name, run] of Object.entries(SCENES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  try {
    await run();
  } catch (e) {
    console.error('scene failed', name, e.message);
  }
}
if (!existsSync(OUT)) process.exit(1);
