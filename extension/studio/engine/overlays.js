// Overlay track renderer (iMovie-style video overlays), called by the compositor's drawFrame() after the main track
// and before the titles, so the preview (engine/player.js) and the export (engine/exporter.js) draw them identically.
//
//   drawOverlays(ctx, {project, layout, t, getSource, scratch}) -> {items, ready}
//
// Modes (OverlayClip.mode, see core/model.js):
//  * pip         — the picture in a box (keeps the source's aspect ratio) placed in the frame's free space, with
//                  optional border, rounded corners and drop shadow.
//  * cutaway     — the overlay covers the whole frame (clip.fit framing): the main track keeps running underneath
//                  (and keeps its sound), as in iMovie's cutaway.
//  * split       — side by side: the overlay fills `split.size` of the frame on `split.side`; the main-track picture
//                  already drawn is moved into the remaining part, centre-cropped at its full-frame scale (nothing is
//                  squeezed: the main picture keeps its framing and loses its edges, like iMovie's side-by-side).
//  * greenscreen — full-frame overlay with a chroma key: pixels near `key.color` become transparent (smooth edge
//                  via `softness`, colour spill desaturated via `spill`). Keying runs on a scratch canvas; the preview
//                  may cap its width (scratch.keyMaxWidth) to stay realtime, the export keys at full resolution.
// Entrances / exits (transitionIn / transitionOut): dissolve (opacity), zoom (scale from / to the box centre),
// slide (PiP: from / to the nearest side edge; full-frame modes: in from the right, out to the left; side by side:
// the split line slides open / closed).

import { overlayItemsAt, sourceTimeAt, fadeFactor } from '../core/model.js';
import { clamp } from '../core/utils.js';
import { buildFilter, drawVignette, fitRect, easeOutCubic } from './effects.js';

/** Inset (fraction of the frame's short side) between a PiP box and the frame edge. */
export const PIP_MARGIN = 0.035;

