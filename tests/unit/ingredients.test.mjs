// Ingredients tab: pure geometry (crop / orientation / resize / grid), pixel adjustments and library logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../extension/studio/ui/ingredients/geometry.js';
import { adjustPixels, adjustIsNeutral, adjustEqual, adjustValue, sharpenPixels, toneCurve, ADJUST_DEFAULTS, ADJUST_FIELDS, ADJUST_LOOKS } from '../../extension/studio/ui/ingredients/pixels.js';
import * as L from '../../extension/studio/ui/ingredients/logic.js';
import { FILTER_DEFAULTS } from '../../extension/studio/core/model.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const assertRectNear = (actual, expected, eps = 1e-6, msg = '') => {
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(near(actual[k], expected[k], eps), `${msg} ${k}: ${actual[k]} vs ${expected[k]} (${JSON.stringify(actual)})`);
};
const inside = (r, W, H) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= W + 1e-9 && r.y + r.h <= H + 1e-9;

// ------------------------------------------------------------------------------------------------ orientation

test('normalizeRotation and orientedSize', () => {
  assert.equal(G.normalizeRotation(0), 0);
  assert.equal(G.normalizeRotation(450), 90);
  assert.equal(G.normalizeRotation(-90), 270);
  assert.equal(G.normalizeRotation(-360), 0);
  assert.equal(G.normalizeRotation(100), 90);
  assert.deepEqual(G.orientedSize(800, 600, 90), { width: 600, height: 800 });
  assert.deepEqual(G.orientedSize(800, 600, 180), { width: 800, height: 600 });
  assert.deepEqual(G.orientedSize(800, 600, -90), { width: 600, height: 800 });
});

test('orientationMatrix maps the source corners onto the oriented frame', () => {
  const W = 800;
  const H = 600;
  const corners = [[0, 0], [W, 0], [W, H], [0, H]];
  for (const rot of [0, 90, 180, 270]) {
    for (const flipH of [false, true]) {
      for (const flipV of [false, true]) {
        const m = G.orientationMatrix(W, H, rot, flipH, flipV);
        const { width: OW, height: OH } = G.orientedSize(W, H, rot);
        const pts = corners.map(([x, y]) => G.applyMatrix(m, x, y));
        const xs = pts.map((p) => Math.round(p.x)).sort((a, b) => a - b);
        const ys = pts.map((p) => Math.round(p.y)).sort((a, b) => a - b);
        assert.deepEqual([xs[0], xs[3], ys[0], ys[3]], [0, OW, 0, OH], `rot ${rot} flipH ${flipH} flipV ${flipV}`);
      }
    }
  }
  // 90° clockwise: the source top-left corner ends up top-right.
  const p = G.applyMatrix(G.orientationMatrix(W, H, 90), 0, 0);
  assert.deepEqual([p.x, p.y], [H, 0]);
  // flipH after rotation mirrors the displayed image: top-left goes back to the left.
  const q = G.applyMatrix(G.orientationMatrix(W, H, 90, true), 0, 0);
  assert.deepEqual([q.x, q.y], [0, 0]);
});

test('rotateRect follows the pixels under a quarter turn; four turns are the identity', () => {
  const W = 800;
  const H = 600;
  const r = { x: 100, y: 50, w: 200, h: 120 };
  const cw = G.rotateRect(r, W, H, 1);
  assert.deepEqual(cw, { x: 600 - 170, y: 100, w: 120, h: 200 });
  // the rect's top-left source pixel maps where the orientation matrix says it does (it becomes the top-right corner)
  const m = G.orientationMatrix(W, H, 90);
  const tl = G.applyMatrix(m, r.x, r.y);
  assert.equal(tl.x, cw.x + cw.w);
  assert.equal(tl.y, cw.y);
  // ccw is the inverse of cw
  assert.deepEqual(G.rotateRect(cw, H, W, -1), r);
  let cur = r;
  let dims = [W, H];
  for (let i = 0; i < 4; i++) {
    cur = G.rotateRect(cur, dims[0], dims[1], 1);
    dims = [dims[1], dims[0]];
  }
  assert.deepEqual(cur, r);
});

test('flipRect mirrors about the centre lines', () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };
  assert.deepEqual(G.flipRect(r, 400, 300, 'h'), { x: 290, y: 20, w: 100, h: 50 });
  assert.deepEqual(G.flipRect(r, 400, 300, 'v'), { x: 10, y: 230, w: 100, h: 50 });
  assert.deepEqual(G.flipRect(G.flipRect(r, 400, 300, 'h'), 400, 300, 'h'), r);
});

test('multiplyMatrix composes in apply-right-first order', () => {
  const translate = [1, 0, 0, 1, 10, 5];
  const scale2 = [2, 0, 0, 2, 0, 0];
  const m = G.multiplyMatrix(translate, scale2); // scale then translate
  assert.deepEqual(G.applyMatrix(m, 3, 4), { x: 16, y: 13 });
});

// ------------------------------------------------------------------------------------------------ crop rects

test('maxAspectRect: largest centred rect of each preset ratio', () => {
  assert.deepEqual(G.maxAspectRect(1024, 1024, 16 / 9), { x: 0, y: 224, w: 1024, h: 576 });
  assert.deepEqual(G.maxAspectRect(1024, 1024, 9 / 16), { x: 224, y: 0, w: 576, h: 1024 });
  assert.deepEqual(G.maxAspectRect(800, 600, 1), { x: 100, y: 0, w: 600, h: 600 });
  assert.deepEqual(G.maxAspectRect(800, 600, null), { x: 0, y: 0, w: 800, h: 600 });
  for (const a of G.ASPECT_PRESETS.filter((p) => p.ratio)) {
    const r = G.maxAspectRect(1920, 1080, a.ratio);
    assert.ok(inside(r, 1920, 1080), a.id);
    assert.ok(Math.abs(r.w / r.h - a.ratio) < 0.01, a.id);
    assert.ok(r.w === 1920 || r.h === 1080, `${a.id} touches two edges`);
  }
  assert.equal(G.aspectRatioOf('3:2'), 1.5);
  assert.equal(G.aspectRatioOf('free'), null);
});

