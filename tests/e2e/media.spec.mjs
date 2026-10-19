// Core media pipeline (studio/core/media.js): import from URL/File, probing, previews, peaks, audio decode, frame grabs, errors.
import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { launch, openStudioTab, seedMedia, getProject, fixture, expect } from './harness.mjs';

test('imports every fixture type with correct metadata and previews', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const files = ['clip-red.mp4', 'clip-cyan.webm', 'clip-noaudio.mp4', 'clip-vertical.mp4', 'music.mp3', 'voice.wav', 'still.jpg', 'still.png'];
    const ids = await seedMedia(studio, files, { timeout: 60000 });
    const p = await getProject(studio);
    const byName = Object.fromEntries(ids.map((id, i) => [files[i], p.media[id]]));
    const near = (a, b, eps = 0.15) => Math.abs(a - b) <= eps;

    expect(byName['clip-red.mp4']).toMatchObject({ kind: 'video', width: 640, height: 360, hasAudio: true, status: 'ready' });
    expect(near(byName['clip-red.mp4'].duration, 4)).toBe(true);
    expect(byName['clip-red.mp4'].fps).toBeGreaterThan(25);
    expect(byName['clip-cyan.webm']).toMatchObject({ kind: 'video', hasAudio: true });
    expect(near(byName['clip-cyan.webm'].duration, 3)).toBe(true);
    expect(byName['clip-noaudio.mp4']).toMatchObject({ kind: 'video', hasAudio: false });
    expect(byName['clip-vertical.mp4']).toMatchObject({ width: 360, height: 640 });
    expect(byName['music.mp3'].kind).toBe('audio');
    expect(near(byName['music.mp3'].duration, 12, 0.2)).toBe(true);
    expect(byName['voice.wav'].kind).toBe('audio');
    expect(byName['still.jpg']).toMatchObject({ kind: 'image', width: 1024, height: 1024, duration: 0 });
    expect(byName['still.png']).toMatchObject({ kind: 'image', width: 800, height: 600 });

    const details = await studio.evaluate(async (allIds) => {
      const media = window.__gis.media;
      const out = {};
      for (const id of allIds) {
        const prev = await media.getPreviews(id);
        const peaks = await media.getPeaks(id);
        out[id] = { thumb: !!prev?.thumb, strip: !!prev?.strip, stripCount: prev?.stripCount || 0, peaks: peaks ? peaks.length : 0 };
      }
      return out;
    }, ids);
    for (const f of ['clip-red.mp4', 'clip-cyan.webm', 'clip-vertical.mp4']) {
      const d = details[ids[files.indexOf(f)]];
      expect(d.thumb && d.strip, `${f} previews`).toBe(true);
      expect(d.stripCount).toBe(10);
    }
    expect(details[ids[files.indexOf('still.jpg')]].thumb).toBe(true);
    expect(details[ids[files.indexOf('music.mp3')]].peaks).toBeGreaterThan(1000); // 12s * 50/s * 2
    expect(details[ids[files.indexOf('clip-red.mp4')]].peaks).toBeGreaterThan(300); // video sound waveform
    expect(details[ids[files.indexOf('clip-noaudio.mp4')]].peaks).toBe(0);

    // frame grab: correct size and colour (red clip, white box moves across the middle — sample the top-left)
    const grab = await studio.evaluate(async (id) => {
      const blob = await window.__gis.media.grabFrame(id, 1.0);
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      return { type: blob.type, w: bmp.width, h: bmp.height, px: Array.from(g.getImageData(10, 10, 1, 1).data.slice(0, 3)) };
    }, ids[0]);
    expect(grab).toMatchObject({ type: 'image/png', w: 640, h: 360 });
    // colour-faithful: untagged SD H.264 must decode like Chrome's <video> (BT.601), not orange-shifted BT.709
    expect(grab.px[0]).toBeGreaterThan(245);
    expect(grab.px[1]).toBeLessThan(8);
    expect(grab.px[2]).toBeLessThan(8);

    // decoded audio
    const audio = await studio.evaluate(async (id) => {
      const buf = await window.__gis.media.getAudioBuffer(id);
      return { sr: buf.sampleRate, ch: buf.numberOfChannels, dur: buf.duration };
    }, ids[files.indexOf('music.mp3')]);
    expect(audio.sr).toBe(48000);
    expect(near(audio.dur, 12, 0.2)).toBe(true);
  } finally {
    await ctx.close();
  }
});

