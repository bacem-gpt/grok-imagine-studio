// Fixtures: clip-ramp.mp4 is a grey ramp (level ≈ 64 x source seconds), so the source time a frame shows can be read
// off its pixels; clip-red.mp4 is red with a static white box near the right edge.
//
// iMovie-style clip tools end to end: reverse / rotate / crop / temperature through the inspector (checked on the
// program monitor's pixels), freeze frame + instant replay + title styles + backgrounds, an export of a reversed
// clip, a freeze frame and a rotated clip (decoded frames checked), ducking in the mixdown, and a voice-over recorded
// from Chrome's fake microphone.
import { test } from '@playwright/test';
import { launch, openStudioTab, seedMedia, getProject, expect } from './harness.mjs';

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
  await page.waitForTimeout(400);
}

const seek = (page, t) => page.evaluate((x) => window.__gis.uiStore.set((s) => ({ ...s, playhead: x })), t);
const videoClips = async (page) => (await getProject(page)).tracks.video;

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

/** Horizontal centre (fraction of the width) of clip-red's white box on the monitor's middle row, or null. */
const monitorBoxX = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.mon-canvas');
    const d = c.getContext('2d').getImageData(0, Math.floor(c.height / 2), c.width, 1).data;
    let sum = 0;
    let n = 0;
    for (let x = 0; x < c.width; x++) if (d[x * 4 + 1] > 170 && d[x * 4 + 2] > 170) (sum += x), n++;
    return n ? sum / n / c.width : null;
  });

const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80;
const isBlack = ([r, g, b]) => r < 30 && g < 30 && b < 30;