test('clampRect, moveRect and roundRect keep rects inside the frame', () => {
  assert.deepEqual(G.clampRect({ x: -20, y: 590, w: 100, h: 100 }, 800, 600), { x: 0, y: 500, w: 100, h: 100 });
  assert.deepEqual(G.clampRect({ x: 0, y: 0, w: 2000, h: 0 }, 800, 600, 8), { x: 0, y: 0, w: 800, h: 8 });
  assert.deepEqual(G.moveRect({ x: 700, y: 10, w: 100, h: 100 }, 50, -40, 800, 600), { x: 700, y: 0, w: 100, h: 100 });
  assert.deepEqual(G.roundRect({ x: 10.4, y: 0.6, w: 99.5, h: 799.9 }, 800, 600), { x: 10, y: 1, w: 100, h: 599 });
});

test('constrainAspect reshapes around the centre and fits the frame', () => {
  const r = G.constrainAspect({ x: 300, y: 200, w: 200, h: 200 }, 16 / 9, 800, 600);
  assert.ok(near(r.w / r.h, 16 / 9, 1e-9));
  assert.ok(near(r.x + r.w / 2, 400) && near(r.y + r.h / 2, 300), 'centre kept');
  assert.ok(near(r.w * r.h, 40000, 1e-6), 'area kept');
  const big = G.constrainAspect({ x: 0, y: 0, w: 800, h: 600 }, 9 / 16, 800, 600);
  assert.ok(inside(big, 800, 600));
  assert.ok(near(big.h, 600) && near(big.w, 600 * (9 / 16)));
});

test('resizeRect free: edges and corners move, clamped to frame and min size', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assertRectNear(G.resizeRect(r, 'se', 50, 30, { W: 800, H: 600 }), { x: 100, y: 100, w: 250, h: 130 });
  assertRectNear(G.resizeRect(r, 'nw', -30, -20, { W: 800, H: 600 }), { x: 70, y: 80, w: 230, h: 120 });
  assertRectNear(G.resizeRect(r, 'e', 1000, 0, { W: 800, H: 600 }), { x: 100, y: 100, w: 700, h: 100 });
  assertRectNear(G.resizeRect(r, 'w', 1000, 0, { W: 800, H: 600, min: 8 }), { x: 292, y: 100, w: 8, h: 100 });
  assertRectNear(G.resizeRect(r, 'n', 0, -500, { W: 800, H: 600 }), { x: 100, y: 0, w: 200, h: 200 });
});

test('resizeRect with a ratio keeps the ratio, the anchor and the bounds', () => {
  const W = 1000;
  const H = 800;
  const ratio = 16 / 9;
  const r = { x: 200, y: 200, w: 320, h: 180 };
  // corner: anchored at the opposite corner; a drag along the diagonal tracks the pointer exactly
  const se = G.resizeRect(r, 'se', 160, 90, { W, H, ratio });
  assertRectNear(se, { x: 200, y: 200, w: 480, h: 270 });
  const nw = G.resizeRect(r, 'nw', -160, -10, { W, H, ratio });
  assert.ok(near(nw.x + nw.w, 520) && near(nw.y + nw.h, 380), 'nw anchors bottom-right');
  assert.ok(near(nw.w / nw.h, ratio));
  // corner dragged far outside: clamped by the frame, ratio still exact
  const huge = G.resizeRect(r, 'se', 5000, 5000, { W, H, ratio });
  assert.ok(inside(huge, W, H));
  assert.ok(near(huge.w / huge.h, ratio));
  assert.ok(near(huge.x + huge.w, W) || near(huge.y + huge.h, H));
  // corner dragged inward past the anchor: minimum size, ratio kept
  const tiny = G.resizeRect(r, 'se', -5000, -5000, { W, H, ratio, min: 16 });
  assert.ok(near(tiny.w / tiny.h, ratio) && tiny.h >= 16 - 1e-9 && near(tiny.x, 200));
  // side edge: keeps the vertical centre
  const e = G.resizeRect(r, 'e', 80, 0, { W, H, ratio });
  assert.ok(near(e.w, 400) && near(e.h, 225) && near(e.y + e.h / 2, 290) && near(e.x, 200));
  // top edge: keeps the bottom edge and the horizontal centre
  const n = G.resizeRect(r, 'n', 0, -45, { W, H, ratio });
  assert.ok(near(n.h, 225) && near(n.y + n.h, 380) && near(n.x + n.w / 2, 360) && near(n.w / n.h, ratio));
  // every handle, random drags: always inside, always the ratio
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const handle of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    for (let i = 0; i < 40; i++) {
      const out = G.resizeRect(r, handle, rnd() * 900, rnd() * 900, { W, H, ratio });
      assert.ok(inside(out, W, H), `${handle} inside ${JSON.stringify(out)}`);
      assert.ok(near(out.w / out.h, ratio, 1e-6), `${handle} ratio`);
    }
  }
});

