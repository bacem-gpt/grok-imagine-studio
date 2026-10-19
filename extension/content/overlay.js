// On-page studio container: launcher tab, panel (docked right / bottom, full window, or a floating window) hosting
// the studio iframe,
// resize handle, page toasts, the "reveal" flash, and the MessageChannel handshake with the studio
// (see shared/protocol.js; it carries a token from the service worker, so the studio frame can tell it from a port
// handed over by a grok.com page script). Everything lives in an (open, for testability) shadow root attached to <html>,
// outside Grok's React tree. Other on-page UI (hover toolbar) mounts into the same shadow root.
//
// Docked right or bottom, the panel makes room instead of covering grok.com: a page stylesheet narrows (or
// shortens) <body> to the area beside the panel and makes it the containing block of the page's fixed elements, so
// Grok's composer and its Generate button re-centre in the visible area (pagePushCss()). Our own UI stays
// viewport-relative because its host is a child of <html>, not of <body>. A floating window opens clear of Grok's
// composer unless the user placed it.

import { HANDSHAKE, PROTOCOL_VERSION } from '../shared/protocol.js';
import { svg } from './icons.js';

const HANDSHAKE_RETRY_MS = 1000;
const HANDSHAKE_MAX_TRIES = 30;
const TOKEN_TIMEOUT_MS = 3000;
const MAX_TOASTS = 3;
const MIN_RIGHT = 480; // px: the studio header (layout menu, Export, Close) needs 480 px
const MIN_BOTTOM = 240;
const MIN_FLOAT_W = 480; // the studio header needs 480 px
const MIN_FLOAT_H = 300;
const FLOAT_MIN_VIEWPORT = 560; // narrower windows show the floating window docked right (full width) instead
const MIN_PAGE_W = 160; // a narrower strip of page beside a right dock is useless: the dock takes the whole width
const MIN_PAGE_H = 120;
const FLOAT_MARGIN = 24;

const DOCK_KEY = 'gis:dock';
const STUDIO_URL = chrome.runtime.getURL('studio/studio.html?mode=embedded');

