// Pure geometry for the Ingredients image editor and grid composer. No DOM: unit-tested in tests/unit/ingredients.test.mjs.
//
// Coordinate spaces used by the editor
//   source   : the stored image, W x H pixels.
//   oriented : the source rotated clockwise by `rotation` (0/90/180/270), THEN mirrored about the displayed axes
//              (flipH / flipV). This is what the user sees; crop rectangles live here, in full-resolution pixels.
//   output   : the crop scaled to the chosen resize preset.
// Rectangles are {x, y, w, h}. Affine matrices use the canvas setTransform order [a, b, c, d, e, f]:
//   x' = a*x + c*y + e,  y' = b*x + d*y + f
import { adjustEqual } from './pixels.js';

export const MAX_OUTPUT_DIM = 8192;
export const MIN_CROP = 8;

export const ASPECT_PRESETS = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '2:3', label: '2:3', ratio: 2 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
];

/** Ratio (w / h) of an aspect preset id, or null for free / unknown. */
export const aspectRatioOf = (id) => ASPECT_PRESETS.find((a) => a.id === id)?.ratio ?? null;

/** Resize presets. `long` scales the long side; width/height are exact outputs (the crop is locked to that ratio). */
export const RESIZE_PRESETS = [
  { id: 'original', label: 'Original size' },
  { id: 'long-512', label: '512 px long side', long: 512 },
  { id: 'long-768', label: '768 px long side', long: 768 },
  { id: 'long-1024', label: '1024 px long side', long: 1024 },
  { id: 'long-1280', label: '1280 px long side', long: 1280 },
  { id: '1280x720', label: '1280 × 720 (16:9)', width: 1280, height: 720 },
  { id: '720x1280', label: '720 × 1280 (9:16)', width: 720, height: 1280 },
  { id: 'custom', label: 'Custom size…' },
];

export const resizePresetOf = (id) => RESIZE_PRESETS.find((p) => p.id === id) || RESIZE_PRESETS[0];

/** Aspect id implied by an exact-size resize preset (so the output never stretches), else null. */
export function aspectForResize(presetId) {
  const p = resizePresetOf(presetId);
  if (!p.width || !p.height) return null;
  const r = p.width / p.height;
  const match = ASPECT_PRESETS.find((a) => a.ratio && Math.abs(a.ratio - r) < 1e-3);
  return match ? match.id : null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clampDim = (v) => clamp(Math.round(v), 1, MAX_OUTPUT_DIM);

// ---------------------------------------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------------------------------------

/** Any angle -> 0 | 90 | 180 | 270 (nearest quarter turn). */
export function normalizeRotation(deg) {
  const q = Math.round((Number(deg) || 0) / 90) * 90;
  return ((q % 360) + 360) % 360;
}

/** Size of the source after rotation. */
export function orientedSize(width, height, rotation = 0) {
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height };
}