test('resizeRect with a ratio: corner drags along one axis grow AND shrink (pointer projected on the diagonal)', () => {
  const W = 1000;
  const H = 800;
  const ratio = 16 / 9;
  const r = { x: 200, y: 200, w: 320, h: 180 };
  const opts = { W, H, ratio };
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  // [handle, dx, dy, expect 'shrink' | 'grow', anchor corner that must stay put]
  const cases = [
    ['se', -100, 0, 'shrink', 'nw'],
    ['se', 0, -60, 'shrink', 'nw'],
    ['se', 100, 0, 'grow', 'nw'],
    ['se', 0, 60, 'grow', 'nw'],
    ['nw', 100, 0, 'shrink', 'se'],
    ['nw', 0, 50, 'shrink', 'se'],
    ['nw', -100, 0, 'grow', 'se'],
    ['ne', 0, 40, 'shrink', 'sw'],
    ['ne', -80, 0, 'shrink', 'sw'],
    ['ne', 0, -40, 'grow', 'sw'],
    ['sw', 90, 0, 'shrink', 'ne'],
    ['sw', 0, -30, 'shrink', 'ne'],
    ['sw', -90, 0, 'grow', 'ne'],
  ];
  for (const [handle, dx, dy, dir, anchor] of cases) {
    const out = G.resizeRect(r, handle, dx, dy, opts);
    const label = `${handle} (${dx}, ${dy})`;
    if (dir === 'shrink') assert.ok(out.w < r.w - 10, `${label} shrinks: ${out.w}`);
    else assert.ok(out.w > r.w + 10, `${label} grows: ${out.w}`);
    assert.ok(near(out.w / out.h, ratio, 1e-9), `${label} ratio`);
    if (anchor.includes('n')) assert.ok(near(out.y, r.y), `${label} top anchored`);
    if (anchor.includes('s')) assert.ok(near(out.y + out.h, bottom), `${label} bottom anchored`);
    if (anchor.includes('w')) assert.ok(near(out.x, r.x), `${label} left anchored`);
    if (anchor.includes('e')) assert.ok(near(out.x + out.w, right), `${label} right anchored`);
  }
  // the dragged corner lands on the point of the diagonal closest to the pointer
  const pointer = { x: right - 100, y: bottom + 20 };
  const se = G.resizeRect(r, 'se', -100, 20, opts);
  const dist = (w) => Math.hypot(r.x + w - pointer.x, r.y + w / ratio - pointer.y);
  for (const w of [se.w - 5, se.w + 5]) assert.ok(dist(se.w) < dist(w), 'closest point of the diagonal');
  // moving perpendicular to the diagonal changes (almost) nothing; the result is continuous around it
  const perp = G.resizeRect(r, 'se', 100, -100 * ratio, opts);
  assert.ok(Math.abs(perp.w - r.w) < 1, `perpendicular drag: ${perp.w}`);
  const a = G.resizeRect(r, 'se', 100, -100 * ratio + 2, opts);
  const b = G.resizeRect(r, 'se', 100, -100 * ratio - 2, opts);
  assert.ok(Math.abs(a.w - b.w) < 4, 'no jump between growing and shrinking');
  // shrinking stops at the minimum size; growing stops at the frame
  const tiny = G.resizeRect(r, 'nw', 2000, 0, { ...opts, min: 16 });
  assert.ok(near(tiny.h, 16) && near(tiny.x + tiny.w, right) && near(tiny.y + tiny.h, bottom));
  const big = G.resizeRect(r, 'se', 5000, 0, opts);
  assert.ok(inside(big, W, H) && (near(big.x + big.w, W) || near(big.y + big.h, H)));
});

test('editStatesEqual ignores representation-only differences', () => {
  const W = 800;
  const H = 600;
  const base = { rotation: 0, flipH: false, flipV: false, aspect: 'free', crop: null, resize: { preset: 'original', width: 0, height: 0, lock: true }, adjust: { brightness: 100, contrast: 100 }, format: 'auto', quality: 0.92 };
  assert.equal(G.editStatesEqual(base, { ...base }, W, H), true);
  assert.equal(G.editStatesEqual(base, { ...base, crop: { x: 0, y: 0, w: 800, h: 600 } }, W, H), true, 'null crop = full-frame crop');
  assert.equal(G.editStatesEqual(base, { ...base, rotation: 360 }, W, H), true);
  assert.equal(G.editStatesEqual(base, { ...base, adjust: {} }, W, H), true, 'missing adjust keys are neutral');
  assert.equal(G.editStatesEqual(base, { ...base, adjust: { ...ADJUST_DEFAULTS } }, W, H), true);
  assert.equal(G.editStatesEqual(base, { ...base, adjust: { brightness: 0 } }, W, H), false, '0% brightness is black, not neutral');
  assert.equal(G.editStatesEqual(base, { ...base, resize: { preset: 'original', width: 300 } }, W, H), true, 'custom sizes only matter for the custom preset');
  assert.equal(G.editStatesEqual(base, { ...base, crop: { x: 1, y: 0, w: 799, h: 600 } }, W, H), false);
  assert.equal(G.editStatesEqual(base, { ...base, rotation: 90 }, W, H), false);
  assert.equal(G.editStatesEqual(base, { ...base, flipV: true }, W, H), false);
  assert.equal(G.editStatesEqual(base, { ...base, aspect: '1:1' }, W, H), false);
  assert.equal(G.editStatesEqual(base, { ...base, adjust: { brightness: 5 } }, W, H), false);
  assert.equal(G.editStatesEqual(base, { ...base, format: 'image/png' }, W, H), false);
  const custom = { ...base, resize: { preset: 'custom', width: 400, height: 0, lock: true } };
  assert.equal(G.editStatesEqual(custom, { ...custom, resize: { ...custom.resize, width: 401 } }, W, H), false);
  assert.equal(G.editStatesEqual(custom, { ...custom, resize: { ...custom.resize, lock: false } }, W, H), false);
  assert.equal(G.editStatesEqual(base, null, W, H), false);
  // a nudge against the edge is a no-op
  const full = G.cropOf(base, W, H);
  assert.equal(G.editStatesEqual(base, { ...base, crop: G.moveRect(full, -1, 0, W, H) }, W, H), true);
});

test('fitContain centres and scales', () => {
  assert.deepEqual(G.fitContain(1600, 900, 800, 800), { scale: 0.5, width: 800, height: 450, x: 0, y: 175 });
  assert.equal(G.fitContain(100, 100, 800, 600, 2).scale, 2);
  assert.equal(G.fitContain(0, 100, 800, 600).scale, 0);
});

// ------------------------------------------------------------------------------------------------ output size

test('outputSize for every resize preset', () => {
  assert.deepEqual(G.outputSize(1024, 576, { preset: 'original' }), { width: 1024, height: 576 });
  assert.deepEqual(G.outputSize(2000, 1000, { preset: 'long-512' }), { width: 512, height: 256 });
  assert.deepEqual(G.outputSize(1000, 2000, { preset: 'long-768' }), { width: 384, height: 768 });
  assert.deepEqual(G.outputSize(600, 600, { preset: 'long-1024' }), { width: 1024, height: 1024 }, 'long-side presets may upscale');
  assert.deepEqual(G.outputSize(1920, 1080, { preset: 'long-1280' }), { width: 1280, height: 720 });
  assert.deepEqual(G.outputSize(1000, 1000, { preset: '1280x720' }), { width: 1280, height: 720 });
  assert.deepEqual(G.outputSize(1000, 1000, { preset: '720x1280' }), { width: 720, height: 1280 });
  assert.deepEqual(G.outputSize(1600, 900, { preset: 'custom', width: 800, lock: true }), { width: 800, height: 450 });
  assert.deepEqual(G.outputSize(1600, 900, { preset: 'custom', height: 300, lock: true }), { width: 533, height: 300 });
  assert.deepEqual(G.outputSize(1600, 900, { preset: 'custom', width: 500, height: 500, lock: false }), { width: 500, height: 500 });
  assert.deepEqual(G.outputSize(1600, 900, { preset: 'custom' }), { width: 1600, height: 900 });
  assert.deepEqual(G.outputSize(20000, 10000, { preset: 'original' }), { width: 8192, height: 4096 }, 'capped at MAX_OUTPUT_DIM');
  assert.deepEqual(G.outputSize(10, 10, { preset: 'nope' }), { width: 10, height: 10 });
  assert.equal(G.aspectForResize('1280x720'), '16:9');
  assert.equal(G.aspectForResize('720x1280'), '9:16');
  assert.equal(G.aspectForResize('long-512'), null);
});