const CSS = `
:host { all: initial; }
.launcher {
  position: fixed; right: 0; top: 42%; z-index: 2147483646;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 10px 7px 10px 8px; border: 1px solid rgba(255,255,255,.12); border-right: 0;
  border-radius: 12px 0 0 12px; background: linear-gradient(160deg, #8f7dff, #4cc9f0);
  color: #fff; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.35);
  font: 600 11px/1 Inter, system-ui, sans-serif; letter-spacing: .04em;
  transition: transform .15s ease, padding .15s ease, opacity .15s;
}
.launcher:hover { padding-right: 11px; }
.launcher:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
.launcher[hidden] { display: none; }
.launcher svg { width: 18px; height: 18px; }
.launcher .label { writing-mode: vertical-rl; transform: rotate(180deg); }
.badge {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #0b0b10; color: #fff;
  font: 700 10px/18px Inter, system-ui, sans-serif; text-align: center; box-sizing: border-box;
}
.badge[hidden] { display: none; }
.panel {
  position: fixed; z-index: 2147483647; background: #0a0a0d; box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 10px 40px rgba(0,0,0,.55);
  display: flex; flex-direction: column; overflow: hidden;
}
.panel[hidden] { display: none; }
.panel.right { top: 0; right: 0; bottom: 0; width: var(--w, 50vw); }
.panel.bottom { left: 0; right: 0; bottom: 0; height: var(--h, 55vh); }
.panel.max { inset: 0; }
.panel.float {
  left: var(--fx, 24px); top: var(--fy, 24px); width: var(--fw, 760px); height: var(--fh, 520px); border-radius: 12px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 24px 70px rgba(0,0,0,.62);
}
.float-bar {
  display: none; flex: none; height: 14px; align-items: center; justify-content: center; cursor: grab;
  background: #111116; border-bottom: 1px solid #262632; touch-action: none;
}
.float-bar::before { content: ''; width: 38px; height: 4px; border-radius: 4px; background: rgba(255,255,255,.22); }
.float-bar:hover::before, .float-bar.active::before { background: rgba(143,125,255,.8); }
.float-bar.active { cursor: grabbing; }
.panel.float .float-bar { display: flex; }
iframe { flex: 1; width: 100%; height: 100%; border: 0; background: #0a0a0d; color-scheme: dark; }
.resizer { position: absolute; z-index: 2; background: transparent; }
.panel.right .resizer { left: -3px; top: 0; bottom: 0; width: 7px; cursor: ew-resize; }
.panel.bottom .resizer { top: -3px; left: 0; right: 0; height: 7px; cursor: ns-resize; }
.panel.max .resizer { display: none; }
.panel.float .resizer {
  right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; border-radius: 0 0 12px 0;
  background: linear-gradient(135deg, transparent 55%, rgba(255,255,255,.28) 55%, rgba(255,255,255,.28) 62%, transparent 62%, transparent 72%, rgba(255,255,255,.28) 72%, rgba(255,255,255,.28) 79%, transparent 79%);
}
.resizer:hover, .resizer.active { background: rgba(143,125,255,.45); }
.panel.float .resizer:hover, .panel.float .resizer.active { background-color: rgba(143,125,255,.45); }
.shield { position: fixed; inset: 0; z-index: 2147483647; cursor: inherit; }
.shield[hidden] { display: none; }

.toasts {
  position: fixed; z-index: 2147483647; top: 64px; right: calc(var(--page-right, 0px) + 16px);
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px; pointer-events: none;
  width: min(400px, calc(100vw - var(--page-right, 0px) - 32px));
  font: 500 13px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
/* The panel covers the page: toasts sit bottom-centre like the studio's own, away from its header controls. */
.toasts.covered {
  top: auto; bottom: 16px; right: auto; left: 50%; transform: translateX(-50%);
  align-items: center; width: min(420px, calc(100vw - 24px));
}
.toasts.covered .toast.leaving { transform: translateY(6px); }
.toast {
  pointer-events: auto; display: flex; align-items: center; gap: 9px; max-width: 100%; box-sizing: border-box;
  padding: 8px 8px 8px 12px; border-radius: 9px; background: #23232e; color: #f3f3f7;
  border: 1px solid #353544; box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.35);
  animation: gis-pop .16s cubic-bezier(.2,.7,.2,1);
}
.toast.leaving { opacity: 0; transform: translateY(-6px); transition: opacity .18s, transform .18s; }
.toast .ic { display: inline-flex; flex: none; color: #4cc9f0; }
.toast.success .ic { color: #3ddc97; }
.toast.error { border-color: rgba(255,93,108,.45); }
.toast.error .ic { color: #ff5d6c; }
.toast.warn .ic { color: #ffb547; }
.toast .msg { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.toast .count {
  flex: none; padding: 1px 6px; border-radius: 999px; background: rgba(255,255,255,.1); color: #b9b9c6;
  font: 600 11px/16px Inter, ui-sans-serif, system-ui, sans-serif;
}
.toast .count:empty { display: none; }
.toast button {
  all: unset; box-sizing: border-box; cursor: pointer; flex: none; border-radius: 6px;
  font: 600 12px/1 Inter, ui-sans-serif, system-ui, sans-serif;
}
.toast .act { padding: 6px 10px; background: rgba(143,125,255,.18); color: #ddd7ff; }
.toast .act:hover { background: rgba(143,125,255,.3); }
.toast .act.secondary { background: rgba(255,255,255,.07); color: #d6d6e0; }
.toast .act.secondary:hover { background: rgba(255,255,255,.14); }
/* Several actions: message on the first row, buttons right-aligned below it. */
.toast.stacked { flex-wrap: wrap; row-gap: 8px; padding-bottom: 9px; }
.toast.stacked .acts { order: 9; flex: 1 0 100%; display: flex; justify-content: flex-end; gap: 6px; }
.toast .close { display: inline-flex; padding: 4px; color: #7f7f8f; }
.toast .close:hover { color: #f3f3f7; background: rgba(255,255,255,.08); }
.toast button:focus-visible { outline: 2px solid #8f7dff; outline-offset: 1px; }
@keyframes gis-pop { from { opacity: 0; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: none; } }

.flash {
  position: fixed; z-index: 2147483645; pointer-events: none; box-sizing: border-box; border-radius: 12px;
  border: 2px solid #8f7dff; box-shadow: 0 0 0 4px rgba(143,125,255,.28), 0 0 36px 6px rgba(143,125,255,.45);
  animation: gis-flash 1.7s ease-out forwards;
}
@keyframes gis-flash { 0% { opacity: 0; } 12% { opacity: 1; } 65% { opacity: 1; } 100% { opacity: 0; } }
`;

const ICON = svg('clapper', 18);
const TOAST_ICON = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };

// App-shell containers right below <body> (capped while the page makes room for the panel).
const SHELL_SEL = 'html > body > *, html > body > * > *, html > body > * > * > *';

