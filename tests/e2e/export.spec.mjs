// Export area E2E: offline render (engine/exporter.js), audio mixdown (engine/audio-mix.js) and the export dialog.
// Output files are written to test-results/ and verified with ffprobe / ffmpeg.
import { test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, openStudioTab, seedMedia, waitForMediaReady, getProject, expect } from './harness.mjs';

const W = 640;
const H = 360;
const FPS = 30;
const SR = 48000;

/**
 * red 4s -> (dissolve 0.5s) -> green 3s -> (wipe-left 0.5s) -> blue 5s = 11s; music on an audio lane (0..11s,
 * 2s fade-out) and a text overlay. Layout: red [0,4), green [3.5,6.5), blue [6,11).
 */
async function buildSequence(target, [red, green, blue, music], { width = W, height = H } = {}) {
  await target.evaluate(
    ({ red, green, blue, music, width, height, fps }) => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update(
        (p) => {
          let q = M.appendMediaToTimeline(p, [red, green, blue].filter(Boolean)).project;
          if (q.tracks.video[1]) q = M.setTransition(q, q.tracks.video[1].id, { type: 'crossfade', duration: 0.5 });
          if (q.tracks.video[2]) q = M.setTransition(q, q.tracks.video[2].id, { type: 'wipe-left', duration: 0.5 });
          if (music) {
            const a = M.addAudioClip(q, music, { start: 0, lane: 0 });
            q = M.updateClip(a.project, a.id, { out: 11, fadeOut: 2 });
          }
          q = M.addTextClip(q, { text: 'HELLO', start: 1, duration: 3 }).project;
          return M.updateSettings(q, { width, height, fps });
        },
        { label: 'Build test sequence' },
      );
    },
    { red, green, blue, music, width, height, fps: FPS },
  );
}

const ffprobe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]).toString());
const rgbFrame = (file, t) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
const rgbImage = (file) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
/** Average colour of a region (x0..x1, y0..y1 inclusive-exclusive) of an rgb24 frame of width w. */
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
/** Interleaved stereo float samples of a file's audio at 48 kHz. */
function pcm(file) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 256 << 20 });
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}
const meanVolume = (file) => Number(/mean_volume: (-?[\d.]+) dB/.exec(spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString())[1]);
/** Amplitude of a sine at `freq` in the left channel between t0 and t1 (Goertzel). */
function toneAmp(samples, freq, t0, t1) {
  const s0 = Math.round(t0 * SR);
  const n = Math.round((t1 - t0) * SR);
  const k = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(k);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[2 * (s0 + i)];
    const p0 = x + coeff * p1 - p2;
    p2 = p1;
    p1 = p0;
  }
  const re = p1 - p2 * Math.cos(k);
  const im = p2 * Math.sin(k);
  return (2 * Math.hypot(re, im)) / n;
}
const onset = (samples, threshold = 0.02) => {
  for (let i = 0; i < samples.length / 2; i++) if (Math.abs(samples[2 * i]) > threshold) return i;
  return -1;
};

const isRed = ([r, g, b]) => r > 220 && g < 20 && b < 20;
const isGreen = ([r, g, b]) => r < 20 && g > 110 && g < 145 && b < 20;
const isBlue = ([r, g, b]) => r < 20 && g < 20 && b > 220;
const TOP_LEFT = [16, 16, 96, 96]; // away from the moving white box (middle band) and the caption (bottom)
const TOP_RIGHT = [W - 96, 16, W - 16, 96];

