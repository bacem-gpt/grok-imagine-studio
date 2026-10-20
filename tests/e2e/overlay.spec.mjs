// Overlay track E2E (iMovie-style video overlays): drop a bin clip on the overlay row (V2), the overlay clip view,
// the inspector's overlay modes (picture in picture / side by side / cutaway / green screen) checked on the program
// monitor's pixels, moving the PiP box on the monitor, the main-clip "Move to overlay track" menu item, the 480 px
// layout, and an MP4 export whose decoded frames (and WAV mixdown) contain the overlays.
import { test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, openStudioTab, seedMedia, getProject, expect } from './harness.mjs';

async function setup(ctx, files) {
  const page = await openStudioTab(ctx);
  const ids = await seedMedia(page, files, { timeout: 60000 });
  await page.locator('.app-tabs .tab', { hasText: /Edit/ }).click();
  await page.locator('.tl-body').waitFor();
  return { page, ids };
}

const ui = (page) => page.evaluate(() => window.__gis.uiStore.get());
const seek = (page, t) => page.evaluate((x) => window.__gis.uiStore.set((s) => ({ ...s, playhead: x })), t);

/** Average RGB of a small square of the program monitor canvas around fractional coordinates. */
const monitorPixel = (page, fx, fy) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.mon-canvas');
      const px = Math.floor(c.width * x);
      const py = Math.floor(c.height * y);
      const d = c.getContext('2d').getImageData(Math.max(0, px - 2), Math.max(0, py - 2), 4, 4).data;
      const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k];
      return s.map((v) => Math.round(v / (d.length / 4)));
    },
    [fx, fy],
  );

const isRed = ([r, g, b]) => r > 170 && g < 80 && b < 80;
const isBlue = ([r, g, b]) => b > 170 && r < 80 && g < 80;