/**
 * Page CSS that makes room for a panel docked on `side` ('right' | 'bottom') with `size` px, in a `width` x `height`
 * viewport ('' for anything else). <body> becomes the page area; capping the first three levels below it catches
 * app shells sized in viewport units (h-svh, 100vh, w-screen). appShell: the document itself does not scroll (Grok's
 * layout): then <body> also becomes the containing block of the page's fixed elements (a document that scrolls
 * would drag them along) and may be shortened; a scrolling document docked bottom only gets room to scroll its end
 * above the panel.
 */
export function pagePushCss(side, size, { width, height, appShell = true } = {}) {
  const contain = appShell ? ' transform: translate(0, 0);' : '';
  if (side === 'right') {
    const w = Math.max(0, Math.round(width - size));
    return (
      `html > body { width: ${w}px !important; min-width: 0 !important; max-width: ${w}px !important;${contain} }\n` +
      `${SHELL_SEL} { max-width: ${w}px !important; }`
    );
  }
  if (side === 'bottom') {
    if (!appShell) return `html > body { padding-bottom: ${Math.round(size)}px !important; }`;
    const h = Math.max(0, Math.round(height - size));
    return (
      `html > body { height: ${h}px !important; min-height: 0 !important; max-height: ${h}px !important;${contain} }\n` +
      `${SHELL_SEL} { max-height: ${h}px !important; }`
    );
  }
  return '';
}

const overlaps = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Position for a fw x fh floating window in a vw x vh viewport that keeps clear of `avoid` ({box, key}: Grok's
 * composer and its submit button, viewport rects). Tries the current spot, then the corners; prefers clearing the
 * whole composer, else at least the button. Returns {x, y}, or null when no spot helps (or nothing to avoid).
 */
export function floatSpot({ x, y, fw, fh, vw, vh, avoid, margin = FLOAT_MARGIN }) {
  if (!avoid || (!avoid.box && !avoid.key)) return null;
  const right = Math.max(8, vw - fw - margin);
  const bottom = Math.max(8, vh - fh - margin);
  const spots = [
    [x, y],
    [right, bottom],
    [right, margin],
    [margin, margin],
    [margin, bottom],
  ];
  const rect = ([sx, sy]) => ({ left: sx, top: sy, right: sx + fw, bottom: sy + fh });
  for (const target of [avoid.box, avoid.key]) {
    if (!target) continue;
    const hit = spots.find((s) => !overlaps(rect(s), target));
    if (hit) return { x: hit[0], y: hit[1] };
  }
  return null;
}

/** True when the document itself scrolls (most SPAs, Grok included, scroll inner containers instead). */
function documentScrolls() {
  try {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight <= se.clientHeight + 2) return false;
    const hidden = (el) => !!el && /hidden|clip/.test(getComputedStyle(el).overflowY);
    return !hidden(document.documentElement) && !hidden(document.body);
  } catch {
    return false;
  }
}

/** Width of the vertical scrollbar at the right edge of the viewport, at height y (document or inner scroller). */
function rightScrollbarAt(y, host) {
  const docBar = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  const x = window.innerWidth - docBar - 2;
  let el = null;
  try {
    el = document.elementsFromPoint(x, y).find((e) => e !== host && !host?.contains(e)) || null;
  } catch {
    el = null;
  }
  for (let d = 0; el && d < 10; d++, el = el.parentElement) {
    if (el === document.documentElement || el === document.body) break;
    const bar = el.offsetWidth - el.clientWidth;
    if (bar < 3 || el.scrollHeight <= el.clientHeight) continue;
    const r = el.getBoundingClientRect();
    if (r.right < window.innerWidth - docBar - 1) break; // the scroller does not reach the edge
    const cs = getComputedStyle(el);
    return docBar + Math.max(0, bar - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0));
  }
  return docBar;
}