test('local File import, failed URL error state, retry, and page-item dedupe', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const res = await studio.evaluate(async () => {
      const { media, projectStore } = window.__gis;
      const bytes = await (await fetch('https://assets.grok.com/test/clip-green.mp4')).arrayBuffer();
      const [id] = await media.importFiles([new File([bytes], 'my clip.mp4', { type: 'video/mp4' })]);
      const m = projectStore.get().media[id];
      let err = null;
      try {
        await media.importUrl('https://assets.grok.com/test/does-not-exist.mp4');
      } catch (e) {
        err = e.message;
      }
      const broken = Object.values(projectStore.get().media).find((x) => x.sourceUrl?.includes('does-not-exist'));
      const item = {
        key: 'video:11111111-1111-4111-8111-111111111111',
        kind: 'video',
        url: 'https://assets.grok.com/users/test-user-0000/generated/11111111-1111-4111-8111-111111111111/generated_video.mp4',
        altUrls: [],
        thumbUrl: null,
        postId: '11111111-1111-4111-8111-111111111111',
        prompt: 'A red sports car drifting through neon rain',
        source: 'network',
        pageUrl: 'https://grok.com/imagine',
        seenAt: Date.now(),
      };
      const a = await media.importPageItems([item], { flag: 'pick' });
      const b = await media.importPageItems([item]);
      return { name: m.name, kind: m.kind, status: m.status, err, brokenStatus: broken?.status, brokenError: broken?.error, a, b };
    });
    expect(res).toMatchObject({ name: 'my clip', kind: 'video', status: 'ready', brokenStatus: 'error' });
    expect(res.err).toContain('Could not download');
    expect(res.a).toEqual(res.b); // same page key -> same media id
    await studio.waitForFunction((id) => window.__gis.projectStore.get().media[id]?.status === 'ready', res.a[0], { timeout: 30000 });
    const p = await getProject(studio);
    const grokItem = p.media[res.a[0]];
    expect(grokItem).toMatchObject({ origin: 'grok', flag: 'pick', prompt: 'A red sports car drifting through neon rain', duration: expect.any(Number) });
    expect(grokItem.name).toContain('A red sports car');
  } finally {
    await ctx.close();
  }
});

test('a clip sent to the timeline before its download finishes gets the real duration', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const id = await studio.evaluate(async () => {
      const item = {
        key: 'video:44444444-4444-4444-8444-444444444444',
        kind: 'video',
        url: 'https://assets.grok.com/users/test-user-0000/generated/44444444-4444-4444-8444-444444444444/generated_video.mp4',
        altUrls: [],
        postId: '44444444-4444-4444-8444-444444444444',
        prompt: 'A purple nebula',
        source: 'network',
        pageUrl: 'https://grok.com/imagine',
        seenAt: Date.now(),
      };
      const [mid] = await window.__gis.media.importPageItems([item], { toTimeline: true });
      return mid;
    });
    await studio.waitForFunction((mid) => window.__gis.projectStore.get().media[mid]?.status === 'ready', id, { timeout: 30000 });
    const clip = await studio.evaluate(() => window.__gis.projectStore.get().tracks.video[0]);
    expect(Math.abs(clip.out - 6)).toBeLessThan(0.1);
    expect(clip.autoOut).toBe(false);
  } finally {
    await ctx.close();
  }
});

test('undo back to a pre-download snapshot still shows the real clip duration', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const id = await studio.evaluate(async () => {
      const { media, projectStore, model: M } = window.__gis;
      const item = {
        key: 'video:44444444-4444-4444-8444-444444444444',
        kind: 'video',
        url: 'https://assets.grok.com/users/test-user-0000/generated/44444444-4444-4444-8444-444444444444/generated_video.mp4',
        altUrls: [],
        postId: '44444444-4444-4444-8444-444444444444',
        prompt: 'A purple nebula',
        source: 'network',
        pageUrl: 'https://grok.com/imagine',
        seenAt: Date.now(),
      };
      const [mid] = await media.importPageItems([item], { toTimeline: true });
      projectStore.update((p) => M.renameProject(p, 'edited while downloading'), { label: 'rename' });
      return mid;
    });
    await studio.waitForFunction((mid) => window.__gis.projectStore.get().media[mid]?.status === 'ready', id, { timeout: 30000 });
    await studio.evaluate(() => window.__gis.projectStore.undo()); // back to the snapshot taken before the probe
    await studio.waitForFunction(() => Math.abs(window.__gis.projectStore.get().tracks.video[0].out - 6) < 0.1, null, { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

test('Retry downloads again: a broken download is never kept and re-checked', async () => {
  const ctx = await launch();
  try {
    let hits = 0;
    await ctx.context.route('https://assets.grok.com/test/flaky.mp4', (route) => {
      hits++;
      const headers = { 'access-control-allow-origin': '*', 'cache-control': 'max-age=3600' };
      if (hits === 1) return route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'video/mp4' }, body: Buffer.alloc(4096, 7) });
      return route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'video/mp4' }, body: readFileSync(fixture('media', 'clip-green.mp4')) });
    });
    const studio = await openStudioTab(ctx);
    const first = await studio.evaluate(async () => {
      const { media, projectStore, db } = window.__gis;
      const err = await media.importUrl('https://assets.grok.com/test/flaky.mp4').then(() => null, (e) => e.message);
      const m = Object.values(projectStore.get().media).find((x) => x.sourceUrl?.endsWith('flaky.mp4'));
      return { err, id: m.id, status: m.status, stored: await db.hasBlob(m.id) };
    });
    expect(first.err).toBeTruthy();
    expect(first).toMatchObject({ status: 'error', stored: false }); // the garbage was not stored
    const ok = await studio.evaluate((id) => window.__gis.media.retryMedia(id), first.id);
    expect(ok).toBe(true);
    expect(hits).toBe(2); // downloaded again (past the HTTP cache)
    const m = (await getProject(studio)).media[first.id];
    expect(m).toMatchObject({ status: 'ready', kind: 'video', errorStage: null });
    expect(Math.abs(m.duration - 3)).toBeLessThan(0.2);
  } finally {
    await ctx.close();
  }
});