/** m1 ∘ m2 (apply m2 first, then m1). */
export function multiplyMatrix(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

export function applyMatrix(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * Matrix mapping source pixel coordinates (W x H) to oriented coordinates: rotate clockwise by `rotation`,
 * then mirror about the oriented axes. Use with ctx.setTransform / ctx.transform before drawImage(source, 0, 0).
 */
export function orientationMatrix(W, H, rotation = 0, flipH = false, flipV = false) {
  const r = normalizeRotation(rotation);
  let m;
  if (r === 90) m = [0, 1, -1, 0, H, 0];
  else if (r === 180) m = [-1, 0, 0, -1, W, H];
  else if (r === 270) m = [0, -1, 1, 0, 0, W];
  else m = [1, 0, 0, 1, 0, 0];
  const { width: OW, height: OH } = orientedSize(W, H, r);
  if (flipH) m = multiplyMatrix([-1, 0, 0, 1, OW, 0], m);
  if (flipV) m = multiplyMatrix([1, 0, 0, -1, 0, OH], m);
  return m;
}

/** Rect in a W x H frame -> the same pixels after the frame turns a quarter clockwise (dir 1) or counter-clockwise (-1). */
export function rotateRect(rect, W, H, dir = 1) {
  if (dir >= 0) return { x: H - (rect.y + rect.h), y: rect.x, w: rect.h, h: rect.w };
  return { x: rect.y, y: W - (rect.x + rect.w), w: rect.h, h: rect.w };
}

/** Rect mirrored about the vertical ('h') or horizontal ('v') centre line of a W x H frame. */
export function flipRect(rect, W, H, axis = 'h') {
  if (axis === 'h') return { ...rect, x: W - (rect.x + rect.w) };
  return { ...rect, y: H - (rect.y + rect.h) };
}

// ---------------------------------------------------------------------------------------------------------
// Rectangles
// ---------------------------------------------------------------------------------------------------------

export const fullRect = (W, H) => ({ x: 0, y: 0, w: W, h: H });

export const rectsEqual = (a, b, eps = 0.5) =>
  !!a && !!b && Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps;

/** Keeps a rect inside W x H with at least `min` px per side (never larger than the frame). */
export function clampRect(rect, W, H, min = 1) {
  const w = clamp(rect.w, Math.min(min, W), W);
  const h = clamp(rect.h, Math.min(min, H), H);
  return { x: clamp(rect.x, 0, W - w), y: clamp(rect.y, 0, H - h), w, h };
}

/** Integer rect inside W x H (what the renderer and number fields use). */
export function roundRect(rect, W, H) {
  const x = clamp(Math.round(rect.x), 0, Math.max(0, W - 1));
  const y = clamp(Math.round(rect.y), 0, Math.max(0, H - 1));
  const w = clamp(Math.round(rect.w), 1, W - x);
  const h = clamp(Math.round(rect.h), 1, H - y);
  return { x, y, w, h };
}

/** Translates a rect, keeping its size and keeping it inside W x H. */
export function moveRect(rect, dx, dy, W, H) {
  return { x: clamp(rect.x + dx, 0, W - rect.w), y: clamp(rect.y + dy, 0, H - rect.h), w: rect.w, h: rect.h };
}

/** Largest rect with the given ratio, centred in W x H (whole frame when ratio is null). Integer pixels. */
export function maxAspectRect(W, H, ratio) {
  if (!ratio) return fullRect(W, H);
  let w;
  let h;
  if (W / H > ratio) {
    h = H;
    w = Math.min(W, Math.round(H * ratio));
  } else {
    w = W;
    h = Math.min(H, Math.round(W / ratio));
  }
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
}

/** Re-shapes a rect to `ratio` around its centre, keeping roughly its area, shrunk to fit inside W x H. */
export function constrainAspect(rect, ratio, W, H) {
  if (!ratio) return clampRect(rect, W, H);
  const area = Math.max(1, rect.w * rect.h);
  let w = Math.sqrt(area * ratio);
  let h = w / ratio;
  const s = Math.min(1, W / w, H / h);
  w *= s;
  h *= s;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w, h };
}

/**
 * Drags a crop handle. handle: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'. (dx, dy) in image pixels, relative
 * to `rect` (the rect when the drag started). Honors the frame W x H, a minimum size and an optional ratio (w / h):
 * corners keep the opposite corner fixed; edges keep the opposite edge and the perpendicular centre fixed.
 */
export function resizeRect(rect, handle, dx, dy, { W, H, ratio = null, min = MIN_CROP } = {}) {
  const hasN = handle.includes('n');
  const hasS = handle.includes('s');
  const hasE = handle.includes('e');
  const hasW = handle.includes('w');
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.w;
  const y2 = rect.y + rect.h;
  const minW = Math.min(min, W);
  const minH = Math.min(min, H);

  if (!ratio) {
    let nx1 = x1;
    let ny1 = y1;
    let nx2 = x2;
    let ny2 = y2;
    if (hasW) nx1 = clamp(x1 + dx, 0, x2 - minW);
    if (hasE) nx2 = clamp(x2 + dx, x1 + minW, W);
    if (hasN) ny1 = clamp(y1 + dy, 0, y2 - minH);
    if (hasS) ny2 = clamp(y2 + dy, y1 + minH, H);
    return { x: nx1, y: ny1, w: nx2 - nx1, h: ny2 - ny1 };
  }

  const lowW = Math.max(minW, minH * ratio);
  if ((hasE || hasW) && (hasN || hasS)) {
    // Corner: anchor the opposite corner. The dragged corner goes to the point of the box diagonal closest to the
    // pointer (projection), so a drag along either axis grows or shrinks the box and a diagonal drag tracks the
    // pointer exactly.
    const ax = hasE ? x1 : x2;
    const ay = hasS ? y1 : y2;
    const sx = hasE ? 1 : -1;
    const sy = hasS ? 1 : -1;
    const d2 = rect.w * rect.w + rect.h * rect.h;
    let w = d2 > 0 ? rect.w + (rect.w * (sx * dx * rect.w + sy * dy * rect.h)) / d2 : rect.w;
    const availX = hasE ? W - ax : ax;
    const availY = hasS ? H - ay : ay;
    const maxW = Math.min(availX, availY * ratio);
    w = clamp(w, Math.min(lowW, maxW), maxW);
    const h = w / ratio;
    return { x: hasE ? ax : ax - w, y: hasS ? ay : ay - h, w, h };
  }
  if (hasE || hasW) {
    // Side edge: anchor the opposite edge, keep the vertical centre.
    const ax = hasE ? x1 : x2;
    const cy = (y1 + y2) / 2;
    let w = hasE ? x2 + dx - x1 : x2 - (x1 + dx);
    const maxW = Math.min(hasE ? W - ax : ax, 2 * Math.min(cy, H - cy) * ratio);
    w = clamp(w, Math.min(lowW, maxW), maxW);
    const h = w / ratio;
    return { x: hasE ? ax : ax - w, y: clamp(cy - h / 2, 0, H - h), w, h };
  }
  // Top/bottom edge: anchor the opposite edge, keep the horizontal centre.
  const ay = hasS ? y1 : y2;
  const cx = (x1 + x2) / 2;
  let h = hasS ? y2 + dy - y1 : y2 - (y1 + dy);
  const maxH = Math.min(hasS ? H - ay : ay, (2 * Math.min(cx, W - cx)) / ratio);
  h = clamp(h, Math.min(lowW / ratio, maxH), maxH);
  const w = h * ratio;
  return { x: clamp(cx - w / 2, 0, W - w), y: hasS ? ay : ay - h, w, h };
}

/**
 * Rect spanned by dragging from p0 to p1 (any direction) inside W x H, optionally with a fixed ratio (the rect grows
 * from p0 along the drag direction, shrunk to fit the frame). At least `min` px per side.
 */
export function rectFromPoints(p0, p1, { W, H, ratio = null, min = 1 } = {}) {
  const x0 = clamp(p0.x, 0, W);
  const y0 = clamp(p0.y, 0, H);
  const dx = clamp(p1.x, 0, W) - x0;
  const dy = clamp(p1.y, 0, H) - y0;
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  let w = Math.abs(dx);
  let h = Math.abs(dy);
  if (ratio) {
    if (w > h * ratio) h = w / ratio;
    else w = h * ratio;
    const availW = sx > 0 ? W - x0 : x0;
    const availH = sy > 0 ? H - y0 : y0;
    const s = Math.min(1, w > 0 ? availW / w : 1, h > 0 ? availH / h : 1);
    w *= s;
    h *= s;
    const minW = Math.min(W, H * ratio, Math.max(min, min * ratio));
    if (w < minW) {
      w = minW;
      h = w / ratio;
    }
  } else {
    w = Math.max(w, Math.min(min, W));
    h = Math.max(h, Math.min(min, H));
  }
  return clampRect({ x: sx > 0 ? x0 : x0 - w, y: sy > 0 ? y0 : y0 - h, w, h }, W, H, 1);
}

/** Scale + offset that fits w x h inside boxW x boxH (centred). */
export function fitContain(w, h, boxW, boxH, maxScale = Infinity) {
  if (!w || !h || boxW <= 0 || boxH <= 0) return { scale: 0, width: 0, height: 0, x: 0, y: 0 };
  const scale = Math.min(boxW / w, boxH / h, maxScale);
  const width = w * scale;
  const height = h * scale;
  return { scale, width, height, x: (boxW - width) / 2, y: (boxH - height) / 2 };
}

// ---------------------------------------------------------------------------------------------------------
// Output size
// ---------------------------------------------------------------------------------------------------------

/**
 * Output dimensions for a crop of cropW x cropH and a resize spec {preset, width, height, lock}.
 * Custom with lock (default) derives the missing side from the crop ratio; without lock both sides are exact.
 */
export function outputSize(cropW, cropH, resize = {}) {
  const p = resizePresetOf(resize.preset);
  let w = cropW;
  let h = cropH;
  if (p.long) {
    const s = p.long / Math.max(cropW, cropH);
    w = cropW * s;
    h = cropH * s;
  } else if (p.width && p.height) {
    w = p.width;
    h = p.height;
  } else if (p.id === 'custom') {
    const cw = Math.max(0, Number(resize.width) || 0);
    const ch = Math.max(0, Number(resize.height) || 0);
    if (resize.lock !== false) {
      if (cw) {
        w = cw;
        h = (cw * cropH) / cropW;
      } else if (ch) {
        h = ch;
        w = (ch * cropW) / cropH;
      }
    } else {
      w = cw || cropW;
      h = ch || cropH;
    }
  }
  // Keep the long side within MAX_OUTPUT_DIM while preserving the ratio.
  const over = Math.max(w, h) / MAX_OUTPUT_DIM;
  if (over > 1) {
    w /= over;
    h /= over;
  }
  return { width: clampDim(w), height: clampDim(h) };
}

/** Centred sub-rect of `rect` with the ratio outW / outH (what is drawn when the output ratio differs: cover). */
export function coverRect(rect, outW, outH) {
  const target = outW / outH;
  const cur = rect.w / rect.h;
  if (Math.abs(cur - target) < 1e-4) return { ...rect };
  if (cur > target) {
    const w = rect.h * target;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y, w, h: rect.h };
  }
  const h = rect.w / target;
  return { x: rect.x, y: rect.y + (rect.h - h) / 2, w: rect.w, h };
}

