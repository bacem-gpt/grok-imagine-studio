// Full user journeys, driven like a demanding first-time user in the real extension on the mock grok.com pages:
//   1 collect      feed detected with prompts, "+ Bin" on hover, context menu, auto-add (new generations only), add all
//   2 triage       review mode: pick / reject / rate, IN/OUT + Enter puts that range on the timeline, picked-only filter
//   3 edit         reorder, drag-trim, split, dissolve + wipe, music from a URL and a file, fit, title, look, preview, undo
//   4 export       MP4 (H.264 + AAC) and WebM (VP9 + Opus) downloads checked with ffprobe / ffmpeg
//   5 prompts      paste a shot list, bible character, send to Grok, the generation becomes a take, assemble in shot order
//   6 ingredients  grok.com image, crop 16:9, attach to Grok's composer, use as a shot reference
//   7 persistence  reload the grok.com tab (project, bin, timeline, settings), standalone studio tab talks to grok.com
// Everything goes through the UI (clicks, keys, drags, file choosers, Grok's own composer); window.__gis is only read to
// check what the UI did. The "regression" tests at the end each reproduce a bug found on these journeys (now fixed).
import { test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { launch, openGrok, studioFrame, openStudioTab, setDockMode, getProject, seedMedia, fixture, expect } from './harness.mjs';
import { POSTS, mediaPostList, thumbUrl } from './fixtures-map.mjs';
import { GENERATED_POST } from './content-mock-api.mjs';

const ID = Object.keys(POSTS);
const [RED, GREEN, BLUE, HD, IMAGE] = ID;
const WITHOUT_GENERATED = () => mediaPostList(ID.filter((id) => id !== GENERATED_POST)); // the mock generation is new
const MUSIC_URL = 'https://assets.grok.com/test/music.mp3';
const POLL = { polling: 200, timeout: 30000 };
const TAB_TITLE = { clips: 'Collect', edit: 'Timeline editor', prompts: 'Shot list', ingredients: 'Reference images' };

const appErrors = (ctx) => ctx.consoleErrors.filter((e) => !/favicon|Failed to load resource|net::ERR/i.test(e));
function watchPageErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** launch() with a default action timeout, so a stuck step fails with its own message instead of the test timeout. */
async function start(opts) {
  const ctx = await launch(opts);
  ctx.context.setDefaultTimeout(45000);
  return ctx;
}

/** Opens the studio on grok.com with the launcher (like a user) and waits until it is connected to the page. */
async function openPanel(page) {
  const launcher = page.locator('gis-studio-root .launcher');
  await expect(launcher).toBeVisible({ timeout: 15000 });
  await launcher.click();
  await expect(page.locator('gis-studio-root .panel')).toBeVisible();
  const frame = await studioFrame(page, 30000);
  await frame.locator('.app-header').waitFor({ timeout: 30000 });
  await frame.waitForFunction(() => window.__gis?.bridge?.connected && !!window.__gis.projectStore.get()?.id, null, POLL);
  return frame;
}

/** Header tabs are icon-only when the panel is narrow: find them by their tooltip. */
async function showTab(target, name) {
  await target.locator(`.app-tabs .tab[title^="${TAB_TITLE[name]}"]`).click();
  await expect(target.locator(`.view-${name}`)).toBeVisible();
}

const mediaOf = (target, id) => target.evaluate((mid) => window.__gis.projectStore.get().media[mid] || null, id);
const binItem = (target, key) => target.evaluate((k) => Object.values(window.__gis.projectStore.get().media).find((m) => m.pageKey === k) || null, key);
async function binItemReady(target, key) {
  await target.waitForFunction((k) => Object.values(window.__gis.projectStore.get().media).some((m) => m.pageKey === k && m.status === 'ready'), key, POLL);
  return binItem(target, key);
}
async function waitAllReady(target, count) {
  await target.waitForFunction(
    (n) => {
      const p = window.__gis.projectStore.get();
      return p.mediaOrder.length === n && p.mediaOrder.every((id) => p.media[id].status === 'ready');
    },
    count,
    { polling: 200, timeout: 60000 },
  );
}
const mediaByPost = (target) => target.evaluate(() => Object.fromEntries(Object.values(window.__gis.projectStore.get().media).map((m) => [m.postId, m.id])));
const binCard = (target, id) => target.locator(`.bin-card[data-media-id="${id}"]`);
const cardIds = (target) => target.$$eval('.bin-grid .bin-card', (els) => els.map((e) => e.dataset.mediaId));
const uiState = (target) => target.evaluate(() => window.__gis.uiStore.get());

/** "Add all videos" in the "On grok.com" strip, then wait until the bin holds `total` ready items. */
async function addAllVideos(frame, total) {
  await frame.waitForFunction(() => window.__gis.pageStore.get().items.length > 0, null, POLL);
  const btn = frame.locator('.clips-page-head .btn', { hasText: /videos/ });
  await expect(btn).toBeEnabled({ timeout: 20000 });
  await btn.click();
  await waitAllReady(frame, total);
}

/** Appends bin items to the timeline one by one with the "+" that appears on a hovered bin card. */
async function addCardsToTimeline(frame, ids) {
  for (const [i, id] of ids.entries()) {
    const card = binCard(frame, id);
    await card.hover();
    await card.locator('[title="Add to timeline (E)"]').click();
    await frame.waitForFunction((n) => window.__gis.projectStore.get().tracks.video.length === n, i + 1, POLL);
  }
}

async function hoverMedia(page, locator) {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await expect(page.locator('gis-studio-root .hb.show')).toBeVisible();
}

/** What background.js sends to the page when the user picks one of the extension's context-menu items. */
const contextMenu = (ctx, msg) =>
  ctx.sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ url: 'https://grok.com/*' });
    return chrome.tabs.sendMessage(tab.id, { gis: 'context', pageUrl: tab.url, selectionText: null, ...m });
  }, msg);

// --------------------------------------------------------------------------------------------- timeline helpers

const layoutOf = (target) =>
  target.evaluate(() => {
    const p = window.__gis.projectStore.get();
    return window.__gis.model.layoutVideo(p.tracks.video).map((it) => ({
      id: it.clip.id,
      mediaId: it.clip.mediaId,
      post: p.media[it.clip.mediaId]?.postId || null,
      in: it.clip.in,
      out: it.clip.out,
      start: it.start,
      end: it.end,
      transition: it.clip.transition?.type || null,
    }));
  });

async function drag(page, from, to, steps = 16) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.mouse.up();
}
const center = async (locator) => {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** Click on the timeline ruler at time t (seeks the playhead). */
async function clickRulerAt(frame, page, t) {
  const ruler = await frame.locator('.tl-ruler').boundingBox();
  const { zoom } = await uiState(frame);
  const scrollLeft = await frame.evaluate(() => document.querySelector('.tl-scroll').scrollLeft);
  await page.mouse.click(ruler.x + t * zoom - scrollLeft, ruler.y + ruler.height / 2);
}
/** RGB of the program monitor at fractional coordinates. */
const monitorPixel = (frame, fx, fy) =>
  frame.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.mon-canvas');
      const d = c.getContext('2d').getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [fx, fy],
  );
