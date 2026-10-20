// Per-clip visual effects and text rendering for the compositor (canvas 2D; works on OffscreenCanvas too).

import { clamp, lerp, splitGraphemes } from '../core/utils.js';
import { FILTER_DEFAULTS, TEXT_STYLE_DEFAULTS } from '../core/model.js';

export const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
export const easeInOutQuint = (p) => (p < 0.5 ? 16 * p ** 5 : 1 - Math.pow(-2 * p + 2, 5) / 2);
export const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
export const easeOutBack = (p) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

/** Destination rectangle for drawing a (sw x sh) source into (W x H) with the given fit. May overflow (cover). */
export function fitRect(sw, sh, W, H, fit = 'cover') {
  if (!sw || !sh) return { x: 0, y: 0, w: W, h: H };
  if (fit === 'fill') return { x: 0, y: 0, w: W, h: H };
  const s = fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  const w = sw * s;
  const h = sh * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/** CSS filter string for canvas `ctx.filter`. Blur is specified at a 720p reference height and scaled. */
export function buildFilter(filters, H, extraBlurPx = 0) {
  const f = { ...FILTER_DEFAULTS, ...(filters || {}) };
  const parts = [];
  // Exposure (EV stops) is a linear gain like CSS brightness(): both fold into one brightness() function.
  const bright = f.brightness * (f.exposure ? Math.pow(2, f.exposure) : 1);
  if (bright !== 1) parts.push(`brightness(${+bright.toFixed(4)})`);
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturate !== 1) parts.push(`saturate(${f.saturate})`);
  if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
  if (f.grayscale) parts.push(`grayscale(${f.grayscale})`);
  if (f.sepia) parts.push(`sepia(${f.sepia})`);
  if (f.invert) parts.push(`invert(${f.invert})`);
  const blur = (f.blur || 0) * (H / 720) + extraBlurPx;
  if (blur > 0.05) parts.push(`blur(${blur.toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

// ---------------------------------------------------------------------------------------------------------
// Crop / rotate / flip (clip.crop, clip.rotate, clip.flipH, clip.flipV — see core/model.js "clip tools")
// ---------------------------------------------------------------------------------------------------------

/** True when a clip draws its source with a crop, a rotation or a mirror. */
export const hasCropRotate = (clip) => !!(clip && (clip.crop || clip.rotate || clip.flipH || clip.flipV));

/** Source pixel rectangle {sx, sy, sw, sh} a clip's crop selects from a (w x h) picture. */
export function cropRect(clip, w, h) {
  const c = clip?.crop;
  if (!c) return { sx: 0, sy: 0, sw: w, sh: h };
  return { sx: c.x * w, sy: c.y * h, sw: Math.max(1, c.w * w), sh: Math.max(1, c.h * h) };
}

/** Size of the picture a clip shows once cropped and rotated (what the fit — cover / contain / fill — works with). */
export function orientedSize(clip, w, h) {
  const r = cropRect(clip, w, h);
  const quarter = (clip?.rotate || 0) % 180 !== 0;
  return quarter ? { w: r.sh, h: r.sw } : { w: r.sw, h: r.sh };
}

/**
 * Draws a source picture with the clip's crop, rotation and mirroring into the destination rectangle (x, y, w, h),
 * which has the oriented aspect (orientedSize). Without crop / rotate / flip it is a plain drawImage().
 */
export function drawOriented(ctx, image, clip, srcW, srcH, x, y, w, h) {
  if (!hasCropRotate(clip)) {
    ctx.drawImage(image, x, y, w, h);
    return;
  }
  const r = cropRect(clip, srcW, srcH);
  const rot = clip.rotate || 0;
  const quarter = rot % 180 !== 0;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  // Mirror the picture as seen (after rotation): scale first, then rotate the drawing.
  if (clip.flipH || clip.flipV) ctx.scale(clip.flipH ? -1 : 1, clip.flipV ? -1 : 1);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  const dw = quarter ? h : w;
  const dh = quarter ? w : h;
  ctx.drawImage(image, r.sx, r.sy, r.sw, r.sh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

/**
 * Draws a clip's source fitted into (W x H) — crop, rotation and mirroring included. Returns the destination rect.
 * Shared by the main track (compositor drawItem) and anything else that frames a clip the same way.
 */
export function drawClipSource(ctx, source, clip, W, H, fit = clip?.fit || 'cover') {
  const o = orientedSize(clip, source.width, source.height);
  const r = fitRect(o.w, o.h, W, H, fit);
  drawOriented(ctx, source.image, clip, source.width, source.height, r.x, r.y, r.w, r.h);
  return r;
}

// ---------------------------------------------------------------------------------------------------------
// White balance (temperature / tint)
// ---------------------------------------------------------------------------------------------------------

/**
 * Per-channel gains [r, g, b] of a white-balance shift: temperature -1 (cool) .. 1 (warm) scales red up and blue down
 * (or the reverse), tint -1 (green) .. 1 (magenta) scales green; normalized so the luma (Rec. 709) stays the same.
 */
export function whiteBalanceGains(temperature = 0, tint = 0) {
  const T = clamp(Number(temperature) || 0, -1, 1);
  const M = clamp(Number(tint) || 0, -1, 1);
  let r = (1 + 0.3 * T) * (1 + 0.06 * M);
  let g = 1 - 0.25 * M;
  let b = (1 - 0.3 * T) * (1 + 0.06 * M);
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r /= L;
  g /= L;
  b /= L;
  return [r, g, b];
}

/** White-balance gains of a clip's filters, or null when neutral (nothing to grade). */
export function gradeGains(filters) {
  const t = filters?.temperature || 0;
  const m = filters?.tint || 0;
  if (Math.abs(t) < 1e-4 && Math.abs(m) < 1e-4) return null;
  return whiteBalanceGains(t, m);
}

const gradePool = { layer: null, tmp: null };
function gradeCanvas(which, W, H) {
  let c = gradePool[which];
  if (!c || c.width !== W || c.height !== H) {
    if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(W, H);
    else {
      c = document.createElement('canvas');
      c.width = W;
      c.height = H;
    }
    gradePool[which] = c;
  }
  return c;
}

/** A cleared, transparent (W x H) layer for drawing a picture that will be graded (shared, not re-entrant). */
export function gradeLayer(W, H) {
  const c = gradeCanvas('layer', W, H);
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.clearRect(0, 0, W, H);
  return c;
}

const rgb = (r, g, b) => `rgb(${Math.round(clamp(r, 0, 1) * 255)},${Math.round(clamp(g, 0, 1) * 255)},${Math.round(clamp(b, 0, 1) * 255)})`;

/**
 * Multiplies the colour channels of a transparent-backed layer by [r, g, b] (each 0..2), keeping its alpha. Canvas 2D
 * has no colour matrix that works on OffscreenCanvas (SVG filters need a document), so this uses composite operations:
 * gains below 1 are a 'multiply' fill; gains above 1 add `layer x (gain - 1)` back with 'lighter'; 'destination-in'
 * restores the picture's alpha after each fill. Exact for opaque pixels, GPU-fast, and identical in preview and export.
 */
export function applyChannelGains(layer, [r, g, b]) {
  const W = layer.width;
  const H = layer.height;
  const lg = layer.getContext('2d');
  const tmp = gradeCanvas('tmp', W, H);
  const tg = tmp.getContext('2d');
  tg.setTransform(1, 0, 0, 1, 0, 0);
  tg.filter = 'none';
  tg.globalAlpha = 1;
  tg.globalCompositeOperation = 'copy';
  tg.drawImage(layer, 0, 0);
  lg.save();
  lg.setTransform(1, 0, 0, 1, 0, 0);
  lg.filter = 'none';
  lg.globalAlpha = 1;
  if (r < 1 || g < 1 || b < 1) {
    lg.globalCompositeOperation = 'multiply';
    lg.fillStyle = rgb(Math.min(r, 1), Math.min(g, 1), Math.min(b, 1));
    lg.fillRect(0, 0, W, H);
    lg.globalCompositeOperation = 'destination-in';
    lg.drawImage(tmp, 0, 0);
  }
  if (r > 1 || g > 1 || b > 1) {
    tg.globalCompositeOperation = 'multiply';
    tg.fillStyle = rgb(Math.max(r - 1, 0), Math.max(g - 1, 0), Math.max(b - 1, 0));
    tg.fillRect(0, 0, W, H);
    tg.globalCompositeOperation = 'destination-in';
    tg.drawImage(layer, 0, 0);
    lg.globalCompositeOperation = 'lighter';
    lg.drawImage(tmp, 0, 0);
  }
  lg.restore();
  tg.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------------------------------------------------
// Auto enhance
// ---------------------------------------------------------------------------------------------------------

/**
 * Luminance statistics of RGBA pixel data: {mean, low, high, sat} — low / high = the 2nd / 98th luma percentiles,
 * sat = mean chroma (max - min channel); all 0..1.
 */
export function lumaStats(data) {
  const hist = new Uint32Array(256);
  let n = 0;
  let sum = 0;
  let sat = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    hist[y]++;
    sum += y;
    sat += Math.max(r, g, b) - Math.min(r, g, b);
    n++;
  }
  if (!n) return { mean: 0.5, low: 0, high: 1, sat: 0.25 };
  const pct = (p) => {
    const target = p * n;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v / 255;
    }
    return 1;
  };
  return { mean: sum / n / 255, low: pct(0.02), high: pct(0.98), sat: sat / n / 255 };
}

/**
 * iMovie-style "Auto enhance" from luminance statistics: stretches contrast toward the full range, brings the mean
 * toward mid-grey and lifts dull colour a little. Returns a filters patch {brightness, contrast, saturate} (gentle and
 * clamped; a well-exposed picture stays close to neutral).
 */
export function autoEnhanceFilters({ mean, low, high, sat }) {
  const range = Math.max(0.05, high - low);
  const contrast = clamp(0.9 / range, 1, 1.45); // never flattens a picture that already spans the range
  const brightness = clamp(Math.pow(0.48 / Math.max(0.04, mean), 0.6), 0.75, 1.5);
  const saturate = clamp(sat < 0.2 ? 1 + (0.2 - sat) * 1.6 : 1.05, 1, 1.35);
  const r2 = (v) => Math.round(v * 100) / 100;
  return { brightness: r2(brightness), contrast: r2(contrast), saturate: r2(saturate) };
}

/** Darkens the frame edges. strength 0..1. */
export function drawVignette(ctx, W, H, strength) {
  if (!strength) return;
  const r = Math.hypot(W, H) / 2;
  const g = ctx.createRadialGradient(W / 2, H / 2, r * (0.75 - strength * 0.45), W / 2, H / 2, r);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${clamp(0.35 + strength * 0.6, 0, 0.95)})`);
  ctx.save();
  ctx.filter = 'none';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/** Applies the Ken Burns pan/zoom for progress k (0..1) about a focus point. */
export function applyKenBurns(ctx, kb, k, W, H) {
  if (!kb) return;
  const e = easeInOut(clamp(k, 0, 1));
  const zoom = lerp(kb.from.zoom ?? 1, kb.to.zoom ?? 1, e);
  let x = lerp(kb.from.x ?? 0.5, kb.to.x ?? 0.5, e);
  let y = lerp(kb.from.y ?? 0.5, kb.to.y ?? 0.5, e);
  if (zoom >= 1) {
    // Never pan past the frame edge: the visible window (1/zoom of the frame) stays inside it.
    const h = 0.5 / zoom;
    x = clamp(x, h, 1 - h);
    y = clamp(y, h, 1 - h);
  }
  if (zoom === 1 && x === 0.5 && y === 0.5) return;
  // Keep the focus point (x, y) moving from its start position toward the centre while zooming.
  ctx.translate(W / 2, H / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-W * x, -H * y);
}

// ---------------------------------------------------------------------------------------------------------
// Text overlays
// ---------------------------------------------------------------------------------------------------------

export const FONT_CHOICES = [
  { label: 'Sans (Inter / system)', value: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif' },
  { label: 'Condensed bold', value: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif' },
  { label: 'Impact', value: 'Impact, Haettenschweiler, "Arial Black", sans-serif' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Elegant serif', value: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif' },
  { label: 'Mono', value: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace' },
  { label: 'Handwritten', value: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive' },
];

let wordSegmenter;
/** Word-level segments with the separators kept ("a", " ", "b"); CJK and Thai are split into words too (ICU). */
function segmentWords(text) {
  if (wordSegmenter === undefined) {
    try {
      wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    } catch {
      wordSegmenter = null;
    }
  }
  if (!wordSegmenter) return text.split(/(\s+)/).filter(Boolean);
  return Array.from(wordSegmenter.segment(text), (x) => x.segment);
}

// Never at the start of a line: closing brackets/quotes, punctuation, dashes, Japanese iteration / prolonged marks.
const NO_LINE_START = /^[\p{Pe}\p{Pf}\p{Po}\p{Pd}ー々ゝゞヽヾ]/u;
// Never at the end of a line: opening brackets/quotes.
const NO_LINE_END = /^[\p{Ps}\p{Pi}]+$/u;
const SPACES = /^\s+$/;
// Strong right-to-left letters (Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, presentation forms, RTL
// historic scripts, Adlam…).
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;

/** Base direction of a paragraph: that of its first letter (Unicode's first-strong rule). */
export function textDirection(text) {
  for (const ch of String(text || '')) {
    if (!LETTER.test(ch)) continue;
    return RTL_LETTER.test(ch) ? 'rtl' : 'ltr';
  }
  return 'ltr';
}

/**
 * Greedy line wrapping into [{text, dir}] (dir: the paragraph's direction). Breaks between words — which includes
 * between CJK words, where no spaces exist — and inside a word only when the word alone is wider than maxWidth (long
 * URLs, very long words: broken between characters, never inside an emoji). Closing punctuation stays on the line
 * it follows, opening brackets move to the line they open.
 */
export function wrapText(ctx, text, maxWidth) {
  const out = [];
  const width = (s) => ctx.measureText(s).width;
  for (const para of String(text).split('\n')) {
    const dir = textDirection(para);
    let segs = [];
    let line = '';
    const pieces = [];
    for (const seg of segmentWords(para)) {
      if (!SPACES.test(seg) && width(seg) > maxWidth) pieces.push(...splitGraphemes(seg));
      else pieces.push(seg);
    }
    for (const seg of pieces) {
      if (!line) {
        if (SPACES.test(seg)) continue; // no leading spaces on a wrapped line
        line = seg;
        segs = [seg];
        continue;
      }
      const test = line + seg;
      const keep = SPACES.test(seg) || width(test) <= maxWidth || (NO_LINE_START.test(seg) && width(seg) <= maxWidth * 0.25);
      if (keep) {
        line = test;
        segs.push(seg);
        continue;
      }
      let carry = '';
      if (segs.length > 1 && NO_LINE_END.test(segs[segs.length - 1])) {
        carry = segs.pop();
        line = segs.join('');
      }
      out.push({ text: line.trimEnd(), dir });
      line = carry + seg;
      segs = carry ? [carry, seg] : [seg];
    }
    out.push({ text: line.trimEnd(), dir });
  }
  return out;
}

/** wrapText() as plain strings. */
export const wrapLines = (ctx, text, maxWidth) => wrapText(ctx, text, maxWidth).map((l) => l.text);

// Wrapped lines per (font, width, text): titles are re-drawn every frame.
const wrapCache = new Map();
function wrapCached(ctx, text, maxWidth) {
  const key = `${ctx.font}\u0000${Math.round(maxWidth)}\u0000${text}`;
  let lines = wrapCache.get(key);
  if (!lines) {
    lines = wrapText(ctx, text, maxWidth).map((l) => ({ ...l, g: splitGraphemes(l.text) }));
    wrapCache.set(key, lines);
    if (wrapCache.size > 200) wrapCache.delete(wrapCache.keys().next().value);
  }
  return lines;
}

/** Cinematic bars (12% of the height, top and bottom) behind a title; `alpha` follows the title's animation. */
function drawLetterbox(ctx, W, H, alpha) {
  const bar = Math.round(H * 0.12);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, bar);
  ctx.fillRect(0, H - bar, W, bar);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** Animation state of a text item at local time (seconds since its start). */
export function textAnimationState(animation, local, duration, charCount) {
  const edge = Math.min(0.35, duration / 4);
  const inK = edge > 0 ? clamp(local / edge, 0, 1) : 1;
  const outK = edge > 0 ? clamp((duration - local) / edge, 0, 1) : 1;
  const st = { alpha: 1, dy: 0, scale: 1, chars: charCount };
  switch (animation) {
    case 'fade':
      st.alpha = Math.min(inK, outK);
      break;
    case 'slide-up':
      st.alpha = Math.min(inK, outK);
      st.dy = (1 - easeOutCubic(inK)) * 0.06 - (1 - outK) * 0.03;
      break;
    case 'pop':
      st.scale = local < edge ? lerp(0.6, 1, easeOutBack(inK)) : 1;
      st.alpha = Math.min(clamp(inK * 2, 0, 1), outK);
      break;
    case 'typewriter': {
      const typeDur = Math.max(0.2, Math.min(duration * 0.6, charCount * 0.05));
      st.chars = Math.round(charCount * clamp(local / typeDur, 0, 1));
      st.alpha = outK;
      break;
    }
    case 'scroll-up':
      // End credits: the block rolls from below the frame to above it over the whole clip (drawTextItem places it).
      st.scroll = duration > 0 ? clamp(local / duration, 0, 1) : 1;
      break;
    default:
      break;
  }
  return st;
}

/** Draws a text overlay item (from layoutProject().text) at timeline time t. */
export function drawTextItem(ctx, item, t, W, H) {
  const clip = item.clip;
  const style = { ...TEXT_STYLE_DEFAULTS, ...(clip.style || {}) };
  const text = String(clip.text || '');
  if (!text.trim()) return;
  const local = t - item.start;
  if (textAnimationState(clip.animation, local, item.duration, 1).alpha <= 0.001) return; // alpha never depends on the length
  const size = Math.max(6, style.size * H);
  ctx.save();
  ctx.filter = 'none';
  ctx.font = `${style.italic ? 'italic ' : ''}${style.weight || 700} ${size}px ${style.font}`;
  ctx.textBaseline = 'middle';
  const maxW = (style.maxWidth || 0.9) * W;
  // Wrap the full text so typewriter reveal doesn't reflow; the typewriter counts grapheme clusters (an emoji is
  // revealed whole, never as half a surrogate pair or a lone piece of a ZWJ sequence).
  const fullLines = wrapCached(ctx, text, maxW);
  const anim = textAnimationState(clip.animation, local, item.duration, fullLines.reduce((n, l) => n + l.g.length, 0));
  ctx.globalAlpha = anim.alpha;
  let remaining = anim.chars;
  const lines = fullLines.map((l) => {
    const n = clamp(remaining, 0, l.g.length);
    remaining -= l.g.length;
    return n >= l.g.length ? l.text : l.g.slice(0, n).join('');
  });
  const lineH = size * 1.2;
  const blockH = lineH * fullLines.length;
  const widths = fullLines.map((l) => ctx.measureText(l.text).width);
  const blockW = Math.max(...widths, 1);
  const cx = style.x * W;
  let cy = style.y * H + anim.dy * H;
  if (anim.scroll != null) cy = lerp(H + blockH / 2 + size * 0.5, -blockH / 2 - size * 0.5, anim.scroll);
  if (style.letterbox) drawLetterbox(ctx, W, H, anim.alpha);
  ctx.translate(cx, cy);
  if (anim.scale !== 1) ctx.scale(anim.scale, anim.scale);
  const align = style.align || 'center';
  const left = align === 'left' ? 0 : align === 'right' ? -blockW : -blockW / 2;
  if (style.background) {
    const pad = size * 0.35;
    ctx.fillStyle = style.background;
    roundRect(ctx, left - pad, -blockH / 2 - pad * 0.6, blockW + pad * 2, blockH + pad * 1.2, size * 0.25);
    ctx.fill();
  }
  ctx.textAlign = align;
  const ax = align === 'left' ? left : align === 'right' ? 0 : 0;
  if (style.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = size * 0.18;
    ctx.shadowOffsetY = size * 0.04;
  }
  lines.forEach((l, i) => {
    if (!l) return;
    const y = -blockH / 2 + lineH * (i + 0.5);
    // Right-to-left paragraphs are laid out right-to-left (punctuation on the correct side); the alignment stays
    // physical (left / centre / right), like the inspector shows it.
    ctx.direction = fullLines[i].dir;
    if (style.outline) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1, size * 0.09);
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.strokeText(l, ax, y);
    }
    ctx.fillStyle = style.color || '#fff';
    ctx.fillText(l, ax, y);
  });
  ctx.restore();
}
