// Canvas rendering for the Ingredients tab: image decoding/normalisation, the editor pipeline (orient -> crop ->
// resize -> adjust) shared by the live preview and Save, and the grid composer ("reference sheet").
// DOM/Canvas only; the math lives in geometry.js and pixels.js (pure, unit-tested).
import { orientationMatrix, orientedSize, coverRect, outputSize, clampRect, fullRect, roundRect, gridCells, multiplyMatrix } from './geometry.js';
import { adjustPixels, adjustIsNeutral, ADJUST_DEFAULTS } from './pixels.js';
import { sniffImageMime, outputMime } from './logic.js';
import { fitRect } from '../../engine/effects.js';

/** Default (neutral) editor state. Crop null = whole image. */
export function defaultEdits() {
  return {
    rotation: 0,
    flipH: false,
    flipV: false,
    aspect: 'free',
    crop: null,
    resize: { preset: 'original', width: 0, height: 0, lock: true },
    adjust: { ...ADJUST_DEFAULTS },
    format: 'auto',
    quality: 0.92,
  };
}

/** True when the edits would change the image (format changes count: they re-encode). */
export function editsAreNeutral(edits, imgW, imgH) {
  if (!edits) return true;
  if (edits.rotation || edits.flipH || edits.flipV) return false;
  if (edits.crop && !(edits.crop.x === 0 && edits.crop.y === 0 && edits.crop.w === imgW && edits.crop.h === imgH)) return false;
  if ((edits.resize?.preset || 'original') !== 'original') return false;
  if (!adjustIsNeutral(edits.adjust)) return false;
  return !edits.format || edits.format === 'auto';
}

/** Geometry of an edit for a source of W x H: oriented size, integer crop rect, output size and drawn source rect. */
export function editGeometry(W, H, edits) {
  const o = orientedSize(W, H, edits.rotation);
  const crop = roundRect(clampRect(edits.crop || fullRect(o.width, o.height), o.width, o.height, 1), o.width, o.height);
  const out = outputSize(crop.w, crop.h, edits.resize);
  const src = coverRect(crop, out.width, out.height);
  return { oriented: o, crop, out, src };
}

// ---------------------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------------------

async function decodeViaElement(blob, fallbackSize = 1024) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || fallbackSize;
    const h = img.naturalHeight || fallbackSize;
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Makes sure a blob is a decodable image with an image/* MIME type. Re-types mislabelled downloads by sniffing the
 * bytes and rasterises formats createImageBitmap can't read (SVG, ICO…) to PNG. Throws for non-images.
 */
export async function normalizeImageBlob(blob) {
  if (!blob || !blob.size) throw new Error('The image is empty');
  let out = blob;
  const type = (blob.type || '').toLowerCase();
  if (!type.startsWith('image/') || type === 'image/svg+xml') {
    const sniffed = sniffImageMime(new Uint8Array(await blob.slice(0, 96).arrayBuffer()));
    if (!sniffed) throw new Error(`Not an image (${type || 'unknown type'})`);
    out = new Blob([blob], { type: sniffed });
  }
  if (out.type !== 'image/svg+xml') {
    try {
      const bmp = await createImageBitmap(out);
      bmp.close();
      return out;
    } catch {
      /* fall through to the element decoder */
    }
  }
  try {
    const canvas = await decodeViaElement(out);
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch {
    throw new Error(`Unsupported image format (${out.type || 'unknown'})`);
  }
}

/** ImageBitmap of a blob, optionally downscaled so the long side is <= maxSide. Caller must close() it. */
export async function decodeImage(blob, { maxSide = 0 } = {}) {
  const full = await createImageBitmap(blob);
  if (!maxSide || Math.max(full.width, full.height) <= maxSide) return full;
  const s = maxSide / Math.max(full.width, full.height);
  try {
    return await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * s)), resizeHeight: Math.max(1, Math.round(full.height * s)), resizeQuality: 'high' });
  } finally {
    full.close();
  }
}

/** Preview bitmap (long side <= maxSide) plus the full-resolution size of the image. Caller must close() bitmap. */
export async function decodePreview(blob, maxSide = 1600) {
  const full = await createImageBitmap(blob);
  const { width, height } = full;
  if (Math.max(width, height) <= maxSide) return { bitmap: full, width, height };
  const s = maxSide / Math.max(width, height);
  try {
    const bitmap = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(width * s)), resizeHeight: Math.max(1, Math.round(height * s)), resizeQuality: 'high' });
    return { bitmap, width, height };
  } finally {
    full.close();
  }
}

export async function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), type, quality));
}

// ---------------------------------------------------------------------------------------------------------
// Editor pipeline
// ---------------------------------------------------------------------------------------------------------

function applyAdjustments(ctx, w, h, adjust) {
  if (adjustIsNeutral(adjust)) return;
  const img = ctx.getImageData(0, 0, w, h);
  adjustPixels(img.data, w, h, adjust);
  ctx.putImageData(img, 0, 0);
}

/**
 * Renders the edited image at full resolution. `source` is a Blob or an ImageBitmap of the original.
 * Returns {blob, width, height, type}.
 */