test('coverRect trims the crop to the output ratio around its centre', () => {
  assert.deepEqual(G.coverRect({ x: 0, y: 0, w: 1000, h: 1000 }, 1280, 720), { x: 0, y: 218.75, w: 1000, h: 562.5 });
  assert.deepEqual(G.coverRect({ x: 0, y: 0, w: 1600, h: 900 }, 100, 100), { x: 350, y: 0, w: 900, h: 900 });
  assert.deepEqual(G.coverRect({ x: 5, y: 5, w: 160, h: 90 }, 1280, 720), { x: 5, y: 5, w: 160, h: 90 });
});

// ------------------------------------------------------------------------------------------------ grid composer

test('gridDims for each layout', () => {
  assert.deepEqual(G.gridDims(3, 'row'), { cols: 3, rows: 1, count: 3 });
  assert.deepEqual(G.gridDims(3, 'column'), { cols: 1, rows: 3, count: 3 });
  assert.deepEqual(G.gridDims(4, '2x2'), { cols: 2, rows: 2, count: 4 });
  assert.deepEqual(G.gridDims(6, '2x2'), { cols: 2, rows: 2, count: 4 }, '2x2 shows at most 4');
  assert.deepEqual(G.gridDims(3, '2x2'), { cols: 2, rows: 2, count: 3 });
  assert.deepEqual(G.gridDims(5, '3x3'), { cols: 3, rows: 2, count: 5 });
  assert.deepEqual(G.gridDims(12, '3x3'), { cols: 3, rows: 3, count: 9 });
  assert.deepEqual(G.gridDims(2, 'auto'), { cols: 2, rows: 1, count: 2 });
  assert.deepEqual(G.gridDims(4, 'auto'), { cols: 2, rows: 2, count: 4 });
  assert.deepEqual(G.gridDims(5, 'auto'), { cols: 3, rows: 2, count: 5 });
  assert.deepEqual(G.gridDims(9, 'auto'), { cols: 3, rows: 3, count: 9 });
  assert.deepEqual(G.gridDims(0, 'auto'), { cols: 1, rows: 1, count: 0 });
});

test('gridCells: 2x2 in 1024 with 16px gaps; incomplete last row is centred', () => {
  const g = G.gridCells(4, '2x2', 1024, 1024, 16);
  assert.equal(g.cellW, 488);
  assert.equal(g.cellH, 488);
  assert.deepEqual(g.cells, [
    { x: 16, y: 16, w: 488, h: 488 },
    { x: 520, y: 16, w: 488, h: 488 },
    { x: 16, y: 520, w: 488, h: 488 },
    { x: 520, y: 520, w: 488, h: 488 },
  ]);
  const three = G.gridCells(3, '2x2', 1024, 1024, 16);
  assert.equal(three.cells[2].x, 16 + (488 + 16) / 2, 'single cell of the last row is centred');
  const five = G.gridCells(5, 'auto', 1200, 800, 0);
  assert.equal(five.cells.length, 5);
  assert.equal(five.cells[3].x, 200);
  assert.equal(five.cells[4].x, 600);
  // gaps larger than the sheet are reduced so cells keep a positive size
  const squeezed = G.gridCells(3, 'row', 30, 30, 100);
  assert.ok(squeezed.cellW > 0 && squeezed.cellH > 0);
  for (const c of G.gridCells(9, '3x3', 1000, 700, 12).cells) assert.ok(inside(c, 1000, 700));
});

test('sheetSize: presets, custom and auto from the cell aspect', () => {
  assert.deepEqual(G.sheetSize('1024x1024'), { width: 1024, height: 1024 });
  assert.deepEqual(G.sheetSize('720x1280'), { width: 720, height: 1280 });
  assert.deepEqual(G.sheetSize('custom', { custom: { width: 900, height: 300 } }), { width: 900, height: 300 });
  assert.deepEqual(G.sheetSize('auto', { n: 4, layout: '2x2', cellAspect: 1, gap: 16 }), { width: 1536, height: 1536 });
  const row = G.sheetSize('auto', { n: 3, layout: 'row', cellAspect: 1, gap: 0 });
  assert.deepEqual(row, { width: 1536, height: 512 });
  const col = G.sheetSize('auto', { n: 2, layout: 'column', cellAspect: 16 / 9, gap: 0 });
  assert.ok(col.width < col.height || col.height === 1536 || col.width === 1536);
  assert.ok(Math.max(col.width, col.height) <= 1536);
  // auto sheets never overshoot the long side, whatever the gap / count / cell shape
  for (const layout of ['auto', 'row', 'column', '2x2', '3x3']) {
    for (let n = 2; n <= 9; n++) {
      for (const gap of [0, 7, 16, 33, 64]) {
        for (const cellAspect of [0.5625, 0.75, 1, 1.5, 16 / 9]) {
          const s = G.sheetSize('auto', { n, layout, cellAspect, gap });
          assert.ok(Math.max(s.width, s.height) <= 1536, `${layout} n=${n} gap=${gap} ar=${cellAspect}: ${s.width}x${s.height}`);
          assert.ok(Math.max(s.width, s.height) >= 1536 - 10, `${layout} n=${n} gap=${gap}: uses the long side (${s.width}x${s.height})`);
        }
      }
    }
  }
  assert.deepEqual(G.sheetSize('auto', { n: 3, layout: 'auto', cellAspect: 1, gap: 16 }), { width: 1534, height: 522 });
  assert.equal(G.medianAspect([{ width: 100, height: 100 }, { width: 200, height: 100 }, { width: 400, height: 100 }]), 2);
  assert.equal(G.medianAspect([{ width: 100, height: 100 }, { width: 300, height: 100 }]), 2);
  assert.equal(G.medianAspect([]), 1);
});