test('renders the timeline to MP4, WebM, WAV and PNG that match it', async () => {
  test.setTimeout(240_000);
  const ctx = await launch();
  const cleanup = [];
  try {
    const studio = await openStudioTab(ctx);
    const ids = await seedMedia(studio, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4', 'music.mp3'], { timeout: 60000 });
    await buildSequence(studio, ids);
    const res = await studio.evaluate(async () => {
      const { projectStore, model: M } = window.__gis;
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      const project = projectStore.get();
      const b64 = async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      };
      const meta = async (r) => ({ ...r, blob: undefined, data: await b64(r.blob), type: r.blob.type });
      const stages = [];
      let lastProgress = 0;
      let monotonic = true;
      const mp4 = await ex.exportProject(project, {
        format: 'mp4',
        onProgress: (p) => {
          if (!stages.includes(p.stage)) stages.push(p.stage);
          if (p.progress < lastProgress - 1e-9) monotonic = false;
          lastProgress = p.progress;
        },
      });
      const webm = await ex.exportProject(project, { format: 'webm' });
      const wav = await ex.exportAudioWav(project);
      const png = await ex.exportFrame(project, 1, { width: 640, height: 360 });
      const blend = await ex.exportFrame(project, 3.75, { width: 320, height: 180 });
      return {
        caps: await ex.getExportCapabilities({ width: 640, height: 360 }),
        duration: M.layoutProject(project).duration,
        stages,
        monotonic,
        lastProgress,
        mp4: await meta(mp4),
        webm: await meta(webm),
        wav: { type: wav.type, data: await b64(wav) },
        png: { type: png.type, data: await b64(png) },
        blend: { type: blend.type, data: await b64(blend) },
      };
    });
    // Checks read a private copy (other Playwright runs may wipe test-results/ concurrently); a copy is kept in
    // test-results/ for inspection.
    const work = mkdtempSync(join(tmpdir(), 'gis-export-'));
    cleanup.push(() => rmSync(work, { recursive: true, force: true }));
    const save = (name, b64) => {
      const bytes = Buffer.from(b64, 'base64');
      try {
        writeFileSync(test.info().outputPath(name), bytes);
      } catch {
        /* best effort */
      }
      const path = join(work, name);
      writeFileSync(path, bytes);
      return path;
    };
    const files = { mp4: save('export.mp4', res.mp4.data), webm: save('export.webm', res.webm.data), wav: save('export.wav', res.wav.data), png: save('frame.png', res.png.data), blend: save('blend.png', res.blend.data) };

    // Capabilities: H.264 + AAC everywhere (native or the vendored WASM encoder), VP9 + Opus for WebM.
    expect(res.caps.mp4).toEqual({ video: 'avc', audio: 'aac' });
    expect(res.caps.webm).toEqual({ video: 'vp9', audio: 'opus' });
    expect(['native', 'wasm']).toContain(res.caps.aacEncoder);
    expect(res.duration).toBe(11);
    expect(res.stages).toEqual(['prepare', 'audio', 'video', 'finalize', 'done']);
    expect(res.monotonic).toBe(true);
    expect(res.lastProgress).toBe(1);
    expect(res.mp4).toMatchObject({ type: 'video/mp4', videoCodec: 'avc', audioCodec: 'aac', width: W, height: H, fps: FPS, frames: 330, duration: 11 });
    expect(res.webm).toMatchObject({ type: 'video/webm', videoCodec: 'vp9', audioCodec: 'opus', width: W, height: H, frames: 330 });

    const frame = 1 / FPS;
    for (const [kind, vcodec, acodec] of [['mp4', 'h264', 'aac'], ['webm', 'vp9', 'opus']]) {
      const info = ffprobe(files[kind]);
      const v = info.streams.find((s) => s.codec_type === 'video');
      const a = info.streams.find((s) => s.codec_type === 'audio');
      expect(v.codec_name, kind).toBe(vcodec);
      expect(a.codec_name, kind).toBe(acodec);
      expect([v.width, v.height]).toEqual([W, H]);
      expect(Number(v.nb_read_frames), `${kind} frame count`).toBe(330);
      expect(Math.abs(Number(info.format.duration) - 11), `${kind} duration`).toBeLessThanOrEqual(frame);
      if (v.duration) expect(Math.abs(Number(v.duration) - 11)).toBeLessThanOrEqual(frame);
      expect(Number(a.sample_rate)).toBe(SR);
      expect(Number(a.channels)).toBe(2);

      // Pictures: red, dissolve blend, green, wipe split, blue — and colours as the preview shows the sources.
      const at = (t) => rgbFrame(files[kind], t);
      expect(isRed(regionAvg(at(1), W, TOP_LEFT)), `${kind} red at 1s`).toBe(true);
      const mid = regionAvg(at(3.75), W, TOP_LEFT);
      expect(mid[0], `${kind} dissolve red ${mid}`).toBeGreaterThan(90);
      expect(mid[0]).toBeLessThan(170);
      expect(mid[1], `${kind} dissolve green ${mid}`).toBeGreaterThan(40);
      expect(mid[1]).toBeLessThan(100);
      expect(isGreen(regionAvg(at(5), W, TOP_LEFT)), `${kind} green at 5s`).toBe(true);
      const wipe = at(6.25);
      expect(isGreen(regionAvg(wipe, W, TOP_LEFT)), `${kind} wipe left side`).toBe(true);
      expect(isBlue(regionAvg(wipe, W, TOP_RIGHT)), `${kind} wipe right side`).toBe(true);
      expect(isBlue(regionAvg(at(10.5), W, TOP_LEFT)), `${kind} blue at 10.5s`).toBe(true);
      // The caption is burned in while it is on screen.
      const caption = regionAvg(at(2.5), W, [W / 2 - 40, Math.round(H * 0.86) - 8, W / 2 + 40, Math.round(H * 0.86) + 8]);
      expect(caption[1], `${kind} caption`).toBeGreaterThan(60);

      expect(meanVolume(files[kind]), `${kind} audio is not silent`).toBeGreaterThan(-35);
    }

    // WAV mixdown.
    const wavInfo = ffprobe(files.wav).streams[0];
    expect(wavInfo).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: String(SR), channels: 2 });
    expect(Math.abs(Number(wavInfo.duration) - 11)).toBeLessThan(0.001);
    const wav = pcm(files.wav);
    expect(meanVolume(files.wav)).toBeGreaterThan(-35);
    // Clip sound crossfades with the picture: 440 Hz (red) -> 660 Hz (green) across [3.5, 4).
    expect(toneAmp(wav, 440, 3.0, 3.3)).toBeGreaterThan(0.08);
    expect(toneAmp(wav, 660, 3.0, 3.3)).toBeLessThan(0.02);
    expect(toneAmp(wav, 440, 3.7, 3.8)).toBeGreaterThan(0.05);
    expect(toneAmp(wav, 660, 3.7, 3.8)).toBeGreaterThan(0.05);
    expect(toneAmp(wav, 440, 4.2, 4.5)).toBeLessThan(0.02);
    expect(toneAmp(wav, 660, 4.2, 4.5)).toBeGreaterThan(0.08);
    // Music (left channel: 220 Hz during [8, 9)) at full level, then faded out (440 Hz during [10, 11), gain ~0.15).
    expect(toneAmp(wav, 220, 8.0, 8.4)).toBeGreaterThan(0.2);
    expect(toneAmp(wav, 440, 10.6, 10.9)).toBeLessThan(0.1);
    // Audio stays in sync with the picture: the encoded tracks start exactly where the mix starts
    // (AAC encoder priming trimmed by an edit list, Opus pre-skip honoured).
    for (const kind of ['mp4', 'webm']) expect(Math.abs(onset(pcm(files[kind])) - onset(wav)), `${kind} A/V offset (samples)`).toBeLessThanOrEqual(4);

    // PNG frames: full-size red frame at 1s, and the dissolve at 3.75s.
    expect(ffprobe(files.png).streams[0]).toMatchObject({ codec_name: 'png', width: W, height: H });
    expect(isRed(regionAvg(rgbImage(files.png), W, TOP_LEFT))).toBe(true);
    const half = regionAvg(rgbImage(files.blend), 320, [8, 8, 48, 48]);
    expect(Math.abs(half[0] - 127)).toBeLessThan(12);
    expect(Math.abs(half[1] - 64)).toBeLessThan(12);
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
    cleanup.forEach((fn) => fn());
  }
});

test('retimed clips keep their pitch in the mixdown (like the preview) and stay in sync', async () => {
  const ctx = await launch();
  const work = mkdtempSync(join(tmpdir(), 'gis-export-'));
  try {
    const studio = await openStudioTab(ctx);
    const [red] = await seedMedia(studio, ['clip-red.mp4']);
    const b64 = await studio.evaluate(async (red) => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => {
        const q = M.appendMediaToTimeline(p, [red]).project;
        return M.updateClip(q, q.tracks.video[0].id, { speed: 0.5 }); // 4s of 440 Hz -> 8s
      });
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      const blob = await ex.exportAudioWav(projectStore.get());
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }, red);
    const file = join(work, 'slow.wav');
    writeFileSync(file, Buffer.from(b64, 'base64'));
    expect(Math.abs(Number(ffprobe(file).streams[0].duration) - 8)).toBeLessThan(0.001);
    const wav = pcm(file);
    for (const [t0, t1] of [[0.5, 1.0], [3.5, 4.0], [7.0, 7.5]]) {
      expect(toneAmp(wav, 440, t0, t1), `440 Hz at ${t0}s`).toBeGreaterThan(0.08);
      expect(toneAmp(wav, 220, t0, t1), `no octave drop at ${t0}s`).toBeLessThan(0.02);
    }
  } finally {
    await ctx.close();
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------
// Export dialog
// ---------------------------------------------------------------------------------------------------------

/** Defines window.__b64(blob) in the page (base64 of a Blob, for moving outputs to node). */
const installB64 = (target) =>
  target.evaluate(() => {
    window.__b64 = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    };
  });