test('importing a link that is already in the bin reuses that item instead of downloading it again', async () => {
  const requested = [];
  const ctx = await launch({ assets: { onAsset: (u) => requested.push(u) } });
  try {
    const studio = await openStudioTab(ctx);
    const [id] = await seedMedia(studio, ['music.mp3']);
    const again = await studio.evaluate(async () => {
      const { media, projectStore } = window.__gis;
      const a = await media.importUrl('https://assets.grok.com/test/music.mp3');
      const b = await media.importUrl('https://assets.grok.com/test/music.mp3', { kind: 'audio', toTimeline: true });
      const p = projectStore.get();
      return { a, b, items: p.mediaOrder.length, audioClips: p.tracks.audio.map((c) => c.mediaId) };
    });
    expect(again).toEqual({ a: id, b: id, items: 1, audioClips: [id] });
    expect(requested.filter((u) => u.endsWith('/music.mp3')).length).toBe(1);
  } finally {
    await ctx.close();
  }
});

test('getAudioStatus tells a missing file from undecodable audio; a ready item whose file vanished turns failed', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const [music, silent, still, red] = await seedMedia(studio, ['music.mp3', 'clip-noaudio.mp4', 'still.jpg', 'clip-red.mp4']);
    const res = await studio.evaluate(
      async ({ music, silent, still, red }) => {
        const { media, projectStore, model: M, db } = window.__gis;
        projectStore.update((p) => {
          let q = M.addMedia(p, M.createMediaItem({ id: 'med_badaudio', kind: 'audio', status: 'ready', duration: 2, hasAudio: true }));
          q = M.addMedia(q, M.createMediaItem({ id: 'med_loading', kind: 'audio', status: 'loading' }));
          return q;
        });
        await db.putBlob('med_badaudio', new Blob([new Uint8Array(4096).fill(3)], { type: 'audio/mpeg' }));
        const out = {
          music: await media.getAudioStatus(music),
          silent: await media.getAudioStatus(silent),
          still: await media.getAudioStatus(still),
          red: await media.getAudioStatus(red),
          bad: await media.getAudioStatus('med_badaudio'),
          loading: await media.getAudioStatus('med_loading'),
        };
        // the file of a ready item disappears from storage (cleared site data, another window…)
        await db.deleteBlob(silent);
        out.missing = await media.getAudioStatus(silent);
        out.blob = await media.getMediaBlob(silent);
        await new Promise((r) => setTimeout(r, 50));
        out.after = projectStore.get().media[silent];
        out.retried = await media.retryMedia(silent);
        out.final = projectStore.get().media[silent].status;
        return out;
      },
      { music, silent, still, red },
    );
    expect(res).toMatchObject({ music: 'ok', silent: 'none', still: 'none', red: 'ok', bad: 'undecodable', loading: 'pending', missing: 'missing', blob: null });
    expect(res.after).toMatchObject({ status: 'error', errorStage: 'missing' });
    expect(res.after.error).toContain('missing from storage');
    expect(res.retried).toBe(true);
    expect(res.final).toBe('ready');
  } finally {
    await ctx.close();
  }
});

test('downloads with emoji, right-to-left marks or reserved names are saved under a valid name', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const names = ['Coding night 👩\u200d💻.png', '\u200fرجل يمشي في المطر\u200e.mp4', 'CON.gis.json', '.hidden sequence.webm', '~draft.png', 'zero\u200bwidth.wav', `${'A very long sequence name '.repeat(12)}.mp4`];
    const res = await studio.evaluate(async (list) => {
      const { downloadBlob } = await import(chrome.runtime.getURL('studio/core/utils.js'));
      const used = [];
      const real = chrome.downloads.download.bind(chrome.downloads);
      chrome.downloads.download = (opts) => (used.push(opts.filename), real(opts)); // the names Chrome was given
      const out = [];
      for (const n of list) {
        const name = JSON.parse(`"${n}"`);
        const err = await downloadBlob(new Blob(['x'], { type: 'application/octet-stream' }), name).then(() => null, (e) => e.message);
        out.push(err);
      }
      await new Promise((r) => setTimeout(r, 800));
      const items = await chrome.downloads.search({});
      return { errors: out, used, done: items.filter((i) => i.state === 'complete').length };
    }, names);
    expect(res.errors).toEqual(names.map(() => null));
    expect(res.done).toBe(names.length);
    expect(res.used.slice(0, 6)).toEqual(['Coding night 👩💻.png', 'رجل يمشي في المطر.mp4', '_CON.gis.json', 'hidden sequence.webm', 'draft.png', 'zerowidth.wav']);
    expect(res.used[6]).toMatch(/^A very long.*\.mp4$/);
    expect(res.used.length).toBe(names.length); // each accepted on the first try
  } finally {
    await ctx.close();
  }
});
