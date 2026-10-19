// Floating mini toolbar shown over detected media while the pointer hovers it on grok.com:
//   [+ Bin] [Pick] [Timeline] (+ [Ingredient] for images)
// Rendered inside the overlay's shadow root (outside Grok's React tree), anchored in the top-left corner of the
// media's visible part (clipped by scroll containers and the viewport), below sticky / fixed page layers and clear of
// the card's own controls, and kept there on scroll / resize.
// Finding the media under the pointer is cheap: the pointer event's own target (the browser already hit-tested it)
// leads to the media, also below Grok's card overlays (gradients, links, pointer-events:none images); a hit test runs
// only when the content scrolled under a resting pointer. The toolbar never blocks page clicks except on its own
// buttons, hides shortly after the pointer leaves, shows an "In bin" state from the studio's bin keys, and follows
// the element when its media changes in place (revalidate() after every DOM scan; the key is re-read on click).
import { svg } from './icons.js';

const HIDE_DELAY_MS = 280;
const SETTLE_MS = 140; // after scrolling stops: hit-test the resting pointer and place the toolbar precisely
const OWN_BAR = 'own-bar';
const OWN_UI = 'own-ui';
const MAX_WIDTH_SHARE = 0.75; // the toolbar never spans more than this share of the media width
const CARD_SEL = 'div[class*="media-post-masonry-card"], [role="listitem"], article';
const CONTROL_SEL = 'button, [role="button"], [role="checkbox"], [role="switch"], a[aria-label]';

const CSS = `
.hb {
  position: fixed; left: 0; top: 0; z-index: 2147483646;
  display: flex; align-items: center; gap: 2px; padding: 3px;
  border-radius: 11px; background: rgba(12, 12, 17, 0.84);
  -webkit-backdrop-filter: blur(12px) saturate(1.5); backdrop-filter: blur(12px) saturate(1.5);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  font: 600 12px/1 Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: #f3f3f7; letter-spacing: 0.01em; -webkit-font-smoothing: antialiased;
  opacity: 0; translate: 0 -4px; visibility: hidden; pointer-events: none;
  transition: opacity 0.14s ease, translate 0.14s ease, visibility 0s linear 0.14s;
}
.hb.show { opacity: 1; translate: 0 0; visibility: visible; transition: opacity 0.14s ease, translate 0.14s ease; }
.hb .mark {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 22px; height: 22px; margin: 0 3px 0 1px; border-radius: 7px; color: #fff;
  background: linear-gradient(150deg, #8f7dff, #4cc9f0);
}
.hb button {
  all: unset; box-sizing: border-box; pointer-events: auto;
  display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px 0 6px;
  border-radius: 8px; cursor: pointer; color: #e7e7ef; white-space: nowrap;
  transition: background 0.12s ease, color 0.12s ease;
}
.hb button:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
.hb button:active { background: rgba(255, 255, 255, 0.18); }
.hb button:focus-visible { outline: 2px solid #8f7dff; outline-offset: 1px; }
.hb button.primary { background: #8f7dff; color: #fff; }
.hb button.primary:hover { background: #7a66ff; }
.hb button.in-bin { background: rgba(61, 220, 151, 0.16); color: #3ddc97; }
.hb button.in-bin:hover { background: rgba(61, 220, 151, 0.26); }
.hb button.done { color: #3ddc97; }
.hb button.done.primary { background: #3ddc97; color: #06140d; }
.hb button svg { flex: none; }
.hb .sep { width: 1px; height: 16px; margin: 0 2px; background: rgba(255, 255, 255, 0.12); flex: none; }
.hb.medium button:not(.primary):not(.in-bin) { padding: 0 7px; }
.hb.medium button:not(.primary):not(.in-bin) .lbl { display: none; }
.hb.compact button { padding: 0 7px; }
.hb.compact .lbl, .hb.mini .lbl { display: none; }
.hb.mini { padding: 2px; border-radius: 9px; }
.hb.mini button { width: 26px; padding: 0; justify-content: center; }
`;

const LABELS = {
  bin: { icon: 'plus', label: 'Bin', title: 'Add to the Studio bin' },
  inBin: { icon: 'check', label: 'In bin', title: 'Already in your Studio bin. Click to open the Studio' },
  pick: { icon: 'flag', label: 'Pick', title: 'Add to the bin as a pick' },
  timeline: { icon: 'film', label: 'Timeline', title: 'Add to the end of the Studio timeline' },
  ingredient: { icon: 'image', label: 'Ingredient', title: 'Save as a reference image (Studio Ingredients)' },
};
const DONE_LABEL = { bin: 'Added', pick: 'Picked', timeline: 'Added', ingredient: 'Saved' };

