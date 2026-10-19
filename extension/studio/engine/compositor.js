// Frame compositor shared by the live preview (engine/player.js) and the exporter (engine/exporter.js).
// It is deliberately source-agnostic: callers supply `getSource(item, sourceTime)` returning the already-decoded
// image for a main-track item (an HTMLVideoElement in preview, a VideoFrame/canvas in export, an ImageBitmap/
// HTMLImageElement for stills) so preview and export render identically.
//
//   drawFrame(ctx, {project, layout, t, getSource, scratch})
//     project : the project (settings.background used)
//     layout  : layoutProject(project)
//     t       : timeline time in seconds
//     getSource(item, sourceTime) -> {image: CanvasImageSource, width, height} | null   (null => clip not ready)
//     scratch : optional Compositor scratch holder (createScratch()) reused across frames for pixelate/glitch.

import { videoItemsAt, textItemsAt, sourceTimeAt, fadeFactor, transitionProgress } from '../core/model.js';
import { EPS } from '../core/utils.js';
import { TRANSITION_RENDERERS } from './transitions.js';
import { buildFilter, drawVignette, applyKenBurns, fitRect, drawTextItem, easeInOut } from './effects.js';

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Scratch canvases reused across frames (one per compositor user). */
export function createScratch() {
  const pool = { A: null, B: null, tiny: null };
  return {
    get(which, W, H) {
      let c = pool[which];
      if (!c || c.width !== W || c.height !== H) {
        c = makeCanvas(W, H);
        pool[which] = c;
      }
      return c;
    },
    tiny(w, h) {
      let c = pool.tiny;
      if (!c || c.width < w || c.height < h) {
        c = makeCanvas(Math.max(w, 64), Math.max(h, 64));
        pool.tiny = c;
      }
      return c;
    },
  };
}

const defaultScratch = createScratch();

/**
 * Draws one main-track item into ctx with its own effects plus optional transition modifiers.
 * Exported for thumbnails / single-clip previews.
 */
export function drawItem(ctx, item, t, source, W, H, mods = {}) {
  if (!source || !source.image) return false;
  const clip = item.clip;
  const alpha = (mods.alpha ?? 1) * fadeFactor(item, t);
  if (alpha <= 0.001) return true;
  ctx.save();
  if (mods.clip) {
    ctx.beginPath();
    mods.clip(ctx);
    ctx.clip();
  }
  ctx.globalAlpha = Math.min(1, alpha);
  // Transition transforms (about the frame centre)
  if (mods.dx || mods.dy) ctx.translate(mods.dx || 0, mods.dy || 0);
  if ((mods.scale && mods.scale !== 1) || mods.rotate) {
    ctx.translate(W / 2, H / 2);
    if (mods.rotate) ctx.rotate(mods.rotate);
    if (mods.scale && mods.scale !== 1) ctx.scale(mods.scale, mods.scale);
    ctx.translate(-W / 2, -H / 2);
  }
  ctx.save(); // Ken Burns applies to the picture only, not to the vignette
  if (clip.kenBurns) applyKenBurns(ctx, clip.kenBurns, item.duration > 0 ? (t - item.start) / item.duration : 0, W, H);
  ctx.filter = buildFilter(clip.filters, H, mods.blur || 0);
  const r = fitRect(source.width, source.height, W, H, clip.fit || 'cover');
  try {
    ctx.drawImage(source.image, r.x, r.y, r.w, r.h);
  } catch {
    // Source not decodable yet (e.g. video with readyState < 2): treat as not ready.
    ctx.restore();
    ctx.restore();
    return false;
  }
  ctx.restore();
  const vig = clip.filters?.vignette || 0;
  if (vig) drawVignette(ctx, W, H, vig);
  ctx.restore();
  return true;
}

/**
 * Renders the frame at time t. Returns {items, ready}: `ready` is false if any visible clip had no source yet
 * (preview uses this to keep showing the last good frame; export waits).
 */
export function drawFrame(ctx, { project, layout, t, getSource, scratch = defaultScratch }) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const bg = project.settings?.background || '#000000';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const items = videoItemsAt(layout.video, t);
  let ready = true;
  const src = (item) => {
    const s = getSource(item, sourceTimeAt(item, t));
    if (!s) ready = false;
    return s;
  };

  if (items.length === 1) {
    if (!drawItem(ctx, items[0], t, src(items[0]), W, H)) ready = false;
  } else if (items.length === 2) {
    const [a, b] = items;
    const p = transitionProgress(b, t);
    // An unknown transition type (project from a newer version) still blends instead of cutting.
    const renderer = b.transIn && (TRANSITION_RENDERERS[b.transIn.type] || TRANSITION_RENDERERS.crossfade);
    if (p == null || !renderer) {
      // Both clips active but no transition window (within EPS of a plain cut): the clip that owns this instant.
      const front = b.transIn && t < b.transIn.start + EPS ? a : b;
      if (!drawItem(ctx, front, t, src(front), W, H)) ready = false;
    } else {
      const sa = src(a);
      const sb = src(b);
      const r = {
        p,
        ep: easeInOut(p),
        W,
        H,
        ctx,
        drawA: (mods) => {
          if (!drawItem(ctx, a, t, sa, W, H, mods)) ready = false;
        },
        drawB: (mods) => {
          if (!drawItem(ctx, b, t, sb, W, H, mods)) ready = false;
        },
        fill: (color) => {
          ctx.save();
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, W, H);
          ctx.restore();
        },
        scratch: (which) => {
          const c = scratch.get(which, W, H);
          const cctx = c.getContext('2d');
          cctx.setTransform(1, 0, 0, 1, 0, 0);
          cctx.fillStyle = bg;
          cctx.fillRect(0, 0, W, H);
          const it = which === 'A' ? a : b;
          if (!drawItem(cctx, it, t, which === 'A' ? sa : sb, W, H)) ready = false;
          return c;
        },
        tiny: (w, h) => scratch.tiny(w, h),
      };
      renderer(r);
    }
  }

  for (const ti of textItemsAt(layout.text, t).sort((x, y) => (x.clip.lane || 0) - (y.clip.lane || 0))) {
    drawTextItem(ctx, ti, t, W, H);
  }
  ctx.restore();
  return { items, ready };
}