/** A private folder for output files (other runs may wipe test-results/); a copy goes to test-results/ when possible. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'gis-export-'));
  return {
    save(name, b64) {
      const bytes = Buffer.from(b64, 'base64');
      try {
        writeFileSync(test.info().outputPath(name), bytes);
      } catch {
        /* best effort */
      }
      const path = join(dir, name);
      writeFileSync(path, bytes);
      return path;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Base64 of the file behind the result card's preview (video / img / audio src). */
const resultB64 = (target) =>
  target.evaluate(async () => {
    const el = document.querySelector('.ex-result video, .ex-result img, .ex-result audio');
    return window.__b64(await (await fetch(el.src)).blob());
  });

const appErrors = (ctx) => ctx.consoleErrors.filter((e) => !/favicon/.test(e));

test('export dialog: WebM export, result card, add to bin, remembered settings', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const ids = await seedMedia(studio, ['clip-red.mp4', 'clip-green.mp4'], { timeout: 60000 });
    await buildSequence(studio, ids);
    await studio.locator('.export-btn').click();
    const modal = studio.locator('.ex-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.ex-format[data-format="mp4"]')).toHaveAttribute('aria-checked', 'true');
    await expect(modal.locator('.ex-format[data-format="mp4"] .ex-format-sub')).toHaveText('H.264 + AAC', { timeout: 20000 });
    await expect(modal.locator('.ex-chip.is-strong')).toContainText('H.264 · AAC');

    await modal.locator('.ex-format[data-format="webm"]').click();
    await expect(modal.locator('.ex-ext')).toHaveText('.webm');
    await expect(modal.locator('.ex-chip.is-strong')).toContainText('VP9 · Opus');
    await modal.locator('.ex-filename input').fill('My cut');
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-progress')).toBeVisible();
    await expect(modal.locator('.ex-result video')).toBeVisible({ timeout: 60000 });
    await expect(modal.locator('.ex-result-name')).toHaveText('My cut.webm');
    await expect(modal.locator('.ex-result-meta')).toContainText('VP9 + Opus');
    await expect(modal.locator('.ex-result-meta')).toContainText(`${W}×${H}`);
    await expect(modal.locator('.ex-result-notes')).toHaveCount(0);
    const layoutDuration = await studio.evaluate(() => window.__gis.model.layoutProject(window.__gis.projectStore.get()).duration);
    const videoDuration = await studio.evaluate(async () => {
      const v = document.querySelector('.ex-result video');
      if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
      return v.duration;
    });
    expect(Math.abs(videoDuration - layoutDuration)).toBeLessThan(0.05);

    // Save As dismissed: no error, and the render still counts as unsaved. A plain download marks it saved.
    await studio.evaluate(() => {
      window.__downloads = [];
      chrome.downloads.download = async (opts) => {
        window.__downloads.push([opts.filename, !!opts.saveAs]);
        if (opts.saveAs) throw new Error('Download canceled');
        return 1;
      };
    });
    await modal.locator('[title="Save as… (choose a folder)"]').click();
    await expect.poll(() => studio.evaluate(() => window.__downloads.length)).toBe(1);
    await studio.keyboard.press('Escape');
    const discard = studio.locator('.modal', { hasText: 'Discard this export?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep it' }).click();
    await expect(discard).toBeHidden();
    await expect(studio.locator('.toast-error')).toHaveCount(0);
    await modal.locator('.ex-download').click();
    await expect(studio.locator('.toast', { hasText: 'Downloading My cut.webm' })).toBeVisible();
    expect(await studio.evaluate(() => window.__downloads)).toEqual([
      ['My cut.webm', true],
      ['My cut.webm', false],
    ]);

    // Add the render to the bin as a new media item.
    await modal.locator('.ex-add-bin').click();
    await expect(modal.locator('.ex-add-bin')).toHaveText('In bin', { timeout: 30000 });
    const project = await getProject(studio);
    const exported = Object.values(project.media).find((m) => m.origin === 'export');
    expect(exported).toMatchObject({ kind: 'video', status: 'ready', name: 'My cut', width: W, height: H });
    expect(project.exportSettings).toMatchObject({ format: 'webm', name: 'My cut', quality: 'high' });

    // Remembered settings are preferences, not edits: undo / redo keep them.
    const remembered = project.exportSettings;
    await studio.evaluate(() => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => M.addMarker(p, 1, 'After export').project, { label: 'Add marker' });
      projectStore.undo();
      projectStore.undo();
      projectStore.undo();
      projectStore.redo();
    });
    expect((await getProject(studio)).exportSettings).toEqual(remembered);

    // Back to the settings, close with Escape, reopen: the choices are remembered.
    await modal.locator('.ex-another').click();
    await expect(modal.locator('.ex-format[data-format="webm"]')).toHaveAttribute('aria-checked', 'true');
    await studio.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await studio.keyboard.press('Control+e');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.ex-format[data-format="webm"]')).toHaveAttribute('aria-checked', 'true');
    await expect(modal.locator('.ex-filename input')).toHaveValue('My cut');

    // PNG frame and WAV modes produce their files too.
    await modal.locator('.ex-format[data-format="png"]').click();
    await expect(modal.locator('.ex-frame-preview img')).toBeVisible({ timeout: 20000 });
    await studio.keyboard.press('Enter');
    await expect(modal.locator('.ex-result img')).toBeVisible({ timeout: 30000 });
    await expect(modal.locator('.ex-result-name')).toHaveText('My cut.png');
    await modal.locator('.ex-another').click();
    await modal.locator('.ex-format[data-format="wav"]').click();
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-result audio')).toBeVisible({ timeout: 30000 });
    await expect(modal.locator('.ex-result-meta')).toContainText('PCM 16-bit');
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('export dialog keyboard: Enter exports right away, choices take Enter first, buttons keep theirs', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const ids = await seedMedia(studio, ['clip-red.mp4', 'clip-green.mp4'], { timeout: 60000 });
    await buildSequence(studio, ids);
    const modal = studio.locator('.ex-modal');
    const progress = modal.locator('.ex-progress');
    const cancel = modal.getByRole('button', { name: 'Cancel export' });

    // Focus starts inside the dialog, so Enter right after opening starts the export.
    await studio.locator('.export-btn').click();
    await expect(modal.locator('.ex-format[data-format="mp4"]')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => studio.evaluate(() => !!document.activeElement?.closest('.ex-modal'))).toBe(true);
    await studio.keyboard.press('Enter');
    await expect(progress).toBeVisible();
    await cancel.click();
    await expect(modal.locator('.ex-start')).toBeVisible();

    // A focused format tile that isn't chosen: Enter chooses it without exporting...
    await modal.locator('.ex-format[data-format="webm"]').focus();
    await studio.keyboard.press('Enter');
    await expect(modal.locator('.ex-format[data-format="webm"]')).toHaveAttribute('aria-checked', 'true');
    await expect(modal.locator('.ex-ext')).toHaveText('.webm');
    await studio.waitForTimeout(300);
    await expect(progress).toHaveCount(0);
    // ...and Enter on the chosen one exports exactly that format.
    await studio.keyboard.press('Enter');
    await expect(modal.locator('.ex-result video')).toBeVisible({ timeout: 60000 });
    await expect(modal.locator('.ex-result-name')).toHaveText('My first sequence.webm');
    await expect(modal.locator('.ex-result-meta')).toContainText('VP9');
    await modal.locator('.ex-another').click();

    // Segmented options work the same way.
    const low = modal.locator('.segmented button', { hasText: 'Low' });
    await low.focus();
    await studio.keyboard.press('Enter');
    await expect(low).toHaveClass(/is-active/);
    await studio.waitForTimeout(300);
    await expect(progress).toHaveCount(0);
    await studio.keyboard.press('Enter');
    await expect(progress).toBeVisible();
    await cancel.click();
    await expect(modal.locator('.ex-start')).toBeVisible();

    // Ctrl+Enter exports from inside a field; a focused button keeps its own Enter (Cancel closes).
    await modal.locator('.field', { hasText: 'Resolution' }).locator('select').focus();
    await studio.keyboard.press('Control+Enter');
    await expect(progress).toBeVisible();
    await cancel.click();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await studio.keyboard.press('Enter');
    await expect(modal).toBeHidden();
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('export dialog: empty timeline teaches the next step, unfinished downloads block, failures show inline', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await studio.locator('.export-btn').click();
    const modal = studio.locator('.ex-modal');
    await expect(modal.locator('.empty-title')).toHaveText('Nothing to export yet');
    await modal.getByRole('button', { name: 'Go to the Edit tab' }).click();
    await expect(modal).toBeHidden();
    expect(await studio.evaluate(() => window.__gis.uiStore.get().tab)).toBe('edit');
    // Opened from the Edit tab itself, it points to where clips come from instead (and can just close).
    await studio.locator('.export-btn').click();
    await expect(modal.locator('.empty-title')).toHaveText('Nothing to export yet');
    await expect(modal.getByRole('button', { name: 'Go to the Edit tab' })).toHaveCount(0);
    await expect(modal.locator('.empty-body')).toContainText('drag them from the bin here onto the timeline');
    await modal.locator('.empty-action').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
    expect(await studio.evaluate(() => window.__gis.uiStore.get().tab)).toBe('edit');
    await studio.locator('.export-btn').click();
    await modal.getByRole('button', { name: 'Collect clips' }).click();
    await expect(modal).toBeHidden();
    expect(await studio.evaluate(() => window.__gis.uiStore.get().tab)).toBe('clips');

    // A clip that is still downloading sits on the timeline.
    await studio.evaluate(() => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => {
        const m = M.createMediaItem({ id: 'med_pending', kind: 'video', name: 'Pending clip', duration: 3, status: 'loading' });
        return M.appendMediaToTimeline(M.addMedia(p, m), [m.id]).project;
      });
    });
    await studio.locator('.export-btn').click();
    await expect(modal.locator('.ex-banner')).toContainText('Waiting for 1 clip to finish downloading');
    await expect(modal.locator('.ex-banner')).toContainText('Pending clip');
    await expect(modal.locator('.ex-start')).toBeDisabled();
    await studio.evaluate(() => window.__gis.projectStore.update((p) => window.__gis.model.updateMedia(p, 'med_pending', { status: 'error', error: 'HTTP 403' }), { history: false }));
    await expect(modal.locator('.ex-banner')).toContainText('1 clip failed to download');
    await expect(modal.locator('.ex-banner').getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(modal.locator('.ex-start')).toBeDisabled();
    // Both kinds at once: the title counts both.
    await studio.evaluate(() => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => {
        const m = M.createMediaItem({ id: 'med_pending2', kind: 'video', name: 'Second clip', duration: 2, status: 'loading' });
        return M.appendMediaToTimeline(M.addMedia(p, m), [m.id]).project;
      });
    });
    await expect(modal.locator('.ex-banner-title')).toHaveText('1 clip failed to download · 1 still downloading');
    await expect(modal.locator('.ex-banner-body')).toHaveText('Pending clip, Second clip');
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();

    // A failure while exporting is shown in the dialog (once — no duplicate toast).
    await studio.evaluate(() => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => {
        const q = M.removeClips(p, p.tracks.video.map((c) => c.id));
        const m = M.createMediaItem({ id: 'med_gone', kind: 'video', name: 'Gone clip', duration: 2, status: 'ready', hasAudio: false, width: 640, height: 360 });
        return M.appendMediaToTimeline(M.addMedia(q, m), [m.id]).project;
      });
    });
    await studio.locator('.export-btn').click();
    await modal.locator('.ex-format[data-format="webm"]').click();
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-error')).toContainText('"Gone clip" is not available offline any more');
    await expect(modal.getByRole('button', { name: 'Try again' })).toBeVisible();
    await studio.waitForTimeout(400);
    await expect(studio.locator('.toast-error')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Back to settings' }).click();
    await expect(modal.locator('.ex-start')).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test('cancelling: AbortSignal stops a render, Cancel resets at once, Escape asks inline', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const ids = await seedMedia(studio, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4'], { timeout: 60000 });
    await buildSequence(studio, ids, { width: 1920, height: 1080 });
    // Long enough at 1080p that the render is still going while the UI is driven.
    await studio.evaluate((media) => window.__gis.projectStore.update((p) => window.__gis.model.appendMediaToTimeline(p, [...media, ...media]).project), ids);
    const aborted = await studio.evaluate(async () => {
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      const ac = new AbortController();
      let abortedAt = 0;
      try {
        await ex.exportProject(window.__gis.projectStore.get(), {
          format: 'mp4',
          signal: ac.signal,
          onProgress: (p) => {
            if (p.stage === 'video' && p.frame > 5 && !ac.signal.aborted) {
              abortedAt = performance.now();
              ac.abort();
            }
          },
        });
        return { name: 'finished' };
      } catch (e) {
        return { name: e.name, settleMs: performance.now() - abortedAt };
      }
    });
    expect(aborted.name).toBe('AbortError');
    expect(aborted.settleMs).toBeLessThan(3000);

    const modal = studio.locator('.ex-modal');
    const stop = modal.locator('.ex-stop');
    await studio.locator('.export-btn').click();
    await modal.locator('.segmented button', { hasText: 'Max' }).click();
    // Cancel button: back to the settings.
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-progress')).toBeVisible();
    await expect(modal.locator('.ex-elapsed')).toBeVisible();
    await modal.getByRole('button', { name: 'Cancel export' }).click();
    await expect(modal.locator('.ex-start')).toBeVisible();
    await expect(studio.locator('.toast', { hasText: 'Export cancelled' })).toBeVisible();

    // Escape while rendering asks inline (the render stays visible, no second dialog); Escape again keeps going.
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-progress')).toBeVisible();
    await studio.keyboard.press('Escape');
    await expect(stop).toContainText('Stop the export?');
    await expect(modal.locator('.ex-keep')).toBeFocused();
    await expect(studio.locator('.modal')).toHaveCount(1);
    await expect(modal.locator('.ex-progress')).toBeVisible();
    await studio.keyboard.press('Escape');
    await expect(stop).toHaveCount(0);
    await expect(modal.locator('.ex-progress')).toBeVisible();
    // The close button asks the same; "Keep rendering" answers it; "Stop export" stops and closes.
    await modal.locator('.modal-header [title="Close"]').click();
    await expect(stop).toBeVisible();
    await modal.locator('.ex-keep').click();
    await expect(stop).toHaveCount(0);
    await modal.locator('.modal-header [title="Close"]').click();
    await modal.locator('.ex-stop-btn').click();
    await expect(modal).toBeHidden();
    await expect(studio.locator('.toast', { hasText: 'Export cancelled' }).last()).toBeVisible();

    // Cancelling a PNG while it encodes (made slow on purpose) returns at once; the late result never shows up.
    await studio.locator('.export-btn').click();
    await modal.locator('.ex-format[data-format="png"]').click();
    await expect(modal.locator('.ex-frame-preview img')).toBeVisible({ timeout: 20000 });
    await studio.evaluate(() => {
      const encode = OffscreenCanvas.prototype.convertToBlob;
      window.__pngEncodes = 0;
      OffscreenCanvas.prototype.convertToBlob = async function convertToBlob(opts) {
        if (opts?.type === 'image/png') {
          window.__pngEncodes++;
          await new Promise((r) => setTimeout(r, 2500));
        }
        return encode.call(this, opts);
      };
    });
    await modal.locator('.ex-start').click();
    await expect.poll(() => studio.evaluate(() => window.__pngEncodes)).toBe(1);
    const t0 = Date.now();
    await modal.getByRole('button', { name: 'Cancel export' }).click();
    await expect(modal.locator('.ex-start')).toBeVisible();
    expect(Date.now() - t0).toBeLessThan(1500);
    await studio.waitForTimeout(3500);
    await expect(modal.locator('.ex-result')).toHaveCount(0);
    await expect(modal.locator('.ex-progress')).toHaveCount(0);
    await expect(modal.locator('.modal-title')).toHaveText('Export');
    // A second Cancel isn't needed and the dialog works normally afterwards.
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-result img')).toBeVisible({ timeout: 30000 });
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('a render that finishes while "Stop the export?" is open is kept', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const ids = await seedMedia(studio, ['clip-red.mp4', 'clip-green.mp4'], { timeout: 60000 });
    await buildSequence(studio, ids);
    const modal = studio.locator('.ex-modal');
    await studio.locator('.export-btn').click();
    await modal.locator('.ex-format[data-format="webm"]').click();
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-progress')).toBeVisible();
    await studio.keyboard.press('Escape');
    await expect(modal.locator('.ex-stop')).toBeVisible();
    // Nobody answers: the render completes and the result replaces the question.
    await expect(modal.locator('.ex-result video')).toBeVisible({ timeout: 60000 });
    await expect(modal.locator('.modal-title')).toHaveText('Export ready');
    await expect(modal.locator('.ex-stop')).toHaveCount(0);
    // Closing now protects the unsaved file.
    await studio.keyboard.press('Escape');
    const discard = studio.locator('.modal', { hasText: 'Discard this export?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep it' }).click();
    await expect(modal.locator('.ex-result video')).toBeVisible();
    await studio.keyboard.press('Escape');
    await discard.getByRole('button', { name: 'Discard' }).click();
    await expect(modal).toBeHidden();
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('PNG preview is framed like the export (chosen resolution and shape)', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const [hd] = await seedMedia(studio, ['clip-hd.mp4'], { timeout: 60000 });
    await studio.evaluate((id) => {
      const { projectStore, uiStore, model: M } = window.__gis;
      projectStore.update((p) => M.updateSettings(M.appendMediaToTimeline(p, [id]).project, { width: 1280, height: 720, fps: 30 }), { label: 'Build' });
      uiStore.set((s) => ({ ...s, playhead: 3 })); // the moving white box is inside the 9:16 crop here
    }, hd);
    const modal = studio.locator('.ex-modal');
    await studio.locator('.export-btn').click();
    await modal.locator('.ex-format[data-format="png"]').click();
    // Custom size with the aspect lock: the ratio is kept exactly, however many edits (no rounding drift).
    const resolution = modal.locator('.field', { hasText: 'Resolution' }).locator('select');
    await resolution.selectOption('custom');
    const [cw, ch] = [modal.locator('.ex-custom-size input').nth(0), modal.locator('.ex-custom-size input').nth(1)];
    const typeSize = async (input, value) => {
      await input.fill(String(value));
      await input.press('Enter');
    };
    for (const [input, value, other, expected] of [
      [cw, 1001, ch, '564'],
      [cw, 1920, ch, '1080'],
      [ch, 333, cw, '592'],
      [ch, 1080, cw, '1920'],
      [cw, 1002, ch, '564'],
      [cw, 1280, ch, '720'],
    ]) {
      await typeSize(input, value);
      await expect(other, `${value} -> ${expected}`).toHaveValue(expected);
    }
    await modal.locator('.ex-custom-size [title="Aspect ratio locked"]').click();
    await typeSize(cw, 1000);
    await expect(ch).toHaveValue('720');
    await expect(modal.locator('.ex-chips')).toContainText('1000×720');
    await resolution.selectOption('720v');
    const img = modal.locator('.ex-frame-preview img');
    await expect.poll(() => img.evaluate((el) => `${el.naturalWidth}x${el.naturalHeight}`).catch(() => ''), { timeout: 20000 }).toBe('270x480');
    const box = await modal.locator('.ex-frame-preview').boundingBox();
    expect(Math.abs(box.width / box.height - 720 / 1280)).toBeLessThan(0.02);
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-result img')).toBeVisible({ timeout: 30000 });
    // The preview (re-rendered the way the dialog does) and the exported frame show the same crop, compared at 27×48.
    const cmp = await studio.evaluate(async () => {
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      const p = window.__gis.projectStore.get();
      const toPx = async (blob) => {
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(27, 48);
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0, 27, 48);
        return { size: `${bmp.width}x${bmp.height}`, px: Array.from(g.getImageData(0, 0, 27, 48).data) };
      };
      const result = await toPx(await (await fetch(document.querySelector('.ex-result img').src)).blob());
      const preview = await toPx(await ex.exportFrame(p, 3, { width: 270, height: 480, type: 'image/jpeg', quality: 0.85 }));
      let sum = 0;
      for (let i = 0; i < result.px.length; i++) if (i % 4 !== 3) sum += Math.abs(result.px[i] - preview.px[i]);
      // white pixels: where the box is in the result
      let white = 0;
      for (let i = 0; i < result.px.length; i += 4) if (result.px[i] > 200 && result.px[i + 1] > 200 && result.px[i + 2] > 200) white++;
      return { result: result.size, preview: preview.size, meanDiff: sum / ((result.px.length / 4) * 3), white };
    });
    expect(cmp.result).toBe('720x1280');
    expect(cmp.preview).toBe('270x480');
    expect(cmp.white, 'the white box is in the exported crop').toBeGreaterThan(3);
    expect(cmp.meanDiff).toBeLessThan(8);
  } finally {
    await ctx.close();
  }
});

test('long mixdowns keep the page responsive, show live progress and cancel at once', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const ids = await seedMedia(studio, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4'], { timeout: 60000 });
    const duration = await studio.evaluate((media) => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => {
        let q = p;
        for (let i = 0; i < 8; i++) q = M.appendMediaToTimeline(q, media).project;
        for (const c of q.tracks.video) q = M.updateClip(q, c.id, { speed: 0.5 }); // pitch-preserving stretch work
        return M.updateSettings(q, { width: 640, height: 360, fps: 30 });
      }, { label: 'Long retimed sequence' });
      return M.layoutProject(projectStore.get()).duration;
    }, ids);
    expect(duration).toBeGreaterThan(180);
    const modal = studio.locator('.ex-modal');
    await studio.locator('.export-btn').click();
    await modal.locator('.ex-format[data-format="wav"]').click();
    await modal.locator('.ex-start').click();
    const samples = [];
    let maxRoundTrip = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const s = Date.now();
      const state = await studio.evaluate(() => ({
        running: !!document.querySelector('.ex-modal .ex-progress'),
        done: !!document.querySelector('.ex-modal .ex-result'),
        pct: Number.parseInt(document.querySelector('.ex-modal .ex-pct')?.textContent || 'NaN', 10),
        elapsed: document.querySelector('.ex-modal .ex-elapsed')?.textContent || null,
      }));
      maxRoundTrip = Math.max(maxRoundTrip, Date.now() - s);
      if (state.done) break;
      if (state.running) samples.push(state);
      await studio.waitForTimeout(150);
    }
    await expect(modal.locator('.ex-result audio')).toBeVisible();
    const pcts = samples.map((x) => x.pct).filter(Number.isFinite);
    const elapsed = new Set(samples.map((x) => x.elapsed));
    expect(maxRoundTrip, 'the page answers while mixing').toBeLessThan(1000);
    expect(elapsed.size, `elapsed keeps ticking (${[...elapsed]})`).toBeGreaterThanOrEqual(3);
    expect(new Set(pcts).size, `progress moves (${pcts})`).toBeGreaterThanOrEqual(3);
    expect(pcts.every((v, i) => i === 0 || v >= pcts[i - 1])).toBe(true);
    await expect(modal.locator('.ex-result-meta')).toContainText(formatTimeLike(duration));

    // Cancel in the middle of the mix: back to the settings at once, no late result.
    await modal.locator('.ex-another').click();
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-progress')).toBeVisible();
    await studio.waitForTimeout(700);
    const c0 = Date.now();
    await modal.getByRole('button', { name: 'Cancel export' }).click();
    await expect(modal.locator('.ex-start')).toBeVisible();
    expect(Date.now() - c0).toBeLessThan(1500);
    await studio.waitForTimeout(3000);
    await expect(modal.locator('.ex-result')).toHaveCount(0);
    await expect(modal.locator('.modal-title')).toHaveText('Export');
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