export class Overlay {
  /**
   * @param {{onPort?: Function, onVisibility?: Function, onLayout?: Function, onFrame?: Function,
   *          getAvoid?: () => ({box: DOMRect|null, key: DOMRect|null}|null)}} opts
   *   getAvoid: what a floating window should keep clear of (Grok's composer and its submit button).
   */
  constructor({ onPort, onVisibility, onLayout, onFrame, getAvoid } = {}) {
    this.onPort = onPort;
    this.onVisibility = onVisibility;
    this.onLayout = onLayout;
    this.onFrame = onFrame; // (present: boolean) the studio iframe was created / removed
    this.getAvoid = getAvoid;
    const fw = Math.min(760, window.innerWidth - 48);
    const fh = Math.min(520, window.innerHeight - 48);
    this.state = {
      mode: 'right',
      w: Math.round(Math.min(Math.max(window.innerWidth * 0.5, MIN_RIGHT), 1100)),
      h: Math.round(window.innerHeight * 0.55),
      fw,
      fh,
      fx: Math.max(8, window.innerWidth - fw - FLOAT_MARGIN),
      fy: Math.max(8, window.innerHeight - fh - FLOAT_MARGIN),
      floatUser: false, // the user moved the floating window: keep it where they put it
      open: false,
    };
    this.iframe = null;
    this.port = null;
    this.connected = false;
    this._cleanups = [];
    this.push = null; // {side, size, appShell} while the page makes room for the panel
    this.pushCss = '';
  }

