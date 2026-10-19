// Transition renderers. Each receives a context object `r`:
//   r.p      linear progress 0..1          r.ep   eased progress (ease-in-out)
//   r.W, r.H output size                   r.ctx  the 2D context
//   r.drawA(opts) / r.drawB(opts)          draw the outgoing / incoming clip with extra options:
//        {alpha, dx, dy, scale, rotate, blur, clip(ctx) -> adds a path to clip to}
//   r.fill(color)                          fill the frame
//   r.scratch(which) -> canvas             the clip rendered alone into a scratch canvas (W x H)
// Catalogue (ids, names) lives in core/model.js TRANSITIONS.

import { easeInOutQuint } from './effects.js';

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const maxRadius = (W, H) => Math.hypot(W, H) / 2 + 2;

export const TRANSITION_RENDERERS = {
  crossfade(r) {
    r.drawA();
    r.drawB({ alpha: r.p });
  },
  'fade-black'(r) {
    r.fill('#000');
    if (r.p < 0.5) r.drawA({ alpha: 1 - r.p * 2 });
    else r.drawB({ alpha: (r.p - 0.5) * 2 });
  },
  'fade-white'(r) {
    r.fill('#fff');
    if (r.p < 0.5) r.drawA({ alpha: 1 - r.p * 2 });
    else r.drawB({ alpha: (r.p - 0.5) * 2 });
  },
  blur(r) {
    const amount = 24 * (r.H / 720);
    r.drawA({ blur: r.p * amount });
    r.drawB({ alpha: r.p, blur: (1 - r.p) * amount });
  },
  'wipe-left'(r) {
    r.drawA();
    r.drawB({ clip: (c) => c.rect(r.W * (1 - r.ep), 0, r.W * r.ep + 1, r.H) });
  },
  'wipe-right'(r) {
    r.drawA();
    r.drawB({ clip: (c) => c.rect(0, 0, r.W * r.ep, r.H) });
  },
  'wipe-up'(r) {
    r.drawA();
    r.drawB({ clip: (c) => c.rect(0, r.H * (1 - r.ep), r.W, r.H * r.ep + 1) });
  },
  'wipe-down'(r) {
    r.drawA();
    r.drawB({ clip: (c) => c.rect(0, 0, r.W, r.H * r.ep) });
  },
  'slide-left'(r) {
    r.drawA({ dx: -r.W * r.ep });
    r.drawB({ dx: r.W * (1 - r.ep) });
  },
  'slide-right'(r) {
    r.drawA({ dx: r.W * r.ep });
    r.drawB({ dx: -r.W * (1 - r.ep) });
  },
  'slide-up'(r) {
    r.drawA({ dy: -r.H * r.ep });
    r.drawB({ dy: r.H * (1 - r.ep) });
  },
  'slide-down'(r) {
    r.drawA({ dy: r.H * r.ep });
    r.drawB({ dy: -r.H * (1 - r.ep) });
  },
  'whip-left'(r) {
    const e = easeInOutQuint(r.p);
    const blur = Math.sin(Math.PI * r.p) * 18 * (r.H / 720);
    r.drawA({ dx: -r.W * e, blur });
    r.drawB({ dx: r.W * (1 - e), blur });
  },
  'whip-right'(r) {
    const e = easeInOutQuint(r.p);
    const blur = Math.sin(Math.PI * r.p) * 18 * (r.H / 720);
    r.drawA({ dx: r.W * e, blur });
    r.drawB({ dx: -r.W * (1 - e), blur });
  },
  'zoom-in'(r) {
    r.drawA({ scale: 1 + r.ep * 1.2, alpha: 1 - r.ep, blur: r.ep * 6 * (r.H / 720) });
    r.drawB({ scale: 0.6 + 0.4 * r.ep, alpha: r.ep });
  },
  'zoom-out'(r) {
    r.drawA({ scale: 1 - 0.4 * r.ep, alpha: 1 - r.ep });
    r.drawB({ scale: 2.2 - 1.2 * r.ep, alpha: r.ep, blur: (1 - r.ep) * 6 * (r.H / 720) });
  },
  spin(r) {
    if (r.p < 0.5) {
      const k = r.p * 2;
      r.drawA({ rotate: k * Math.PI, scale: 1 - 0.8 * k, alpha: 1 - k * 0.3 });
    } else {
      const k = (r.p - 0.5) * 2;
      r.drawB({ rotate: (k - 1) * Math.PI, scale: 0.2 + 0.8 * k, alpha: 0.7 + k * 0.3 });
    }
  },
  'circle-open'(r) {
    r.drawA();
    r.drawB({ clip: (c) => c.arc(r.W / 2, r.H / 2, Math.max(0.1, r.ep * maxRadius(r.W, r.H)), 0, Math.PI * 2) });
  },
  'circle-close'(r) {
    r.drawB();
    r.drawA({ clip: (c) => c.arc(r.W / 2, r.H / 2, Math.max(0.1, (1 - r.ep) * maxRadius(r.W, r.H)), 0, Math.PI * 2) });
  },
  clock(r) {
    r.drawA();
    if (r.p <= 0) return;
    const R = maxRadius(r.W, r.H) * 1.5;
    r.drawB({
      clip: (c) => {
        c.moveTo(r.W / 2, r.H / 2);
        c.arc(r.W / 2, r.H / 2, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * r.p);
        c.closePath();
      },
    });
  },
  pixelate(r) {
    const src = r.scratch(r.p < 0.5 ? 'A' : 'B');
    const block = 1 + Math.round(Math.sin(Math.PI * r.p) * 48 * (r.H / 720));
    if (block <= 1) {
      r.ctx.drawImage(src, 0, 0, r.W, r.H);
      return;
    }
    const sw = Math.max(1, Math.round(r.W / block));
    const sh = Math.max(1, Math.round(r.H / block));
    const tiny = r.tiny(sw, sh);
    const tctx = tiny.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.clearRect(0, 0, sw, sh);
    tctx.drawImage(src, 0, 0, sw, sh);
    r.ctx.save();
    r.ctx.imageSmoothingEnabled = false;
    r.ctx.drawImage(tiny, 0, 0, sw, sh, 0, 0, r.W, r.H);
    r.ctx.restore();
  },
  glitch(r) {
    const which = r.p < 0.5 ? 'A' : 'B';
    const src = r.scratch(which);
    const intensity = Math.sin(Math.PI * r.p);
    const step = Math.floor(r.p * 24);
    const slices = 14;
    const sliceH = r.H / slices;
    const ctx = r.ctx;
    for (let i = 0; i < slices; i++) {
      const off = (hash(step * 31 + i) - 0.5) * r.W * 0.25 * intensity;
      const y = i * sliceH;
      ctx.drawImage(src, 0, y, r.W, sliceH + 1, off, y, r.W, sliceH + 1);
    }
    // Colour fringe
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.25 * intensity;
    ctx.drawImage(src, 8 * intensity * (r.W / 1280), 0, r.W, r.H);
    ctx.restore();
    if (hash(step) > 0.8) {
      ctx.save();
      ctx.globalAlpha = 0.15 * intensity;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, r.W, r.H);
      ctx.restore();
    }
  },
};