/** "5:12.00"-style text the result card shows for a duration. */
function formatTimeLike(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

test('stills slideshow renders and frees images; a clip whose sound cannot be decoded is reported', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  const ws = workspace();
  try {
    const studio = await openStudioTab(ctx);
    await installB64(studio);
    const [r, g, b, mute] = await seedMedia(studio, ['thumb-red.jpg', 'thumb-green.jpg', 'thumb-blue.jpg', 'clip-noaudio.mp4'], { timeout: 60000 });
    await studio.evaluate(({ r, g, b, mute }) => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => {
        let q = M.appendMediaToTimeline(p, [r, g, b, mute]).project;
        for (const c of q.tracks.video.slice(0, 3)) q = M.updateClip(q, c.id, { out: 1 });
        // The probe found no audio track; pretend it has one so the mixdown tries (and fails) to decode it.
        q = M.updateMedia(q, mute, { hasAudio: true, name: 'Yellow clip' });
        return M.updateSettings(q, { width: 640, height: 360, fps: 30 });
      }, { label: 'Slideshow' });
    }, { r, g, b, mute });
    const res = await studio.evaluate(async () => {
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      // Count live ImageBitmaps made by the export.
      const live = new Set();
      let maxLive = 0;
      const origCreate = window.createImageBitmap;
      const origClose = ImageBitmap.prototype.close;
      window.createImageBitmap = async (...args) => {
        const bmp = await origCreate(...args);
        live.add(bmp);
        maxLive = Math.max(maxLive, live.size);
        return bmp;
      };
      ImageBitmap.prototype.close = function close() {
        live.delete(this);
        return origClose.call(this);
      };
      const warnings = [];
      let out;
      try {
        out = await ex.exportProject(window.__gis.projectStore.get(), { format: 'webm', onWarning: (w) => warnings.push(w) });
      } finally {
        window.createImageBitmap = origCreate;
        ImageBitmap.prototype.close = origClose;
      }
      return { warnings, returned: out.warnings, maxLive, leftOpen: live.size, duration: out.duration, data: await window.__b64(out.blob) };
    });
    expect(res.duration).toBe(5);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatchObject({ mediaId: mute, name: 'Yellow clip' });
    expect(res.warnings[0].message).toContain('The sound of "Yellow clip" couldn\'t be decoded');
    expect(res.returned).toEqual(res.warnings);
    expect(res.maxLive, 'at most the stills on screen and the next one are decoded').toBeLessThanOrEqual(2);
    expect(res.leftOpen).toBe(0);
    const file = ws.save('slideshow.webm', res.data);
    expect(isRed(regionAvg(rgbFrame(file, 0.5), W, TOP_LEFT)), 'red still').toBe(true);
    expect(isGreen(regionAvg(rgbFrame(file, 1.5), W, TOP_LEFT)), 'green still').toBe(true);
    expect(isBlue(regionAvg(rgbFrame(file, 2.5), W, TOP_LEFT)), 'blue still').toBe(true);
    const yellow = regionAvg(rgbFrame(file, 4), W, TOP_LEFT);
    expect(yellow[0] > 200 && yellow[1] > 200 && yellow[2] < 60, `yellow clip ${yellow}`).toBe(true);

    // The dialog shows the same warning on the result card.
    const modal = studio.locator('.ex-modal');
    await studio.locator('.export-btn').click();
    await modal.locator('.ex-format[data-format="wav"]').click();
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-result audio')).toBeVisible({ timeout: 30000 });
    await expect(modal.locator('.ex-result-notes .ex-note-warn')).toContainText('The sound of "Yellow clip" couldn\'t be decoded');
  } finally {
    await ctx.close();
    ws.cleanup();
  }
});

