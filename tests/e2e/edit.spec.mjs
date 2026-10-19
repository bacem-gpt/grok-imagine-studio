// Edit tab end-to-end: realtime preview playback, split, trim drags (+ undo/redo as one step), reorder, transition
// popover, audio clip with fades, text overlays, inspector filters, drops from the bin, keyboard shortcuts, the
// docked (480 / 720 px) / bottom-dock / full-window (1440 px) layouts and where the inspector opens in each.
import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { launch, openStudioTab, seedMedia, getProject, expect } from './harness.mjs';

/** Where the layout screenshots go (GIS_SHOTS_DIR overrides; default: this test's output folder). */
const shotPath = (name) => {
  const dir = process.env.GIS_SHOTS_DIR;
  if (!dir) return test.info().outputPath(name);
  mkdirSync(dir, { recursive: true });
  return `${dir}/${name}`;
};

async function setup(ctx, files) {
  const page = await openStudioTab(ctx);
  const ids = await seedMedia(page, files, { timeout: 60000 });
  await page.locator('.app-tabs .tab', { hasText: /Edit/ }).click();
  await page.locator('.tl-body').waitFor();
  return { page, ids };
}

async function addToTimeline(page, ids) {
  await page.evaluate((list) => {
    const { projectStore, model } = window.__gis;
    projectStore.update((p) => model.appendMediaToTimeline(p, list).project, { label: 'Add to timeline' });
  }, ids);
  await expect(page.locator('.tl-clip-video')).toHaveCount(ids.length);
  await page.waitForTimeout(400); // first content triggers a fit-to-view
}

const ui = (page) => page.evaluate(() => window.__gis.uiStore.get());
const setUi = (page, patch) => page.evaluate((x) => window.__gis.uiStore.set((s) => ({ ...s, ...x })), patch);
const seek = (page, t) => setUi(page, { playhead: t });
const layout = (page) =>
  page.evaluate(() => {
    const p = window.__gis.projectStore.get();
    return window.__gis.model.layoutVideo(p.tracks.video).map((it) => ({ id: it.clip.id, mediaId: it.clip.mediaId, start: it.start, end: it.end }));
  });

/** RGB of the program monitor canvas at fractional coordinates. */
const monitorPixel = (page, fx, fy) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.mon-canvas');
      const d = c.getContext('2d').getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [fx, fy],
  );

/** Drags with real mouse events in small steps (pointer events + capture, like a user). */
async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.mouse.up();
}

const center = async (locator) => {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80;

/** True when what is on top at the monitor's centre is the monitor itself (no drawer, sheet or backdrop over it). */
const monitorUncovered = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('.mon-stage').getBoundingClientRect();
    return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.mon-stage');
  });
const isGreen = ([r, g, b]) => g > 90 && r < 80 && b < 80;