/** Parses '#rrggbb' to [r, g, b] (0..255). */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [0, 255, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** '#rrggbb' of [r, g, b]. */
export const rgbToHex = (r, g, b) => `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;

// BT.601 chroma (Cb, Cr) of 0..255 RGB, centred on 0, in 0..1 units.
const cbOf = (r, g, b) => (-0.168736 * r - 0.331264 * g + 0.5 * b) / 255;
const crOf = (r, g, b) => (0.5 * r - 0.418688 * g - 0.081312 * b) / 255;

/**
 * Chroma key on RGBA pixels, in place (pure: no DOM). A pixel's alpha falls to 0 when its chroma (Cb/Cr) is within
 * `tolerance` of the key colour's, ramping back to opaque over `softness`; pixels in that ramp (and just past it)
 * are desaturated by `spill` so green/blue fringes go neutral. Luminance is ignored, so shadows on the screen key out
 * too. Same model as OBS' chroma key (tolerance 0.4 / softness 0.1 suit a typical green screen).
 * @param {Uint8ClampedArray} data  RGBA (ImageData.data)
 * @param {{color?:string, tolerance?:number, softness?:number, spill?:number}} key
 * @returns {Uint8ClampedArray} the same array
 */
export function chromaKey(data, { color = '#00ff00', tolerance = 0.4, softness = 0.1, spill = 0.5 } = {}) {
  const [kr, kg, kb] = hexToRgb(color);
  const kcb = cbOf(kr, kg, kb);
  const kcr = crOf(kr, kg, kb);
  const tol = Math.max(0, tolerance);
  const soft = Math.max(1e-3, softness);
  const spillRange = Math.max(0, spill) * 0.5;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const dcb = cbOf(r, g, b) - kcb;
    const dcr = crOf(r, g, b) - kcr;
    const base = Math.sqrt(dcb * dcb + dcr * dcr) - tol;
    if (base <= 0) {
      data[i + 3] = 0;
      continue;
    }
    if (base < soft) {
      const a = Math.pow(base / soft, 1.5);
      data[i + 3] = data[i + 3] * a;
    }
    if (spillRange > 0 && base < spillRange) {
      // Pull the colour toward its own grey (luma) the closer it is to the key.
      const s = Math.pow(base / spillRange, 1.5);
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      data[i] = y + (r - y) * s;
      data[i + 1] = y + (g - y) * s;
      data[i + 2] = y + (b - y) * s;
    }
  }
  return data;
}

/**
 * Entrance / exit state of an overlay item at time t: {alpha, scale, slide, phase} — alpha includes the clip's fades,
 * scale = zoom factor (1 = full size), slide = 0..1 how far the overlay still is from (or already is past) its place,
 * phase = 'in' | 'out' | null.
 */
export function overlayTransitionState(item, t) {
  const c = item.clip;
  const local = t - item.start;
  const state = { alpha: fadeFactor(item, t), scale: 1, slide: 0, phase: null, k: 1 };
  const apply = (tr, k, phase) => {
    if (!tr || tr.type === 'none' || !(tr.duration > 0)) return;
    const p = clamp(k, 0, 1);
    if (p >= 1) return;
    state.phase = phase;
    state.k = Math.min(state.k, p);
    if (tr.type === 'dissolve') state.alpha *= p;
    else if (tr.type === 'zoom') state.scale *= Math.max(0.001, easeOutCubic(p));
    else if (tr.type === 'slide') state.slide = Math.max(state.slide, 1 - easeOutCubic(p));
  };
  apply(c.transitionIn, local / (c.transitionIn?.duration || 1), 'in');
  apply(c.transitionOut, (item.duration - local) / (c.transitionOut?.duration || 1), 'out');
  return state;
}

/**
 * Picture-in-picture box {x, y, w, h} (px) for a (srcW x srcH) source in a W x H frame. The box keeps the source's
 * aspect ratio, is pip.scale of the frame wide (at most 92% of its height) and sits in the free space at pip.x / pip.y.
 */
export function pipRect(pip, srcW, srcH, W, H) {
  const aspect = srcW > 0 && srcH > 0 ? srcH / srcW : 9 / 16;
  let w = clamp(pip?.scale ?? 0.36, 0.05, 1) * W;
  let h = w * aspect;
  if (h > H * 0.92) {
    h = H * 0.92;
    w = h / aspect;
  }
  const m = Math.round(Math.min(W, H) * PIP_MARGIN);
  const x = m + clamp(pip?.x ?? 1, 0, 1) * Math.max(0, W - w - 2 * m);
  const y = m + clamp(pip?.y ?? 0, 0, 1) * Math.max(0, H - h - 2 * m);
  return { x, y, w, h };
}

/** Inverse of pipRect's placement: pip.x / pip.y that put a w x h box's top-left corner at (x, y). */
export function pipPositionFor(x, y, w, h, W, H) {
  const m = Math.round(Math.min(W, H) * PIP_MARGIN);
  const fx = W - w - 2 * m;
  const fy = H - h - 2 * m;
  return { x: fx > 0 ? clamp((x - m) / fx, 0, 1) : 0.5, y: fy > 0 ? clamp((y - m) / fy, 0, 1) : 0.5 };
}

/** Side-by-side rectangles {overlay, main} (px) for split = {side, size} in a W x H frame. */
export function splitRects(split, W, H) {
  const size = clamp(split?.size ?? 0.5, 0, 1);
  const side = split?.side || 'left';
  if (side === 'top' || side === 'bottom') {
    const oh = Math.round(H * size);
    return side === 'top'
      ? { overlay: { x: 0, y: 0, w: W, h: oh }, main: { x: 0, y: oh, w: W, h: H - oh } }
      : { overlay: { x: 0, y: H - oh, w: W, h: oh }, main: { x: 0, y: 0, w: W, h: H - oh } };
  }
  const ow = Math.round(W * size);
  return side === 'left'
    ? { overlay: { x: 0, y: 0, w: ow, h: H }, main: { x: ow, y: 0, w: W - ow, h: H } }
    : { overlay: { x: W - ow, y: 0, w: ow, h: H }, main: { x: 0, y: 0, w: W - ow, h: H } };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = clamp(r, 0, Math.min(w, h) / 2);
  ctx.beginPath();
  if (rr <= 0.5) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draws `source` into rect (clipped to it, rounded by `radius`) with the clip's look and framing. */
function drawPicture(ctx, clip, source, rect, H, { fit = 'cover', radius = 0 } = {}) {
  ctx.save();
  roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
  ctx.clip();
  ctx.filter = buildFilter(clip.filters, H);
  const r = fitRect(source.width, source.height, rect.w, rect.h, fit);
  ctx.drawImage(source.image, rect.x + r.x, rect.y + r.y, r.w, r.h);
  ctx.filter = 'none';
  const vig = clip.filters?.vignette || 0;
  if (vig) {
    ctx.translate(rect.x, rect.y);
    drawVignette(ctx, rect.w, rect.h, vig);
  }
  ctx.restore();
}

/** Scales about (cx, cy) and shifts by dx (canvas transform for zoom / slide). */
function transformAbout(ctx, cx, cy, scale, dx = 0, dy = 0) {
  if (dx || dy) ctx.translate(dx, dy);
  if (scale !== 1) {
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
  }
}

function drawPip(ctx, item, source, st, W, H) {
  const clip = item.clip;
  const pip = clip.pip || {};
  const rect = pipRect(pip, source.width, source.height, W, H);
  const k = H / 720;
  const border = Math.max(0, pip.border || 0) * k;
  const radius = Math.max(0, pip.radius || 0) * k;
  let dx = 0;
  if (st.slide > 0) {
    const pad = border + (pip.shadow !== false ? 0.04 * H : 0);
    dx = rect.x + rect.w / 2 < W / 2 ? -(rect.x + rect.w + pad) * st.slide : (W - rect.x + pad) * st.slide;
  }
  ctx.save();
  ctx.globalAlpha = clamp(st.alpha, 0, 1);
  transformAbout(ctx, rect.x + rect.w / 2, rect.y + rect.h / 2, st.scale, dx);
  if (pip.shadow !== false || border > 0) {
    ctx.save();
    if (pip.shadow !== false) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 0.03 * H * st.scale;
      ctx.shadowOffsetY = 0.008 * H * st.scale;
    }
    ctx.fillStyle = border > 0 ? pip.borderColor || '#ffffff' : '#000000';
    roundRectPath(ctx, rect.x - border, rect.y - border, rect.w + border * 2, rect.h + border * 2, radius + border);
    ctx.fill();
    ctx.restore();
  }
  drawPicture(ctx, clip, source, rect, H, { fit: 'cover', radius });
  ctx.restore();
}

function drawFull(ctx, item, source, st, W, H, phaseDir) {
  ctx.save();
  ctx.globalAlpha = clamp(st.alpha, 0, 1);
  transformAbout(ctx, W / 2, H / 2, st.scale, st.slide > 0 ? W * st.slide * phaseDir : 0);
  drawPicture(ctx, item.clip, source, { x: 0, y: 0, w: W, h: H }, H, { fit: item.clip.fit || 'cover' });
  ctx.restore();
}

function drawSplit(ctx, item, source, st, W, H, scratch) {
  const clip = item.clip;
  const split = clip.split || {};
  // A sliding split opens / closes the dividing line; the other entrances act on the whole side-by-side picture.
  const size = (split.size ?? 0.5) * (st.slide > 0 ? 1 - st.slide : 1);
  if (size * Math.max(W, H) < 0.5) return;
  const { overlay, main } = splitRects({ side: split.side, size }, W, H);
  const tmp = scratch.get('ovsplit', W, H);
  const tctx = tmp.getContext('2d');
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.globalAlpha = 1;
  tctx.filter = 'none';
  tctx.clearRect(0, 0, W, H);
  tctx.drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = clamp(st.alpha, 0, 1);
  // The main track's picture, centre-cropped into its part of the frame.
  if (main.w > 0 && main.h > 0) ctx.drawImage(tmp, (W - main.w) / 2, (H - main.h) / 2, main.w, main.h, main.x, main.y, main.w, main.h);
  ctx.save();
  roundRectPath(ctx, overlay.x, overlay.y, overlay.w, overlay.h, 0);
  ctx.clip();
  ctx.fillStyle = '#000000';
  ctx.fillRect(overlay.x, overlay.y, overlay.w, overlay.h);
  transformAbout(ctx, overlay.x + overlay.w / 2, overlay.y + overlay.h / 2, st.scale);
  drawPicture(ctx, clip, source, overlay, H, { fit: clip.fit || 'cover' });
  ctx.restore();
  ctx.restore();
}

function drawKeyed(ctx, item, source, st, W, H, scratch, phaseDir) {
  const clip = item.clip;
  const kw = Math.max(2, Math.round(Math.min(W, scratch.keyMaxWidth || W)));
  const kh = Math.max(2, Math.round((H * kw) / W));
  const kc = scratch.get('ovkey', kw, kh);
  const kctx = kc.getContext('2d', { willReadFrequently: true });
  kctx.setTransform(1, 0, 0, 1, 0, 0);
  kctx.globalAlpha = 1;
  kctx.filter = 'none';
  kctx.clearRect(0, 0, kw, kh);
  drawPicture(kctx, clip, source, { x: 0, y: 0, w: kw, h: kh }, kh, { fit: clip.fit || 'cover' });
  const img = kctx.getImageData(0, 0, kw, kh);
  chromaKey(img.data, clip.key || {});
  kctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalAlpha = clamp(st.alpha, 0, 1);
  transformAbout(ctx, W / 2, H / 2, st.scale, st.slide > 0 ? W * st.slide * phaseDir : 0);
  ctx.drawImage(kc, 0, 0, W, H);
  ctx.restore();
}

/**
 * Draws every overlay visible at time t (bottom lane first). Returns {items, ready}: ready is false when a visible
 * overlay had no source yet (same contract as the main track in drawFrame).
 */
export function drawOverlays(ctx, { layout, t, getSource, scratch }) {
  const items = overlayItemsAt(layout.overlay || [], t);
  let ready = true;
  if (!items.length) return { items, ready };
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  for (const item of items) {
    const source = getSource(item, sourceTimeAt(item, t));
    if (!source || !source.image) {
      ready = false;
      continue;
    }
    const st = overlayTransitionState(item, t);
    if (st.alpha <= 0.001 || st.scale <= 0.002) continue;
    const dir = st.phase === 'out' ? -1 : 1; // full-frame slides enter from the right and leave to the left
    try {
      const mode = item.clip.mode || 'pip';
      if (mode === 'cutaway') drawFull(ctx, item, source, st, W, H, dir);
      else if (mode === 'split') drawSplit(ctx, item, source, st, W, H, scratch);
      else if (mode === 'greenscreen') drawKeyed(ctx, item, source, st, W, H, scratch, dir);
      else drawPip(ctx, item, source, st, W, H);
    } catch {
      // A source that can't be drawn yet (video element without data): treat as not ready.
      ready = false;
    }
  }
  return { items, ready };
}
