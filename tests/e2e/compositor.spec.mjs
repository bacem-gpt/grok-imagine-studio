// Pixel-level checks of the shared compositor (engine/compositor.js): every transition, fades, filters, text.
import { test } from '@playwright/test';
import { launch, openStudioTab, expect } from './harness.mjs';

test('compositor renders transitions, fades, filters and text correctly', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const result = await studio.evaluate(async () => {
      const C = await import(chrome.runtime.getURL('studio/engine/compositor.js'));
      const M = window.__gis.model;
      const W = 160;
      const H = 90;
      const solid = (color) => {
        const c = new OffscreenCanvas(64, 36);
        const g = c.getContext('2d');
        g.fillStyle = color;
        g.fillRect(0, 0, 64, 36);
        return { image: c, width: 64, height: 36 };
      };
      const red = solid('#ff0000');
      const blue = solid('#0000ff');
      const build = (type, extraA = {}, extraB = {}) => {
        let p = M.createProject('t');
        p = M.addMedia(p, M.createMediaItem({ id: 'a', kind: 'video', duration: 2, status: 'ready' }));
        p = M.addMedia(p, M.createMediaItem({ id: 'b', kind: 'video', duration: 2, status: 'ready' }));
        p = M.appendMediaToTimeline(p, ['a', 'b']).project;
        p = M.updateClip(p, p.tracks.video[0].id, extraA);
        p = M.updateClip(p, p.tracks.video[1].id, extraB);
        if (type) p = M.setTransition(p, p.tracks.video[1].id, { type, duration: 1 });
        return p;
      };
      const canvas = new OffscreenCanvas(W, H);
      const g = canvas.getContext('2d', { willReadFrequently: true });
      const render = (project, t) => {
        const layout = M.layoutProject(project);
        C.drawFrame(g, { project, layout, t, getSource: (item) => (item.clip.mediaId === 'a' ? red : blue) });
      };
      const px = (x, y) => Array.from(g.getImageData(Math.round(x * (W - 1)), Math.round(y * (H - 1)), 1, 1).data.slice(0, 3));
      const out = { start: {}, end: {}, mid: {} };
      for (const { id } of M.TRANSITIONS) {
        const p = build(id);
        render(p, 1.0005); // transition window is [1, 2)
        out.start[id] = px(0.5, 0.5);
        render(p, 1.9995);
        out.end[id] = px(0.5, 0.5);
        render(p, 1.5);
        out.mid[id] = { c: px(0.5, 0.5), l: px(0.1, 0.5), r: px(0.9, 0.5), t: px(0.5, 0.1), b: px(0.5, 0.9) };
      }
      // fades
      const pf = build(null, { fadeIn: 1 });
      render(pf, 0.5);
      out.fadeMid = px(0.5, 0.5);
      // filters
      const pg = build(null, { filters: { ...M.FILTER_DEFAULTS, grayscale: 1 } });
      render(pg, 0.5);
      out.gray = px(0.5, 0.5);
      // text overlay
      let pt = build(null);
      pt = M.addTextClip(pt, { text: 'HELLO', start: 0, duration: 2, animation: 'none', style: { size: 0.3, y: 0.5, color: '#ffffff', shadow: false } }).project;
      render(pt, 1);
      const data = g.getImageData(0, 0, W, H).data;
      let white = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) white++;
      out.whitePixels = white;
      // not-ready source reports ready=false
      const layout = M.layoutProject(pf);
      out.notReady = C.drawFrame(g, { project: pf, layout, t: 0.5, getSource: () => null }).ready;
      return out;
    });

    const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
    const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60;
    const isBlack = ([r, g, b]) => r < 40 && g < 40 && b < 40;
    for (const [id, c] of Object.entries(result.start)) expect(isRed(c), `${id} starts on A (got ${c})`).toBe(true);
    for (const [id, c] of Object.entries(result.end)) expect(isBlue(c), `${id} ends on B (got ${c})`).toBe(true);
    const mid = result.mid;
    expect(mid.crossfade.c[0]).toBeGreaterThan(90);
    expect(mid.crossfade.c[2]).toBeGreaterThan(90);
    expect(isBlack(mid['fade-black'].c)).toBe(true);
    expect(mid['fade-white'].c.every((v) => v > 215)).toBe(true);
    expect(isRed(mid['wipe-left'].l) && isBlue(mid['wipe-left'].r)).toBe(true);
    expect(isBlue(mid['wipe-right'].l) && isRed(mid['wipe-right'].r)).toBe(true);
    expect(isRed(mid['wipe-up'].t) && isBlue(mid['wipe-up'].b)).toBe(true);
    expect(isBlue(mid['wipe-down'].t) && isRed(mid['wipe-down'].b)).toBe(true);
    expect(isRed(mid['slide-left'].l) && isBlue(mid['slide-left'].r)).toBe(true);
    expect(isBlue(mid['slide-right'].l) && isRed(mid['slide-right'].r)).toBe(true);
    expect(isRed(mid['slide-up'].t) && isBlue(mid['slide-up'].b)).toBe(true);
    expect(isBlue(mid['slide-down'].t) && isRed(mid['slide-down'].b)).toBe(true);
    expect(isBlue(mid['circle-open'].c) && isRed(mid['circle-open'].l)).toBe(true);
    expect(isRed(mid['circle-close'].c) && isBlue(mid['circle-close'].l)).toBe(true);
    // fade-in at half way = half-bright red over black
    expect(result.fadeMid[0]).toBeGreaterThan(100);
    expect(result.fadeMid[0]).toBeLessThan(160);
    // grayscale: channels equal
    const [r, g, b] = result.gray;
    expect(Math.abs(r - g) < 6 && Math.abs(g - b) < 6).toBe(true);
    expect(result.whitePixels).toBeGreaterThan(200);
    expect(result.notReady).toBe(false);
  } finally {
    await ctx.close();
  }
});