test('preview plays through the compositor; split, trim drag with one-step undo/redo, reorder', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4']);
    await addToTimeline(page, ids);

    // --- playback: time advances and real (non-black) pixels are drawn
    await expect.poll(async () => isRed(await monitorPixel(page, 0.1, 0.12)), { timeout: 10000 }).toBe(true);
    await page.locator('.mon-play').click();
    await expect.poll(async () => (await ui(page)).playing).toBe(true);
    await page.waitForTimeout(1500);
    const t1 = (await ui(page)).playhead;
    expect(t1).toBeGreaterThan(0.6);
    expect(isRed(await monitorPixel(page, 0.1, 0.12))).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await ui(page)).playing).toBe(false);
    // paused seek redraws the frame of the new position (green clip starts at 4s)
    await seek(page, 5);
    await expect.poll(async () => isGreen(await monitorPixel(page, 0.1, 0.12)), { timeout: 10000 }).toBe(true);

    // --- split at the playhead (S)
    await seek(page, 1.5);
    await page.keyboard.press('s');
    let p = await getProject(page);
    expect(p.tracks.video.length).toBe(4);
    expect(p.tracks.video[0].out).toBeCloseTo(1.5, 2);
    expect(p.tracks.video[1].in).toBeCloseTo(1.5, 2);
    await page.keyboard.press('Control+z');
    p = await getProject(page);
    expect(p.tracks.video.length).toBe(3);

    // --- drag the right trim handle of the first clip 1s to the left (snapping off for exact numbers)
    await setUi(page, { snapping: false });
    const zoom = (await ui(page)).zoom;
    const first = p.tracks.video[0];
    const handle = page.locator(`.tl-clip[data-clip-id="${first.id}"] .tl-trim-out`);
    const hc = await center(handle);
    await drag(page, hc, { x: hc.x - zoom, y: hc.y }, 16);
    p = await getProject(page);
    const trimmedOut = p.tracks.video[0].out;
    expect(trimmedOut).toBeGreaterThan(first.out - 1.15);
    expect(trimmedOut).toBeLessThan(first.out - 0.85);
    let lay = await layout(page);
    expect(lay[1].start).toBeCloseTo(trimmedOut, 2); // the magnetic track rippled
    // the whole drag is one undo step
    await page.keyboard.press('Control+z');
    p = await getProject(page);
    expect(p.tracks.video[0].out).toBeCloseTo(first.out, 5);
    await page.keyboard.press('Control+Shift+z');
    p = await getProject(page);
    expect(p.tracks.video[0].out).toBeCloseTo(trimmedOut, 5);

    // --- left edge ripple trim
    const inHandle = page.locator(`.tl-clip[data-clip-id="${p.tracks.video[1].id}"] .tl-trim-in`);
    const ic = await center(inHandle);
    await drag(page, ic, { x: ic.x + zoom * 0.5, y: ic.y }, 10);
    p = await getProject(page);
    expect(p.tracks.video[1].in).toBeGreaterThan(0.35);
    expect(p.tracks.video[1].in).toBeLessThan(0.65);

    // --- drag the first clip to the end of the main track
    lay = await layout(page);
    const order0 = lay.map((x) => x.mediaId);
    const body = page.locator(`.tl-clip[data-clip-id="${lay[0].id}"]`);
    const bb = await body.boundingBox();
    const lastBox = await page.locator(`.tl-clip[data-clip-id="${lay[2].id}"]`).boundingBox();
    await page.mouse.move(bb.x + 20, bb.y + bb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(bb.x + 20 + ((lastBox.x + lastBox.width - 4 - bb.x - 20) * i) / 20, bb.y + bb.height / 2);
    await expect(page.locator('.tl-insert')).toBeVisible();
    await expect(page.locator('.tl-ghost')).toBeVisible();
    await page.mouse.up();
    lay = await layout(page);
    expect(lay.map((x) => x.mediaId)).toEqual([order0[1], order0[2], order0[0]]);
    await page.keyboard.press('Control+z');
    expect((await layout(page)).map((x) => x.mediaId)).toEqual(order0);

    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('transition popover, audio with fades, text overlay, inspector filters, drop from the bin', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4', 'music.mp3', 'clip-blue.mp4']);
    const [red, green, music, blue] = ids;
    await addToTimeline(page, [red, green]);

    // --- transition popover on the cut between the two clips
    let p = await getProject(page);
    const second = p.tracks.video[1].id;
    await page.locator(`.tl-trbadge[data-tr-for="${second}"]`).click();
    const pop = page.locator('.tl-pop');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.tl-tr-opt[data-transition]')).toHaveCount(22);
    await pop.locator('.tl-tr-opt[data-transition="wipe-left"]').click();
    p = await getProject(page);
    expect(p.tracks.video[1].transition.type).toBe('wipe-left');
    let lay = await layout(page);
    expect(lay[1].start).toBeLessThan(lay[0].end - 0.3); // the clips overlap for the transition
    await expect(pop.locator('.tl-pop-current')).toHaveText('Wipe left');
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await expect(page.locator(`.tl-trbadge.has-transition[data-tr-for="${second}"]`)).toBeVisible();
    // the preview renders the wipe: left half red (outgoing), right half green (incoming) mid-transition
    const mid = (lay[1].start + lay[0].end) / 2;
    await seek(page, mid);
    await expect.poll(async () => isRed(await monitorPixel(page, 0.05, 0.12)), { timeout: 10000 }).toBe(true);
    await expect.poll(async () => isGreen(await monitorPixel(page, 0.95, 0.12)), { timeout: 10000 }).toBe(true);

    // --- audio from the bin via the toolbar, then fades in the inspector
    await seek(page, 0.5);
    await page.locator('.tl-toolbar .btn', { hasText: 'Audio' }).click();
    await page.locator('.menu .menu-item', { hasText: 'music' }).click();
    p = await getProject(page);
    expect(p.tracks.audio.length).toBe(1);
    const aud = p.tracks.audio[0];
    expect(aud.mediaId).toBe(music);
    expect(aud.start).toBeCloseTo(0.5, 2);
    await expect(page.locator(`.tl-clip-audio[data-clip-id="${aud.id}"]`)).toBeVisible();
    await expect(page.locator(`.tl-clip-audio[data-clip-id="${aud.id}"] canvas.tl-wave`)).toBeVisible();
    const insp = page.locator('.insp');
    await expect(insp.locator('.panel-title')).toHaveText('Audio');
    const fadeIn = insp.locator('.slider', { has: page.locator('.slider-label', { hasText: /^Fade in$/ }) }).locator('input');
    const fadeOut = insp.locator('.slider', { has: page.locator('.slider-label', { hasText: /^Fade out$/ }) }).locator('input');
    await fadeIn.fill('1.5');
    await fadeOut.fill('2');
    p = await getProject(page);
    expect(p.tracks.audio[0].fadeIn).toBeCloseTo(1.5, 2);
    expect(p.tracks.audio[0].fadeOut).toBeCloseTo(2, 2);
    await expect(page.locator(`.tl-clip-audio[data-clip-id="${aud.id}"] .tl-fade-in`)).toBeVisible();
    // fit to video end trims the music to the main track
    await insp.locator('.btn', { hasText: 'Fit to video end' }).click();
    p = await getProject(page);
    lay = await layout(page);
    expect(p.tracks.audio[0].start + (p.tracks.audio[0].out - p.tracks.audio[0].in)).toBeCloseTo(lay[lay.length - 1].end, 2);

    // --- text overlay: T adds a title at the playhead, the inspector text field is focused
    await page.locator('.tl-row-video').click({ position: { x: 5, y: 5 } }); // deselect + keyboard focus back on the page
    await seek(page, 1);
    await page.keyboard.press('t');
    p = await getProject(page);
    expect(p.tracks.text.length).toBe(1);
    const txt = p.tracks.text[0];
    expect(txt.start).toBeCloseTo(1, 2);
    const textarea = insp.locator('.insp-textarea textarea');
    await expect(textarea).toBeFocused();
    await page.keyboard.type('Hello Grok');
    p = await getProject(page);
    expect(p.tracks.text[0].text).toBe('Hello Grok');
    await expect(page.locator(`.tl-clip-text[data-clip-id="${txt.id}"]`)).toContainText('Hello Grok');
    await insp.locator('.chip', { hasText: 'Center' }).click();
    p = await getProject(page);
    expect(p.tracks.text[0].style.y).toBeCloseTo(0.5, 3);
    // white title pixels in the middle of the frame
    await seek(page, 2);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const c = document.querySelector('.mon-canvas');
            const d = c.getContext('2d').getImageData(0, Math.floor(c.height * 0.4), c.width, Math.floor(c.height * 0.2)).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 220 && d[i + 2] > 220) n++;
            return n;
          }),
        { timeout: 10000 },
      )
      .toBeGreaterThan(150);
    await textarea.press('Escape'); // blur the field so shortcuts work again

    // --- inspector: filters on a video clip (slider + look preset)
    p = await getProject(page);
    const firstClip = p.tracks.video[0].id;
    await page.locator(`.tl-clip-video[data-clip-id="${firstClip}"]`).click();
    await expect(insp.locator('.panel-title')).toHaveText('Clip');
    const brightness = insp.locator('.slider', { has: page.locator('.slider-label', { hasText: /^Brightness$/ }) }).locator('input');
    await brightness.fill('1.5');
    p = await getProject(page);
    expect(p.tracks.video[0].filters.brightness).toBeCloseTo(1.5, 3);
    await expect(page.locator(`.tl-clip-video[data-clip-id="${firstClip}"] .tl-badge-icon[title="Color filter"]`)).toBeVisible();
    await insp.locator('.insp-look[data-preset="noir"]').click();
    p = await getProject(page);
    expect(p.tracks.video[0].filters.grayscale).toBe(1);
    expect(p.tracks.video[0].filters.brightness).toBe(1);
    await seek(page, 0.5);
    await expect
      .poll(async () => {
        const [r, g, b] = await monitorPixel(page, 0.3, 0.2);
        return Math.abs(r - g) < 12 && Math.abs(g - b) < 12;
      }, { timeout: 10000 })
      .toBe(true);
    // speed chip
    await insp.locator('.chip', { hasText: /^2×$/ }).click();
    p = await getProject(page);
    expect(p.tracks.video[0].speed).toBe(2);

    // --- drop a bin item onto the start of the main track
    const vRow = await page.locator('.tl-row-video').boundingBox();
    const scrollBox = await page.locator('.tl-scroll').boundingBox();
    const header = await page.locator('.tl-row-video .tl-row-head').boundingBox();
    const dropX = scrollBox.x + header.width + 4;
    const dropY = vRow.y + vRow.height / 2;
    await page.evaluate(
      ({ id, x, y }) => {
        const body = document.querySelector('.tl-body');
        const dt = new DataTransfer();
        dt.setData('application/x-gis-media', JSON.stringify([id]));
        for (const type of ['dragenter', 'dragover', 'drop']) body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      },
      { id: blue, x: dropX, y: dropY },
    );
    p = await getProject(page);
    expect(p.tracks.video.length).toBe(3);
    expect(p.tracks.video[0].mediaId).toBe(blue);
    // dropping audio media onto an audio lane places it at the drop time
    const aRow = await page.locator('.tl-row-audio').first().boundingBox();
    await page.evaluate(
      ({ id, x, y }) => {
        const body = document.querySelector('.tl-body');
        const dt = new DataTransfer();
        dt.setData('application/x-gis-media', JSON.stringify([id]));
        for (const type of ['dragover', 'drop']) body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      },
      { id: music, x: dropX + 150, y: aRow.y + aRow.height / 2 },
    );
    p = await getProject(page);
    expect(p.tracks.audio.length).toBe(2);

    // --- a video file dropped from the OS is imported, then placed at the end of the main track
    const nVideo = (await getProject(page)).tracks.video.length;
    await page.evaluate(() => {
      const sc = document.querySelector('.tl-scroll');
      sc.scrollLeft = sc.scrollWidth;
    });
    await page.waitForTimeout(100);
    const lastBox = await page.locator('.tl-clip-video').last().boundingBox();
    const endX = lastBox.x + lastBox.width + 20;
    await page.evaluate(
      async ({ x, y }) => {
        const bytes = await (await fetch('https://assets.grok.com/test/clip-cyan.webm')).arrayBuffer();
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'dropped clip.webm', { type: 'video/webm' }));
        const body = document.querySelector('.tl-body');
        for (const type of ['dragover', 'drop']) body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      },
      { x: endX, y: dropY },
    );
    await expect.poll(async () => (await getProject(page)).tracks.video.length, { timeout: 30000 }).toBe(nVideo + 1);
    p = await getProject(page);
    expect(p.media[p.tracks.video[p.tracks.video.length - 1].mediaId].name).toBe('dropped clip');

    // --- drag an audio clip in time and down onto a new lane: one undo step
    await page.evaluate(() => (document.querySelector('.tl-scroll').scrollLeft = 0));
    await page.waitForTimeout(100);
    p = await getProject(page);
    const movable = p.tracks.audio.find((c) => (c.lane || 0) === 0);
    const audioEl = page.locator(`.tl-clip-audio[data-clip-id="${movable.id}"]`);
    const ab = await audioEl.boundingBox();
    const zoomNow = (await ui(page)).zoom;
    await setUi(page, { snapping: false });
    await drag(page, { x: ab.x + 40, y: ab.y + ab.height / 2 }, { x: ab.x + 40 + zoomNow, y: ab.y + ab.height * 2.2 }, 14);
    p = await getProject(page);
    const moved = p.tracks.audio.find((c) => c.id === movable.id);
    expect(moved.lane).toBeGreaterThanOrEqual(1);
    expect(moved.start).toBeGreaterThan(movable.start + 0.8);
    expect(moved.start).toBeLessThan(movable.start + 1.2);
    await page.keyboard.press('Control+z');
    p = await getProject(page);
    expect(p.tracks.audio.find((c) => c.id === movable.id).start).toBeCloseTo(movable.start, 5);

    // --- grab the composited frame into the bin (full output resolution)
    const before = (await getProject(page)).mediaOrder.length;
    await page.locator('.mon-right [title^="Grab this frame"]').click();
    await page.locator('.menu .menu-item', { hasText: 'Add to the bin' }).click();
    await expect.poll(async () => (await getProject(page)).mediaOrder.length, { timeout: 20000 }).toBe(before + 1);
    p = await getProject(page);
    const frame = p.media[p.mediaOrder[0]];
    expect(frame).toMatchObject({ kind: 'image', origin: 'frame' });
    await expect.poll(async () => (await getProject(page)).media[frame.id].status, { timeout: 20000 }).toBe('ready');
    p = await getProject(page);
    expect(p.media[frame.id].width).toBe(p.settings.width);
    expect(p.media[frame.id].height).toBe(p.settings.height);

    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('keyboard shortcuts, markers, copy/paste, context menu', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4']);
    await addToTimeline(page, ids);
    const fps = (await getProject(page)).settings.fps;
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    expect((await ui(page)).playhead).toBeCloseTo(1 / fps, 4);
    await page.keyboard.press('Shift+ArrowRight');
    expect((await ui(page)).playhead).toBeCloseTo(1 + 1 / fps, 3);
    await page.keyboard.press('ArrowDown'); // next cut = end of clip 1 (4 s)
    expect((await ui(page)).playhead).toBeCloseTo(4, 3);
    await page.keyboard.press('End');
    expect((await ui(page)).playhead).toBeCloseTo(7, 1);
    await page.keyboard.press('ArrowUp');
    expect((await ui(page)).playhead).toBeCloseTo(4, 3);
    // markers
    await page.keyboard.press('m');
    let p = await getProject(page);
    expect(p.markers.length).toBe(1);
    expect(p.markers[0].time).toBeCloseTo(4, 3);
    await expect(page.locator('.tl-marker')).toHaveCount(1);
    // J/K/L
    await page.keyboard.press('Home');
    await page.keyboard.press('l');
    await expect.poll(async () => (await ui(page)).playing).toBe(true);
    await page.keyboard.press('k');
    await expect.poll(async () => (await ui(page)).playing).toBe(false);
    // select all, copy, paste at the end, duplicate, delete
    p = await getProject(page);
    await page.locator(`.tl-clip-video[data-clip-id="${p.tracks.video[1].id}"]`).click();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('End');
    await page.keyboard.press('Control+v');
    p = await getProject(page);
    expect(p.tracks.video.length).toBe(3);
    expect(p.tracks.video[2].mediaId).toBe(ids[1]);
    expect((await ui(page)).selection).toEqual([p.tracks.video[2].id]);
    await page.keyboard.press('Control+d');
    p = await getProject(page);
    expect(p.tracks.video.length).toBe(4);
    await page.keyboard.press('Delete');
    p = await getProject(page);
    expect(p.tracks.video.length).toBe(3);
    await page.keyboard.press('Escape');
    expect((await ui(page)).selection).toEqual([]);
    // Ctrl+D with nothing selected stays ours: a hint, and the default (the browser's bookmark dialog) is prevented
    await page.evaluate(() => window.addEventListener('keydown', (e) => (window.__lastKey = { key: e.key, prevented: e.defaultPrevented })));
    await page.keyboard.press('Control+d');
    expect(await page.evaluate(() => window.__lastKey)).toEqual({ key: 'd', prevented: true });
    await expect(page.locator('.toast', { hasText: 'Nothing to duplicate' })).toBeVisible();
    expect((await getProject(page)).tracks.video.length).toBe(3);
    // context menu on a clip
    await page.locator(`.tl-clip-video[data-clip-id="${p.tracks.video[0].id}"]`).click({ button: 'right' });
    await expect(page.locator('.menu')).toBeVisible();
    await expect(page.locator('.menu .menu-item', { hasText: 'Detach audio' })).toBeVisible();
    await page.locator('.menu .menu-item', { hasText: 'Duplicate' }).click();
    p = await getProject(page);
    expect(p.tracks.video.length).toBe(4);
    // 'timeline.reveal' from another tab switches to Edit, selects the clip and moves the playhead to it
    p = await getProject(page);
    await page.locator('.app-tabs .tab').first().click();
    await page.evaluate((id) => window.__gis.appState.appEvents.emit('timeline.reveal', { clipId: id }), p.tracks.video[2].id);
    await expect(page.locator('.view-edit')).toBeVisible();
    await expect.poll(async () => (await ui(page)).selection).toEqual([p.tracks.video[2].id]);
    const lay2 = await layout(page);
    expect((await ui(page)).playhead).toBeCloseTo(lay2[2].start, 3);
    await page.keyboard.press('Escape');
    // zoom shortcuts
    const z0 = (await ui(page)).zoom;
    await page.keyboard.press('=');
    expect((await ui(page)).zoom).toBeGreaterThan(z0);
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    expect((await ui(page)).zoom).toBeLessThan(z0);
    // ctrl + wheel zooms around the cursor
    const z1 = (await ui(page)).zoom;
    const tb = await page.locator('.tl-scroll').boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + 40);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -240);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await ui(page)).zoom).toBeGreaterThan(z1);
    // reverse shuttle (J) moves backwards, K stops
    await seek(page, 3);
    await page.keyboard.press('j');
    await page.waitForTimeout(700);
    const back = (await ui(page)).playhead;
    expect(back).toBeLessThan(2.85);
    expect(back).toBeGreaterThan(1.5);
    await page.keyboard.press('k');
    await expect.poll(async () => (await ui(page)).playing).toBe(false);
    // loop playback wraps around at the end of the sequence
    const dur = await page.evaluate(() => window.__gis.model.sequenceDuration(window.__gis.projectStore.get()));
    await page.locator('.mon-right [title^="Loop"]').click();
    await seek(page, dur - 0.3);
    await page.keyboard.press('Space');
    await page.waitForTimeout(1200);
    const looped = await ui(page);
    expect(looped.playing).toBe(true);
    expect(looped.playhead).toBeLessThan(dur - 0.3);
    await page.keyboard.press('Space');
    await expect(page.locator('.mon-loop-badge')).toBeVisible();
    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