/** Sets a kit Slider (range input) the way a drag does: input events, then change (= gesture end). */
async function setSlider(page, label, value) {
  const input = page.locator('.insp-body .slider', { hasText: label }).locator('input[type=range]');
  await input.evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('inspector: reverse, rotate, crop, flip and temperature change the monitor picture (undoable)', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-ramp.mp4', 'clip-red.mp4']);
    await addToTimeline(page, ids); // ramp 0..4 s, red 4..8 s
    await page.locator('.tl-clip-video').first().click();
    await expect(page.locator('.insp-tools')).toBeVisible();
    const grey = async () => (await monitorPixel(page, 0.5, 0.5))[0];

    // Forward: timeline 0.5 s shows source 0.5 s (dark grey).
    await seek(page, 0.5);
    await expect.poll(grey, { timeout: 10000 }).toBeLessThan(60);

    // Reverse: timeline 0.5 s shows source 3.5 s (light grey).
    await page.locator('.insp-tools .toggle', { hasText: 'Reverse' }).click();
    expect((await videoClips(page))[0].reverse).toBe(true);
    await expect(page.locator('.tl-clip-video .tl-badge[title="Reversed"]')).toBeVisible();
    await seek(page, 0.6);
    await seek(page, 0.5);
    await expect.poll(grey, { timeout: 10000 }).toBeGreaterThan(190);
    // Playing a reversed clip seeks frame by frame: the picture keeps running backwards and never drops to black.
    await seek(page, 0.2);
    await page.waitForTimeout(400);
    await page.locator('.mon-play').click();
    const seen = [];
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(150);
      seen.push(await grey());
    }
    await page.locator('.mon-play').click();
    for (const g of seen) expect(g, `reverse playback frame ${seen}`).toBeGreaterThan(120);
    expect(seen[0] - seen[seen.length - 1], `reverse playback darkens ${seen}`).toBeGreaterThan(25);
    await page.locator('.insp-tools .toggle', { hasText: 'Reverse' }).click();
    expect((await videoClips(page))[0].reverse).toBe(false);

    // Rotation: with Fit (contain), a quarter turn pillarboxes the 16:9 picture.
    await page.locator('.tl-clip-video').nth(1).click();
    await seek(page, 5);
    await page.locator('.insp-body .segmented button', { hasText: 'Fit' }).click();
    await expect.poll(async () => isRed(await monitorPixel(page, 0.05, 0.5)), { timeout: 10000 }).toBe(true);
    await page.locator('[title="Rotate right (90° clockwise)"]').click();
    expect((await videoClips(page))[1].rotate).toBe(90);
    await expect.poll(async () => isBlack(await monitorPixel(page, 0.05, 0.5)), { timeout: 10000 }).toBe(true);
    expect(isRed(await monitorPixel(page, 0.5, 0.1))).toBe(true);
    await page.locator('[title^="Rotate left"]').click();
    expect((await videoClips(page))[1].rotate).toBe(0);
    await expect.poll(async () => isRed(await monitorPixel(page, 0.05, 0.5)), { timeout: 10000 }).toBe(true);

    // Crop to 1:1 (still Fit): a square in a 16:9 frame -> pillarbox.
    await page.locator('.insp-crop-aspects .chip', { hasText: '1:1' }).click();
    const crop = (await videoClips(page))[1].crop;
    expect(crop.w).toBeCloseTo(360 / 640, 3);
    expect(crop.h).toBe(1);
    await expect.poll(async () => isBlack(await monitorPixel(page, 0.1, 0.5)), { timeout: 10000 }).toBe(true);
    // Drag the crop's corner: the rectangle stays square (locked aspect) and one undo step undoes the whole drag.
    const handle = page.locator('.insp-crop-handle.is-se');
    await handle.scrollIntoViewIfNeeded();
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(hb.x + hb.width / 2 - i * 5, hb.y + hb.height / 2 - i * 5);
    await page.mouse.up();
    const dragged = (await videoClips(page))[1].crop;
    expect(dragged.w).toBeLessThan(crop.w);
    expect((dragged.w * 640) / (dragged.h * 360)).toBeCloseTo(1, 2);
    await page.evaluate(() => window.__gis.projectStore.undo());
    expect((await videoClips(page))[1].crop.w).toBeCloseTo(crop.w, 3);
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    expect((await videoClips(page))[1].crop).toBe(null);
    await expect.poll(async () => isRed(await monitorPixel(page, 0.1, 0.5)), { timeout: 10000 }).toBe(true);

    // Flip: the box near the right edge moves to the left edge.
    await page.locator('.insp-body .segmented button', { hasText: 'Fill' }).click();
    await expect.poll(async () => monitorBoxX(page), { timeout: 10000 }).toBeGreaterThan(0.8);
    await page.locator('[title="Flip horizontally (mirror)"]').click();
    await expect.poll(async () => monitorBoxX(page), { timeout: 10000 }).toBeLessThan(0.2);
    await page.locator('[title="Flip horizontally (mirror)"]').click();

    // Temperature: cool white balance takes red down; warm keeps it saturated; tint and exposure are sliders too.
    await setSlider(page, 'Temperature', -1);
    expect((await videoClips(page))[1].filters.temperature).toBe(-1);
    await expect.poll(async () => (await monitorPixel(page, 0.1, 0.12))[0], { timeout: 10000 }).toBeLessThan(215);
    const cool = await monitorPixel(page, 0.1, 0.12);
    expect(cool[2]).toBeLessThan(40); // pure red has no blue to boost
    await setSlider(page, 'Temperature', 1);
    await expect.poll(async () => (await monitorPixel(page, 0.1, 0.12))[0], { timeout: 10000 }).toBeGreaterThan(235);
    await setSlider(page, 'Exposure', -1);
    await expect.poll(async () => (await monitorPixel(page, 0.1, 0.12))[0], { timeout: 10000 }).toBeLessThan(160);
    await page.getByRole('button', { name: 'Reset look' }).click();
    await expect.poll(async () => isRed(await monitorPixel(page, 0.1, 0.12)), { timeout: 10000 }).toBe(true);
    // Auto enhance analyses the clip's frame and sets a look.
    await page.getByRole('button', { name: 'Auto enhance' }).click();
    await expect.poll(async () => !!(await videoClips(page))[1].filters, { timeout: 10000 }).toBe(true);
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('freeze frame (button + Shift+F), instant replay, title styles, backgrounds, EQ and ducking controls', async () => {
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-ramp.mp4', 'voice.wav', 'clip-red.mp4']);
    await addToTimeline(page, [ids[0]]);
    await page.locator('.tl-clip-video').first().click();
    await seek(page, 1.5);

    // Freeze frame from the inspector: split + a 2 s still of source 1.5 s, selected.
    await page.getByRole('button', { name: 'Freeze frame' }).click();
    let clips = await videoClips(page);
    expect(clips.length).toBe(3);
    expect(clips[1]).toMatchObject({ freeze: true, in: 0, out: 2 });
    expect(clips[1].freezeAt).toBeCloseTo(1.5, 3);
    await expect(page.locator('.tl-clip-video .tl-badge[title="Freeze frame"]')).toBeVisible();
    await expect(page.locator('.insp-body .field-label', { hasText: 'Hold for' })).toBeVisible();
    // The still shows that frame (grey ≈ 95) all the way through.
    const grey = async () => (await monitorPixel(page, 0.5, 0.5))[0];
    await seek(page, 1.8);
    await expect.poll(grey, { timeout: 10000 }).toBeGreaterThan(80);
    expect(await grey()).toBeLessThan(110);
    await seek(page, 3.2);
    await page.waitForTimeout(400);
    expect(Math.abs((await grey()) - 95)).toBeLessThan(14);
    await page.evaluate(() => window.__gis.projectStore.undo());
    expect((await videoClips(page)).length).toBe(1);

    // Shift+F does the same at the playhead.
    await page.locator('.tl-row-video').click({ position: { x: 5, y: 5 } });
    await seek(page, 2);
    await page.keyboard.press('Shift+F');
    clips = await videoClips(page);
    expect(clips.length).toBe(3);
    expect(clips[1].freezeAt).toBeCloseTo(2, 3);
    await page.evaluate(() => window.__gis.projectStore.undo());

    // Instant replay at 50%: 2 s before the playhead again at half speed, with a title over it — one undo step.
    await page.locator('.tl-clip-video').first().click();
    await seek(page, 3);
    await page.getByRole('button', { name: 'Instant replay' }).click();
    clips = await videoClips(page);
    expect(clips.length).toBe(3);
    expect(clips[1]).toMatchObject({ in: 1, out: 3, speed: 0.5 });
    let p = await getProject(page);
    expect(p.tracks.text.map((t) => t.text)).toEqual(['Instant replay']);
    await page.evaluate(() => window.__gis.projectStore.undo());
    p = await getProject(page);
    expect(p.tracks.video.length).toBe(1);
    expect(p.tracks.text.length).toBe(0);

    // Title styles: add from the toolbar menu, restyle from the inspector.
    await page.locator('.tl-styles-btn').click();
    await page.locator('.menu .menu-item', { hasText: 'Lower third' }).click();
    p = await getProject(page);
    expect(p.tracks.text.length).toBe(1);
    expect(p.tracks.text[0].style).toMatchObject({ align: 'left', x: 0.06 });
    await page.locator('.tl-row-video').click({ position: { x: 5, y: 5 } }); // leave the title's text field
    await page.locator('.tl-clip-text').first().click();
    await page.locator('[data-title-preset="credits"]').click();
    p = await getProject(page);
    expect(p.tracks.text[0].animation).toBe('scroll-up');
    await expect(page.locator('[data-title-preset="credits"]')).toHaveClass(/is-active/);
    // Credits roll: the text block moves up the frame over the clip.
    const textRows = async () =>
      page.evaluate(() => {
        const c = document.querySelector('.mon-canvas');
        const d = c.getContext('2d').getImageData(Math.floor(c.width * 0.45), 0, Math.floor(c.width * 0.1), c.height).data;
        const w = Math.floor(c.width * 0.1);
        let sum = 0;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) (sum += Math.floor(i / 4 / w)), n++;
        return n ? sum / n / c.height : null;
      });
    await seek(page, p.tracks.text[0].start + 3);
    await page.waitForTimeout(400);
    const y1 = await textRows();
    await seek(page, p.tracks.text[0].start + 5);
    await page.waitForTimeout(400);
    const y2 = await textRows();
    expect(y1).not.toBeNull();
    expect(y2).not.toBeNull();
    expect(y2).toBeLessThan(y1);

    // Background: a generated still on the main track at the playhead.
    await seek(page, 0);
    await page.locator('.tl-styles-btn').click();
    await page.locator('.menu .menu-item', { hasText: 'Add a background' }).click();
    await page.locator('.menu .menu-item', { hasText: 'Sunset' }).click();
    await expect.poll(async () => (await videoClips(page)).length, { timeout: 15000 }).toBe(2);
    p = await getProject(page);
    const bg = p.tracks.video[0];
    expect(p.media[bg.mediaId]).toMatchObject({ kind: 'image', status: 'ready' });
    expect(bg.kenBurns).toBe(null);
    await seek(page, 0.5);
    await expect.poll(async () => {
      const [r, g, b] = await monitorPixel(page, 0.5, 0.5);
      return r > 230 && g > 120 && g < 200 && b > 80 && b < 150;
    }, { timeout: 10000 }).toBe(true);

    // EQ on a clip with sound, ducking on an audio clip (inspector).
    await page.evaluate((id) => window.__gis.projectStore.update((q) => window.__gis.model.appendMediaToTimeline(q, [id]).project, { label: 'red' }), ids[2]);
    await page.locator('.tl-clip-video').nth(2).click();
    await page.locator('.insp-body .field', { hasText: 'Equalizer' }).locator('select').selectOption('voice');
    expect((await videoClips(page))[2].eq).toBe('voice');
    await page.evaluate((id) => window.__gis.projectStore.update((q) => window.__gis.model.addAudioClip(q, id, { start: 0 }).project, { label: 'a' }), ids[1]);
    await page.locator('.tl-clip-audio').first().click();
    await page.locator('.insp-body .toggle', { hasText: 'Duck other audio' }).click();
    await setSlider(page, 'Reduce others by', 0.5);
    p = await getProject(page);
    expect(p.tracks.audio[0]).toMatchObject({ duck: true, duckAmount: 0.5 });
    await page.locator('.insp-body .field', { hasText: 'Equalizer' }).locator('select').selectOption('hum50');
    expect((await getProject(page)).tracks.audio[0].eq).toBe('hum50');
    // Preview plays with the EQ / ducking graph without errors.
    await seek(page, 0);
    await page.locator('.mon-play').click();
    await page.waitForTimeout(1200);
    await page.locator('.mon-play').click();
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('export: reversed clip, freeze frame and rotated clip render like the timeline; ducking in the mixdown', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-ramp.mp4', 'clip-red.mp4', 'music.mp3', 'voice.wav']);
    const res = await page.evaluate(async ([ramp, red, music, voice]) => {
      const { projectStore, model: M } = window.__gis;
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      const mix = await import(chrome.runtime.getURL('studio/engine/audio-mix.js'));
      const media = await import(chrome.runtime.getURL('studio/core/media.js'));
      // [ramp reversed 0..2] [freeze of ramp 1.0 s, 1 s] [red rotated 90°, fit contain, 0..1]
      projectStore.update(
        (p) => {
          let q = M.updateSettings(p, { width: 640, height: 360, fps: 30 });
          q = M.appendMediaToTimeline(q, [ramp, red]).project;
          const [a, b] = q.tracks.video;
          q = M.updateClip(q, a.id, { in: 0, out: 2, reverse: true });
          q = M.updateClip(q, b.id, { in: 0, out: 1, rotate: 90, fit: 'contain' });
          const f = M.insertFreezeFrame(q, 1.999, { duration: 1, clipId: a.id });
          q = f.project;
          q = M.updateClip(q, f.id, { freezeAt: 1 });
          return q;
        },
        { label: 'build' },
      );
      const project = projectStore.get();
      const lay = M.layoutProject(project);
      const out = await ex.exportProject(project, { format: 'webm', includeAudio: false });
      // Decode the result and find the white box per frame.
      const MB = await media.loadMediabunny();
      const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(out.blob) });
      const track = await input.getPrimaryVideoTrack();
      const sink = new MB.VideoSampleSink(track);
      const c = new OffscreenCanvas(640, 360);
      const g = c.getContext('2d', { willReadFrequently: true });
      const probe = async (t) => {
        const s = await sink.getSample(t + 0.001);
        g.clearRect(0, 0, 640, 360);
        s.draw(g, 0, 0, 640, 360);
        s.close();
        const grey = g.getImageData(320, 180, 1, 1).data[0];
        const edge = Array.from(g.getImageData(10, 180, 1, 1).data.slice(0, 3));
        const mid = Array.from(g.getImageData(320, 40, 1, 1).data.slice(0, 3));
        return { grey, edge, mid };
      };
      const frames = {};
      for (const t of [0.5, 1.5, 2.2, 2.8, 3.5]) frames[t] = await probe(t);
      input.dispose();

      // Ducking: music on A1, a (nearly silent) voice-over on A2 ducking it by 75 % over [4, 6).
      projectStore.update(
        (p) => {
          let q = M.addAudioClip(p, music, { start: 0 }).project;
          const r = M.addAudioClip(q, voice, { start: 4 });
          q = M.updateClip(r.project, r.id, { duck: true, duckAmount: 0.75, volume: 0.001, out: 2 });
          return q;
        },
        { label: 'audio' },
      );
      const buf = await mix.renderAudioMix(projectStore.get(), { start: 0, end: 8, limiter: false });
      const rms = (a, b) => {
        const ch = buf.getChannelData(0);
        let s = 0;
        const i0 = Math.round(a * buf.sampleRate);
        const i1 = Math.round(b * buf.sampleRate);
        for (let i = i0; i < i1; i++) s += ch[i] * ch[i];
        return Math.sqrt(s / (i1 - i0));
      };
      return { duration: lay.duration, frames, out: { frames: out.frames, w: out.width }, before: rms(2.5, 3.5), during: rms(4.6, 5.6), after: rms(6.8, 7.8) };
    }, ids);
    expect(res.duration).toBeCloseTo(4, 3);
    expect(res.out.frames).toBe(120);
    const f = res.frames;
    // reversed: timeline 0.5 = source 1.5 (grey ≈ 95); timeline 1.5 = source 0.5 (≈ 31) — forward would be the other way
    expect(Math.abs(f[0.5].grey - 95), `reversed frame at 0.5 s: ${f[0.5].grey}`).toBeLessThan(12);
    expect(Math.abs(f[1.5].grey - 31), `reversed frame at 1.5 s: ${f[1.5].grey}`).toBeLessThan(12);
    // freeze of source 1.0 s: holds ≈ 63
    expect(Math.abs(f[2.2].grey - 63), `freeze ${f[2.2].grey}`).toBeLessThan(12);
    expect(Math.abs(f[2.8].grey - f[2.2].grey)).toBeLessThan(3);
    // rotated with Fit: black pillarbox at the edge, red in the middle
    expect(isBlack(f[3.5].edge)).toBe(true);
    expect(isRed(f[3.5].mid)).toBe(true);
    // ducking: music at 25 % while the voice-over plays, back to full after the ramp
    expect(res.before).toBeGreaterThan(0.05);
    expect(res.during / res.before).toBeLessThan(0.35);
    expect(res.during / res.before).toBeGreaterThan(0.15);
    expect(res.after / res.before).toBeGreaterThan(0.75);
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('voice-over: count-in, records the (fake) microphone while the timeline plays, adds a ducking audio clip', async () => {
  const ctx = await launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4']);
    await addToTimeline(page, ids);
    await seek(page, 0.5);
    await page.locator('.mon-mic').click();
    await page.locator('.menu .menu-item', { hasText: 'Record from' }).click();
    await expect(page.locator('.mon-vo-num')).toHaveText('3');
    await expect(page.locator('.mon-vo-rec')).toBeVisible({ timeout: 6000 });
    expect(await page.evaluate(() => document.querySelector('.mon-play').classList.contains('is-playing'))).toBe(true);
    await page.waitForTimeout(1500);
    await page.locator('.mon-vo-stop').click();
    await expect.poll(async () => (await getProject(page)).tracks.audio.length, { timeout: 20000 }).toBe(1);
    const p = await getProject(page);
    const a = p.tracks.audio[0];
    expect(a).toMatchObject({ duck: true, label: 'Voice-over' });
    expect(a.start).toBeCloseTo(0.5, 2);
    expect(p.media[a.mediaId]).toMatchObject({ kind: 'audio', status: 'ready' });
    expect(a.out - a.in).toBeGreaterThan(0.8);
    expect(a.out - a.in).toBeLessThan(4);
    await expect(page.locator('.mon-vo')).toHaveCount(0);
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});