/** Share of (sampled) monitor pixels that are not black. */
const litShare = (frame) =>
  frame.evaluate(() => {
    const c = document.querySelector('.mon-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      n++;
      if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    }
    return lit / n;
  });
const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80;
const isGreen = ([r, g, b]) => g > 90 && r < 80 && b < 80;
const isBlue = ([r, g, b]) => b > 180 && r < 80 && g < 80;
const isGray = ([r, g, b]) => r > 25 && Math.abs(r - g) < 14 && Math.abs(g - b) < 14;

/** Adds a sound from a link through Edit → Audio → "From a link (URL)…" (typed into the dialog like a paste). */
/** Studio shortcut keys, dispatched inside the studio frame (page-level key presses can reach grok.com's composer instead). */
const frameKey = (frame, key) =>
  frame.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k === 'Space' ? ' ' : k, bubbles: true, cancelable: true })), key);

async function addAudioFromLink(frame, page, url) {
  await frame.locator('.tl-toolbar .btn', { hasText: 'Audio' }).click();
  await frame.locator('.menu .menu-item', { hasText: 'From a link (URL)' }).click();
  const dlg = frame.locator('.modal', { hasText: 'Add audio from a link' });
  const input = dlg.locator('input');
  await expect(input).toBeVisible();
  await input.fill(url); // into the frame's field: page-level keys can land in grok.com's composer under load
  await expect(input).toHaveValue(url);
  await dlg.locator('button[type="submit"]').click();
  await expect(frame.locator('.toast', { hasText: 'Audio added to the timeline' })).toBeVisible({ timeout: 30000 });
}

// --------------------------------------------------------------------------------------------- export helpers

async function saveDownload(page, button, name) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), button.click()]);
  const path = test.info().outputPath(name);
  await download.saveAs(path);
  return path;
}
const ffprobe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]).toString());
const rgbFrame = (file, t) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
function regionAvg(buf, w, [x0, y0, x1, y1]) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3;
      sum[0] += buf[i];
      sum[1] += buf[i + 1];
      sum[2] += buf[i + 2];
      n++;
    }
  }
  return sum.map((v) => Math.round(v / n));
}
const meanVolume = (file) => Number(/mean_volume: (-?[\d.]+) dB/.exec(spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString())?.[1]);

// ================================================================================================= journeys