// ---------------------------------------------------------------------------------------------------------
// Grid composer ("reference sheet")
// ---------------------------------------------------------------------------------------------------------

export const GRID_LAYOUTS = [
  { id: 'auto', label: 'Auto' },
  { id: 'row', label: 'Row' },
  { id: 'column', label: 'Column' },
  { id: '2x2', label: '2×2', max: 4 },
  { id: '3x3', label: '3×3', max: 9 },
];

export const GRID_MIN = 2;
export const GRID_MAX = 9;

export const SHEET_SIZES = [
  { id: 'auto', label: 'Auto (fit images)' },
  { id: '1024x1024', label: '1024 × 1024 (1:1)', width: 1024, height: 1024 },
  { id: '1536x1536', label: '1536 × 1536 (1:1)', width: 1536, height: 1536 },
  { id: '2048x2048', label: '2048 × 2048 (1:1)', width: 2048, height: 2048 },
  { id: '1280x720', label: '1280 × 720 (16:9)', width: 1280, height: 720 },
  { id: '1920x1080', label: '1920 × 1080 (16:9)', width: 1920, height: 1080 },
  { id: '720x1280', label: '720 × 1280 (9:16)', width: 720, height: 1280 },
  { id: '1080x1920', label: '1080 × 1920 (9:16)', width: 1080, height: 1920 },
  { id: '1536x1024', label: '1536 × 1024 (3:2)', width: 1536, height: 1024 },
  { id: '1024x1536', label: '1024 × 1536 (2:3)', width: 1024, height: 1536 },
  { id: 'custom', label: 'Custom…' },
];