// ------------------------------------------------------------------------------------------------ pixels

const px = (...rgb) => new Uint8ClampedArray([...rgb, 255]);

test('adjustIsNeutral and neutral adjustments leave pixels untouched', () => {
  assert.equal(adjustIsNeutral(ADJUST_DEFAULTS), true);
  assert.equal(adjustIsNeutral(null), true);
  assert.equal(adjustIsNeutral({}), true, 'missing keys are neutral');
  assert.equal(adjustIsNeutral({ brightness: 100, contrast: '100', warmth: null }), true);
  assert.equal(adjustIsNeutral({ ...ADJUST_DEFAULTS, warmth: 5 }), false);
  assert.equal(adjustIsNeutral({ brightness: 0 }), false, '0% brightness is black');
  assert.equal(adjustIsNeutral({ saturation: 0 }), false, '0% saturation is greyscale');
  assert.equal(adjustValue({ brightness: 'x' }, 'brightness'), 100, 'invalid values read as neutral');
  assert.equal(adjustEqual({ contrast: 120 }, { ...ADJUST_DEFAULTS, contrast: 120 }), true);
  const d = px(10, 120, 250);
  adjustPixels(d, 1, 1, ADJUST_DEFAULTS);
  assert.deepEqual([...d], [10, 120, 250, 255]);
  const lut = toneCurve(100, 100);
  for (const v of [0, 1, 127, 128, 200, 255]) assert.equal(lut[v], v);
});

test('brightness, contrast, saturation, warmth behave as expected', () => {
  const bright = adjustPixels(px(100, 100, 100), 1, 1, { brightness: 180 });
  assert.deepEqual([...bright].slice(0, 3), [180, 180, 180]);
  const dark = adjustPixels(px(100, 100, 100), 1, 1, { brightness: 60 });
  assert.deepEqual([...dark].slice(0, 3), [60, 60, 60]);
  assert.deepEqual([...adjustPixels(px(100, 150, 200), 1, 1, { brightness: 0 })].slice(0, 3), [0, 0, 0], '0% is black');
  const contrast = adjustPixels(new Uint8ClampedArray([60, 60, 60, 255, 200, 200, 200, 255]), 2, 1, { contrast: 175 });
  assert.ok(contrast[0] < 60 && contrast[4] > 200, 'contrast pushes values away from mid grey');
  const flat = adjustPixels(new Uint8ClampedArray([60, 60, 60, 255, 200, 200, 200, 255]), 2, 1, { contrast: 0 });
  assert.deepEqual([flat[0], flat[4]], [128, 128], '0% contrast is flat mid grey');
  const grey = adjustPixels(px(200, 50, 50), 1, 1, { saturation: 0 });
  assert.equal(grey[0], grey[1]);
  assert.equal(grey[1], grey[2]);
  const vivid = adjustPixels(px(150, 100, 100), 1, 1, { saturation: 200 });
  assert.ok(vivid[0] - vivid[1] > 50);
  const warm = adjustPixels(px(100, 100, 100), 1, 1, { warmth: 100 });
  assert.ok(warm[0] > 100 && warm[2] < 100);
  const cool = adjustPixels(px(100, 100, 100), 1, 1, { warmth: -100 });
  assert.ok(cool[0] < 100 && cool[2] > 100);
  assert.equal(warm[3], 255, 'alpha untouched');
});

test('brightness, contrast and saturation use the Edit inspector scale: % of the original, 100% = untouched, CSS filter maths', () => {
  // The Edit tab's clip looks (core/model.js FILTER_DEFAULTS, rendered with CSS brightness()/contrast()/saturate()
  // and shown as Math.round(v * 100) + '%') use multipliers with 1 = untouched.
  const fields = Object.fromEntries(ADJUST_FIELDS.map((f) => [f.key, f]));
  for (const [key, filterKey, max] of [['brightness', 'brightness', 2], ['contrast', 'contrast', 2], ['saturation', 'saturate', 3]]) {
    assert.equal(ADJUST_DEFAULTS[key], FILTER_DEFAULTS[filterKey] * 100, `${key} neutral`);
    assert.equal(fields[key].format(ADJUST_DEFAULTS[key]), `${Math.round(FILTER_DEFAULTS[filterKey] * 100)}%`, `${key} neutral readout`);
    assert.deepEqual([fields[key].min, fields[key].max], [0, max * 100], `${key} range matches the inspector`);
  }
  assert.equal(fields.brightness.format(120), '120%');
  assert.equal(fields.warmth.format(0), '0');
  assert.equal(fields.warmth.format(40), '+40');
  assert.equal(fields.warmth.format(-40), '-40');
  assert.equal(fields.sharpen.format(25), '25%');

  // Reference: the Filter Effects spec formulas (each function clamped to 0..1 before the next).
  const c01 = (v) => Math.min(1, Math.max(0, v));
  const cssFilter = ([r, g, b], { brightness = 1, contrast = 1, saturate = 1 }) => {
    let rgb = [r, g, b].map((v) => c01((v / 255) * brightness));
    rgb = rgb.map((v) => c01((v - 0.5) * contrast + 0.5));
    const [R, G, B] = rgb;
    const s = saturate;
    rgb = [
      (0.213 + 0.787 * s) * R + (0.715 - 0.715 * s) * G + (0.072 - 0.072 * s) * B,
      (0.213 - 0.213 * s) * R + (0.715 + 0.285 * s) * G + (0.072 - 0.072 * s) * B,
      (0.213 - 0.213 * s) * R + (0.715 - 0.715 * s) * G + (0.072 + 0.928 * s) * B,
    ];
    return rgb.map((v) => Math.round(c01(v) * 255));
  };
  const cases = [
    { brightness: 1.2 },
    { brightness: 0.5 },
    { brightness: 1.6, contrast: 0.6 }, // the brightness result is clamped before contrast
    { contrast: 1.5 },
    { contrast: 0.3 },
    { saturate: 0 },
    { saturate: 2.4 },
    { brightness: 1.1, contrast: 1.3, saturate: 0.7 },
  ];
  for (const f of cases) {
    for (const rgb of [[10, 120, 250], [200, 60, 40], [128, 128, 128], [240, 230, 20]]) {
      const ours = [...adjustPixels(px(...rgb), 1, 1, { brightness: (f.brightness ?? 1) * 100, contrast: (f.contrast ?? 1) * 100, saturation: (f.saturate ?? 1) * 100 })].slice(0, 3);
      const ref = cssFilter(rgb, f);
      assert.ok(ours.every((v, i) => Math.abs(v - ref[i]) <= 2), `${JSON.stringify(f)} on ${rgb}: ${ours} vs ${ref}`);
    }
  }
});