export async function renderEdited(source, edits, { srcMime = 'image/png' } = {}) {
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  try {
    const { out, src } = editGeometry(bmp.width, bmp.height, edits);
    const canvas = new OffscreenCanvas(out.width, out.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: !adjustIsNeutral(edits.adjust) });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const type = outputMime(srcMime, edits.format);
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff'; // JPEG has no alpha: flatten transparent areas on white, like most editors
      ctx.fillRect(0, 0, out.width, out.height);
    }
    // canvas = Scale(out / src) ∘ Translate(-src) ∘ Orientation
    const view = [out.width / src.w, 0, 0, out.height / src.h, (-src.x * out.width) / src.w, (-src.y * out.height) / src.h];
    ctx.setTransform(...multiplyMatrix(view, orientationMatrix(bmp.width, bmp.height, edits.rotation, edits.flipH, edits.flipV)));
    ctx.drawImage(bmp, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    applyAdjustments(ctx, out.width, out.height, edits.adjust);
    const blob = await canvasToBlob(canvas, type, edits.quality ?? 0.92);
    return { blob, width: out.width, height: out.height, type };
  } finally {
    if (source instanceof Blob) bmp.close();
  }
}

/**
 * Live preview: draws the whole oriented image (no crop: the crop box is an overlay) from a downscaled preview
 * bitmap into `canvas`, with adjustments applied. `maxWidth` (device px) limits the canvas to what is on screen so
 * slider drags stay cheap. `showOriginal` skips the adjustments (before/after compare).
 */
export function renderPreview(canvas, previewBmp, edits, { showOriginal = false, maxWidth = 0 } = {}) {
  const pw = previewBmp.width;
  const ph = previewBmp.height;
  const o = orientedSize(pw, ph, edits.rotation);
  const s = maxWidth > 0 ? Math.min(1, maxWidth / o.width) : 1;
  const cw = Math.max(1, Math.round(o.width * s));
  const ch = Math.max(1, Math.round(o.height * s));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(...multiplyMatrix([cw / o.width, 0, 0, ch / o.height, 0, 0], orientationMatrix(pw, ph, edits.rotation, edits.flipH, edits.flipV)));
  ctx.drawImage(previewBmp, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!showOriginal) applyAdjustments(ctx, cw, ch, edits.adjust);
}

// ---------------------------------------------------------------------------------------------------------
// Grid composer
// ---------------------------------------------------------------------------------------------------------

/** Default reference-sheet options. */
export function defaultSheetOptions() {
  return { layout: 'auto', gap: 16, background: '#111114', fit: 'cover', labels: 'none', size: 'auto', custom: { width: 1536, height: 1024 }, format: 'image/jpeg' };
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}

/** Perceived luminance (0..1) of a #rrggbb colour, used to pick label colours that stay readable. */
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/**
 * Draws a reference sheet into ctx in sheet coordinates (W x H; the caller may pre-scale ctx for a smaller preview).
 * items: [{bitmap, name}] in order. opts: defaultSheetOptions() shape. Returns the cell layout used.
 */
export function drawSheet(ctx, items, opts, W, H) {
  const grid = gridCells(items.length, opts.layout, W, H, opts.gap);
  ctx.save();
  ctx.fillStyle = opts.background || '#000000';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const radius = opts.gap > 0 ? Math.min(grid.cellW, grid.cellH) * 0.02 : 0;
  grid.cells.forEach((cell, i) => {
    const { bitmap } = items[i];
    if (!bitmap) return;
    ctx.save();
    roundedRectPath(ctx, cell.x, cell.y, cell.w, cell.h, radius);
    ctx.clip();
    const r = fitRect(bitmap.width, bitmap.height, cell.w, cell.h, opts.fit === 'contain' ? 'contain' : 'cover');
    ctx.drawImage(bitmap, cell.x + r.x, cell.y + r.y, r.w, r.h);
    ctx.restore();
  });
  if (opts.labels && opts.labels !== 'none') drawLabels(ctx, items, grid, opts);
  ctx.restore();
  return grid;
}

function drawLabels(ctx, items, grid, opts) {
  const unit = Math.min(grid.cellW, grid.cellH);
  const font = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const showNumbers = opts.labels === 'numbers' || opts.labels === 'both';
  const showNames = opts.labels === 'names' || opts.labels === 'both';
  grid.cells.forEach((cell, i) => {
    if (showNames && items[i].name) {
      const size = Math.max(11, Math.round(unit * 0.055));
      const band = Math.round(size * 2.1);
      ctx.save();
      roundedRectPath(ctx, cell.x, cell.y, cell.w, cell.h, opts.gap > 0 ? unit * 0.02 : 0);
      ctx.clip();
      const g = ctx.createLinearGradient(0, cell.y + cell.h - band * 1.6, 0, cell.y + cell.h);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = g;
      ctx.fillRect(cell.x, cell.y + cell.h - band * 1.6, cell.w, band * 1.6);
      ctx.font = `600 ${size}px ${font}`;
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const pad = Math.round(size * 0.8);
      ctx.fillText(ellipsize(ctx, items[i].name, cell.w - pad * 2), cell.x + pad, cell.y + cell.h - band / 2);
      ctx.restore();
    }
    if (showNumbers) {
      const d = Math.max(20, Math.round(unit * 0.11));
      const x = cell.x + d * 0.35;
      const y = cell.y + d * 0.35;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
      ctx.fillStyle = luminance(opts.background) > 0.6 ? 'rgba(20,20,24,0.88)' : 'rgba(255,255,255,0.92)';
      ctx.fill();
      ctx.font = `700 ${Math.round(d * 0.56)}px ${font}`;
      ctx.fillStyle = luminance(opts.background) > 0.6 ? '#ffffff' : '#111114';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x + d / 2, y + d / 2 + d * 0.03);
      ctx.restore();
    }
  });
}

/** Renders a sheet at full size and encodes it. Returns {blob, width, height}. */
export async function renderSheet(items, opts, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  drawSheet(canvas.getContext('2d'), items, opts, width, height);
  const type = opts.format || 'image/jpeg';
  const blob = await canvasToBlob(canvas, type, 0.92);
  return { blob, width, height, type };
}