/** Columns, rows and how many images a layout shows for n images. */
export function gridDims(n, layout = 'auto') {
  const count0 = Math.max(0, Math.floor(n));
  if (!count0) return { cols: 1, rows: 1, count: 0 };
  switch (layout) {
    case 'row':
      return { cols: count0, rows: 1, count: count0 };
    case 'column':
      return { cols: 1, rows: count0, count: count0 };
    case '2x2': {
      const count = Math.min(4, count0);
      return { cols: Math.min(2, count), rows: Math.ceil(count / 2), count };
    }
    case '3x3': {
      const count = Math.min(9, count0);
      return { cols: Math.min(3, count), rows: Math.ceil(count / 3), count };
    }
    default: {
      const count = count0;
      if (count <= 3) return { cols: count, rows: 1, count };
      if (count === 4) return { cols: 2, rows: 2, count };
      const cols = Math.ceil(Math.sqrt(count));
      return { cols, rows: Math.ceil(count / cols), count };
    }
  }
}

/**
 * Cell rectangles for n images in a W x H sheet with `gap` px between cells and around the edge.
 * Incomplete last rows are centred. Returns {cols, rows, gap, cellW, cellH, cells: [{x, y, w, h}]}.
 */
export function gridCells(n, layout, W, H, gap = 0) {
  const { cols, rows, count } = gridDims(n, layout);
  const g = Math.max(0, Math.min(gap, Math.floor((W - cols) / (cols + 1)), Math.floor((H - rows) / (rows + 1))));
  const cellW = (W - g * (cols + 1)) / cols;
  const cellH = (H - g * (rows + 1)) / rows;
  const cells = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inRow = r === rows - 1 ? count - r * cols : cols;
    const offset = ((cols - inRow) * (cellW + g)) / 2;
    cells.push({ x: g + c * (cellW + g) + offset, y: g + r * (cellH + g), w: cellW, h: cellH });
  }
  return { cols, rows, gap: g, cellW, cellH, cells };
}