test('looks: "Original" is neutral, the others differ, every value is on its slider', () => {
  const fields = Object.fromEntries(ADJUST_FIELDS.map((f) => [f.key, f]));
  assert.equal(adjustIsNeutral(ADJUST_LOOKS[0].adjust), true);
  for (const look of ADJUST_LOOKS.slice(1)) {
    assert.equal(adjustIsNeutral(look.adjust), false, look.id);
    for (const [k, v] of Object.entries(look.adjust)) {
      assert.ok(fields[k], `${look.id}: unknown adjustment ${k}`);
      assert.ok(Number.isInteger(v) && v >= fields[k].min && v <= fields[k].max, `${look.id}.${k} = ${v}`);
    }
  }
  for (let i = 0; i < ADJUST_LOOKS.length; i++) {
    for (let j = i + 1; j < ADJUST_LOOKS.length; j++) assert.equal(adjustEqual(ADJUST_LOOKS[i].adjust, ADJUST_LOOKS[j].adjust), false, `${ADJUST_LOOKS[i].id} vs ${ADJUST_LOOKS[j].id}`);
  }
  // Mono stays grey.
  const mono = adjustPixels(px(200, 60, 40), 1, 1, ADJUST_LOOKS.find((l) => l.id === 'mono').adjust);
  assert.equal(mono[0], mono[1]);
  assert.equal(mono[1], mono[2]);
});

test('sharpen leaves flat areas alone and boosts edges', () => {
  const W = 4;
  const H = 3;
  const flat = new Uint8ClampedArray(W * H * 4).fill(90);
  const before = [...flat];
  sharpenPixels(flat, W, H, 1);
  assert.deepEqual([...flat], before);
  // left half dark, right half bright
  const edge = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = x < 2 ? 80 : 160;
    edge.set([v, v, v, 255], (y * W + x) * 4);
  }
  adjustPixels(edge, W, H, { sharpen: 100 });
  const at = (x, y) => edge[(y * W + x) * 4];
  assert.ok(at(1, 1) < 80, 'dark side of the edge gets darker');
  assert.ok(at(2, 1) > 160, 'bright side gets brighter');
  assert.equal(edge[3], 255);
});

// ------------------------------------------------------------------------------------------------ library logic

const LIB = [
  { id: 'a', name: 'Hero portrait', tags: ['character', 'Hero'], note: '', prompt: 'A knight in silver armour', origin: 'page', width: 1024, height: 1024, size: 300, createdAt: 3, updatedAt: 9 },
  { id: 'b', name: 'Neon street', tags: ['location'], note: 'night scene', prompt: null, origin: 'file', width: 1920, height: 1080, size: 900, createdAt: 2, updatedAt: 2 },
  { id: 'c', name: 'alley 2', tags: ['location', 'hero'], note: '', prompt: '', origin: 'url', width: 640, height: 480, size: 100, createdAt: 1, updatedAt: 5 },
  { id: 'd', name: 'Alley 10', tags: [], note: '', prompt: '', origin: 'paste', width: 100, height: 100, size: 50, createdAt: 4, updatedAt: 4 },
];
const ids = (list) => list.map((i) => i.id);

test('filterIngredients: search terms, tags (AND, case-insensitive) and sorts', () => {
  assert.deepEqual(ids(L.filterIngredients(LIB)), ['d', 'a', 'b', 'c']);
  assert.deepEqual(ids(L.filterIngredients(LIB, { sort: 'oldest' })), ['c', 'b', 'a', 'd']);
  assert.deepEqual(ids(L.filterIngredients(LIB, { sort: 'name' })), ['c', 'd', 'a', 'b'], 'numeric-aware, case-insensitive');
  assert.deepEqual(ids(L.filterIngredients(LIB, { sort: 'largest' })), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ids(L.filterIngredients(LIB, { sort: 'size' })), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ids(L.filterIngredients(LIB, { sort: 'edited' })), ['a', 'c', 'd', 'b']);
  assert.deepEqual(ids(L.filterIngredients(LIB, { search: 'knight' })), ['a'], 'matches the prompt');
  assert.deepEqual(ids(L.filterIngredients(LIB, { search: 'NIGHT scene' })), ['b'], 'all terms, note, case-insensitive');
  assert.deepEqual(ids(L.filterIngredients(LIB, { search: 'grok' })), ['a'], 'origin label');
  assert.deepEqual(ids(L.filterIngredients(LIB, { tags: ['hero'] })), ['a', 'c']);
  assert.deepEqual(ids(L.filterIngredients(LIB, { tags: ['hero', 'location'] })), ['c']);
  assert.deepEqual(ids(L.filterIngredients(LIB, { tags: ['hero'], search: 'alley' })), ['c']);
  assert.notEqual(L.filterIngredients(LIB), LIB, 'returns a new array');
});

test('tagCounts merges case variants; parseTags / mergeTags', () => {
  assert.deepEqual(L.tagCounts(LIB), [{ tag: 'Hero', count: 2 }, { tag: 'location', count: 2 }, { tag: 'character', count: 1 }]);
  assert.deepEqual(L.parseTags('hero, #Red car ;  style\nHERO,, '), ['hero', 'Red car', 'style']);
  assert.deepEqual(L.parseTags(''), []);
  assert.equal(L.parseTags('x'.repeat(50))[0].length, 32);
  assert.deepEqual(L.mergeTags(['a', 'B'], ['b', 'c']), ['a', 'B', 'c']);
});