/** Drops bin media on the timeline at (x, y) like a drag from the bin. */
const dropMedia = (page, ids, x, y) =>
  page.evaluate(
    ({ ids, x, y }) => {
      const body = document.querySelector('.tl-body');
      const dt = new DataTransfer();
      dt.setData('application/x-gis-media', JSON.stringify(ids));
      for (const type of ['dragenter', 'dragover', 'drop']) body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    { ids, x, y },
  );

test('overlay row: drop, modes on the monitor, PiP drag, move to overlay, 480 px', async () => {
  test.setTimeout(150_000);
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-blue.mp4', 'clip-green.mp4']);
    const [red, blue, green] = ids;
    await page.evaluate((list) => {
      const { projectStore, model } = window.__gis;
      projectStore.update((p) => model.appendMediaToTimeline(p, list).project, { label: 'Add to timeline' });
    }, [red, green]);
    await expect(page.locator('.tl-clip-video')).toHaveCount(2);
    await page.waitForTimeout(400); // first content triggers a fit-to-view

    // --- the overlay row (V2) sits above V1 and accepts drops from the bin
    const ovRow = page.locator('.tl-row-overlay');
    await expect(ovRow).toHaveCount(1);
    await expect(ovRow.locator('.tl-row-head')).toContainText('V2');
    const ovBox = await ovRow.boundingBox();
    const vBox = await page.locator('.tl-row-video').boundingBox();
    expect(ovBox.y + ovBox.height).toBeLessThanOrEqual(vBox.y + 1);
    const head = await ovRow.locator('.tl-row-head').boundingBox();
    await dropMedia(page, [blue], head.x + head.width + 4, ovBox.y + ovBox.height / 2);
    await expect(page.locator('.tl-clip-overlay')).toHaveCount(1);
    let p = await getProject(page);
    expect(p.tracks.overlay.length).toBe(1);
    const ov = p.tracks.overlay[0];
    expect(ov.mediaId).toBe(blue);
    expect(ov.start).toBeLessThan(0.2);
    expect(ov.mode).toBe('pip');
    expect((await ui(page)).selection).toEqual([ov.id]);

    // --- drag to move (one undo step), drag the end edge to trim
    const clipEl = page.locator('.tl-clip-overlay').first();
    const cb = await clipEl.boundingBox();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(cb.x + cb.width / 2 + i * 8, cb.y + cb.height / 2);
    await page.mouse.up();
    p = await getProject(page);
    expect(p.tracks.overlay[0].start).toBeGreaterThan(0.1);
    expect(p.tracks.overlay[0].lane).toBe(0);
    expect(await page.evaluate(() => window.__gis.projectStore.undoLabel())).toBe('Move overlay');
    const tb = await clipEl.locator('.tl-trim-out').boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(tb.x + tb.width / 2 - i * 8, tb.y + tb.height / 2);
    await page.mouse.up();
    p = await getProject(page);
    expect(p.tracks.overlay[0].out).toBeLessThan(4.9);
    expect(await page.evaluate(() => window.__gis.projectStore.undoLabel())).toBe('Trim overlay');
    // dragging up by a row puts it on a new lane (V3)
    const cb2 = await clipEl.boundingBox();
    await page.mouse.move(cb2.x + cb2.width / 2, cb2.y + cb2.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(cb2.x + cb2.width / 2, cb2.y + cb2.height / 2 - i * 7);
    await page.mouse.up();
    expect((await getProject(page)).tracks.overlay[0].lane).toBe(1);
    await expect(page.locator('.tl-row-overlay')).toHaveCount(2);
    await page.evaluate(() => {
      window.__gis.projectStore.undo();
      window.__gis.projectStore.undo();
      window.__gis.projectStore.undo();
    });
    p = await getProject(page);
    expect([p.tracks.overlay[0].start, p.tracks.overlay[0].out]).toEqual([ov.start, ov.out]);
    await page.evaluate((id) => window.__gis.uiStore.set((s) => ({ ...s, selection: [id] })), ov.id);

    // --- inspector: overlay panel
    const insp = page.locator('.insp');
    await expect(insp.locator('.panel-title')).toHaveText('Overlay');
    await expect(insp.locator('.ovp-mode.is-active')).toHaveAttribute('data-mode', 'pip');

    // --- picture in picture on the monitor: blue box top right, red main elsewhere
    await seek(page, 1);
    const pipAt = await page.evaluate(async (id) => {
      const { projectStore } = window.__gis;
      const ovm = await import(chrome.runtime.getURL('studio/engine/overlays.js'));
      const p = projectStore.get();
      const c = p.tracks.overlay.find((x) => x.id === id);
      const m = p.media[c.mediaId];
      const { width: W, height: H } = document.querySelector('.mon-canvas');
      const r = ovm.pipRect(c.pip, m.width, m.height, W, H);
      return { x: (r.x + r.w * 0.15) / W, y: (r.y + r.h * 0.15) / H }; // the clip's top-left area (away from its moving box)
    }, ov.id);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: test.info().outputPath('overlay-pip-first.png') });
    await expect.poll(async () => isBlue(await monitorPixel(page, pipAt.x, pipAt.y)), { timeout: 15000 }).toBe(true);
    expect(isRed(await monitorPixel(page, 0.08, 0.1))).toBe(true);

    // --- the PiP box can be dragged on the monitor (one undo step)
    const box = page.locator('.ovh-layer .ovh-box');
    await expect(box).toBeVisible();
    const bb = await box.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(bb.x + bb.width / 2 - i * 40, bb.y + bb.height / 2 + i * 10);
    await page.mouse.up();
    p = await getProject(page);
    expect(p.tracks.overlay[0].pip.x).toBeLessThan(0.8);
    expect(p.tracks.overlay[0].pip.y).toBeGreaterThan(0.05);
    expect(await page.evaluate(() => window.__gis.projectStore.undoLabel())).toBe('Move picture in picture');
    // corner presets
    await insp.locator('.chip[data-pos="bl"]').click();
    p = await getProject(page);
    expect([p.tracks.overlay[0].pip.x, p.tracks.overlay[0].pip.y]).toEqual([0, 1]);
    await expect.poll(async () => isBlue(await monitorPixel(page, 0.06, 0.72)), { timeout: 8000 }).toBe(true);
    expect(isRed(await monitorPixel(page, 0.9, 0.1))).toBe(true);
    await page.screenshot({ path: test.info().outputPath('overlay-pip.png') });

    // --- side by side: overlay left half, main (centre-cropped) right half
    await insp.locator('.ovp-mode[data-mode="split"]').click();
    expect((await getProject(page)).tracks.overlay[0].mode).toBe('split');
    await expect.poll(async () => isBlue(await monitorPixel(page, 0.1, 0.1)), { timeout: 8000 }).toBe(true);
    expect(isRed(await monitorPixel(page, 0.9, 0.1))).toBe(true);
    await page.screenshot({ path: test.info().outputPath('overlay-split.png') });

    // --- cutaway: the overlay covers the frame
    await insp.locator('.ovp-mode[data-mode="cutaway"]').click();
    await expect.poll(async () => isBlue(await monitorPixel(page, 0.9, 0.1)), { timeout: 8000 }).toBe(true);
    expect(isBlue(await monitorPixel(page, 0.08, 0.1))).toBe(true);

    // --- green screen with a blue key: the blue overlay keys out, the red main track shows through
    await insp.locator('.ovp-mode[data-mode="greenscreen"]').click();
    await insp.locator('.ovp-keychip[data-key="blue"]').click();
    await expect.poll(async () => isRed(await monitorPixel(page, 0.08, 0.1)), { timeout: 8000 }).toBe(true);
    // the eyedropper picks the screen colour from the overlay's own picture
    await insp.locator('[title="Pick the colour from the frame on the monitor"]').click();
    await expect(page.locator('.ovh-pick')).toBeVisible();
    const stage = await page.locator('.mon-canvas').boundingBox();
    await page.mouse.click(stage.x + stage.width * 0.08, stage.y + stage.height * 0.1);
    await expect.poll(async () => (await getProject(page)).tracks.overlay[0].key.color).not.toBe('#0047ff');
    const picked = (await getProject(page)).tracks.overlay[0].key.color;
    const [pr, pg, pb] = [1, 3, 5].map((i) => parseInt(picked.slice(i, i + 2), 16));
    expect(pb, `picked ${picked}`).toBeGreaterThan(170);
    expect(Math.max(pr, pg)).toBeLessThan(80);
    expect(isRed(await monitorPixel(page, 0.08, 0.1))).toBe(true);
    // undo goes back step by step (key colour, then the preset)
    await page.evaluate(() => window.__gis.projectStore.undo());
    expect((await getProject(page)).tracks.overlay[0].key.color).toBe('#0047ff');

    // --- context menu on a main-track clip: Move to overlay track
    const greenClip = p.tracks.video[1].id;
    await page.locator(`.tl-clip-video[data-clip-id="${greenClip}"]`).click({ button: 'right' });
    await page.locator('.menu-item, [role="menuitem"]', { hasText: 'Move to overlay track' }).click();
    p = await getProject(page);
    expect(p.tracks.video.map((c) => c.mediaId)).toEqual([red]);
    expect(p.tracks.overlay.map((c) => c.mediaId).sort()).toEqual([blue, green].sort());
    await expect(page.locator('.tl-clip-overlay')).toHaveCount(2);
    const moved = p.tracks.overlay.find((c) => c.mediaId === green);
    expect(moved.start).toBeCloseTo(4, 3);
    // split (S on a selected overlay) and delete
    await seek(page, 5);
    await page.evaluate((id) => window.__gis.uiStore.set((s) => ({ ...s, selection: [id] })), moved.id);
    await page.locator('.tl-tools [title="Split at playhead (S)"]').click();
    expect((await getProject(page)).tracks.overlay.length).toBe(3);
    await page.evaluate(() => window.__gis.projectStore.undo());

    // --- 480 px: the overlay row and clips stay usable
    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(400);
    await expect(page.locator('.tl-row-overlay .tl-row-head').first()).toBeVisible();
    await expect(page.locator('.tl-clip-overlay').first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('overlay-480.png') });
    await page.evaluate((id) => window.__gis.uiStore.set((s) => ({ ...s, selection: [id] })), ov.id);
    await page.locator('.edit-fab', { hasText: 'Edit clip' }).click();
    const sheet = page.locator('.edit-insp-sheet .insp');
    await expect(sheet.locator('.ovp-modes')).toBeVisible();
    await sheet.locator('.ovp-mode[data-mode="pip"]').click();
    await expect(sheet.locator('.ovp-pad')).toBeVisible();
    const padBox = await sheet.locator('.ovp-pad').boundingBox();
    expect(padBox.width).toBeLessThanOrEqual(480);
    await page.screenshot({ path: test.info().outputPath('overlay-480-inspector.png') });
    await sheet.locator('.insp-close').click();
    await page.setViewportSize({ width: 1440, height: 900 });

    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('preview: overlay video plays with its own sound (main track muted); muting the overlay silences it', async () => {
  test.setTimeout(90_000);
  const ctx = await launch();
  try {
    const { page, ids } = await setup(ctx, ['clip-red.mp4', 'clip-blue.mp4']);
    const [red, blue] = ids;
    const ovId = await page.evaluate(
      ({ red, blue }) => {
        const { projectStore, model: M } = window.__gis;
        let id = null;
        projectStore.update(
          (p) => {
            let q = M.appendMediaToTimeline(p, [red]).project;
            q = M.updateClip(q, q.tracks.video[0].id, { muted: true });
            const r = M.addOverlayClip(q, blue, { start: 0, mode: 'cutaway' });
            id = r.id;
            return r.project;
          },
          { label: 'Build' },
        );
        return id;
      },
      { red, blue },
    );
    await expect(page.locator('.tl-clip-overlay')).toHaveCount(1);
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
    const rms = () => page.evaluate(() => window.__rms());
    await page.locator('.mon-play').click();
    await expect.poll(rms, { timeout: 5000, message: 'overlay sound' }).toBeGreaterThan(0.01);
    expect(isBlue(await monitorPixel(page, 0.08, 0.1))).toBe(true);
    await page.evaluate((id) => window.__gis.projectStore.update((p) => window.__gis.model.updateClip(p, id, { muted: true }), { label: 'Mute' }), ovId);
    await expect.poll(rms, { timeout: 3000, message: 'muted overlay' }).toBeLessThan(0.002);
    await page.locator('.mon-play').click();
    expect(ctx.consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------------------------- export

const W = 640;
const H = 360;
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
function pcm(file) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], { maxBuffer: 256 << 20 });
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}
function toneAmp(samples, freq, t0, t1, sr = 48000) {
  const s0 = Math.round(t0 * sr);
  const n = Math.round((t1 - t0) * sr);
  const k = (2 * Math.PI * freq) / sr;
  const coeff = 2 * Math.cos(k);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < n; i++) {
    const p0 = samples[2 * (s0 + i)] + coeff * p1 - p2;
    p2 = p1;
    p1 = p0;
  }
  return (2 * Math.hypot(p1 - p2 * Math.cos(k), p2 * Math.sin(k))) / n;
}

test('export renders overlays (PiP, green screen) into the MP4 and mixes their sound', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  const work = mkdtempSync(join(tmpdir(), 'gis-overlay-'));
  try {
    const studio = await openStudioTab(ctx);
    const [red, blue, green] = await seedMedia(studio, ['clip-red.mp4', 'clip-blue.mp4', 'clip-green.mp4'], { timeout: 60000 });
    const res = await studio.evaluate(
      async ({ red, blue, green, W, H }) => {
        const { projectStore, model: M } = window.__gis;
        // main: red 0..4 (muted, so only the overlay is heard early on); PiP blue 0.5..2 (top right, sound on);
        // green screen: green 2.5..4 keyed with its own colour -> red shows through.
        projectStore.update(
          (p) => {
            let q = M.appendMediaToTimeline(p, [red]).project;
            q = M.updateClip(q, q.tracks.video[0].id, { muted: true });
            q = M.addOverlayClip(q, blue, { start: 0.5, out: 1.5, mode: 'pip', pip: { x: 1, y: 0, scale: 0.4, border: 0, shadow: false } }).project;
            q = M.addOverlayClip(q, green, { start: 2.5, out: 1.5, mode: 'greenscreen', key: { color: '#008000', tolerance: 0.3, softness: 0.05, spill: 0.3 } }).project;
            return M.updateSettings(q, { width: W, height: H, fps: 30 });
          },
          { label: 'Build overlay sequence' },
        );
        const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
        const project = projectStore.get();
        const out = await ex.exportProject(project, { format: 'mp4' });
        const wav = await ex.exportAudioWav(project);
        const png = await ex.exportFrame(project, 1, { width: W, height: H });
        const b64 = async (blob) => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(bin);
        };
        return { mp4: await b64(out.blob), frames: out.frames, wav: await b64(wav), png: await b64(png) };
      },
      { red, blue, green, W, H },
    );
    expect(res.frames).toBe(120);
    const save = (name, data) => {
      const path = join(work, name);
      writeFileSync(path, Buffer.from(data, 'base64'));
      try {
        writeFileSync(test.info().outputPath(name), Buffer.from(data, 'base64'));
      } catch {
        /* best effort */
      }
      return path;
    };
    const mp4 = save('overlay.mp4', res.mp4);
    const wav = save('overlay.wav', res.wav);
    const png = save('overlay-frame.png', res.png);
    const m = Math.round(H * 0.035);
    const pipW = Math.round(W * 0.4);
    const pipRegion = [W - m - pipW + 8, m + 8, W - m - pipW + 40, m + 40]; // the overlay's top-left corner area
    const isRedPx = ([r, g, b]) => r > 200 && g < 40 && b < 40;
    const isBluePx = ([r, g, b]) => b > 200 && r < 40 && g < 40;
    // 0.25 s: only the main track
    expect(isRedPx(regionAvg(rgbFrame(mp4, 0.25), W, pipRegion))).toBe(true);
    // 1 s: the blue PiP in the top-right corner, red elsewhere
    const f1 = rgbFrame(mp4, 1);
    expect(isBluePx(regionAvg(f1, W, pipRegion)), `pip ${regionAvg(f1, W, pipRegion)}`).toBe(true);
    expect(isRedPx(regionAvg(f1, W, [16, 16, 96, 96]))).toBe(true);
    // 3 s: the green screen overlay is keyed out where it is green -> red
    const f3 = rgbFrame(mp4, 3);
    expect(isRedPx(regionAvg(f3, W, [16, 16, 96, 96])), `keyed ${regionAvg(f3, W, [16, 16, 96, 96])}`).toBe(true);
    // the single-frame export matches
    const still = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
    expect(isBluePx(regionAvg(still, W, pipRegion))).toBe(true);
    // sound: the blue overlay's 880 Hz plays during [0.5, 2), the main track is muted
    const s = pcm(wav);
    expect(toneAmp(s, 880, 0.8, 1.6)).toBeGreaterThan(0.08);
    expect(toneAmp(s, 880, 0.05, 0.4)).toBeLessThan(0.01);
    expect(toneAmp(s, 440, 0.8, 1.6)).toBeLessThan(0.01);
    // and the green overlay's 660 Hz during [2.5, 4)
    expect(toneAmp(s, 660, 2.8, 3.6)).toBeGreaterThan(0.08);
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
    rmSync(work, { recursive: true, force: true });
  }
});