test('MP4 falls back to Opus audio, and says so, when the AAC encoder cannot start', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  const ws = workspace();
  try {
    const studio = await openStudioTab(ctx);
    await installB64(studio);
    // Before anything probes the encoders: make the vendored WASM AAC module fail to load.
    await studio.evaluate(async () => {
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      ex.resetExportCapabilities({ aacLoader: () => Promise.reject(new Error('blocked by the test')) });
    });
    const ids = await seedMedia(studio, ['clip-red.mp4', 'clip-green.mp4'], { timeout: 60000 });
    await buildSequence(studio, ids);
    const modal = studio.locator('.ex-modal');
    await studio.locator('.export-btn').click();
    await expect(modal.locator('.ex-format[data-format="mp4"] .ex-format-sub')).toHaveText('H.264 + Opus', { timeout: 20000 });
    await expect(modal.locator('.ex-chip.is-strong')).toContainText('H.264 · Opus');
    await expect(modal.locator('.ex-note-warn')).toContainText('AAC isn’t available, so this MP4 gets Opus audio');
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-result video')).toBeVisible({ timeout: 60000 });
    await expect(modal.locator('.ex-result-meta')).toContainText('H.264 + Opus');
    const file = ws.save('opus-fallback.mp4', await resultB64(studio));
    const info = ffprobe(file);
    expect(info.format.format_name).toContain('mp4');
    expect(info.streams.find((s) => s.codec_type === 'video').codec_name).toBe('h264');
    expect(info.streams.find((s) => s.codec_type === 'audio').codec_name).toBe('opus');
    expect(Math.abs(Number(info.format.duration) - 6.5)).toBeLessThanOrEqual(1 / FPS + 0.03);
    expect(meanVolume(file)).toBeGreaterThan(-35);

    // After a reset with the real loader, MP4 gets AAC again.
    await studio.keyboard.press('Escape');
    await studio.locator('.modal', { hasText: 'Discard this export?' }).getByRole('button', { name: 'Discard' }).click();
    await expect(modal).toBeHidden();
    await studio.evaluate(async () => {
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      ex.resetExportCapabilities({ aacLoader: null });
    });
    await studio.locator('.export-btn').click();
    await expect(modal.locator('.ex-format[data-format="mp4"] .ex-format-sub')).toHaveText('H.264 + AAC', { timeout: 20000 });
    await expect(modal.locator('.ex-note-warn')).toHaveCount(0);
  } finally {
    await ctx.close();
    ws.cleanup();
  }
});