test('rangeSelect and moveFocusIndex', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(L.rangeSelect(order, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(L.rangeSelect(order, 'd', 'b'), ['b', 'c', 'd']);
  assert.deepEqual(L.rangeSelect(order, 'zz', 'c'), ['c']);
  assert.deepEqual(L.rangeSelect(order, 'a', 'zz'), []);
  assert.equal(L.moveFocusIndex(0, 'arrowright', 5, 3), 1);
  assert.equal(L.moveFocusIndex(0, 'arrowleft', 5, 3), 0);
  assert.equal(L.moveFocusIndex(1, 'arrowdown', 5, 3), 4);
  assert.equal(L.moveFocusIndex(2, 'arrowdown', 5, 3), 4, 'down on a short last row goes to the last item');
  assert.equal(L.moveFocusIndex(4, 'arrowup', 5, 3), 1);
  assert.equal(L.moveFocusIndex(-1, 'arrowright', 5, 3), 0);
  assert.equal(L.moveFocusIndex(3, 'home', 5, 3), 0);
  assert.equal(L.moveFocusIndex(0, 'end', 5, 3), 4);
  assert.equal(L.moveFocusIndex(0, 'arrowright', 0, 3), -1);
});

test('naming helpers', () => {
  assert.equal(L.nameFromUrl('https://example.com/photos/red_car-final.jpg?x=1'), 'red car final');
  assert.equal(L.nameFromUrl('https://assets.grok.com/users/u/generated/abc/image.jpg'), 'assets.grok.com');
  assert.equal(L.nameFromUrl('data:image/png;base64,AAA'), 'Image from data URL');
  assert.equal(L.nameFromUrl('not a url'), 'Image');
  assert.equal(L.editedName('Hero'), 'Hero (edited)');
  assert.equal(L.editedName('Hero (edited)'), 'Hero (edited)');
  assert.equal(L.baseName('my photo.final.PNG'), 'my photo.final');
  assert.equal(L.pastedName(new Date(2026, 9, 19, 9, 5)), 'Pasted image 09:05');
  assert.equal(L.ingredientFilename({ name: 'Hero portrait #1' }, 'image/jpeg'), 'hero-portrait-1.jpg');
  assert.equal(L.ingredientFilename({ name: '' }, 'image/webp'), 'reference.webp');
});

test('sniffImageMime recognises common formats', () => {
  const bytes = (...xs) => new Uint8Array(xs);
  const ascii = (s, pad = []) => new Uint8Array([...pad, ...[...s].map((c) => c.charCodeAt(0))]);
  assert.equal(L.sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), 'image/png');
  assert.equal(L.sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(L.sniffImageMime(ascii('GIF89a')), 'image/gif');
  assert.equal(L.sniffImageMime(ascii('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(L.sniffImageMime(ascii('\0\0\0\x1cftypavif')), 'image/avif');
  assert.equal(L.sniffImageMime(ascii('  <svg xmlns="http://www.w3.org/2000/svg">')), 'image/svg+xml');
  assert.equal(L.sniffImageMime(ascii('<!doctype html>')), null);
  assert.equal(L.sniffImageMime(new Uint8Array()), null);
  assert.equal(L.extForImageMime('image/jpeg'), 'jpg');
  assert.equal(L.extForImageMime('image/unknown'), 'png');
  assert.equal(L.isImageFile({ name: 'x.JPG', type: '' }), true);
  assert.equal(L.isImageFile({ name: 'x.mp4', type: 'video/mp4' }), false);
  assert.equal(L.outputMime('image/jpeg'), 'image/jpeg');
  assert.equal(L.outputMime('image/gif'), 'image/png');
  assert.equal(L.outputMime('image/png', 'image/webp'), 'image/webp');
});

test('urlsFromText reads uri-lists, plain text and <img src>', () => {
  assert.deepEqual(L.urlsFromText('# comment\nhttps://a.com/x.png\r\nhttps://a.com/x.png\nnot a url'), ['https://a.com/x.png']);
  assert.deepEqual(L.urlsFromText('', '<p><img alt="x" src="https://b.com/y.jpg?a=1&amp;b=2"></p>'), ['https://b.com/y.jpg?a=1&b=2']);
  assert.deepEqual(L.urlsFromText('data:image/png;base64,AAAA'), ['data:image/png;base64,AAAA']);
  assert.deepEqual(L.urlsFromText('ftp://nope'), []);
});

test('shotLabel and addIngredientsToShot', () => {
  assert.equal(L.shotLabel({ title: 'Neon chase' }, 2), '3. Neon chase');
  assert.equal(L.shotLabel({ title: '', prompt: 'x'.repeat(60) }, 0), `1. ${'x'.repeat(41)}…`);
  assert.equal(L.shotLabel({}, 0), '1. Untitled shot');
  const project = { id: 'p', shots: [{ id: 's1', ingredientIds: ['a'] }, { id: 's2' }], updatedAt: 1 };
  const next = L.addIngredientsToShot(project, 's1', ['a', 'b']);
  assert.deepEqual(next.shots[0].ingredientIds, ['a', 'b']);
  assert.equal(next.shots[1], project.shots[1], 'other shots untouched');
  assert.deepEqual(project.shots[0].ingredientIds, ['a'], 'immutable');
  assert.equal(L.addIngredientsToShot(next, 's1', ['b']), next, 'no-op returns the same object');
  assert.deepEqual(L.addIngredientsToShot(project, 's2', ['c']).shots[1].ingredientIds, ['c']);
  assert.equal(L.addIngredientsToShot(project, 'missing', ['c']), project);
});

test('references to deleted ingredients: usage counts and stripping from shots and bible entries', () => {
  const project = {
    id: 'p',
    updatedAt: 1,
    shots: [
      { id: 's1', ingredientIds: ['a', 'b'] },
      { id: 's2', ingredientIds: ['c'] },
      { id: 's3' },
    ],
    bible: { characters: [{ id: 'c1', ingredientIds: ['a'] }, { id: 'c2', ingredientIds: [] }], locations: [{ id: 'l1', ingredientIds: ['b', 'c'] }], style: 'noir', notes: '' },
  };
  assert.deepEqual(L.ingredientUsage(project, ['a']), { shots: 1, entries: 1 });
  assert.deepEqual(L.ingredientUsage(project, new Set(['b', 'c'])), { shots: 2, entries: 1 });
  assert.deepEqual(L.ingredientUsage(project, ['zz']), { shots: 0, entries: 0 });
  assert.deepEqual(L.ingredientUsage(null, ['a']), { shots: 0, entries: 0 });
  assert.deepEqual(L.referencedIngredientIds(project).sort(), ['a', 'b', 'c']);

  const next = L.removeIngredientRefs(project, ['a']);
  assert.deepEqual(next.shots[0].ingredientIds, ['b']);
  assert.equal(next.shots[1], project.shots[1], 'untouched shots keep their identity');
  assert.equal(next.shots[2], project.shots[2]);
  assert.deepEqual(next.bible.characters[0].ingredientIds, []);
  assert.equal(next.bible.characters[1], project.bible.characters[1]);
  assert.equal(next.bible.locations, project.bible.locations, 'lists without the id are not copied');
  assert.equal(next.bible.style, 'noir');
  assert.ok(next.updatedAt > 1);
  assert.deepEqual(project.shots[0].ingredientIds, ['a', 'b'], 'immutable');
  assert.equal(L.removeIngredientRefs(project, ['zz']), project, 'no reference: same object');
  assert.equal(L.removeIngredientRefs(project, []), project);
  assert.equal(L.removeIngredientRefs(null, ['a']), null);
  const all = L.removeIngredientRefs(project, new Set(['a', 'b', 'c']));
  assert.deepEqual(L.referencedIngredientIds(all), []);
  // partial / older shapes
  assert.deepEqual(L.removeIngredientRefs({ id: 'q', shots: [{ id: 's', ingredientIds: ['a'] }] }, ['a']).shots[0].ingredientIds, []);
  assert.equal(L.ORIGIN_LABELS.export, 'Export');
});

test('rectFromPoints: any drag direction, ratio and frame bounds', () => {
  assert.deepEqual(G.rectFromPoints({ x: 300, y: 200 }, { x: 100, y: 50 }, { W: 800, H: 600 }), { x: 100, y: 50, w: 200, h: 150 });
  assert.deepEqual(G.rectFromPoints({ x: 10, y: 10 }, { x: 5000, y: 20 }, { W: 800, H: 600 }), { x: 10, y: 10, w: 790, h: 10 });
  const r = G.rectFromPoints({ x: 100, y: 100 }, { x: 420, y: 150 }, { W: 800, H: 600, ratio: 16 / 9 });
  assert.ok(near(r.w / r.h, 16 / 9) && near(r.x, 100) && near(r.y, 100) && near(r.w, 320));
  const edge = G.rectFromPoints({ x: 700, y: 500 }, { x: 2000, y: 2000 }, { W: 800, H: 600, ratio: 1 });
  assert.ok(inside(edge, 800, 600) && near(edge.w, edge.h) && near(edge.w, 100));
  const up = G.rectFromPoints({ x: 400, y: 300 }, { x: 0, y: 0 }, { W: 800, H: 600, ratio: 9 / 16 });
  assert.ok(inside(up, 800, 600) && near(up.w / up.h, 9 / 16) && near(up.x + up.w, 400) && near(up.y + up.h, 300));
  const tiny = G.rectFromPoints({ x: 50, y: 50 }, { x: 51, y: 50 }, { W: 800, H: 600, min: 8 });
  assert.ok(tiny.w >= 8 && tiny.h >= 8);
});

test('editor state: rotate swaps flips and turns the crop; aspect + resize presets', () => {
  const base = { rotation: 0, flipH: false, flipV: false, aspect: 'free', crop: null, resize: { preset: 'original' } };
  const W = 800;
  const H = 600;
  const rot = G.rotateEditState(base, 1, W, H);
  assert.equal(rot.rotation, 90);
  assert.equal(rot.crop, null);
  assert.deepEqual(G.cropOf(rot, W, H), { x: 0, y: 0, w: 600, h: 800 });
  const flipped = G.flipEditState(base, 'h', W, H);
  assert.equal(flipped.flipH, true);
  const rf = G.rotateEditState(flipped, 1, W, H);
  assert.deepEqual([rf.rotation, rf.flipH, rf.flipV], [90, false, true], 'R90 ∘ FH = FV ∘ R90');
  // the displayed result of rotate-after-flip equals the composed matrices
  const shown = G.multiplyMatrix([0, 1, -1, 0, 600, 0], G.orientationMatrix(W, H, 0, true, false));
  const z = (m) => m.map((v) => v + 0); // -0 -> 0
  assert.deepEqual(z(G.orientationMatrix(W, H, rf.rotation, rf.flipH, rf.flipV)), z(shown));
  // aspect preset -> max rect; rotation with a locked aspect keeps the ratio
  const a = G.setAspectState(base, '16:9', W, H);
  assert.deepEqual(a.crop, { x: 0, y: 75, w: 800, h: 450 });
  const ar = G.rotateEditState(a, 1, W, H);
  assert.ok(Math.abs(ar.crop.w / ar.crop.h - 16 / 9) < 1e-6 && ar.crop.w <= 600 + 1e-9);
  assert.equal(G.setAspectState(a, 'free', W, H).crop, a.crop, 'free keeps the crop');
  // flipping a crop mirrors it
  const crop = { ...base, crop: { x: 10, y: 20, w: 100, h: 100 } };
  assert.deepEqual(G.flipEditState(crop, 'h', W, H).crop, { x: 690, y: 20, w: 100, h: 100 });
  assert.deepEqual(G.flipEditState(crop, 'v', W, H).crop, { x: 10, y: 480, w: 100, h: 100 });
  // exact resize presets lock the crop ratio; custom seeds the size from the crop
  const r = G.setResizeState(base, '720x1280', W, H);
  assert.equal(r.aspect, '9:16');
  assert.ok(Math.abs(r.crop.w / r.crop.h - 9 / 16) < 0.01);
  const c = G.setResizeState(a, 'custom', W, H);
  assert.deepEqual([c.resize.width, c.resize.height, c.resize.lock], [800, 450, true]);
  // numeric crop fields
  const f = G.setCropFieldState(a, 'w', 400, W, H);
  assert.deepEqual([f.crop.w, f.crop.h], [400, 225]);
  const big = G.setCropFieldState(a, 'h', 5000, W, H);
  assert.ok(big.crop.w <= 800 && big.crop.h <= 600 && Math.abs(big.crop.w / big.crop.h - 16 / 9) < 0.01);
  const free = G.setCropFieldState(base, 'x', 790, W, H);
  assert.deepEqual(free.crop, { x: 0, y: 0, w: 800, h: 600 }, 'x clamped so the crop stays inside');
  assert.equal(G.setCropFieldState(base, 'x', 'abc', W, H), base);
});