const inside = (r, x, y) => !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export class HoverBar {
  /**
   * @param {{host: Element, shadow: ShadowRoot, registry: import('./registry.js').Registry,
   *          isInBin: (key: string) => boolean, onAction: (act: string, key: string, el: Element, info: object) => any,
   *          resolveKey?: (el: Element) => string|null}} opts
   *   resolveKey: the element's current key, right now (flushes a pending DOM scan): used when a button is clicked.
   */
  constructor({ host, shadow, registry, isInBin, onAction, resolveKey = null }) {
    this.host = host;
    this.shadow = shadow;
    this.registry = registry;
    this.isInBin = isInBin;
    this.onAction = onAction;
    this.resolveKey = resolveKey;
    this.target = null;
    this.key = null;
    this.visible = false;
    this.sig = null;
    this.x = -1;
    this.y = -1;
    this.moveTarget = null; // innermost element under the pointer, from the last pointer event
    this.evalRaf = 0;
    this.hideTimer = null;
    this.placeRaf = 0;
    this.settleTimer = null;
    this.doneUntil = 0;
    this.clippers = []; // ancestors of the target whose overflow clips it
    this.targetRect = null; // the target's visible rect at the last placement (null after a scroll)
    this._onMove = this._onMove.bind(this);
    this._onScroll = this._onScroll.bind(this);
    this._onLeave = this._onLeave.bind(this);
    this._onClick = this._onClick.bind(this);
  }

  mount() {
    const style = document.createElement('style');
    style.textContent = CSS;
    const bar = document.createElement('div');
    bar.className = 'hb';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Imagine Studio');
    bar.addEventListener('click', this._onClick);
    this.shadow.append(style, bar);
    this.bar = bar;
  }

  start() {
    if (!this.bar) this.mount();
    document.addEventListener('pointermove', this._onMove, { capture: true, passive: true });
    document.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
    window.addEventListener('resize', this._onScroll, { passive: true });
    document.documentElement.addEventListener('pointerleave', this._onLeave);
    window.addEventListener('blur', this._onLeave);
  }

  stop() {
    document.removeEventListener('pointermove', this._onMove, { capture: true });
    document.removeEventListener('scroll', this._onScroll, { capture: true });
    window.removeEventListener('resize', this._onScroll);
    document.documentElement.removeEventListener('pointerleave', this._onLeave);
    window.removeEventListener('blur', this._onLeave);
    cancelAnimationFrame(this.evalRaf);
    clearTimeout(this.hideTimer);
    clearTimeout(this.settleTimer);
    cancelAnimationFrame(this.placeRaf);
    this.hide();
  }

  /** Re-renders the current state (bin keys changed, the panel layout changed). */
  refresh() {
    this.sig = null;
    this.targetRect = null;
    if (this.visible) this._place(true);
  }

  /**
   * After a DOM scan: the element under the toolbar may show other media now (its src switched in place: variant
   * switcher, recycled card) or none at all.
   */
  revalidate() {
    if (!this.visible || !this.target) return;
    const key = this.target.isConnected ? this.registry.keyForElement(this.target) : null;
    if (!key) this.hide();
    else if (key !== this.key) this._show(this.target, key);
  }

  hide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.visible = false;
    this.target = null;
    this.key = null;
    this.targetRect = null;
    this.clippers = [];
    this.bar?.classList.remove('show');
  }

  // -------------------------------------------------------------------------------------------------------

  _onMove(e) {
    if (e.pointerType === 'touch') return;
    this.x = e.clientX;
    this.y = e.clientY;
    const target = (typeof e.composedPath === 'function' && e.composedPath()[0]) || e.target;
    // Still over the media the toolbar is shown for: nothing to do.
    if (this.visible && target === this.moveTarget && !this.hideTimer && inside(this.targetRect, this.x, this.y)) return;
    this.moveTarget = target instanceof Element ? target : null;
    if (!this.evalRaf) {
      this.evalRaf = requestAnimationFrame(() => {
        this.evalRaf = 0;
        this._evaluate(this.moveTarget);
      });
    }
  }

  _onScroll() {
    this.targetRect = null;
    this.moveTarget = null; // the content moved under the pointer: the next evaluation hit-tests
    if (this.visible && !this.placeRaf) {
      this.placeRaf = requestAnimationFrame(() => {
        this.placeRaf = 0;
        this._place(false); // cheap: follows the media, no hit tests while scrolling
      });
    }
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.x < 0) return;
      this._evaluate(null); // what is under the resting pointer now
      if (this.visible) this._place(true);
    }, SETTLE_MS);
  }

  _onLeave() {
    this.x = -1;
    this.y = -1;
    this.moveTarget = null;
    this._scheduleHide();
  }

  _scheduleHide() {
    if (!this.visible || this.hideTimer) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, HIDE_DELAY_MS);
  }

  _cancelHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  _evaluate(target) {
    if (this.x < 0) return undefined;
    let hit = null;
    try {
      hit = this._hitTest(this.x, this.y, target);
    } catch {
      hit = null;
    }
    if (hit === OWN_BAR) return this._cancelHide();
    if (!hit || hit === OWN_UI) return this._scheduleHide();
    this._cancelHide();
    if (hit.el !== this.target || hit.key !== this.key) this._show(hit.el, hit.key);
    return undefined;
  }

  /**
   * True when `el`, drawn above `media` at the pointer, belongs to the media's own card (an ancestor, or an overlay
   * inside a container not much bigger than the media: gradient, card link, caption, buttons). A page modal, its
   * backdrop or any other unrelated layer is not, and hides the media from the toolbar.
   */
  _related(el, media) {
    if (el === media || el.contains(media)) return true;
    const mr = media.getBoundingClientRect();
    const maxArea = Math.max(mr.width * mr.height * 2.5, 1);
    let anc = media.parentElement;
    for (let d = 0; anc && d < 6; d++, anc = anc.parentElement) {
      if (!anc.contains(el)) continue;
      const ar = anc.getBoundingClientRect();
      return ar.width * ar.height <= maxArea;
    }
    return false;
  }

  /** Topmost element at a point (inside our shadow root when it is our UI): one hit test. */
  _topAt(x, y) {
    const top = document.elementFromPoint(x, y);
    if (top === this.host) return this.shadow.elementFromPoint(x, y) || this.host;
    return top;
  }

  /**
   * Media under the pointer: {el, key}, OWN_BAR (our toolbar), OWN_UI (other overlay UI) or null. `target` is the
   * innermost element of the pointer event (null: hit-test the point).
   */
  _hitTest(x, y, target) {
    const top = target && target.isConnected ? target : this._topAt(x, y);
    if (!top) return null;
    if (top === this.host || top.getRootNode?.() === this.shadow) return this.bar.contains(top) ? OWN_BAR : OWN_UI;
    const key = this.registry.keyForElement(top);
    if (key) return { el: top, key };
    // Media below the card's overlays (links, gradients, captions): look inside the small containers around the target.
    const vpArea = window.innerWidth * window.innerHeight;
    for (let box = top, d = 0; box && d < 6; d++, box = box.parentElement) {
      if (box === document.body || box === document.documentElement) break;
      const r = box.getBoundingClientRect();
      if (r.width * r.height > vpArea * 0.6) break;
      for (const el of box.querySelectorAll('video, img')) {
        const k = this.registry.keyForElement(el);
        if (!k || !inside(el.getBoundingClientRect(), x, y)) continue;
        return this._related(top, el) ? { el, key: k } : null; // covered by something else
      }
    }
    return null;
  }

  _show(el, key) {
    this.target = el;
    this.key = key;
    this.sig = null;
    this.doneUntil = 0;
    this.clippers = this._clippersOf(el);
    this._place(true);
    if (this.target && !this.visible) {
      this.visible = true;
      this.bar.classList.add('show');
    }
  }

  /** Ancestors whose overflow clips the element (scroll containers, carousels, cards with rounded corners). */
  _clippersOf(el) {
    const out = [];
    for (let a = el.parentElement, d = 0; a && d < 24; a = a.parentElement, d++) {
      if (a === document.body || a === document.documentElement) break;
      const cs = getComputedStyle(a);
      const x = cs.overflowX !== 'visible';
      const y = cs.overflowY !== 'visible';
      if (x || y) out.push({ el: a, x, y });
      if (cs.position === 'fixed') break; // nothing above a fixed element clips it
    }
    return out;
  }

  /** The part of the element that is visible: its rect clipped by the clipping ancestors and the viewport. */
  _visibleRect(r) {
    let { left, top, right, bottom } = r;
    for (const { el, x, y } of this.clippers) {
      if (!el.isConnected) continue;
      const ar = el.getBoundingClientRect();
      const pl = ar.left + el.clientLeft;
      const pt = ar.top + el.clientTop;
      if (x) {
        left = Math.max(left, pl);
        right = Math.min(right, pl + el.clientWidth);
      }
      if (y) {
        top = Math.max(top, pt);
        bottom = Math.min(bottom, pt + el.clientHeight);
      }
    }
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, window.innerWidth);
    bottom = Math.min(bottom, window.innerHeight);
    return right - left > 0 && bottom - top > 0 ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  }

  /** Rects of the page's own controls (favorite, menu, select …) in the media's card that are visible. */
  _controls(el, vis, mediaArea) {
    const card = el.closest(CARD_SEL);
    if (!card) return [];
    const out = [];
    let n = 0;
    for (const c of card.querySelectorAll(CONTROL_SEL)) {
      if (++n > 40) break;
      if (c === el || c.contains(el)) continue; // the card link wrapping the media is not a control
      const r = c.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.width * r.height > mediaArea * 0.5) continue;
      if (!overlaps(r, vis)) continue;
      out.push(r);
    }
    return out;
  }

  /**
   * Horizontal room (px from the toolbar's left edge) before the first page control further right in the toolbar's
   * row, so the toolbar never covers Grok's own buttons. Infinity when there is none. (A control right at the
   * toolbar's corner does not shrink it: _anchor() moves the toolbar below it.)
   */
  _controlsLimit(controls, left, top) {
    let limit = Infinity;
    for (const r of controls) {
      if (r.bottom < top || r.top > top + 34 || r.left < left + 24) continue; // not ahead of the toolbar in its row
      limit = Math.min(limit, r.left - left - 6);
    }
    return limit;
  }

  _render(vis, pad, controls) {
    const pm = this.registry.get(this.key);
    if (!pm) return false;
    if (Date.now() < this.doneUntil) return true; // keep the "Added" feedback visible
    const inBin = !!this.isInBin(this.key);
    // Largest layout that fits: at most MAX_WIDTH_SHARE of the visible media, and left of the card's own controls.
    let room = Math.max(40, vis.width - (vis.width < 150 ? 8 : 16));
    if (vis.width >= 150) room = Math.min(room, Math.max(120, vis.width * MAX_WIDTH_SHARE));
    room = Math.max(32, Math.min(room, this._controlsLimit(controls, vis.left + pad, vis.top + pad)));
    const sig = `${Math.round(room / 8)}|${pm.kind}|${inBin}`;
    if (sig === this.sig) return true;
    this.sig = sig;
    const btn = (act, spec, cls = '') =>
      `<button type="button" data-act="${act}" class="${cls}" title="${spec.title}" aria-label="${spec.title}">${svg(spec.icon)}<span class="lbl">${spec.label}</span></button>`;
    // Largest variant that fits inside the media: brand mark + labels, labels, primary label + icons, icons only,
    // or just the bin button.
    for (const mode of ['full', 'labels', 'medium', 'compact', 'mini']) {
      let html = mode === 'full' ? `<span class="mark" title="Imagine Studio">${svg('clapper', 13)}</span>` : '';
      html += inBin ? btn('bin', LABELS.inBin, 'in-bin') : btn('bin', LABELS.bin, 'primary');
      if (mode !== 'mini') {
        html += btn('pick', LABELS.pick) + btn('timeline', LABELS.timeline);
        if (pm.kind === 'image') html += btn('ingredient', LABELS.ingredient);
      }
      this.bar.className = `hb ${mode}${this.visible ? ' show' : ''}`;
      this.bar.innerHTML = html;
      if (mode === 'mini' || this.bar.offsetWidth <= room) break;
    }
    return true;
  }

  /**
   * The outermost page layer at a point that has nothing to do with the media (a sticky top bar …), or null. One
   * hit test (they are expensive on big feeds); the toolbar's own background lets pointer events through, so only
   * its buttons can be in the way, then the stack is consulted.
   */
  _coverAt(el, x, y) {
    let hit = null;
    try {
      hit = document.elementFromPoint(x, y);
      if (hit === this.host) hit = document.elementsFromPoint(x, y).find((e) => e !== this.host) || null;
    } catch {
      hit = null;
    }
    if (!hit || hit === el || this._related(hit, el)) return null;
    let layer = hit;
    while (layer.parentElement && !layer.parentElement.contains(el)) layer = layer.parentElement;
    return layer;
  }

  /**
   * Where the toolbar (bw x bh) goes inside the visible rect: the top-left corner, else below the controls that sit
   * there, else the bottom-left corner — never over the card's controls. probe: also move below page layers that
   * cover the spot (hit tests: only when the toolbar appears or the scrolling stopped). Returns {left, top} or null.
   */
  _anchor(el, vis, pad, bw, bh, controls, probe) {
    const left = vis.left + pad;
    const box = (top) => ({ left, top, right: left + bw, bottom: top + bh });
    const fits = (top) => top >= vis.top - 0.5 && top + bh <= vis.bottom + 0.5 && left + bw <= vis.right + 0.5;
    const clear = (top) => !controls.some((c) => overlaps(box(top), c));
    const covered = (top) => this._coverAt(el, left + Math.min(12, bw / 2), top + Math.min(8, bh / 2));
    const tops = [vis.top + pad];
    const blocking = controls.filter((c) => overlaps(box(tops[0]), c));
    if (blocking.length) tops.push(Math.max(...blocking.map((c) => c.bottom)) + 4);
    tops.push(vis.bottom - pad - bh);
    for (let top of tops) {
      if (!fits(top) || !clear(top)) continue;
      if (probe) {
        let layer = covered(top);
        for (let i = 0; layer && i < 3; i++) {
          top = layer.getBoundingClientRect().bottom + 4; // below the layer, then look again
          layer = fits(top) && clear(top) ? covered(top) : null;
        }
        if (layer || !fits(top) || !clear(top)) continue;
      }
      return { left, top };
    }
    return null;
  }

  /** Positions the toolbar over the target; full: also re-check page layers covering the spot. */
  _place(full = true) {
    const el = this.target;
    if (!el || !el.isConnected) return this.hide();
    const r = el.getBoundingClientRect();
    const vis = this._visibleRect(r);
    if (!vis || vis.width < 24 || vis.height < 24 || r.width < 24 || r.height < 24) return this.hide();
    const pad = vis.width < 150 ? 4 : 8;
    const controls = this._controls(el, vis, r.width * r.height);
    if (!this._render(vis, pad, controls)) return this.hide();
    const bw = this.bar.offsetWidth || 120;
    const bh = this.bar.offsetHeight || 32;
    let spot = null;
    if (!full && this.offset) {
      // While scrolling: keep the offset found by the last full placement (no hit tests), within the visible part.
      const top = Math.min(Math.max(vis.top + this.offset.dy, vis.top), vis.bottom - bh);
      spot = top >= vis.top - 0.5 ? { left: vis.left + pad, top } : null;
    } else {
      spot = this._anchor(el, vis, pad, bw, bh, controls, full);
    }
    if (!spot) return this.hide();
    this.offset = { dy: spot.top - vis.top };
    this.targetRect = vis;
    const left = Math.min(Math.max(4, spot.left), window.innerWidth - bw - 4);
    const top = Math.min(Math.max(4, spot.top), window.innerHeight - bh - 4);
    this.bar.style.left = `${Math.round(left)}px`;
    this.bar.style.top = `${Math.round(top)}px`;
    return undefined;
  }

  _onClick(e) {
    const btn = e.target instanceof Element ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const act = btn.dataset.act;
    const el = this.target;
    let key = this.key;
    if (!key) return;
    // The element may show other media than when the toolbar appeared (src switched in place): act on what it
    // shows now. A detached element (re-rendered by the page) keeps the media the user saw.
    if (this.resolveKey && el?.isConnected) {
      let now = null;
      try {
        now = this.resolveKey(el);
      } catch {
        now = null;
      }
      if (!now) return this.hide();
      if (now !== key) {
        key = now;
        if (this.target === el) this._show(el, key);
      }
    }
    const wasInBin = !!this.isInBin(key);
    const live = this.bar.querySelector(`button[data-act="${act}"]`) || btn;
    if (!wasInBin) this._flashDone(live, act); // immediate feedback; reverted below if the action fails
    const revert = () => {
      this.doneUntil = 0;
      this.sig = null;
      if (this.visible) this._place(true);
    };
    Promise.resolve()
      .then(() => this.onAction(act, key, el, { inBin: wasInBin }))
      .then((res) => res === false && revert())
      .catch((err) => {
        console.warn('[gis] hover action failed', err);
        revert();
      });
    return undefined;
  }

  _flashDone(btn, act) {
    if (!btn.isConnected) return;
    btn.classList.add('done');
    btn.innerHTML = `${svg('check')}<span class="lbl">${DONE_LABEL[act] || 'Done'}</span>`;
    this.doneUntil = Date.now() + 1300;
    setTimeout(() => {
      this.doneUntil = 0;
      this.sig = null;
      if (this.visible) this._place(true);
    }, 1350);
  }
}