test('repeated exports reuse the decoded music the preview plays instead of decoding the whole file again', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const [red, music] = await seedMedia(studio, ['clip-red.mp4', 'music.mp3'], { timeout: 60000 });
    await studio.evaluate(({ red, music }) => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => {
        const q = M.appendMediaToTimeline(p, [red]).project;
        return M.updateSettings(M.addAudioClip(q, music, { start: 0, in: 6, out: 10 }).project, { width: 320, height: 180, fps: 30 });
      }, { label: 'Clip + 4 s of the song' });
    }, { red, music });
    const decoded = await studio.evaluate(async ({ red, music }) => {
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      const { media } = window.__gis.projectStore.get();
      const sizes = new Map([[media[red].size, 'red'], [media[music].size, 'music']]);
      const log = [];
      const orig = BaseAudioContext.prototype.decodeAudioData;
      BaseAudioContext.prototype.decodeAudioData = function decodeAudioData(data, ...rest) {
        log.push(sizes.get(data.byteLength) || data.byteLength);
        return orig.call(this, data, ...rest);
      };
      const runs = [];
      try {
        for (const run of [() => ex.exportProject(window.__gis.projectStore.get(), { format: 'webm' }), () => ex.exportProject(window.__gis.projectStore.get(), { format: 'mp4' }), () => ex.exportAudioWav(window.__gis.projectStore.get())]) {
          await run();
          runs.push(log.splice(0));
        }
      } finally {
        BaseAudioContext.prototype.decodeAudioData = orig;
      }
      return runs;
    }, { red, music });
    // The song (whose decoded sound the preview Player schedules) is decoded once at most — not again by every export.
    expect(decoded.flat().filter((x) => x === 'music').length, JSON.stringify(decoded)).toBeLessThanOrEqual(1);
    // The clip's own sound is only needed by exports (the preview plays it through <video>): freed after each one,
    // so every later export decodes it again.
    expect(decoded.map((run) => run.filter((x) => x === 'red').length).slice(1), JSON.stringify(decoded)).toEqual([1, 1]);
  } finally {
    await ctx.close();
  }
});