/**
 * Sheet dimensions. sizeId from SHEET_SIZES; 'auto' sizes cells to `cellAspect` (w / h) with the long side of
 * the sheet = longSide; 'custom' uses custom {width, height}.
 */
export function sheetSize(sizeId, { n = 1, layout = 'auto', cellAspect = 1, gap = 0, longSide = 1536, custom = null } = {}) {
  const preset = SHEET_SIZES.find((s) => s.id === sizeId) || SHEET_SIZES[0];
  if (preset.width) return { width: preset.width, height: preset.height };
  if (preset.id === 'custom') {
    return { width: clampDim(custom?.width || 1024), height: clampDim(custom?.height || 1024) };
  }
  const { cols, rows } = gridDims(Math.max(1, n), layout);
  const ar = clamp(Number(cellAspect) || 1, 0.25, 4);
  let cw;
  let ch;
  if (cols * ar >= rows) {
    cw = Math.max(16, (longSide - gap * (cols + 1)) / cols);
    ch = cw / ar;
  } else {
    ch = Math.max(16, (longSide - gap * (rows + 1)) / rows);
    cw = ch * ar;
  }
  // Whole-pixel cells, rounded down so cells + gaps never exceed the long side.
  cw = Math.floor(cw + 1e-9);
  ch = Math.floor(ch + 1e-9);
  return { width: clampDim(cols * cw + gap * (cols + 1)), height: clampDim(rows * ch + gap * (rows + 1)) };
}

/** Median aspect ratio (w / h) of images [{width, height}], 1 when unknown. Used for 'auto' sheet cells. */
export function medianAspect(images) {
  const ratios = images.filter((i) => i && i.width > 0 && i.height > 0).map((i) => i.width / i.height).sort((a, b) => a - b);
  if (!ratios.length) return 1;
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}

// ---------------------------------------------------------------------------------------------------------
// Editor state transitions (pure). Edit state: {rotation, flipH, flipV, aspect, crop: rect|null, resize: {...}, ...}
// for a source image of W x H. crop null = the whole oriented image.
// ---------------------------------------------------------------------------------------------------------

/** Current crop rect (whole oriented image when unset). */
export function cropOf(edits, W, H) {
  const o = orientedSize(W, H, edits.rotation);
  return edits.crop ? clampRect(edits.crop, o.width, o.height, 1) : fullRect(o.width, o.height);
}

/** Rotates what the user sees by a quarter turn (dir 1 = clockwise). Flips swap axes; the crop turns with the image. */
export function rotateEditState(edits, dir, W, H) {
  const o = orientedSize(W, H, edits.rotation);
  const rotation = normalizeRotation(edits.rotation + 90 * (dir >= 0 ? 1 : -1));
  const no = orientedSize(W, H, rotation);
  let crop = edits.crop ? rotateRect(edits.crop, o.width, o.height, dir) : null;
  const ratio = aspectRatioOf(edits.aspect);
  if (ratio) crop = crop ? constrainAspect(crop, ratio, no.width, no.height) : maxAspectRect(no.width, no.height, ratio);
  return { ...edits, rotation, flipH: !!edits.flipV, flipV: !!edits.flipH, crop };
}