/** Attaches a level meter to the player's master bus; returns a function reading its current RMS. */
async function installMeter(page) {
  await page.evaluate(() => {
    const out = window.__gis.edit.player.outputNode;
    const an = out.context.createAnalyser();
    an.fftSize = 2048;
    out.connect(an);
    window.__rms = () => {
      const d = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(d);
      let s = 0;
      for (const v of d) s += v * v;
      return Math.sqrt(s / d.length);
    };
  });
  return () => page.evaluate(() => window.__rms());
}

test('preview sound: clip audio survives pause/resume, K then L, seeks; mute silences it', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4']); // 440 Hz / 660 Hz tones
    await addToTimeline(page, ids);
    const rms = await installMeter(page);
    const play = page.locator('.mon-play');
    const loud = async (label) => expect.poll(rms, { timeout: 4000, message: label }).toBeGreaterThan(0.01);
    await play.click();
    await loud('first play');
    await play.click(); // pause inside the first clip
    await expect.poll(rms, { timeout: 3000 }).toBeLessThan(0.002);
    await play.click(); // resume inside the same clip: its sound must come back (it stayed silent before the fix)
    await loud('resume inside the same clip');
    await page.keyboard.press('k');
    await expect.poll(async () => (await ui(page)).playing).toBe(false);
    await page.keyboard.press('l');
    await loud('K then L');
    await page.keyboard.press('Space');
    await seek(page, 0.5);
    await page.keyboard.press('Space');
    await loud('paused seek, then play');
    await page.locator('.mon-vol-btn').click(); // wide monitor: mute toggle
    await expect.poll(rms, { timeout: 3000 }).toBeLessThan(0.002);
    await page.locator('.mon-vol-btn').click();
    await loud('unmuted');
    await page.keyboard.press('Space');
    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('a new title takes the keyboard in every layout (drawer, collapsed inspector, "Edit text")', async () => {
  const ctx = await launch({ viewport: { width: 480, height: 900 } });
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4']);
    await addToTimeline(page, ids);
    await expect(page.locator('.edit-view')).toHaveClass(/is-narrow/);
    // narrow: the inspector is closed (it opens as a sheet over the timeline) — T then typing must type into the title
    await seek(page, 1);
    await page.keyboard.press('t');
    await page.keyboard.type('Summer');
    let p = await getProject(page);
    expect(p.tracks.text.map((c) => c.text)).toEqual(['Summer']);
    expect(p.tracks.video.length).toBe(2); // no "S" split
    expect(p.markers.length).toBe(0); // no "M" marker
    await expect(page.locator('.edit-insp-sheet .insp-textarea textarea')).toBeFocused();
    await page.keyboard.press('Escape'); // leave the field
    await page.keyboard.press('Escape'); // close the sheet
    await expect(page.locator('.edit-insp-sheet')).toHaveCount(0);

    // wide with the inspector collapsed
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.edit-view')).not.toHaveClass(/is-narrow/);
    await page.locator('.insp-header [title="Hide inspector"]').click();
    await expect(page.locator('.edit-insp')).toHaveCount(0);
    await seek(page, 5);
    await page.keyboard.press('t');
    await page.keyboard.type('Winter');
    p = await getProject(page);
    expect(p.tracks.text.map((c) => c.text).sort()).toEqual(['Summer', 'Winter']);
    expect(p.tracks.video.length).toBe(2);
    await page.keyboard.press('Escape');

    // "Edit text" from the context menu with the inspector collapsed again
    await page.locator('.insp-header [title="Hide inspector"]').click();
    const first = p.tracks.text.find((c) => c.text === 'Summer');
    await page.locator(`.tl-clip-text[data-clip-id="${first.id}"]`).click({ button: 'right' });
    await page.locator('.menu .menu-item', { hasText: 'Edit text' }).click();
    await page.keyboard.type('Autumn');
    p = await getProject(page);
    expect(p.tracks.text.find((c) => c.id === first.id).text).toBe('Autumn');
    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('Ken Burns framing pad, marker drag, start-edge snapping, audio trim floor, edge auto-scroll, slider drag', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4', 'still.png', 'music.mp3']);
    const [red, green, still, music] = ids;
    await addToTimeline(page, [red, green, still]);
    const insp = page.locator('.insp');
    const sliderInput = (label) => insp.locator('.slider', { has: page.locator('.slider-label', { hasText: new RegExp(`^${label}$`) }) }).locator('input');

    // --- Ken Burns pad: only the framing being edited reacts; dragging it is one undo step
    let p = await getProject(page);
    const stillClip = p.tracks.video[2];
    await page.locator(`.tl-clip-video[data-clip-id="${stillClip.id}"]`).click();
    await sliderInput('Start zoom').fill('1.6');
    const pad = page.locator('.insp-kb-pad');
    await pad.scrollIntoViewIfNeeded();
    const fromBox = await page.locator('.insp-kb-rect.is-from').boundingBox();
    const kb0 = (await getProject(page)).tracks.video[2].kenBurns;
    await drag(page, { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 }, { x: fromBox.x + fromBox.width / 2 - 25, y: fromBox.y + fromBox.height / 2 - 12 }, 8);
    let kb = (await getProject(page)).tracks.video[2].kenBurns;
    expect(kb.from.x).toBeLessThan(kb0.from.x - 0.03);
    expect(kb.from.y).toBeLessThan(kb0.from.y - 0.03);
    expect(kb.to).toEqual(kb0.to); // the end framing (drawn on top of it before) is untouched
    await page.keyboard.press('Control+z');
    expect((await getProject(page)).tracks.video[2].kenBurns.from).toEqual(kb0.from);
    // End framing: pressing outside its box centres it there
    await page.locator('.insp-kb-switch button', { hasText: 'End framing' }).click();
    await sliderInput('End zoom').fill('2');
    const pb = await pad.boundingBox();
    await page.mouse.click(pb.x + pb.width * 0.8, pb.y + pb.height * 0.7);
    kb = (await getProject(page)).tracks.video[2].kenBurns;
    expect(kb.to.x).toBeCloseTo(0.75, 2); // clamped so the half-size window stays inside the frame
    expect(kb.to.y).toBeCloseTo(0.7, 1);
    expect(kb.from).toEqual(kb0.from);

    // --- markers: click goes there, drag moves it (one undo step)
    await setUi(page, { snapping: false });
    await seek(page, 2);
    await page.keyboard.press('m');
    const zoom = (await ui(page)).zoom;
    const marker = page.locator('.tl-marker').first();
    const mc = await center(marker);
    await drag(page, mc, { x: mc.x + zoom, y: mc.y }, 10);
    p = await getProject(page);
    expect(p.markers[0].time).toBeGreaterThan(2.85);
    expect(p.markers[0].time).toBeLessThan(3.15);
    await page.keyboard.press('Control+z');
    expect((await getProject(page)).markers[0].time).toBeCloseTo(2, 5);
    await seek(page, 0);
    await page.locator('.tl-marker').first().click();
    expect((await ui(page)).playhead).toBeCloseTo(2, 3);
    await page.locator('.tl-marker').first().dblclick(); // still renames (the drag gesture doesn't swallow it)
    await page.locator('.modal input.text-field').fill('Drop');
    await page.locator('.modal button', { hasText: 'Save' }).click();
    expect((await getProject(page)).markers[0].label).toBe('Drop');

    // --- the start edge of a main-track clip snaps (to the playhead here)
    await setUi(page, { snapping: true });
    await seek(page, 1);
    p = await getProject(page);
    const first = p.tracks.video[0];
    const inHandle = page.locator(`.tl-clip[data-clip-id="${first.id}"] .tl-trim-in`);
    const ib = await inHandle.boundingBox();
    const clipBox = await page.locator(`.tl-clip[data-clip-id="${first.id}"]`).boundingBox();
    await drag(page, { x: ib.x + ib.width / 2, y: ib.y + ib.height / 2 }, { x: clipBox.x + zoom * 1 + 3, y: ib.y + ib.height / 2 }, 12);
    p = await getProject(page);
    expect(p.tracks.video[0].in).toBeCloseTo(1, 6); // exactly on the playhead
    await page.keyboard.press('Control+z');

    // --- extending an audio clip's start past 0 stops where its sound would slip
    await page.evaluate((id) => {
      const { projectStore, model } = window.__gis;
      projectStore.update((q) => model.addAudioClip(q, id, { start: 1, in: 2, out: 8 }).project, { label: 'Add audio' });
    }, music);
    p = await getProject(page);
    const aud = p.tracks.audio[0];
    const aIn = page.locator(`.tl-clip-audio[data-clip-id="${aud.id}"] .tl-trim-in`);
    const ab = await aIn.boundingBox();
    const scrollBox = await page.locator('.tl-scroll').boundingBox();
    await drag(page, { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 }, { x: scrollBox.x + 10, y: ab.y + ab.height / 2 }, 14); // over the track header
    let a2 = (await getProject(page)).tracks.audio[0];
    expect(a2.start).toBeCloseTo(0, 6);
    expect(a2.in).toBeCloseTo(1, 6); // in - start unchanged: still in sync
    await page.keyboard.press('Control+z');

    // --- moving a clip past the visible edge: the timeline scrolls and the clip stays under the pointer
    await setUi(page, { snapping: false, zoom: 200 });
    await page.waitForTimeout(150);
    await page.evaluate(() => (document.querySelector('.tl-scroll').scrollLeft = 0));
    await page.waitForTimeout(150);
    const header = (await page.locator('.tl-row-audio .tl-row-head').first().boundingBox()).width;
    const timeAt = (x) => page.evaluate(([cx, hx, sx]) => (cx - sx - hx + document.querySelector('.tl-scroll').scrollLeft) / window.__gis.uiStore.get().zoom, [x, header, scrollBox.x]);
    const audBox = await page.locator(`.tl-clip-audio[data-clip-id="${aud.id}"]`).boundingBox();
    const grab = { x: audBox.x + 30, y: audBox.y + audBox.height / 2 };
    const t0 = await timeAt(grab.x);
    const edgeX = scrollBox.x + scrollBox.width - 6;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(grab.x + ((edgeX - grab.x) * i) / 12, grab.y);
    for (let i = 0; i < 20; i++) await page.mouse.move(edgeX + (i % 2), grab.y);
    const t1 = await timeAt(edgeX + 1);
    await page.mouse.up();
    const scrolled = await page.evaluate(() => document.querySelector('.tl-scroll').scrollLeft);
    expect(scrolled).toBeGreaterThan(50);
    a2 = (await getProject(page)).tracks.audio[0];
    expect(Math.abs(a2.start - (aud.start + (t1 - t0)))).toBeLessThan(0.05);

    // --- a real drag on an inspector slider: live update, one undo step
    await page.evaluate(() => (document.querySelector('.tl-scroll').scrollLeft = 0));
    await page.keyboard.press('\\'); // fit
    await page.waitForTimeout(200);
    p = await getProject(page);
    await page.locator(`.tl-clip-video[data-clip-id="${p.tracks.video[1].id}"]`).click();
    await expect(insp.locator('.panel-title')).toHaveText('Clip');
    await page.waitForTimeout(100); // the inspector scrolls back to the top for a new clip
    await sliderInput('Brightness').scrollIntoViewIfNeeded();
    const br = await sliderInput('Brightness').boundingBox();
    await drag(page, { x: br.x + br.width / 2, y: br.y + br.height / 2 }, { x: br.x + br.width * 0.8, y: br.y + br.height / 2 }, 10);
    p = await getProject(page);
    expect(p.tracks.video[1].filters.brightness).toBeGreaterThan(1.4);
    await page.keyboard.press('Control+z');
    p = await getProject(page);
    expect(M_neutral(p.tracks.video[1].filters)).toBe(true);
    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

/** filters null or all at their defaults */
function M_neutral(f) {
  if (!f) return true;
  return f.brightness === 1 && f.contrast === 1 && f.saturate === 1 && !f.hue && !f.grayscale && !f.sepia && !f.invert && !f.blur && !f.vignette;
}

test('monitor: double-click = full screen only, click = play/pause, J/L buttons, narrow transport menu + volume popover', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4']);
    await addToTimeline(page, ids);
    const changes = [];
    await page.exposeFunction('__playingChanged', (v) => changes.push(v));
    await page.evaluate(() => window.__gis.uiStore.subscribe((s, prev) => s.playing !== prev.playing && window.__playingChanged(s.playing)));
    const stage = await center(page.locator('.mon-stage'));
    await page.mouse.dblclick(stage.x, stage.y);
    await expect(page.locator('.mon.is-expanded, .mon.is-fullscreen')).toHaveCount(1);
    await page.waitForTimeout(400);
    expect(changes).toEqual([]); // no play + pause on the way
    await page.locator('.mon-right [title^="Exit full screen"]').click();
    await expect(page.locator('.mon.is-expanded, .mon.is-fullscreen')).toHaveCount(0);
    // a single click still plays / pauses (clicks further apart than a double click)
    await page.mouse.click(stage.x, stage.y);
    await expect.poll(async () => (await ui(page)).playing).toBe(true);
    await page.waitForTimeout(700);
    await page.mouse.click(stage.x, stage.y);
    await expect.poll(async () => (await ui(page)).playing).toBe(false);
    // shuttle buttons
    const rate = () => page.evaluate(() => ({ playing: window.__gis.edit.player.playing, rate: window.__gis.edit.player.rate }));
    await seek(page, 2);
    await page.locator('.mon-buttons [title^="Fast forward"]').click();
    await expect.poll(rate).toEqual({ playing: true, rate: 2 });
    await page.locator('.mon-buttons [title^="Fast forward"]').click();
    await expect.poll(rate).toEqual({ playing: true, rate: 4 });
    await page.locator('.mon-buttons [title^="Play backwards"]').click();
    await expect.poll(rate).toEqual({ playing: true, rate: -1 });
    await page.keyboard.press('k');
    await expect.poll(rate).toEqual({ playing: false, rate: 1 });

    // narrow: cut / shuttle buttons move into a menu, the volume slider into a popover
    await page.setViewportSize({ width: 480, height: 900 });
    await expect(page.locator('.mon-more')).toBeVisible();
    await expect(page.locator('.mon-buttons [title^="Fast forward"]')).toBeHidden();
    await expect(page.locator('.mon-volume .mon-vol')).toBeHidden();
    await page.locator('.mon-vol-btn').click();
    await expect(page.locator('.mon-vol-pop')).toBeVisible();
    await page.locator('.mon-vol-pop .mon-vol-range').fill('0.3');
    expect(await page.evaluate(() => window.__gis.edit.player.volume)).toBeCloseTo(0.3, 2);
    await page.keyboard.press('Escape');
    await expect(page.locator('.mon-vol-pop')).toHaveCount(0);
    await seek(page, 1);
    await page.locator('.mon-more').click();
    await page.locator('.menu .menu-item', { hasText: 'Next cut' }).click();
    expect((await ui(page)).playhead).toBeCloseTo(4, 3);
    const overflow = await page.evaluate(() => {
      const el = document.querySelector('.mon-transport');
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    // grab frame -> download confirms with a toast
    await page.locator('.mon-right [title^="Grab this frame"]').click();
    await page.locator('.menu .menu-item', { hasText: 'Download PNG' }).click();
    await expect(page.locator('.toast-success', { hasText: 'Frame saved as' })).toBeVisible({ timeout: 15000 });
    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('selection hygiene, reveal in bin, failed audio link leaves nothing behind', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4']);
    await addToTimeline(page, ids);
    // a selected clip removed by undo: Delete afterwards must not record an empty step
    await seek(page, 1);
    await page.keyboard.press('t');
    await page.keyboard.press('Escape'); // leave the title field
    await page.keyboard.press('Control+z'); // removes the title (still selected a moment ago)
    await expect.poll(async () => (await ui(page)).selection).toEqual([]);
    await expect(page.locator('.tl-toolbar [title^="Delete selected"]')).toBeDisabled();
    const hist = () => page.evaluate(() => ({ undo: window.__gis.projectStore.undoLabel(), can: window.__gis.projectStore.canUndo() }));
    const before = await hist();
    await page.keyboard.press('Delete');
    expect(await hist()).toEqual(before);
    // ids of clips that no longer exist (selection set before the project changed): no empty steps either
    await setUi(page, { selection: ['clp_gone'] });
    await page.locator('.tl-toolbar [title^="Duplicate selected"]').click();
    await page.locator('.tl-toolbar [title^="Delete selected"]').click();
    expect(await hist()).toEqual(before);
    expect((await ui(page)).selection).toEqual([]);
    // clicking the active option again records nothing either
    let p = await getProject(page);
    await page.locator(`.tl-clip-video[data-clip-id="${p.tracks.video[0].id}"]`).click();
    const h1 = await hist();
    await page.locator('.insp .segmented button', { hasText: 'Fill' }).click();
    expect(await hist()).toEqual(h1);

    // reveal in bin: opens the (collapsed) bin and selects + flashes the item there
    await page.locator('.edit-bin [title="Hide bin"]').click();
    await expect(page.locator('.edit-bin')).toHaveCount(0);
    await page.locator(`.tl-clip-video[data-clip-id="${p.tracks.video[1].id}"]`).click({ button: 'right' });
    await page.locator('.menu .menu-item', { hasText: 'Reveal in bin' }).click();
    const item = page.locator(`.edit-bin .bin-compact-item[data-media-id="${p.tracks.video[1].mediaId}"]`);
    await expect(item).toHaveClass(/is-selected/);
    expect(await item.evaluate((el) => el.getAnimations().some((a) => a.id === 'gis-reveal'))).toBe(true); // the flash
    expect((await ui(page)).binSelection).toEqual([]); // the Clips tab's selection is left alone

    // a link that can't be downloaded: error toast with "Try again", and no broken item left in the bin
    const binBefore = (await getProject(page)).mediaOrder.length;
    await page.locator('.tl-toolbar .btn', { hasText: 'Audio' }).click();
    await page.locator('.menu .menu-item', { hasText: 'From a link' }).click();
    await page.locator('.modal input.text-field').fill('https://assets.grok.com/test/does-not-exist.mp3');
    await page.locator('.modal button', { hasText: 'Add audio' }).click();
    const err = page.locator('.toast-error', { hasText: 'Could not download' });
    await expect(err).toBeVisible({ timeout: 20000 });
    await expect(err.locator('.toast-action', { hasText: 'Try again' })).toBeVisible();
    p = await getProject(page);
    expect(p.mediaOrder.length).toBe(binBefore);
    expect(Object.values(p.media).some((m) => m.status === 'error')).toBe(false);
    // the console error comes from the deliberate 404 fetch
    expect(ctx.consoleErrors.filter((e) => !/favicon|404|does-not-exist|Failed to load resource/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

for (const [width, height] of [
  [1440, 900],
  [480, 900],
  [1280, 440],
  [820, 460],
]) {
  test(`layout at ${width}×${height}: monitor, timeline, inspector/bin placement and empty states`, async () => {
    const ctx = await launch({ viewport: { width, height } });
    try {
      const page = await openStudioTab(ctx);
      await page.locator('.app-tabs .tab', { hasText: /Edit/ }).click();
      // empty timeline teaches drag & drop
      await expect(page.locator('.tl-empty')).toBeVisible();
      await expect(page.locator('.tl-empty-card')).toContainText('Drag clips');
      await expect(page.locator('.mon-empty')).toBeVisible();
      const ids = await seedMedia(page, ['clip-red.mp4', 'clip-vertical.mp4', 'still.png', 'voice.wav'], { timeout: 60000 });
      await expect(page.locator('.tl-empty .btn-primary')).toContainText('Add all 3 clips');
      await page.locator('.tl-empty .btn-primary').click();
      await expect(page.locator('.tl-clip-video')).toHaveCount(3);
      await expect(page.locator('.tl-empty')).toHaveCount(0);
      await page.evaluate((id) => {
        const { projectStore, model } = window.__gis;
        projectStore.update((p) => {
          let q = model.addAudioClip(p, id, { start: 1 }).project;
          q = model.addTextClip(q, { text: 'Layout check', start: 0.5, duration: 3 }).project;
          return model.setTransition(q, q.tracks.video[1].id, { type: 'circle-open', duration: 0.8 });
        });
      }, ids[3]);
      const view = page.locator('.edit-view');
      if (height < 500) {
        // wide but low (bottom dock): monitor and timeline side by side, panels as drawers
        await expect(view).toHaveClass(/is-short/);
        const mon = await page.locator('.mon').boundingBox();
        const tl = await page.locator('.tl').boundingBox();
        expect(tl.x).toBeGreaterThanOrEqual(mon.x + mon.width - 1);
        expect(tl.height).toBeGreaterThan(300);
        await expect(page.locator('.tl-row-audio')).toBeVisible();
        // the inspector: a third column when wide enough, else a sheet over the timeline — never over the monitor
        await page.locator('.edit-fab[title="Inspector"]').click();
        await expect(page.locator(width >= 1040 ? '.edit-view > .edit-insp .insp' : '.edit-insp-sheet .insp')).toBeVisible();
        await expect(page.locator('.edit-drawer-backdrop')).toHaveCount(0);
        expect(await monitorUncovered(page)).toBe(true);
        await page.waitForTimeout(250); // slide-in
        await page.screenshot({ path: shotPath(`edit-${width}x${height}-inspector.png`) });
        await page.keyboard.press('Escape');
        await expect(page.locator('.insp')).toHaveCount(0);
      } else if (width < 760) {
        await expect(view).toHaveClass(/is-narrow/);
        await expect(page.locator('.edit-insp')).toHaveCount(0);
        await page.locator('.edit-fab[title="Inspector"]').click();
        await expect(page.locator('.edit-insp-sheet .insp')).toBeVisible();
        await expect(page.locator('.edit-drawer-backdrop')).toHaveCount(0);
        expect(await monitorUncovered(page)).toBe(true);
        await page.waitForTimeout(250); // slide-in
        await page.screenshot({ path: shotPath(`edit-${width}-inspector.png`) });
        await page.keyboard.press('Escape');
        await expect(page.locator('.edit-insp-sheet')).toHaveCount(0);
        await page.locator('.edit-fab[title^="Bin"]').click();
        await expect(page.locator('.edit-drawer-left .bin-compact')).toBeVisible();
        await page.locator('.edit-drawer-backdrop').click({ position: { x: width - 10, y: 300 } });
        await expect(page.locator('.edit-drawer')).toHaveCount(0);
      } else {
        await expect(view).not.toHaveClass(/is-narrow/);
        await expect(page.locator('.edit-insp .insp')).toBeVisible();
        await expect(page.locator('.edit-bin .bin-compact')).toBeVisible();
      }
      // real HTML5 drag from the bin (BinCompact) onto the main track
      const before = (await getProject(page)).tracks.video.length;
      const drawerLayout = width < 760 || height < 500;
      if (drawerLayout) await page.locator('.edit-fab[title^="Bin"]').click();
      const binItem = page.locator(`.bin-compact-item[data-media-id="${ids[0]}"]`);
      const sb = await binItem.boundingBox();
      const vb = await page.locator('.tl-row-video').boundingBox();
      const visible = await page.locator('.tl-scroll').boundingBox();
      const target = { x: visible.x + visible.width - 40, y: vb.y + vb.height / 2 };
      await page.mouse.move(sb.x + 30, sb.y + sb.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 16; i++) await page.mouse.move(sb.x + 30 + ((target.x - sb.x - 30) * i) / 16, sb.y + sb.height / 2 + ((target.y - sb.y - sb.height / 2) * i) / 16);
      await page.mouse.up();
      await expect.poll(async () => (await getProject(page)).tracks.video.length).toBe(before + 1);
      if (drawerLayout) await expect(page.locator('.edit-drawer')).toHaveCount(0);
      // nothing overflows horizontally
      const overflow = await page.evaluate(() => {
        const v = document.querySelector('.edit-view');
        return [...v.querySelectorAll('.mon-transport, .tl-toolbar')].map((el) => el.scrollWidth - el.clientWidth);
      });
      expect(Math.max(...overflow)).toBeLessThanOrEqual(1);
      // toolbar labels follow the toolbar's own width (Audio is the last label to go)
      const labels = await page.locator('.tl-toolbar .tl-tool-btn').evaluateAll((els) => els.map((e) => e.textContent.trim()));
      if (width >= 1440) expect(labels).toEqual(['Text', 'Audio', 'Transitions']);
      else expect(labels).toContain('Audio');
      const canvas = await page.locator('.mon-canvas').boundingBox();
      const stage = await page.locator('.mon-stage').boundingBox();
      expect(canvas.width).toBeLessThanOrEqual(stage.width + 1);
      expect(canvas.height).toBeLessThanOrEqual(stage.height + 1);
      expect(Math.abs(canvas.width / canvas.height - 16 / 9)).toBeLessThan(0.03);
      await page.locator('.tl-clip-video').nth(1).click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: shotPath(`edit-${width}x${height}.png`) });
      expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
}

test('narrow / bottom-dock layouts: the inspector never covers or dims the monitor, and the timeline stays usable', async () => {
  const ctx = await launch({ viewport: { width: 720, height: 900 } });
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4']);
    await addToTimeline(page, ids);
    const [a, b] = (await getProject(page)).tracks.video;
    const view = page.locator('.edit-view');
    await expect(view).toHaveClass(/is-narrow/);
    // every label fits the default 720 px dock (they used to vanish under 760 px)
    await expect(page.locator('.tl-toolbar .tl-tool-btn')).toHaveText(['Text', 'Audio', 'Transitions']);
    await expect(page.locator('.tl-toolbar .tl-zoom-slider')).toBeVisible();

    // --- 720 (the default dock): a column beside the monitor, the timeline below at full width
    await page.locator(`.tl-clip-video[data-clip-id="${a.id}"]`).click();
    await page.locator('.edit-fab', { hasText: 'Edit clip' }).click();
    const insp = page.locator('.edit-top .edit-insp .insp');
    await expect(insp).toBeVisible();
    await expect(insp.locator('.panel-title')).toHaveText('Clip');
    await expect(page.locator('.edit-drawer-backdrop')).toHaveCount(0);
    const mon = await page.locator('.mon-stage').boundingBox();
    const ib = await insp.boundingBox();
    expect(mon.x + mon.width).toBeLessThanOrEqual(ib.x + 1); // side by side
    expect(mon.width).toBeGreaterThan(380);
    expect(await monitorUncovered(page)).toBe(true);
    expect((await page.locator('.tl').boundingBox()).width).toBeGreaterThan(700);
    // the monitor plays with the inspector open: clicking it no longer closes anything
    await page.mouse.click(mon.x + mon.width / 2, mon.y + mon.height / 2);
    await expect.poll(async () => (await ui(page)).playing).toBe(true);
    await page.keyboard.press('k');
    await expect.poll(async () => (await ui(page)).playing).toBe(false);
    await expect(insp).toBeVisible();
    // scrub on the ruler and pick another clip while adjusting
    const ruler = await page.locator('.tl-ruler').boundingBox();
    await page.mouse.click(ruler.x + 100, ruler.y + ruler.height / 2);
    await expect.poll(async () => (await ui(page)).playhead).toBeGreaterThan(0.3);
    await page.locator(`.tl-clip-video[data-clip-id="${b.id}"]`).click();
    expect((await ui(page)).selection).toEqual([b.id]);
    await expect(insp).toBeVisible();
    // a look picked in the inspector shows in the monitor right away
    await seek(page, 5);
    await insp.locator('.insp-look[data-preset="noir"]').click();
    await expect
      .poll(async () => {
        const [r, g, bl] = await monitorPixel(page, 0.3, 0.2);
        return Math.abs(r - g) < 12 && Math.abs(g - bl) < 12;
      }, { timeout: 10000 })
      .toBe(true);
    await page.screenshot({ path: shotPath('edit-720-inspector-column.png') });
    // '‹ Sequence' deselects (the panel stays and shows the sequence settings); × closes, it never deselects
    await insp.locator('.insp-back').click();
    expect((await ui(page)).selection).toEqual([]);
    await expect(insp.locator('.panel-title')).toHaveText('Sequence');
    await expect(insp.locator('.insp-back')).toHaveCount(0);
    await page.locator(`.tl-clip-video[data-clip-id="${a.id}"]`).click();
    await insp.locator('.insp-close').click();
    await expect(page.locator('.insp')).toHaveCount(0);
    expect((await ui(page)).selection).toEqual([a.id]);
    // the FAB toggles it, Escape closes it first (the selection stays)
    const fab = page.locator('.edit-fab[title="Inspector"]');
    await fab.click();
    await expect(fab).toHaveAttribute('aria-pressed', 'true');
    await expect(insp).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.insp')).toHaveCount(0);
    expect((await ui(page)).selection).toEqual([a.id]);
    await page.keyboard.press('Escape');
    expect((await ui(page)).selection).toEqual([]);

    // --- 480: a sheet over the timeline; the monitor above stays visible and playable
    await page.setViewportSize({ width: 480, height: 900 });
    await fab.click();
    const sheet = page.locator('.edit-insp-sheet .insp');
    await expect(sheet).toBeVisible();
    const mon2 = await page.locator('.mon-stage').boundingBox();
    expect((await sheet.boundingBox()).y).toBeGreaterThanOrEqual(mon2.y + mon2.height - 1);
    expect(await monitorUncovered(page)).toBe(true);
    await page.mouse.click(mon2.x + mon2.width / 2, mon2.y + mon2.height / 2);
    await expect.poll(async () => (await ui(page)).playing).toBe(true);
    await page.keyboard.press('k');
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: shotPath('edit-480-inspector-sheet.png') });
    // a bin item dragged out of the bin drawer: the sheet steps aside so the drop lands on the timeline under it
    const before = (await getProject(page)).tracks.video.length;
    await page.locator('.edit-fab[title^="Bin"]').click();
    await expect(page.locator('.edit-drawer-left .bin-compact')).toBeVisible();
    const sb = await page.locator(`.bin-compact-item[data-media-id="${ids[0]}"]`).boundingBox();
    const vb = await page.locator('.tl-row-video').boundingBox();
    const visible = await page.locator('.tl-scroll').boundingBox(); // the row is wider than the view
    const from = { x: sb.x + 30, y: sb.y + sb.height / 2 };
    const to = { x: visible.x + visible.width - 40, y: vb.y + vb.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 16; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 16, from.y + ((to.y - from.y) * i) / 16);
    await page.mouse.up();
    await expect.poll(async () => (await getProject(page)).tracks.video.length).toBe(before + 1);
    await expect(page.locator('.edit-drawer')).toHaveCount(0);
    await expect(page.locator('.edit-insp-sheet')).toHaveCount(0); // the timeline with the new clip shows
    await fab.click();
    await sheet.locator('.insp-close').click();
    await expect(page.locator('.edit-insp-sheet')).toHaveCount(0);

    // --- dock bottom (wide but low): a third column right of the timeline
    await page.setViewportSize({ width: 1440, height: 495 });
    await expect(view).toHaveClass(/is-short/);
    await fab.click();
    const col = page.locator('.edit-view > .edit-insp .insp');
    await expect(col).toBeVisible();
    const mon3 = await page.locator('.mon-stage').boundingBox();
    const tl = await page.locator('.tl').boundingBox();
    const cb = await col.boundingBox();
    expect(tl.x).toBeGreaterThanOrEqual(mon3.x + mon3.width - 1);
    expect(cb.x).toBeGreaterThanOrEqual(tl.x + tl.width - 1);
    expect(tl.width).toBeGreaterThan(450);
    expect(await monitorUncovered(page)).toBe(true);
    await page.locator('.tl-clip-video').first().click(); // the timeline stays clickable
    await expect(col.locator('.panel-title')).toHaveText('Clip');
    await page.screenshot({ path: shotPath('edit-1440x495-inspector-column.png') });
    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('"Every cut" transitions: Mixed when the cuts differ, Remove all says so, replacing offers Undo; offline clips', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4']);
    await addToTimeline(page, ids);
    await page.evaluate(() => window.__gis.projectStore.update((p) => window.__gis.model.appendMediaToTimeline(p, [p.tracks.video[0].mediaId]).project));
    await page.evaluate(() => {
      const { projectStore, model } = window.__gis;
      projectStore.update(
        (p) => {
          const v = p.tracks.video;
          const q = model.setTransition(p, v[1].id, { type: 'crossfade', duration: 0.6 });
          return model.setTransition(q, v[2].id, { type: 'wipe-left', duration: 0.6 });
        },
        { label: 'Seed transitions' },
      );
    });
    const types = async () => (await getProject(page)).tracks.video.slice(1).map((c) => c.transition?.type || null);
    const seeded = ['crossfade', 'wipe-left', null];
    expect(await types()).toEqual(seeded);
    const pop = page.locator('.tl-pop');
    const openAll = () => page.locator('.tl-toolbar [title="Put one transition on every cut"]').click();

    // mixed cuts: no option claims to be current, the cut option says it removes them all
    await openAll();
    await expect(pop.locator('.tl-pop-title')).toHaveText('Every cut (3)');
    await expect(pop.locator('.tl-pop-current')).toHaveText('Mixed');
    await expect(pop.locator('.tl-pop-current')).toHaveAttribute('title', '2 of 3 cuts have a transition: Dissolve, Wipe left');
    await expect(pop.locator('.tl-tr-opt.is-active')).toHaveCount(0);
    await expect(pop.locator('.tl-tr-cut')).toHaveText('Remove all transitions');
    await page.screenshot({ path: shotPath('edit-every-cut-mixed.png') });
    // one type everywhere replaces the two: a toast offers to put them back (once per popover)
    await pop.locator('.tl-tr-opt[data-transition="fade-black"]').click();
    expect(await types()).toEqual(['fade-black', 'fade-black', 'fade-black']);
    await expect(pop.locator('.tl-pop-current')).toHaveText('Dip to black');
    await expect(pop.locator('.tl-tr-opt.is-active')).toHaveText('Dip to black');
    const replaced = page.locator('.toast', { hasText: 'Dip to black on every cut — replaced 2 transitions' });
    await expect(replaced).toBeVisible();
    await pop.locator('.tl-tr-opt[data-transition="crossfade"]').click();
    expect(await types()).toEqual(['crossfade', 'crossfade', 'crossfade']);
    await expect(page.locator('.toast', { hasText: 'replaced' })).toHaveCount(1);
    await replaced.locator('.toast-action', { hasText: 'Undo' }).click(); // also closes the popover
    await expect(pop).toBeHidden();
    expect(await types()).toEqual(seeded); // what the cuts had before the popover opened

    // Remove all: hard cuts everywhere; Undo is a real undo of that step
    await openAll();
    await pop.locator('.tl-tr-cut').click();
    expect(await types()).toEqual([null, null, null]);
    await expect(pop.locator('.tl-pop-current')).toHaveText('Cut');
    await expect(pop.locator('.tl-tr-cut')).toHaveText('Cut');
    await expect(pop.locator('.tl-tr-cut')).toHaveClass(/is-active/);
    const removed = page.locator('.toast', { hasText: 'Removed 2 transitions' });
    await expect(removed).toBeVisible();
    const history = () => page.evaluate(() => ({ undo: window.__gis.projectStore.undoLabel(), redo: window.__gis.projectStore.redoLabel() }));
    expect((await history()).undo).toBe('Remove all transitions');
    await removed.locator('.toast-action', { hasText: 'Undo' }).click();
    expect(await types()).toEqual(seeded);
    expect((await history()).redo).toBe('Remove all transitions'); // undone, not a new "restore" step

    // one junction's "All cuts" over different transitions offers Undo too
    const v = (await getProject(page)).tracks.video;
    await page.locator(`.tl-trbadge[data-tr-for="${v[2].id}"]`).click();
    await pop.locator('.btn', { hasText: 'All cuts' }).click();
    expect(await types()).toEqual(['wipe-left', 'wipe-left', 'wipe-left']);
    const allCuts = page.locator('.toast', { hasText: 'Wipe left on every cut — replaced 1 transition' });
    await expect(allCuts).toBeVisible();
    await allCuts.locator('.toast-action', { hasText: 'Undo' }).click();
    expect(await types()).toEqual(seeded);

    // offline media: one line in a wide clip, the icon alone in a narrow one (the clip's title says what to do)
    await page.evaluate((id) => {
      const { projectStore, model } = window.__gis;
      projectStore.update((p) => model.updateMedia(p, id, { status: 'error', error: 'Could not download' }), { history: false });
    }, v[1].mediaId);
    const offline = page.locator(`.tl-clip-video[data-clip-id="${v[1].id}"]`);
    await expect(offline).toHaveAttribute('title', /Media offline — retry it in the bin/);
    for (const [zoom, label] of [
      [60, true],
      [15, false],
    ]) {
      await setUi(page, { zoom });
      await expect.poll(async () => Math.round((await offline.boundingBox()).width)).toBeLessThan(zoom === 60 ? 260 : 60);
      await expect(offline.locator('.tl-strip-error .icon')).toBeVisible();
      if (label) {
        const span = offline.locator('.tl-strip-error span');
        await expect(span).toHaveText('Media offline');
        expect((await span.boundingBox()).height).toBeLessThan(18); // one line
      } else {
        await expect(offline.locator('.tl-strip-error span')).toHaveCount(0);
      }
    }
    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});