test('a clip whose file stops decoding partway holds its last good frame, and the export says so', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  const ws = workspace();
  try {
    const studio = await openStudioTab(ctx);
    await installB64(studio);
    const [green] = await seedMedia(studio, ['clip-green.mp4'], { timeout: 60000 });
    // The first 30 000 of clip-red.mp4's 58 066 bytes: the index at the front still lists all 4 s, so the import
    // succeeds, but frames and sound stop at about 1.8 s.
    const broken = await studio.evaluate(async () => {
      const full = await (await fetch('https://assets.grok.com/test/clip-red.mp4')).blob();
      return window.__gis.media.addBlobAsMedia(full.slice(0, 30000, 'video/mp4'), { name: 'Broken clip', kind: 'video' });
    });
    await waitForMediaReady(studio, [broken]);
    await studio.evaluate(({ broken, green }) => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => M.updateSettings(M.appendMediaToTimeline(p, [broken, green]).project, { width: 640, height: 360, fps: 30 }), { label: 'Broken + green' });
    }, { broken, green });
    const res = await studio.evaluate(async () => {
      const ex = await import(chrome.runtime.getURL('studio/engine/exporter.js'));
      const warnings = [];
      const out = await ex.exportProject(window.__gis.projectStore.get(), { format: 'webm', onWarning: (w) => warnings.push(w) });
      // A PNG of a frame the file no longer holds fails with a reason instead of showing some other frame.
      const still = await ex.exportFrame(window.__gis.projectStore.get(), 1, { width: 64, height: 36 }).then((b) => b.type);
      const missing = await ex.exportFrame(window.__gis.projectStore.get(), 3, { width: 64, height: 36 }).then(() => 'rendered', (e) => e.message);
      return { warnings, returned: out.warnings, duration: out.duration, still, missing, data: await window.__b64(out.blob) };
    });
    expect(res.duration).toBe(7);
    expect(res.still).toBe('image/png');
    expect(res.missing).toBe('Couldn\'t decode "Broken clip" at 0:03.00 — the file may be damaged or incomplete');
    expect(res.returned).toEqual(res.warnings);
    expect(res.warnings.map((w) => w.mediaId)).toEqual([broken, broken]); // green is fine
    const [sound, picture] = res.warnings; // the mix runs before the frames
    expect(sound.message).toMatch(/^The sound of "Broken clip" stops at 0:01\.\d\d \(the file may be damaged or incomplete\), so this export is silent for 2\.\ds where it should play\.$/);
    expect(picture.message).toMatch(/^"Broken clip" stops decoding at 0:01\.\d\d \(the file may be damaged or incomplete\), so its last good frame is held for 2\.\ds from 0:01\.\d\d on the timeline\.$/);
    // The file: red stays on screen (held, not black) until green starts at 4 s; red's tone, then silence, then green's.
    const file = ws.save('broken.webm', res.data);
    expect(isRed(regionAvg(rgbFrame(file, 3.0), W, TOP_LEFT)), 'held red frame').toBe(true);
    expect(isGreen(regionAvg(rgbFrame(file, 5.0), W, TOP_LEFT)), 'green').toBe(true);
    const wav = pcm(file);
    expect(toneAmp(wav, 440, 0.4, 1.4)).toBeGreaterThan(0.08);
    expect(toneAmp(wav, 440, 2.3, 3.8)).toBeLessThan(0.02);
    expect(toneAmp(wav, 660, 4.4, 6.6)).toBeGreaterThan(0.08);

    // The dialog's result card lists both.
    const modal = studio.locator('.ex-modal');
    await studio.locator('.export-btn').click();
    await modal.locator('.ex-format[data-format="webm"]').click();
    await modal.locator('.ex-start').click();
    await expect(modal.locator('.ex-result video')).toBeVisible({ timeout: 60000 });
    await expect(modal.locator('.ex-result-notes .ex-note-warn')).toHaveCount(2);
    await expect(modal.locator('.ex-result-notes')).toContainText('The sound of "Broken clip" stops at');
    await expect(modal.locator('.ex-result-notes')).toContainText('"Broken clip" stops decoding at');
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
    ws.cleanup();
  }
});