/** Mirrors what the user sees ('h' = left/right, 'v' = top/bottom); the crop is mirrored too. */
export function flipEditState(edits, axis, W, H) {
  const o = orientedSize(W, H, edits.rotation);
  const crop = edits.crop ? flipRect(edits.crop, o.width, o.height, axis) : null;
  return axis === 'h' ? { ...edits, flipH: !edits.flipH, crop } : { ...edits, flipV: !edits.flipV, crop };
}

/** Selects an aspect preset: the crop becomes the largest centred rect of that ratio (free keeps the crop). */
export function setAspectState(edits, aspectId, W, H) {
  const ratio = aspectRatioOf(aspectId);
  const o = orientedSize(W, H, edits.rotation);
  return { ...edits, aspect: ratio ? aspectId : 'free', crop: ratio ? maxAspectRect(o.width, o.height, ratio) : edits.crop };
}

/** Selects a resize preset. Exact sizes lock the crop to their ratio; custom starts from the crop size. */
export function setResizeState(edits, presetId, W, H) {
  const preset = resizePresetOf(presetId);
  let next = { ...edits, resize: { ...(edits.resize || {}), preset: preset.id } };
  const aspect = aspectForResize(preset.id);
  if (aspect) {
    const crop = cropOf(edits, W, H);
    if (edits.aspect !== aspect || Math.abs(crop.w / crop.h - aspectRatioOf(aspect)) > 0.01) next = setAspectState(next, aspect, W, H);
  }
  if (preset.id === 'custom' && !(Number(edits.resize?.width) > 0)) {
    const crop = cropOf(edits, W, H);
    next.resize = { ...next.resize, width: Math.round(crop.w), height: Math.round(crop.h), lock: edits.resize?.lock !== false };
  }
  return next;
}

/**
 * True when two edit states produce the same image for a W x H source (crop null and an explicit full-frame crop
 * are the same). Used to skip no-op edits so they never become undo steps.
 */
export function editStatesEqual(a, b, W, H) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (normalizeRotation(a.rotation) !== normalizeRotation(b.rotation) || !!a.flipH !== !!b.flipH || !!a.flipV !== !!b.flipV) return false;
  if ((a.aspect || 'free') !== (b.aspect || 'free')) return false;
  if (!rectsEqual(cropOf(a, W, H), cropOf(b, W, H), 1e-6)) return false;
  const ra = a.resize || {};
  const rb = b.resize || {};
  if ((ra.preset || 'original') !== (rb.preset || 'original')) return false;
  if ((ra.preset === 'custom' || rb.preset === 'custom') && (Number(ra.width) || 0) !== (Number(rb.width) || 0)) return false;
  if ((ra.preset === 'custom' || rb.preset === 'custom') && ((Number(ra.height) || 0) !== (Number(rb.height) || 0) || (ra.lock !== false) !== (rb.lock !== false))) return false;
  if (!adjustEqual(a.adjust, b.adjust)) return false;
  return (a.format || 'auto') === (b.format || 'auto') && (a.quality ?? 0.92) === (b.quality ?? 0.92);
}

/** Sets one numeric crop field ('x' | 'y' | 'w' | 'h'); with an aspect lock the other side follows. */
export function setCropFieldState(edits, field, value, W, H) {
  const o = orientedSize(W, H, edits.rotation);
  const ratio = aspectRatioOf(edits.aspect);
  const cur = cropOf(edits, W, H);
  const v = Number(value);
  if (!Number.isFinite(v)) return edits;
  let next = { ...cur, [field]: v };
  if (ratio && field === 'w') next.h = v / ratio;
  if (ratio && field === 'h') next.w = v * ratio;
  if (ratio && (next.w > o.width || next.h > o.height)) {
    const s = Math.min(o.width / next.w, o.height / next.h);
    next = { ...next, w: next.w * s, h: next.h * s };
  }
  return { ...edits, crop: roundRect(clampRect(next, o.width, o.height, MIN_CROP), o.width, o.height) };
}