  async mount() {
    try {
      const saved = (await chrome.storage.local.get(DOCK_KEY))?.[DOCK_KEY];
      if (saved && typeof saved === 'object') {
        const next = { ...this.state };
        if (['right', 'bottom', 'max', 'float'].includes(saved.mode)) next.mode = saved.mode;
        for (const k of ['w', 'h', 'fw', 'fh', 'fx', 'fy']) if (Number.isFinite(saved[k])) next[k] = saved[k];
        next.w = Math.max(MIN_RIGHT, next.w); // saved by a version that allowed narrower docks
        next.floatUser = saved.fu === true;
        this.state = { ...next, open: false };
      }
    } catch {
      /* ignore */
    }
    // A previous instance of the content script (extension reloaded) may have left its host behind.
    document.querySelectorAll('gis-studio-root').forEach((el) => el.remove());
    this.host = document.createElement('gis-studio-root');
    this.host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const shadow = this.host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>
      <button class="launcher" title="Imagine Studio (Alt+Shift+S)" aria-label="Open Imagine Studio">${ICON}<span class="label">STUDIO</span><span class="badge" hidden></span></button>
      <div class="panel" hidden><div class="float-bar" title="Drag to move"></div><div class="resizer"></div></div>
      <div class="shield" hidden></div>
      <div class="toasts" role="status" aria-live="polite"></div>`;
    this.shadow = shadow;
    this.launcher = shadow.querySelector('.launcher');
    this.badgeEl = shadow.querySelector('.badge');
    this.panel = shadow.querySelector('.panel');
    this.resizer = shadow.querySelector('.resizer');
    this.floatBar = shadow.querySelector('.float-bar');
    this.shield = shadow.querySelector('.shield');
    this.toastsEl = shadow.querySelector('.toasts');
    this.launcher.addEventListener('click', () => this.toggle(true));
    this._wireResize();
    this._wireFloatDrag();
    document.documentElement.appendChild(this.host);
    // Grok's SPA may replace <body> content but not <html>; still guard against removal.
    this._mo = new MutationObserver(() => {
      if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    });
    this._mo.observe(document.documentElement, { childList: true });
    this._applyLayout();
    requestAnimationFrame(() => this.placeLauncher());
  }

  /** Removes everything (extension context invalidated). */
  destroy() {
    this._mo?.disconnect();
    clearTimeout(this._retryTimer);
    for (const off of this._cleanups) off();
    try {
      this.port?.close?.();
    } catch {
      /* ignore */
    }
    this.host?.remove();
    this._setPushCss('');
    try {
      if (this.pushSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== this.pushSheet);
      this.pushStyleEl?.remove();
    } catch {
      /* ignore */
    }
  }

  /**
   * Keeps the launcher tab clear of the page's scrollbar at the right edge (the document's, or the inner scroller
   * under the tab): grabbing the scrollbar must not open the studio. Cheap enough for the periodic health check.
   */
  placeLauncher() {
    if (!this.launcher || this.launcher.hidden || !this.launcher.isConnected) return;
    const r = this.launcher.getBoundingClientRect();
    const bar = rightScrollbarAt(r.top + r.height / 2, this.host);
    if (bar !== this.launcherOffset) {
      this.launcherOffset = bar;
      this.launcher.style.right = bar ? `${bar}px` : '';
    }
  }

  /**
   * Re-measures what the layout depends on in the page (after an SPA navigation): whether the document scrolls,
   * the launcher's scrollbar offset.
   */
  refreshLayout() {
    if (this.push) this.push = null; // re-evaluated by _applyLayout
    this._applyLayout();
    this.placeLauncher();
  }

  /** Re-adopts the page stylesheet if the page replaced document.adoptedStyleSheets. */
  ensurePageStyle() {
    try {
      if (this.pushSheet && this.pushCss && !document.adoptedStyleSheets.includes(this.pushSheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.pushSheet];
      else if (this.pushStyleEl && this.pushCss && !this.pushStyleEl.isConnected) document.documentElement.appendChild(this.pushStyleEl);
    } catch {
      /* ignore */
    }
  }

  _setPushCss(css) {
    if (css === this.pushCss) return;
    this.pushCss = css;
    if (!this.pushStyleEl) {
      try {
        this.pushSheet ||= new CSSStyleSheet();
        this.pushSheet.replaceSync(css);
        this.ensurePageStyle();
        return;
      } catch {
        this.pushSheet = null; // constructable stylesheets unavailable: a <style> element in <html> instead
      }
      this.pushStyleEl = document.createElement('style');
      this.pushStyleEl.id = 'gis-push-style';
    }
    this.pushStyleEl.textContent = css;
    this.ensurePageStyle();
  }

  /** Makes room in the page for the panel ({side, size}), or gives the page back (null). */
  _applyPush(want) {
    if (!want) {
      this.push = null;
      this._setPushCss('');
      return;
    }
    // Whether the document scrolls is measured when the push starts, with the page at full size.
    if (!this.push || this.push.side !== want.side) {
      this._setPushCss('');
      this.push = { side: want.side, appShell: !documentScrolls() };
    }
    this.push.size = want.size;
    const root = document.documentElement;
    this._setPushCss(pagePushCss(want.side, want.size, { width: root.clientWidth || window.innerWidth, height: window.innerHeight, appShell: this.push.appShell }));
  }

  /** Floating window: move it clear of Grok's composer, unless the user placed it. */
  _placeFloat() {
    const st = this.state;
    if (st.floatUser || this.effectiveMode !== 'float') return;
    let avoid = null;
    try {
      avoid = this.getAvoid?.() || null;
    } catch {
      avoid = null;
    }
    const spot = floatSpot({ x: st.fx, y: st.fy, fw: st.fw, fh: st.fh, vw: window.innerWidth, vh: window.innerHeight, avoid });
    if (!spot || (spot.x === st.fx && spot.y === st.fy)) return;
    st.fx = spot.x;
    st.fy = spot.y;
    this._applyLayout();
  }

  get framePresent() {
    return !!this.iframe;
  }

  /** Creates the studio iframe (once). Called on first open, on a hover action, or early when auto-collect is on. */
  ensureFrame() {
    if (this.iframe) return false;
    const iframe = document.createElement('iframe');
    iframe.src = STUDIO_URL;
    iframe.allow = 'clipboard-read; clipboard-write; autoplay; fullscreen';
    iframe.title = 'Imagine Studio';
    iframe.addEventListener('load', () => {
      this.tokenPromise = this._frameToken(); // one token per studio document, reused by the retries
      this._handshake();
    });
    this.panel.appendChild(iframe);
    this.iframe = iframe;
    this.frameCreatedAt = Date.now();
    this.onFrame?.(true);
    return true;
  }

  /** Removes the studio iframe (it never answered the handshake); the next ensureFrame() starts a fresh one. */
  destroyFrame() {
    if (!this.iframe) return;
    clearTimeout(this._retryTimer);
    try {
      this.port?.close?.();
    } catch {
      /* ignore */
    }
    this.port = null;
    this.connected = false;
    this.tokenPromise = null;
    this.handshakeGen = (this.handshakeGen || 0) + 1; // a handshake waiting for its token must not go on
    this.iframe.remove();
    this.iframe = null;
    if (this.state.open) {
      this.state.open = false;
      this._applyLayout();
      this._emitVisibility();
    }
    this.onFrame?.(false);
  }

  /**
   * A handshake token from the service worker (see HANDSHAKE in shared/protocol.js): it tells the studio frame that
   * the port comes from this content script, not from a grok.com page script. null when none can be had (the studio
   * accepts token-less handshakes only while tokens are not required).
   */
  async _frameToken() {
    try {
      const res = await Promise.race([chrome.runtime.sendMessage({ gis: 'studio-token' }), new Promise((r) => setTimeout(() => r(null), TOKEN_TIMEOUT_MS))]);
      return res?.ok && typeof res.token === 'string' ? res.token : null;
    } catch {
      return null; // extension context gone, or an older service worker without tokens
    }
  }

  /** Sends a fresh MessageChannel port to the studio; retries until the studio acknowledges (see acked()). */
  async _handshake(attempt = 0) {
    clearTimeout(this._retryTimer);
    const gen = (this.handshakeGen = (this.handshakeGen || 0) + 1);
    const token = await (this.tokenPromise || null);
    // Superseded by a newer handshake, the frame is gone, or the studio answered while the token was on its way.
    if (gen !== this.handshakeGen || !this.iframe || (attempt > 0 && this.connected)) return;
    this.connected = false;
    const channel = new MessageChannel();
    this.port?.close?.();
    this.port = channel.port1;
    this.onPort?.(this.port);
    try {
      this.iframe.contentWindow.postMessage({ type: HANDSHAKE, version: PROTOCOL_VERSION, ...(token ? { token } : {}) }, new URL(STUDIO_URL).origin, [channel.port2]);
    } catch {
      /* frame navigating */
    }
    if (attempt < HANDSHAKE_MAX_TRIES) this._retryTimer = setTimeout(() => !this.connected && this._handshake(attempt + 1), HANDSHAKE_RETRY_MS);
  }

  /** Called when the studio acknowledged the handshake over the port. */
  acked() {
    clearTimeout(this._retryTimer);
    this.connected = true;
    this._emitVisibility();
  }

  get isOpen() {
    return this.state.open;
  }

  toggle(force) {
    const open = force === undefined ? !this.state.open : !!force;
    const wasOpen = this.state.open;
    if (open) this.ensureFrame();
    this.state.open = open;
    if (open) this.dismissOpenToasts();
    this._applyLayout();
    if (open && !wasOpen) this._placeFloat();
    if (!open) requestAnimationFrame(() => this.placeLauncher());
    this._emitVisibility();
    if (open) setTimeout(() => this.iframe?.focus(), 50);
    return open;
  }

  /**
   * Dock mode + size (px; clamped to what fits: right >= 480, bottom >= 240, float >= 480 wide, each at most the
   * viewport). Opens the panel. Returns {mode, size} with the size actually used (+ effectiveMode when a narrow
   * window shows the floating window docked right).
   */
  setDock(mode, size) {
    if (!['right', 'bottom', 'max', 'float'].includes(mode)) mode = 'right';
    const st = this.state;
    const wasFloating = st.open && this.effectiveMode === 'float';
    st.mode = mode;
    const n = Number(size);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
    if (Number.isFinite(n) && n > 0) {
      if (mode === 'right') st.w = clamp(n, Math.min(MIN_RIGHT, vw), vw);
      else if (mode === 'bottom') st.h = clamp(n, Math.min(MIN_BOTTOM, vh), vh);
      else if (mode === 'float') st.fw = clamp(n, Math.min(MIN_FLOAT_W, vw - 16), Math.max(vw - 16, 1));
    }
    st.open = true;
    this.ensureFrame();
    this.dismissOpenToasts();
    this._applyLayout();
    if (!wasFloating) this._placeFloat(); // measured with the page back at full size
    this._persist();
    this._emitVisibility();
    return this._dockInfo();
  }

  /** Size in px of the current mode as rendered (panel width when docked right, height when docked bottom). */
  _size() {
    const { mode, w, h, fw } = this.state;
    if (mode === 'float' && this.effectiveMode === 'float') return fw;
    if (mode === 'bottom') return this.rendered?.h ?? h;
    if (mode === 'right' || mode === 'float') return this.rendered?.w ?? w;
    return w;
  }

  _dockInfo() {
    const info = { mode: this.state.mode, size: this._size() };
    if (this.effectiveMode && this.effectiveMode !== this.state.mode) info.effectiveMode = this.effectiveMode;
    return info;
  }

  getDock() {
    return { ...this._dockInfo(), open: this.state.open };
  }

  /** Dismisses toasts whose action opens the studio (it is open now). */
  dismissOpenToasts() {
    for (const t of this.toastsEl?.querySelectorAll('.toast[data-dismiss-on-open]') || []) t._dismiss?.();
  }

  setBadge(n, title = '') {
    if (!this.badgeEl) return;
    this.badgeEl.hidden = !n;
    this.badgeEl.textContent = n > 99 ? '99+' : String(n);
    this.launcher.title = n && title ? `Imagine Studio (Alt+Shift+S) · ${title}` : 'Imagine Studio (Alt+Shift+S)';
  }

  /**
   * Small toast over grok.com. kind: 'info' | 'success' | 'warn' | 'error'; action: {label, run} or
   * actions: [{label, run}, …] (the first one is the primary button); dismissOnOpen: the toast goes away when the
   * studio panel opens (its action was "Open"). Returns a dismiss() function.
   */
  toast(message, { kind = 'info', action = null, actions = null, duration = 4200, dismissOnOpen = false } = {}) {
    if (!this.toastsEl) return () => {};
    const text = String(message || '');
    // The same message again (e.g. several clips added in a row): bump a counter instead of stacking toasts.
    const last = this.toastsEl.lastElementChild;
    if (last && !last.classList.contains('leaving') && last.dataset.msg === text && last.dataset.kind === kind) {
      const n = Number(last.dataset.count || 1) + 1;
      last.dataset.count = String(n);
      last.querySelector('.count').textContent = `×${n}`;
      last._arm?.();
      return last._dismiss;
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.dataset.msg = text;
    el.dataset.kind = kind;
    if (dismissOnOpen) el.dataset.dismissOnOpen = '';
    if (kind === 'error') el.setAttribute('role', 'alert');
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.innerHTML = svg(TOAST_ICON[kind] || 'info', 16);
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = text;
    const count = document.createElement('span');
    count.className = 'count';
    el.append(ic, msg, count);
    let timer = null;
    const dismiss = () => {
      clearTimeout(timer);
      if (!el.isConnected || el.classList.contains('leaving')) return;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    const acts = (Array.isArray(actions) ? actions : action ? [action] : []).filter((a) => a?.label);
    const row = acts.length > 1 ? document.createElement('div') : el;
    if (acts.length > 1) {
      row.className = 'acts';
      el.classList.add('stacked');
    }
    acts.forEach((a, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i ? 'act secondary' : 'act';
      b.textContent = a.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        try {
          a.run?.();
        } finally {
          dismiss();
        }
      });
      row.append(b);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.title = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = svg('x', 14);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });
    el.append(close);
    if (row !== el) el.append(row);
    const arm = () => {
      clearTimeout(timer);
      if (duration > 0) timer = setTimeout(dismiss, duration);
    };
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', arm);
    el._arm = arm;
    el._dismiss = dismiss;
    this.toastsEl.append(el);
    while (this.toastsEl.children.length > MAX_TOASTS) this.toastsEl.firstElementChild.remove();
    arm();
    return dismiss;
  }

  /** Highlights a page element for a moment (follows it while the page scrolls into place). */
  flash(target, ms = 1700) {
    if (!this.shadow || !target?.isConnected) return;
    const f = document.createElement('div');
    f.className = 'flash';
    this.shadow.append(f);
    const t0 = performance.now();
    const tick = () => {
      if (!target.isConnected || performance.now() - t0 > ms) {
        f.remove();
        return;
      }
      const r = target.getBoundingClientRect();
      f.style.left = `${r.left - 3}px`;
      f.style.top = `${r.top - 3}px`;
      f.style.width = `${r.width + 6}px`;
      f.style.height = `${r.height + 6}px`;
      requestAnimationFrame(tick);
    };
    tick();
    setTimeout(() => f.remove(), ms + 200); // rAF does not run in background tabs
  }

  _emitVisibility() {
    this.onVisibility?.({ visible: this.state.open, mode: this.state.mode });
  }

  _persist() {
    const { mode, w, h, fw, fh, fx, fy, floatUser } = this.state;
    try {
      chrome.storage.local.set({ [DOCK_KEY]: { mode, w, h, fw, fh, fx, fy, fu: !!floatUser } });
    } catch {
      /* ignore */
    }
  }

  /** Keeps the floating window on screen (viewport resized, or geometry saved on a bigger screen). */
  _clampFloat() {
    const st = this.state;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    st.fw = Math.round(Math.max(Math.min(MIN_FLOAT_W, vw - 16), Math.min(st.fw || 760, vw - 16)));
    st.fh = Math.round(Math.max(Math.min(MIN_FLOAT_H, vh - 16), Math.min(st.fh || 520, vh - 16)));
    st.fx = Math.round(Math.max(8, Math.min(Number.isFinite(st.fx) ? st.fx : vw - st.fw - 24, vw - st.fw - 8)));
    st.fy = Math.round(Math.max(8, Math.min(Number.isFinite(st.fy) ? st.fy : vh - st.fh - 24, vh - st.fh - 8)));
  }

  _applyLayout() {
    const { mode, w, h, open } = this.state;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // A floating window narrower than the studio's 480 px layout is useless: small windows dock it right instead.
    const eff = mode === 'float' && vw < FLOAT_MIN_VIEWPORT ? 'right' : mode;
    this.effectiveMode = eff;
    this.panel.hidden = !open;
    this.launcher.hidden = open;
    this.panel.className = `panel ${eff}`;
    // A sliver of page next to the panel is useless: on small windows the dock takes the whole side.
    let pw = Math.min(Math.max(w, MIN_RIGHT), vw - 40);
    let ph = Math.min(Math.max(h, MIN_BOTTOM), vh - 40);
    if (eff !== mode || vw - pw < MIN_PAGE_W) pw = vw;
    if (vh - ph < MIN_PAGE_H) ph = vh;
    this.rendered = { w: pw, h: ph };
    // Docked beside the page: the page makes room (see pagePushCss). Full-size docks and float/max cover it.
    this._applyPush(open && eff === 'right' && pw < vw ? { side: 'right', size: pw } : open && eff === 'bottom' && ph < vh ? { side: 'bottom', size: ph } : null);
    this.panel.style.setProperty('--w', `${pw}px`);
    this.panel.style.setProperty('--h', `${ph}px`);
    if (eff === 'float') {
      this._clampFloat();
      const { fx, fy, fw, fh } = this.state;
      this.panel.style.setProperty('--fx', `${fx}px`);
      this.panel.style.setProperty('--fy', `${fy}px`);
      this.panel.style.setProperty('--fw', `${fw}px`);
      this.panel.style.setProperty('--fh', `${fh}px`);
    }
    // Page area not covered by the panel: toasts stay in its top-right corner, away from Grok's composer. When the
    // panel covers (almost) the whole page, toasts sit bottom-centre over it instead of over the studio's header.
    const besidePanel = open && eff === 'right' && vw - pw >= 300;
    const covered = open && (eff === 'max' || (eff === 'right' && !besidePanel) || (eff === 'bottom' && ph >= vh));
    this.toastsEl?.style.setProperty('--page-right', besidePanel ? `${pw}px` : '0px');
    this.toastsEl?.classList.toggle('covered', covered);
    this.onLayout?.({ open, mode: eff });
  }

  _wireResize() {
    let start = null;
    this.resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY, w: this.state.w, h: this.state.h, fw: this.state.fw, fh: this.state.fh };
      this.resizer.setPointerCapture(e.pointerId);
      this.resizer.classList.add('active');
      this.shield.hidden = false; // keep pointer events away from the iframe while dragging
      const m = this.effectiveMode || this.state.mode;
      this.shield.style.cursor = m === 'bottom' ? 'ns-resize' : m === 'float' ? 'nwse-resize' : 'ew-resize';
    });
    this.resizer.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const m = this.effectiveMode || this.state.mode;
      if (m === 'right') this.state.w = Math.max(MIN_RIGHT, Math.min(window.innerWidth - 40, start.w - dx));
      else if (m === 'bottom') this.state.h = Math.max(MIN_BOTTOM, Math.min(window.innerHeight - 40, start.h - dy));
      else if (m === 'float') {
        this.state.fw = Math.max(MIN_FLOAT_W, Math.min(window.innerWidth - this.state.fx - 8, start.fw + dx));
        this.state.fh = Math.max(MIN_FLOAT_H, Math.min(window.innerHeight - this.state.fy - 8, start.fh + dy));
      }
      this._applyLayout();
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.resizer.classList.remove('active');
      this.shield.hidden = true;
      this._persist();
    };
    this.resizer.addEventListener('pointerup', end);
    this.resizer.addEventListener('pointercancel', end);
    const onResize = () => {
      this._applyLayout();
      this.placeLauncher();
    };
    window.addEventListener('resize', onResize);
    this._cleanups.push(() => window.removeEventListener('resize', onResize));
  }

  /** Floating mode: drag the window by its top bar. */
  _wireFloatDrag() {
    let start = null;
    const bar = this.floatBar;
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY, fx: this.state.fx, fy: this.state.fy };
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('active');
      this.shield.hidden = false;
      this.shield.style.cursor = 'grabbing';
    });
    bar.addEventListener('pointermove', (e) => {
      if (!start) return;
      this.state.fx = start.fx + (e.clientX - start.x);
      this.state.fy = start.fy + (e.clientY - start.y);
      this.state.floatUser = true; // their spot from now on (not moved off Grok's composer again)
      this._applyLayout(); // clamps to the viewport
    });
    const end = () => {
      if (!start) return;
      start = null;
      bar.classList.remove('active');
      this.shield.hidden = true;
      this._persist();
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    bar.addEventListener('dblclick', () => this.setDock('right'));
  }
}