test('journey 1 · collect: feed detected with prompts, "+ Bin" on hover, context menu, auto-add takes only a new generation, add all videos', async () => {
  test.setTimeout(240_000);
  const ctx = await start({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    const page = ctx.page;
    const pageErrors = watchPageErrors(page);
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(7); // 5 API posts + a DOM-only clip + a moderated image
    await expect(page.locator('gis-studio-root .badge')).toHaveText('5'); // videos that are not in the bin yet
    const frame = await openPanel(page);

    // The studio lists what Grok shows, with the prompts.
    const strip = frame.locator('.clips-page');
    await expect(strip.locator('.clips-page-conn')).toHaveText('Imagine feed');
    await expect(strip.locator('.clips-pcard')).toHaveCount(6);
    for (const id of [RED, GREEN, BLUE, HD]) await expect(strip.locator(`.clips-pcard[data-key="video:${id}"] .clips-pcard-prompt`)).toHaveText(POSTS[id].prompt);
    await expect(strip.locator(`.clips-pcard[data-key="image:${IMAGE}"] .clips-pcard-prompt`)).toHaveText(POSTS[IMAGE].prompt);
    await expect(strip.locator('.clips-pcard[data-key="url:https://assets.grok.com/test/clip-cyan.webm"] .clips-pcard-prompt')).toHaveText('Cyan light waves rolling over a glass floor, loop');
    await expect(frame.locator('.bin-panel')).toContainText('Your bin is empty');

    // 1. Hover a video on grok.com and click "+ Bin".
    await hoverMedia(page, page.locator(`[data-post-id="${RED}"] video`));
    expect(await page.locator('gis-studio-root .hb.show button').allInnerTexts()).toEqual(['Bin', 'Pick', 'Timeline']);
    await page.locator('gis-studio-root .hb.show button[data-act="bin"]').click();
    const red = await binItemReady(frame, `video:${RED}`);
    expect(red).toMatchObject({ kind: 'video', origin: 'grok', postId: RED, prompt: POSTS[RED].prompt, duration: 4, width: 640, height: 360 });
    await expect(binCard(frame, red.id).locator('.clips-thumb-img')).toBeVisible();
    await expect(binCard(frame, red.id)).toContainText('A red sports car');
    await expect(strip.locator(`.clips-pcard[data-key="video:${RED}"]`)).toHaveClass(/is-inbin/);
    await expect(page.locator(`[data-post-id="${RED}"] video[data-gis-in-bin]`)).toHaveCount(1);

    // 2. Right-click a clip's poster → "Add to Imagine Studio bin" (Chrome hands the click to background.js, which
    //    relays it to the page exactly like this).
    expect(await contextMenu(ctx, { action: 'gis-add-media', srcUrl: thumbUrl(GREEN), mediaType: 'image' })).toEqual({ ok: true });
    const green = await binItemReady(frame, `video:${GREEN}`);
    expect(green).toMatchObject({ postId: GREEN, prompt: POSTS[GREEN].prompt, duration: 3 });
    await expect(frame.locator('.bin-card')).toHaveCount(2);

    // 3. Auto-add (the strip's "More" menu at this panel width) leaves the clips already in the feed alone...
    await frame.locator('.clips-page-head [title^="More"]').click();
    await frame.locator('.menu .menu-item', { hasText: 'Auto-add new videos' }).click();
    await expect(frame.locator('.toast', { hasText: 'added to the bin automatically' })).toBeVisible();
    await page.waitForTimeout(2500);
    expect((await getProject(frame)).mediaOrder).toHaveLength(2);
    // ...and takes the clip Grok generates next (typed and submitted in Grok's own prompt box).
    await page.locator('.query-bar [contenteditable="true"]').click({ position: { x: 40, y: 12 } });
    await page.keyboard.type('A glass whale gliding over a desert');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__mock.submitted)).toEqual(['A glass whale gliding over a desert']);
    const gen = await binItemReady(frame, `video:${GENERATED_POST}`);
    expect(gen.prompt).toBe('A glass whale gliding over a desert');
    let p = await getProject(frame);
    expect(Object.values(p.media).map((m) => m.postId).sort()).toEqual([RED, GREEN, GENERATED_POST].sort());

    // 4. "Add all videos" takes the remaining three (blue, nebula and the DOM-only cyan clip) in one click.
    const addAll = frame.locator('.clips-page-head .btn', { hasText: /videos/ });
    await expect(addAll).toHaveText(/\(3\)/);
    await addAll.click();
    await expect(frame.locator('.toast', { hasText: 'Adding 3 items to the bin' })).toBeVisible();
    await waitAllReady(frame, 6);
    await expect(addAll).toBeDisabled();
    await expect(frame.locator('.bin-card')).toHaveCount(6);
    await expect(frame.locator('.bin-card .clips-thumb.is-loading')).toHaveCount(0);
    await expect(frame.locator('.bin-card .clips-thumb.is-error')).toHaveCount(0);
    await expect(strip.locator('.clips-pcard.is-inbin')).toHaveCount(6); // every video; the poster image stays on the page
    p = await getProject(frame);
    expect(p.media[p.mediaOrder.find((id) => p.media[id].pageKey.startsWith('url:'))].prompt).toBe('Cyan light waves rolling over a glass floor, loop');
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => window.__mock.errors)).toEqual([]);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('journey 2 · triage: review mode picks 3, rejects 1, rates, IN/OUT + Enter puts that range on the timeline, picked-only filter', async () => {
  test.setTimeout(240_000);
  const ctx = await start();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await openPanel(page);
    await addAllVideos(frame, 6);
    const order = await cardIds(frame); // the order Review walks through
    const p0 = await getProject(frame);

    await frame.locator('.bin-toolbar button', { hasText: 'Review' }).click();
    const review = frame.locator('.clips-review');
    await expect(review).toBeVisible();
    const count = review.locator('.clips-review-count');
    const stamp = review.locator('.clips-review-stamp');
    await expect(count).toHaveText('1 / 6');
    await expect(review.locator('.clips-review-prompt-text')).toHaveText(p0.media[order[0]].prompt);

    // #1: pick it, 4 stars.
    await frameKey(frame, 'p');
    await expect(stamp).toContainText('Picked');
    await frameKey(frame, '4');
    await expect.poll(async () => (await mediaOf(frame, order[0])).rating).toBe(4);
    expect((await mediaOf(frame, order[0])).flag).toBe('pick');
    await frameKey(frame, 'ArrowRight');
    await expect(count).toHaveText('2 / 6');

    // #2: reject.
    await frameKey(frame, 'x');
    await expect(stamp).toContainText('Rejected');
    expect((await mediaOf(frame, order[1])).flag).toBe('reject');
    await frameKey(frame, 'ArrowRight');
    await expect(count).toHaveText('3 / 6');

    // #3: pick, then IN at 1 s and OUT at 3 s (click the scrub bar, press I / O); Enter adds that range and moves on.
    await frameKey(frame, 'p');
    const d3 = p0.media[order[2]].duration;
    await frame.waitForFunction(() => document.querySelector('.clips-review .src-video')?.readyState >= 2, null, POLL);
    await frameKey(frame, 'Space'); // pause the autoplay
    await frame.waitForFunction(() => document.querySelector('.clips-review .src-video').paused, null, POLL);
    const bar = await review.locator('.src-scrub').boundingBox();
    const seekTo = async (t) => {
      const at = t + 0.5 / 30; // the middle of the frame (marks snap to frame starts)
      await page.mouse.click(bar.x + (bar.width * at) / d3, bar.y + bar.height / 2);
      await frame.waitForFunction((x) => Math.abs(document.querySelector('.clips-review .src-video').currentTime - x) < 0.02, at, POLL);
    };
    await seekTo(1);
    await frameKey(frame, 'i');
    await seekTo(3);
    await frameKey(frame, 'o');
    await expect(review.locator('.clips-review-mark.is-set')).toHaveCount(2);
    await expect(review.locator('.clips-review-mark').first()).toHaveText('IN 0:01.00');
    await frameKey(frame, 'Enter');
    await expect(stamp).toContainText('Added to timeline');
    await expect(count).toHaveText('4 / 6');
    const tl = (await getProject(frame)).tracks.video;
    expect(tl).toHaveLength(1);
    expect(tl[0].mediaId).toBe(order[2]);
    expect(Math.abs(tl[0].in - 1)).toBeLessThan(0.05);
    expect(Math.abs(tl[0].out - (3 + 1 / 30))).toBeLessThan(0.05); // OUT includes the frame under the playhead

    // #4: pick, 5 stars; then walk past #5 and #6 to the summary.
    await frameKey(frame, 'p');
    await frameKey(frame, '5');
    await expect.poll(async () => (await mediaOf(frame, order[3])).rating).toBe(5);
    await frameKey(frame, 'ArrowRight');
    await expect(count).toHaveText('5 / 6');
    await frameKey(frame, 'ArrowRight');
    await expect(count).toHaveText('6 / 6');
    await frameKey(frame, 'ArrowRight');
    await expect(review.locator('.clips-review-done-title')).toHaveText('Review complete');
    await expect(review.locator('.clips-review-done-body')).toContainText('You picked 3 of 6 items and rejected 1');

    // "Show picked in the bin": the bin is filtered to the 3 picks.
    await review.locator('.btn', { hasText: 'Show picked in the bin' }).click();
    await expect(review).toHaveCount(0);
    await expect(frame.locator('.bin-card')).toHaveCount(3);
    await expect(frame.locator('.bin-card.is-pick')).toHaveCount(3);
    expect((await cardIds(frame)).sort()).toEqual([order[0], order[2], order[3]].sort());
    await expect(frame.locator('.bin-status')).toContainText('3 picked');
    await expect(frame.locator('.bin-status')).toContainText('1 rejected');
    await expect(frame.locator('.bin-status')).toContainText('showing 3');
    // The flag filter says so (behind the filter button at this panel width).
    const flags = frame.locator('.bin-toolbar select[title="Flags"]');
    if (!(await flags.isVisible())) await frame.locator('.bin-toolbar [title="Filters & sort"]').click();
    await expect(flags).toHaveValue('pick');
    // Reset brings everything back; the trimmed clip is on the timeline with its range.
    await frame.locator('.bin-status .bin-link', { hasText: 'Reset filters' }).click();
    await expect(frame.locator('.bin-card')).toHaveCount(6);
    await expect(binCard(frame, order[2]).locator('.bin-card-trim')).toBeVisible();
    await showTab(frame, 'edit');
    await expect(frame.locator('.tl-clip-video')).toHaveCount(1);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('journey 3 · edit: reorder, drag-trim, split, dissolve + wipe, music from a URL and a file, fit, title, look, preview, undo/redo', async () => {
  test.setTimeout(300_000);
  const ctx = await start();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await openPanel(page);
    await addAllVideos(frame, 6);
    const byPost = await mediaByPost(frame);
    await setDockMode(frame, 'max'); // editing wants the whole window
    await expect(page.locator('gis-studio-root .panel.max')).toBeVisible();
    // Red, green, blue in this order: one card "+" at a time (a multi-selection is appended in bin order, see the
    // known issue about the bin order).
    await addCardsToTimeline(frame, [byPost[RED], byPost[GREEN], byPost[BLUE]]);
    await showTab(frame, 'edit');
    await expect(frame.locator('.tl-clip-video')).toHaveCount(3);
    await page.waitForTimeout(500); // the first content is fitted to the view
    let L = await layoutOf(frame);
    expect(L.map((c) => c.post)).toEqual([RED, GREEN, BLUE]);
    const { zoom } = await uiState(frame);

    // Reorder: drag blue onto the start of green.
    const blueBox = await frame.locator(`.tl-clip[data-clip-id="${L[2].id}"]`).boundingBox();
    const greenBox = await frame.locator(`.tl-clip[data-clip-id="${L[1].id}"]`).boundingBox();
    const from = { x: blueBox.x + blueBox.width / 2, y: blueBox.y + blueBox.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(from.x + ((greenBox.x + 6 - from.x) * i) / 20, from.y);
    await expect(frame.locator('.tl-insert')).toBeVisible();
    await page.mouse.up();
    L = await layoutOf(frame);
    expect(L.map((c) => c.post)).toEqual([RED, BLUE, GREEN]);

    // Drag-trim: pull red's end 1 s to the left; the magnetic track ripples.
    const outHandle = await center(frame.locator(`.tl-clip[data-clip-id="${L[0].id}"] .tl-trim-out`));
    await drag(page, outHandle, { x: outHandle.x - zoom, y: outHandle.y });
    L = await layoutOf(frame);
    expect(L[0].out).toBeGreaterThan(2.85);
    expect(L[0].out).toBeLessThan(3.15);
    expect(L[1].start).toBeCloseTo(L[0].end, 3);

    // Split at the playhead: click the ruler at 1.5 s, then the scissors.
    await clickRulerAt(frame, page, 1.5);
    await expect.poll(async () => (await uiState(frame)).playhead).toBeCloseTo(1.5, 1);
    await frame.locator('.tl-toolbar [title^="Split at playhead"]').click();
    L = await layoutOf(frame);
    expect(L.map((c) => c.post)).toEqual([RED, RED, BLUE, GREEN]);
    expect(L[0].out).toBeCloseTo(1.5, 1);
    expect(L[1].in).toBeCloseTo(1.5, 1);

    // Transitions: a dissolve into blue and a wipe into green, from the badges on the cuts.
    const pop = frame.locator('.tl-pop');
    await frame.locator(`.tl-trbadge[data-tr-for="${L[2].id}"]`).click();
    await pop.locator('.tl-tr-opt[data-transition="crossfade"]').click();
    await expect(pop.locator('.tl-pop-current')).toHaveText('Dissolve');
    // Keys go to an element inside the studio frame: page-level key presses can land in grok.com's composer under load.
    await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await expect(pop).toBeHidden();
    await frame.locator(`.tl-trbadge[data-tr-for="${L[3].id}"]`).click();
    await pop.locator('.tl-tr-opt[data-transition="wipe-left"]').click();
    await expect(pop.locator('.tl-pop-current')).toHaveText('Wipe left');
    await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await expect(pop).toBeHidden();
    L = await layoutOf(frame);
    expect(L.map((c) => c.transition)).toEqual([null, null, 'crossfade', 'wipe-left']);
    await expect(frame.locator('.tl-trbadge.has-transition')).toHaveCount(2);
    // The preview renders the wipe: outgoing blue on the left, incoming green on the right.
    await clickRulerAt(frame, page, (L[3].start + L[2].end) / 2);
    await expect.poll(async () => isBlue(await monitorPixel(frame, 0.05, 0.12)), { timeout: 10000 }).toBe(true);
    await expect.poll(async () => isGreen(await monitorPixel(frame, 0.95, 0.12)), { timeout: 10000 }).toBe(true);

    // Music from a link, from the start of the sequence.
    await frame.locator('[title="Go to start (Home)"]').click();
    await expect.poll(async () => (await uiState(frame)).playhead).toBe(0);
    await addAudioFromLink(frame, page, MUSIC_URL);
    let p = await getProject(frame);
    expect(p.tracks.audio).toHaveLength(1);
    const music = p.tracks.audio[0];
    expect(p.media[music.mediaId]).toMatchObject({ kind: 'audio', name: 'music', origin: 'url', status: 'ready' });
    expect(music.start).toBe(0);
    await expect(frame.locator(`.tl-clip-audio[data-clip-id="${music.id}"] canvas.tl-wave`)).toBeVisible();

    // A voice-over from a file (the OS file chooser).
    await frame.locator('.tl-toolbar .btn', { hasText: 'Audio' }).click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), frame.locator('.menu .menu-item', { hasText: 'From a file' }).click()]);
    await chooser.setFiles(fixture('media', 'voice.wav'));
    await expect(frame.locator('.toast', { hasText: 'Added 1 audio clip' })).toBeVisible({ timeout: 30000 });
    p = await getProject(frame);
    expect(p.tracks.audio).toHaveLength(2);
    const voice = p.tracks.audio.find((a) => a.id !== music.id);
    expect(p.media[voice.mediaId]).toMatchObject({ kind: 'audio', name: 'voice', origin: 'file' });
    expect(voice.lane).toBe(1); // the music already uses lane 0 there

    // Fit the audio to the end of the video.
    await frame.locator('.tl-toolbar .btn', { hasText: 'Audio' }).click();
    await frame.locator('.menu .menu-item', { hasText: 'Fit audio to video end' }).click();
    p = await getProject(frame);
    L = await layoutOf(frame);
    const seqEnd = L[L.length - 1].end;
    const fitted = p.tracks.audio.find((a) => a.id === music.id);
    expect(fitted.start + fitted.out - fitted.in).toBeCloseTo(seqEnd, 2);
    const voiceAfter = p.tracks.audio.find((a) => a.id === voice.id);
    expect(voiceAfter.out - voiceAfter.in).toBeCloseTo(3, 1); // ended before the video anyway

    // A title.
    await frame.locator('.tl-toolbar .btn', { hasText: 'Text' }).click();
    const textarea = frame.locator('.insp .insp-textarea textarea');
    await expect(textarea).toBeFocused();
    await textarea.fill('Neon Nights'); // into the frame's field: page-level keys can land in grok.com's composer under load
    await expect(frame.locator('.tl-clip-text')).toContainText('Neon Nights');
    await expect.poll(async () => (await getProject(frame)).tracks.text.map((t) => t.text)).toEqual(['Neon Nights']);
    await textarea.press('Escape');

    // A look (filter) on the first clip.
    await frame.locator(`.tl-clip-video[data-clip-id="${L[0].id}"]`).click();
    const insp = frame.locator('.insp');
    await expect(insp.locator('.panel-title')).toHaveText('Clip');
    await insp.locator('.insp-look[data-preset="noir"]').click();
    await expect.poll(async () => (await getProject(frame)).tracks.video[0].filters?.grayscale).toBe(1);
    await expect(frame.locator(`.tl-clip-video[data-clip-id="${L[0].id}"] .tl-badge-icon[title="Color filter"]`)).toBeVisible();
    await clickRulerAt(frame, page, 0.5);
    await expect.poll(async () => isGray(await monitorPixel(frame, 0.3, 0.2)), { timeout: 10000 }).toBe(true);

    // Play ~2 s from the start: time advances and real pixels are drawn.
    await frame.locator('[title="Go to start (Home)"]').click();
    await frame.locator('.mon-play').click();
    await expect.poll(async () => (await uiState(frame)).playing).toBe(true);
    await page.waitForTimeout(2000);
    const played = (await uiState(frame)).playhead;
    expect(played).toBeGreaterThan(1.2);
    expect(played).toBeLessThan(4);
    expect(await litShare(frame)).toBeGreaterThan(0.9);
    await frame.locator('.mon-play').click();
    await expect.poll(async () => (await uiState(frame)).playing).toBe(false);

    // Undo / redo from the header.
    const before = (await getProject(frame)).tracks;
    const undo = frame.locator('.header-actions [title^="Undo"]');
    const redo = frame.locator('.header-actions [title^="Redo"]');
    await expect(undo).toHaveAttribute('title', /Look: Noir/);
    await undo.click();
    await expect.poll(async () => (await getProject(frame)).tracks.video[0].filters?.grayscale ?? 0).toBe(0);
    await expect(redo).toHaveAttribute('title', /Look: Noir/);
    await undo.click();
    await redo.click();
    await redo.click();
    expect((await getProject(frame)).tracks).toEqual(before);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('journey 4 · export: MP4 (H.264 + AAC) and WebM (VP9 + Opus) downloads match the timeline', async () => {
  test.setTimeout(300_000);
  const ctx = await start();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await openPanel(page);
    await addAllVideos(frame, 6);
    const byPost = await mediaByPost(frame);
    await setDockMode(frame, 'max');
    // Red, green, blue; a dissolve into blue; the music from a link under everything, fitted to the video.
    await addCardsToTimeline(frame, [byPost[RED], byPost[GREEN], byPost[BLUE]]);
    await showTab(frame, 'edit');
    await expect(frame.locator('.tl-clip-video')).toHaveCount(3);
    const L = await layoutOf(frame);
    await frame.locator(`.tl-trbadge[data-tr-for="${L[2].id}"]`).click();
    await frame.locator('.tl-pop .tl-tr-opt[data-transition="crossfade"]').click();
    await frameKey(frame, 'Escape');
    await frame.locator('[title="Go to start (Home)"]').click();
    await addAudioFromLink(frame, page, MUSIC_URL);
    await frame.locator('.tl-toolbar .btn', { hasText: 'Audio' }).click();
    await frame.locator('.menu .menu-item', { hasText: 'Fit audio to video end' }).click();
    const seq = await frame.evaluate(() => {
      const p = window.__gis.projectStore.get();
      return { duration: window.__gis.model.layoutProject(p).duration, ...p.settings };
    });
    const cuts = await layoutOf(frame); // with the dissolve: blue starts before green ends
    expect(cuts[2].transition).toBe('crossfade');
    expect(seq.duration).toBeGreaterThan(11);
    const frameDur = 1 / seq.fps;

    // MP4: the default format.
    await frame.locator('.export-btn').click();
    const modal = frame.locator('.ex-modal');
    await expect(modal.locator('.ex-format[data-format="mp4"]')).toHaveAttribute('aria-checked', 'true');
    await expect(modal.locator('.ex-format[data-format="mp4"] .ex-format-sub')).toHaveText('H.264 + AAC', { timeout: 20000 });
    await modal.locator('.ex-filename input').fill('Neon journey');
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-result video')).toBeVisible({ timeout: 120000 });
    await expect(modal.locator('.ex-result-name')).toHaveText('Neon journey.mp4');
    const mp4 = await saveDownload(page, modal.locator('.ex-download'), 'journey.mp4');
    // WebM: "Export another".
    await modal.locator('.ex-another').click();
    await modal.locator('.ex-format[data-format="webm"]').click();
    await expect(modal.locator('.ex-ext')).toHaveText('.webm');
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-result video')).toBeVisible({ timeout: 120000 });
    await expect(modal.locator('.ex-result-name')).toHaveText('Neon journey.webm');
    const webm = await saveDownload(page, modal.locator('.ex-download'), 'journey.webm');

    const expectedFrames = Math.round(seq.duration * seq.fps);
    for (const [file, vcodec, acodec] of [
      [mp4, 'h264', 'aac'],
      [webm, 'vp9', 'opus'],
    ]) {
      const info = ffprobe(file);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const a = info.streams.find((s) => s.codec_type === 'audio');
      expect(v.codec_name, file).toBe(vcodec);
      expect(a?.codec_name, file).toBe(acodec);
      expect([v.width, v.height], file).toEqual([seq.width, seq.height]);
      expect(Math.abs(Number(v.nb_read_frames) - expectedFrames), `${file} frames`).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(info.format.duration) - seq.duration), `${file} duration`).toBeLessThanOrEqual(frameDur + 0.001);
      expect(meanVolume(file), `${file} has the music`).toBeGreaterThan(-40);
      // First frame: red; last frame: blue (top-left corner, away from the moving white box).
      const box = [32, 32, 192, 192];
      expect(isRed(regionAvg(rgbFrame(file, 0), v.width, box)), `${file} first frame`).toBe(true);
      expect(isBlue(regionAvg(rgbFrame(file, seq.duration - 1.5 * frameDur), v.width, box)), `${file} last frame`).toBe(true);
      // Mid-dissolve (green → blue): a mix of both.
      const tr = (cuts[2].start + cuts[1].end) / 2;
      const mid = regionAvg(rgbFrame(file, tr), v.width, box);
      expect(mid[1] > 20 && mid[2] > 60, `${file} dissolve ${mid}`).toBe(true);
    }
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('journey 5 · prompts: paste a 3-shot list, bible character, send shot 1 to Grok, the generation is linked as its take, assemble in shot order', async () => {
  test.setTimeout(240_000);
  const ctx = await start({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await openPanel(page);
    await showTab(frame, 'prompts');
    await expect(frame.locator('.pr-welcome')).toContainText('Prompt workshop');

    // Paste a 3-shot list.
    await frame.locator('.pr-welcome .btn', { hasText: 'Paste a prompt list' }).click();
    const paste = frame.locator('.pr-paste-dialog');
    await paste.locator('[data-testid="pr-paste-text"]').fill(
      [
        '1. Opening: @Mara walks through a neon market at night, slow tracking shot',
        '2. Chase: drones chase a red car across wet rooftops, aerial shot',
        '3. Finale: the car stops at a glowing harbor at dawn, wide shot',
      ].join('\n'),
    );
    await expect(paste.locator('.pr-paste-summary')).toContainText('3 shots');
    await paste.locator('[data-testid="pr-paste-import"]').click();
    await expect(paste).toBeHidden();
    await expect(frame.locator('.pr-card')).toHaveCount(3);
    const shots = () => frame.evaluate(() => window.__gis.projectStore.get().shots);
    expect((await shots()).map((s) => s.title)).toEqual(['Opening', 'Chase', 'Finale']);

    // @Mara is unknown: one click adds her to the bible, then describe her there.
    await expect(frame.locator('.pr-warn-row')).toContainText('@Mara');
    await frame.locator('.pr-warn-tok', { hasText: '@Mara' }).click();
    const card = frame.locator('.pr-bible-card', { hasText: 'Mara' });
    await expect(card).toBeVisible();
    if (!(await card.evaluate((e) => e.classList.contains('is-open')))) await card.click();
    await frame.locator('.pr-bible-card.is-open textarea').first().fill('a courier with short silver hair and a red jacket');
    await frame.locator('.pr-bible-card.is-open .pr-bible-name').click(); // leave the field
    await expect.poll(async () => (await getProject(frame)).bible.characters).toEqual([expect.objectContaining({ name: 'Mara', description: 'a courier with short silver hair and a red jacket' })]);
    if (await frame.locator('.pr-col-lib .pr-side-switch button', { hasText: 'Shots' }).isVisible()) await frame.locator('.pr-col-lib .pr-side-switch button', { hasText: 'Shots' }).click();
    const expanded = 'Mara (a courier with short silver hair and a red jacket) walks through a neon market at night, slow tracking shot';
    await expect(frame.locator('[data-testid="pr-preview"]')).toContainText(expanded);
    await expect(frame.locator('.pr-warn-row')).toHaveCount(0);

    // Send shot 1: Grok's prompt box on the page gets the expanded text.
    await frame.locator('[data-testid="pr-send"]').click();
    await expect(page.locator('.query-bar [contenteditable="true"]')).toHaveText(expanded);
    await expect(frame.locator('.toast', { hasText: "Shot 1 is in Grok's prompt box" })).toBeVisible();
    await expect.poll(async () => (await shots())[0].status).toBe('sent');

    // Generate on grok.com (Enter in Grok's box — its send button is under the docked studio, see the known issue).
    await page.locator('.query-bar [contenteditable="true"]').click({ position: { x: 40, y: 12 } });
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__mock.submitted)).toEqual([expanded]);
    await frame.waitForFunction(
      (gen) => {
        const p = window.__gis.projectStore.get();
        const s = p.shots[0];
        return s.takes.length === 1 && p.media[s.takes[0]]?.pageKey === `video:${gen}` && s.status === 'generated';
      },
      GENERATED_POST,
      POLL,
    );
    await expect(frame.locator('.toast', { hasText: 'Linked 1 new take to shot 1' })).toBeVisible();
    let p = await getProject(frame);
    const take = p.media[p.shots[0].takes[0]];
    expect(take).toMatchObject({ shotId: p.shots[0].id, prompt: expanded });
    await frame.waitForFunction((id) => window.__gis.projectStore.get().media[id].status === 'ready', take.id, POLL);
    await expect(frame.locator('.pr-take')).toHaveCount(1);

    // Takes for shots 2 and 3 from clips generated earlier: collect them, then "Link from bin…".
    await showTab(frame, 'clips');
    await addAllVideos(frame, 6);
    const byPost = await mediaByPost(frame);
    await showTab(frame, 'prompts');
    for (const [i, post] of [
      [1, BLUE],
      [2, RED],
    ]) {
      await frame.locator('.pr-card').nth(i).click();
      await frame.locator('.pr-takes-tools .btn', { hasText: 'Link from bin' }).click();
      await frame.locator(`.pr-link-card[data-media-id="${byPost[post]}"]`).click();
      await frame.locator('[data-testid="pr-link-done"]').click();
      await expect(frame.locator('.pr-take')).toHaveCount(1);
    }

    // Assemble: the takes land on the timeline in shot order.
    await frame.locator('[data-testid="pr-assemble"]').click();
    const asm = frame.locator('.pr-dialog', { hasText: 'Assemble the timeline' });
    await expect(asm.locator('.pr-asm-row')).toHaveCount(3);
    await asm.locator('[data-testid="pr-assemble-run"]').click();
    await expect(asm).toBeHidden();
    const placed = frame.locator('.toast', { hasText: 'Placed 3 clips on the timeline' });
    await expect(placed).toBeVisible();
    p = await getProject(frame);
    expect(p.tracks.video.map((c) => p.media[c.mediaId].postId)).toEqual([GENERATED_POST, BLUE, RED]);
    await placed.locator('.toast-action', { hasText: 'Open Edit' }).click();
    await expect(frame.locator('.view-edit')).toBeVisible();
    await expect(frame.locator('.tl-clip-video')).toHaveCount(3);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('journey 6 · ingredients: a grok.com image, cropped to 16:9, attached to Grok and used as a shot reference', async () => {
  test.setTimeout(240_000);
  const ctx = await start();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await openPanel(page);
    const library = () => frame.evaluate(() => window.__gis.libraryStore.get().ingredients);
    await showTab(frame, 'ingredients');

    // Import the image Grok shows on the page.
    await frame.locator('[data-testid="ing-add"]').click();
    await frame.locator('.menu-item', { hasText: 'From grok.com' }).click();
    const dialog = frame.locator('.modal', { hasText: 'Images on grok.com' });
    await dialog.locator('.ing-pick-card', { hasText: POSTS[IMAGE].prompt }).click();
    await dialog.locator('.btn', { hasText: 'Add 1 image' }).click();
    await expect(dialog).toBeHidden();
    await expect(frame.locator('.ing-card')).toHaveCount(1);
    const [original] = await library();
    expect(original).toMatchObject({ origin: 'page', width: 1024, height: 1024, prompt: POSTS[IMAGE].prompt });

    // Crop it to 16:9 and save a copy.
    await frame.locator('.ing-card').first().dblclick();
    await expect(frame.locator('.ing-ws')).toBeVisible();
    await frame.locator('.ing-aspect', { hasText: '16:9' }).click();
    await expect(frame.locator('.ing-stage-badge')).toContainText('1024 × 576');
    await frame.locator('.ing-ws-header .btn', { hasText: 'Save as new' }).click();
    await expect(frame.locator('.toast', { hasText: 'Saved a copy (1024 × 576)' })).toBeVisible();
    await expect.poll(async () => (await library()).length).toBe(2);
    const edited = (await library()).find((i) => i.origin === 'edit');
    expect(edited).toMatchObject({ width: 1024, height: 576 });
    const size = await frame.evaluate(async (id) => {
      const blob = await window.__gis.db.getBlob(id);
      const bmp = await createImageBitmap(blob);
      return { w: bmp.width, h: bmp.height, bytes: blob.size, type: blob.type };
    }, edited.id);
    expect([size.w, size.h]).toEqual([1024, 576]);
    await frame.locator('.ing-ws-header button').first().click(); // back to the library
    await expect(frame.locator('.ing-ws')).toBeHidden();
    await expect(frame.locator('.modal')).toHaveCount(0);

    // Attach the cropped copy to Grok's composer: the page receives the file.
    await frame.locator('.ing-card', { hasText: '(edited)' }).click();
    await frame.locator('.ing-selbar [title="Attach to the Grok composer"]').click();
    await expect(frame.locator('.toast', { hasText: 'Attached 1 image to Grok' })).toBeVisible({ timeout: 35000 });
    expect(await page.evaluate(() => window.__mock.attached)).toEqual([expect.objectContaining({ type: size.type, size: size.bytes })]);
    await expect(page.locator('.query-bar .att img')).toHaveCount(1);

    // Use it as the reference of a shot.
    await showTab(frame, 'prompts');
    await frame.locator('.pr-welcome .btn', { hasText: 'New shot' }).click();
    await expect(frame.locator('#pr-prompt-input')).toBeFocused();
    await frame.locator('#pr-prompt-input').fill('The hero poster unfolds, slow push in');
    await expect.poll(async () => (await getProject(frame)).shots[0]?.prompt).toBe('The hero poster unfolds, slow push in');
    await showTab(frame, 'ingredients');
    await expect(frame.locator('.ing-card.is-selected')).toContainText('(edited)');
    await frame.locator('.ing-selbar [title="Use in shot"]').click();
    await frame.locator('.menu .menu-item', { hasText: 'The hero poster unfolds' }).click();
    await expect(frame.locator('.toast', { hasText: 'Added 1 reference' })).toBeVisible();
    expect((await getProject(frame)).shots[0].ingredientIds).toEqual([edited.id]);
    await showTab(frame, 'prompts');
    await expect(frame.locator(`.pr-refs .ing-picker-chip[title="${edited.name}"]`)).toBeVisible();
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('journey 7 · persistence: reload grok.com keeps project, bin, timeline and settings; the standalone tab talks to grok.com', async () => {
  test.setTimeout(240_000);
  const ctx = await start();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    let frame = await openPanel(page);
    let before;
    await test.step('set up: picks on the timeline, picked-only filter, auto-add, dissolve, snapping off, 24 fps, dock bottom', async () => {
      await addAllVideos(frame, 6);
      const byPost = await mediaByPost(frame);
      for (const post of [RED, GREEN]) await binCard(frame, byPost[post]).locator('.bin-flag.is-pick').click();
      await binCard(frame, byPost[RED]).click();
      await binCard(frame, byPost[GREEN]).click({ modifiers: ['Control'] });
      await frame.locator('.bin-selbar .btn', { hasText: /^Add/ }).click();
      if (!(await frame.locator('.bin-toolbar select[title="Flags"]').isVisible())) await frame.locator('.bin-toolbar [title="Filters & sort"]').click();
      await frame.locator('.bin-toolbar select[title="Flags"]').selectOption('pick');
      await expect(frame.locator('.bin-card')).toHaveCount(2);
      await frame.locator('.clips-page-head [title^="More"]').click();
      await frame.locator('.menu .menu-item', { hasText: 'Auto-add new videos' }).click();
      await showTab(frame, 'edit');
      await expect(frame.locator('.tl-clip-video')).toHaveCount(2);
      const L = await layoutOf(frame);
      await frame.locator(`.tl-trbadge[data-tr-for="${L[1].id}"]`).click();
      await frame.locator('.tl-pop .tl-tr-opt[data-transition="crossfade"]').click();
      await frameKey(frame, 'Escape');
      await frame.locator('.tl-zoom [title^="Snapping on"]').click();
      await frame.locator('.edit-fab', { hasText: 'Settings' }).click(); // opens the inspector at this width
      await frame.locator('.insp .segmented button', { hasText: '24 fps' }).click();
      await expect.poll(async () => (await getProject(frame)).settings.fps).toBe(24);
      await frameKey(frame, 'Escape');
      await setDockMode(frame, 'bottom');
      await expect(page.locator('gis-studio-root .panel.bottom')).toBeVisible();
      before = await getProject(frame);
      await page.waitForTimeout(1500); // autosave
    });

    await test.step('reload grok.com: the panel stays closed until asked, then everything is where it was', async () => {
      await page.reload();
      await page.locator('gis-studio-root').waitFor({ state: 'attached' });
      await expect(page.locator('gis-studio-root .panel')).toBeHidden();
      frame = await openPanel(page);
      await expect(page.locator('gis-studio-root .panel.bottom')).toBeVisible();
      await expect(frame.locator('.view-edit')).toBeVisible(); // the tab it was on
      const p = await getProject(frame);
      expect(p.id).toBe(before.id);
      expect(p.tracks).toEqual(before.tracks);
      expect(p.settings.fps).toBe(24);
      expect(p.mediaOrder).toEqual(before.mediaOrder);
      await expect(frame.locator('.tl-clip-video')).toHaveCount(2);
      await expect(frame.locator('.tl-trbadge.has-transition')).toHaveCount(1);
      await expect(frame.locator('.tl-zoom [title^="Snapping off"]')).toBeVisible();
      await waitAllReady(frame, 6);
      await showTab(frame, 'clips');
      await expect(frame.locator('.bin-card')).toHaveCount(2); // still filtered to picks
      await expect(frame.locator('.bin-status')).toContainText('showing 2');
      await expect(frame.locator('.bin-card .clips-thumb-img')).toHaveCount(2);
      await expect(frame.locator('.bin-card .clips-thumb.is-loading')).toHaveCount(0);
      expect((await uiState(frame)).autoCollect).toBe(true);
      await frame.locator('.clips-page-head [title^="More"]').click();
      await expect(frame.locator('.menu .menu-item', { hasText: 'Auto-add new videos' })).toHaveClass(/is-checked|checked/);
      await frameKey(frame, 'Escape');
    });

    await test.step('the standalone studio tab: same project, connected to the grok.com tab, acts on it', async () => {
      const tab = await openStudioTab(ctx);
      await tab.waitForFunction(() => window.__gis.bridge.connected && window.__gis.bridge.tabId != null, null, POLL);
      await expect(tab.locator('.conn-pill.is-on')).toContainText('grok.com · imagine');
      expect((await getProject(tab)).id).toBe(before.id);
      await expect(tab.locator('.clips-pcard')).toHaveCount(7);
      await expect(tab.locator('.clips-pcard.is-inbin')).toHaveCount(6);
      await tab.locator(`.clips-pcard[data-key="video:${BLUE}"]`).hover();
      await tab.locator(`.clips-pcard[data-key="video:${BLUE}"] [title="Reveal on grok.com"]`).click();
      await expect(page.locator('gis-studio-root .flash')).toHaveCount(1);
      // A prompt sent from the standalone tab lands in Grok's prompt box.
      await showTab(tab, 'prompts');
      await tab.locator('.pr-welcome .btn', { hasText: 'New shot' }).click();
      await expect(tab.locator('#pr-prompt-input')).toBeFocused();
      await tab.keyboard.type('A paper lantern drifting over a dark lake');
      await expect.poll(async () => (await getProject(tab)).shots[0]?.prompt).toBe('A paper lantern drifting over a dark lake');
      await tab.locator('[data-testid="pr-send"]').click();
      await expect(page.locator('.query-bar [contenteditable="true"]')).toHaveText('A paper lantern drifting over a dark lake');
      await expect.poll(async () => (await getProject(tab)).shots[0].status, { timeout: 15000 }).toBe('sent');
    });
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

// ================================================================================== known issues (expected to fail)

test('regression · docked right, the studio covers Grok\'s send button: the page is not resized', async () => {
  const ctx = await start();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await openPanel(page);
    const send = await page.locator('.query-bar button[type="submit"]').boundingBox();
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.localName, [send.x + send.width / 2, send.y + send.height / 2]);
    expect(hit, 'element under the centre of Grok\'s send button').not.toBe('gis-studio-root');
  } finally {
    await ctx.close();
  }
});

test('regression · one "Add all videos" click can scramble the bin order (and Review / multi-select "Add to timeline" follow it)', async () => {
  const ctx = await start();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await openPanel(page);
    await frame.waitForFunction(() => window.__gis.pageStore.get().items.length >= 6, null, POLL);
    const feed = await frame.evaluate(() => window.__gis.pageStore.get().items.filter((i) => i.kind === 'video').map((i) => i.key));
    // A slower machine: every Date.now() in the studio lands on the next millisecond (happens at random otherwise).
    await frame.evaluate(() => {
      const real = Date.now.bind(Date);
      let last = 0;
      Date.now = () => (last = Math.max(real(), last + 1));
    });
    await addAllVideos(frame, 6);
    const p = await getProject(frame);
    const shown = (await cardIds(frame)).map((id) => p.media[id].pageKey);
    expect(shown, 'bin order after one "Add all videos" (Newest first)').toEqual(feed);
  } finally {
    await ctx.close();
  }
});

/** Studio inside the grok.com tab + the standalone studio tab, both connected to the same page. */
async function twoStudioWindows(ctx, page) {
  await openGrok(page, '/imagine');
  const frame = await openPanel(page);
  const tab = await openStudioTab(ctx);
  await tab.waitForFunction(() => window.__gis.bridge.connected && window.__gis.bridge.tabId != null, null, POLL);
  return { frame, tab };
}
const binKeysOf = (target) => target.evaluate(() => Object.values(window.__gis.projectStore.get().media).map((m) => m.pageKey));

test('regression · with the standalone tab open too, auto-add imports each new generation twice', async () => {
  const ctx = await start({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    await ctx.sw.evaluate(() => chrome.storage.local.set({ 'gis:ui': { autoCollect: true } }));
    const page = ctx.page;
    const { frame, tab } = await twoStudioWindows(ctx, page);
    await page.bringToFront();
    await page.locator('.query-bar [contenteditable="true"]').click({ position: { x: 40, y: 12 } });
    await page.keyboard.type('A copper fox running through snow');
    await page.keyboard.press('Enter');
    await binItemReady(frame, `video:${GENERATED_POST}`);
    await page.waitForTimeout(4000); // both windows have reacted and saved
    for (const target of [frame, tab]) expect(await binKeysOf(target)).toEqual([`video:${GENERATED_POST}`]);
  } finally {
    await ctx.close();
  }
});

/** Closes the grok.com tab like a user (beforeunload handlers run) and opens grok.com again in a new tab. */
async function closeAndReopen(ctx, page) {
  await page.close({ runBeforeUnload: true });
  const next = await ctx.context.newPage();
  await openGrok(next, '/imagine');
  const frame = await openPanel(next);
  await next.waitForTimeout(1000); // library and project loaded
  return { page: next, frame };
}

test('regression · an ingredient added right before the grok.com tab is closed is lost', async () => {
  const ctx = await start();
  try {
    await openGrok(ctx.page, '/imagine');
    const frame = await openPanel(ctx.page);
    await showTab(frame, 'ingredients');
    await frame.locator('[data-testid="ing-add"]').click();
    await frame.locator('.menu-item', { hasText: 'From grok.com' }).click();
    const dialog = frame.locator('.modal', { hasText: 'Images on grok.com' });
    await dialog.locator('.ing-pick-card', { hasText: POSTS[IMAGE].prompt }).click();
    await dialog.locator('.btn', { hasText: 'Add 1 image' }).click();
    // The "Added … to Ingredients" toast is up: the user closes the tab.
    await frame.waitForFunction(() => window.__gis.libraryStore.get().ingredients.length === 1, null, { polling: 20, timeout: 30000 });
    const again = await closeAndReopen(ctx, ctx.page);
    expect(await again.frame.evaluate(() => window.__gis.libraryStore.get().ingredients.length)).toBe(1);
  } finally {
    await ctx.close();
  }
});

test('regression · review summary "Add picked to timeline" adds a pick already placed with Enter a second time', async () => {
  const ctx = await start();
  try {
    const studio = await openStudioTab(ctx);
    await seedMedia(studio, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4']);
    await studio.locator('.bin-toolbar button', { hasText: 'Review' }).click();
    const review = studio.locator('.clips-review');
    await expect(review.locator('.clips-review-count')).toHaveText('1 / 3');
    await studio.keyboard.press('p');
    await studio.keyboard.press('Enter'); // keeper: on the timeline, next
    await expect(review.locator('.clips-review-count')).toHaveText('2 / 3');
    await studio.keyboard.press('p');
    await studio.keyboard.press('ArrowRight');
    await studio.keyboard.press('ArrowRight');
    await expect(review.locator('.clips-review-done-title')).toHaveText('Review complete');
    // the pick already placed with Enter is not offered again
    await review.locator('.btn', { hasText: /Add 1 picked not on the timeline yet/ }).click();
    const ids = (await getProject(studio)).tracks.video.map((c) => c.mediaId);
    expect(new Set(ids).size, `timeline media ${ids}`).toBe(ids.length);
  } finally {
    await ctx.close();
  }
});

test('regression · a shot prompt typed just before the grok.com tab is closed is lost', async () => {
  const ctx = await start();
  try {
    await openGrok(ctx.page, '/imagine');
    const frame = await openPanel(ctx.page);
    await showTab(frame, 'prompts');
    await frame.locator('.pr-welcome .btn', { hasText: 'New shot' }).click();
    await expect(frame.locator('#pr-prompt-input')).toBeFocused();
    await frame.locator('#pr-prompt-input').fill('A lighthouse in a storm, waves crashing');
    await ctx.page.waitForTimeout(150); // the text is in the project (and its journal) within ~60 ms
    const again = await closeAndReopen(ctx, ctx.page);
    await expect.poll(() => again.frame.evaluate(() => window.__gis.projectStore.get().shots.map((s) => s.prompt)), { timeout: 10000 }).toEqual(['A lighthouse in a storm, waves crashing']);
  } finally {
    await ctx.close();
  }
});