test('frame-aligned transitions never flash the incoming clip; long CJK titles wrap inside the frame', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const result = await studio.evaluate(async () => {
      const C = await import(chrome.runtime.getURL('studio/engine/compositor.js'));
      const M = window.__gis.model;
      const W = 320;
      const H = 180;
      const solid = (color) => {
        const c = new OffscreenCanvas(64, 36);
        const g = c.getContext('2d');
        g.fillStyle = color;
        g.fillRect(0, 0, 64, 36);
        return { image: c, width: 64, height: 36 };
      };
      const canvas = new OffscreenCanvas(W, H);
      const g = canvas.getContext('2d', { willReadFrequently: true });
      const px = (x, y) => Array.from(g.getImageData(Math.round(x * (W - 1)), Math.round(y * (H - 1)), 1, 1).data.slice(0, 3));
      // 30 fps, A trimmed to 66 frames, 0.5 s dip to black into B: B starts at 1.7000000000000002, frame 51 is 1.7.
      let p = M.createProject('flash');
      p = M.addMedia(p, M.createMediaItem({ id: 'a', kind: 'video', duration: 6, status: 'ready' }));
      p = M.addMedia(p, M.createMediaItem({ id: 'b', kind: 'video', duration: 6, status: 'ready' }));
      p = M.appendMediaToTimeline(p, ['a', 'b'], { ranges: { a: { in: 0, out: 66 / 30 } } }).project;
      p = M.setTransition(p, p.tracks.video[1].id, { type: 'fade-black', duration: 0.5 });
      const layout = M.layoutProject(p);
      const frames = {};
      for (const f of [50, 51, 52]) {
        C.drawFrame(g, { project: p, layout, t: f / 30, getSource: (item) => (item.clip.mediaId === 'a' ? solid('#ff0000') : solid('#0000ff')) });
        frames[f] = px(0.5, 0.5);
      }
      // A long Japanese title (no spaces) at the default style: it must wrap, not run off both edges.
      let q = M.createProject('text');
      q = M.addTextClip(q, { text: '東京の夜景とネオンの街を歩く女性のシネマティックな映像、雨上がりの路面に反射する光', start: 0, duration: 3, animation: 'none', style: { size: 0.08, y: 0.5, color: '#ffffff', shadow: false } }).project;
      C.drawFrame(g, { project: q, layout: M.layoutProject(q), t: 1, getSource: () => null });
      const data = g.getImageData(0, 0, W, H).data;
      const lit = (x, y) => data[(y * W + x) * 4] > 128;
      let edge = 0;
      const rows = [];
      for (let y = 0; y < H; y++) {
        let n = 0;
        for (let x = 0; x < W; x++) {
          if (!lit(x, y)) continue;
          n++;
          if (x < W * 0.02 || x > W * 0.98) edge++;
        }
        rows.push(n > 0);
      }
      let bands = 0;
      for (let y = 0; y < H; y++) if (rows[y] && !rows[y - 1]) bands++;
      return { frames, edge, bands };
    });
    const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
    // frame 51 sits on the start of the dip: still clip A (red), never B (blue) at full strength
    expect(isRed(result.frames[50]), `frame 50 ${result.frames[50]}`).toBe(true);
    expect(isRed(result.frames[51]), `frame 51 ${result.frames[51]}`).toBe(true);
    expect(result.frames[52][2]).toBeLessThan(60); // dimming towards black, no blue
    expect(result.edge).toBe(0);
    expect(result.bands).toBeGreaterThanOrEqual(2);
  } finally {
    await ctx.close();
  }
});