test('music past the last clip: the summary says the end has no picture and offers to fit the audio or end there', async () => {
  test.setTimeout(180_000);
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const [red, music] = await seedMedia(studio, ['clip-red.mp4', 'music.mp3'], { timeout: 60000 });
    await studio.evaluate(({ red, music }) => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => M.updateSettings(M.addAudioClip(M.appendMediaToTimeline(p, [red]).project, music, { start: 0 }).project, { width: 640, height: 360, fps: 30 }), { label: '4 s clip, 12 s song' });
    }, { red, music });
    const modal = studio.locator('.ex-modal');
    const note = modal.locator('.ex-summary .ex-note', { hasText: 'have no picture' });
    await studio.locator('.export-btn').click();
    await expect(note).toHaveText(/The last 8s have no picture — only sound over the background colour\./);
    await expect(note).toHaveClass(/ex-note-warn/);
    await expect(modal.locator('.ex-range .ex-label-aside')).toContainText(/0:00\.00 – 0:12\.0\d/); // the song lasts 12.04 s

    // "End at 0:04.00": a custom range that stops with the last clip (the sequence is untouched).
    await note.getByRole('button', { name: 'End at 0:04.00' }).click();
    await expect(modal.locator('.ex-range .ex-label-aside')).toContainText('0:00.00 – 0:04.00');
    await expect(modal.locator('.ex-range .segmented .is-active')).toHaveText('Custom');
    await expect(note).toHaveCount(0);
    expect((await getProject(studio)).tracks.audio[0].out).toBeCloseTo(12, 1);

    // Back to the whole sequence: "Fit audio to video" trims the song (1 s fade-out), undoable from the toast.
    await modal.locator('.ex-range .segmented button', { hasText: 'Whole sequence' }).click();
    await expect(note).toBeVisible();
    await note.getByRole('button', { name: 'Fit audio to video' }).click();
    await expect(note).toHaveCount(0);
    await expect(modal.locator('.ex-range .ex-label-aside')).toContainText('0:00.00 – 0:04.00');
    let audio = (await getProject(studio)).tracks.audio[0];
    expect(audio.out - audio.in).toBeCloseTo(4, 3);
    expect(audio.fadeOut).toBe(1);
    const toastEl = studio.locator('.toast', { hasText: 'The audio now ends with the last clip' });
    await toastEl.getByRole('button', { name: 'Undo' }).click();
    await expect(note).toBeVisible();
    audio = (await getProject(studio)).tracks.audio[0];
    expect(audio.out - audio.in).toBeCloseTo(12, 1);

    // Titles alone over the end read as an end card: a softer note, and nothing to fit.
    await studio.evaluate(() => {
      const { projectStore, model: M } = window.__gis;
      projectStore.update((p) => M.addTextClip(M.removeClips(p, p.tracks.audio.map((c) => c.id)), { text: 'THE END', start: 3.5, duration: 3 }).project, { label: 'End card' });
    });
    await expect(modal.locator('.ex-summary .ex-note', { hasText: 'have no picture' })).toHaveText(/The last 2\.5s have no picture — only titles over the background colour\./);
    await expect(modal.locator('.ex-summary .ex-note', { hasText: 'have no picture' })).toHaveClass(/ex-note-info/);
    await expect(modal.getByRole('button', { name: 'Fit audio to video' })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'End at 0:04.00' })).toBeVisible();
    // PNG and WAV exports don't render that ending as video: no note there.
    await modal.locator('.ex-format[data-format="wav"]').click();
    await expect(modal.locator('.ex-summary .ex-note', { hasText: 'have no picture' })).toHaveCount(0);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});
