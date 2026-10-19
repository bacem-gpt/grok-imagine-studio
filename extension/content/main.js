// Content-script entry (isolated world, ES module). Wires everything that runs on grok.com:
//  - Overlay (launcher + docked studio iframe, toasts) and Server (page side of the page <-> studio bridge)
//  - media detection: DOM scanner (detect.js) + network records from the MAIN-world hook (network.js) -> Registry
//  - hover toolbar on detected media, on-page "in bin" marks, launcher badge
//  - composer integration (insert / attach / submit / read, submission watcher)
//  - every REQ handler of shared/protocol.js, context-menu actions from background.js, SPA navigation
//  - cross-tab coordination (hosts.js): user actions and auto-collected generations go to a studio that already runs
//    (embedded in another grok.com tab, or a standalone studio tab) instead of booting one more hidden studio here
// Robustness rules: never throw into grok.com, throttle all observers, start once, tear down when the extension
// context goes away (extension reloaded/updated).
import { REQ, EVT, HANDSHAKE_ACK, STUDIO_REQ, STUDIO_EVT } from '../shared/protocol.js';
import { isThumbnailUrl, videoFromThumbnail, normalizeUrl } from '../shared/grok-urls.js';
import { Overlay } from './overlay.js';
import { Server } from './server.js';
import { Registry } from './registry.js';
import { Detector } from './detect.js';
import { listenToHook, fetchBlobViaHook, attachProbe } from './network.js';
import { HoverBar } from './hover.js';
import { Hosts, pickHost } from './hosts.js';
import { findComposer, findSubmitButton, insertText, attachFile, submitComposer, readText, watchSubmissions } from './composer.js';
import { lastAssistantReply, selectionText } from './text.js';
import { routeOf, adhocPageMedia } from './records.js';

const UI_PREFS_KEY = 'gis:ui';
const BIN_KEYS_KEY = 'gis:binKeys';
const MEDIA_EMIT_DEBOUNCE_MS = 400;
const NAV_POLL_MS = 700;
const HEALTH_MS = 4000;
const TAB_STUDIO_POLL_MS = 8000;
const TAB_ATTACHED_MS = 30000; // a standalone studio tab that talked to this tab this recently is attached to it
const TAB_PROBE_DELAY_MS = 1200;
const DELIVERY_DEADLINE_MS = 15000; // a studio iframe that has not answered by then is broken
const OPTIMISTIC_MS = 20000; // "in bin" shown right after an add, until the studio's bin keys confirm it
const RELAY_TIMEOUT_MS = 2500;
const RELAYABLE = new Set([EVT.PAGE_ADD, EVT.PAGE_INGREDIENT, EVT.PAGE_IMPORT_TEXT]);
const PAGE_CSS = '[data-gis-in-bin]{outline:2px solid rgba(61,220,151,.8)!important;outline-offset:-2px!important;}';
const TOAST_KINDS = new Set(['info', 'success', 'warn', 'error']);
const STREAM_ERROR = 'Grok only streams this clip on this page (no file to download yet). Open its post page, or add it again once Grok has listed it';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PageInfo for the current page (see shared/protocol.js). */
export function pageInfo() {
  let composerFound = false;
  try {
    composerFound = !!findComposer();
  } catch {
    composerFound = false;
  }
  return { url: location.href, title: document.title, route: routeOf(location.pathname), composerFound };
}

function contextAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/** Viewport rects of Grok's composer (its box) and its submit button: a floating studio window keeps clear of them. */
function composerRects() {
  const composer = findComposer();
  if (!composer) return null;
  const box = (composer.closest('.query-bar, form') || composer).getBoundingClientRect();
  const key = findSubmitButton(composer, { includeDisabled: true })?.getBoundingClientRect() || null;
  return { box, key };
}

function isPageScroller(el) {
  return !el || el === document.scrollingElement || el === document.documentElement || el === document.body;
}

/** True when another tab's studio can import these items (a page's blob: URLs only work inside that page). */
function relayable(name, payload) {
  if (!RELAYABLE.has(name) || !payload || typeof payload !== 'object') return false;
  const items = name === EVT.PAGE_ADD ? payload.items || [] : name === EVT.PAGE_INGREDIENT ? [payload.item] : [];
  return items.every((it) => it && [it.url, ...(it.altUrls || [])].some((u) => typeof u === 'string' && /^https?:\/\//i.test(u)));
}

class ContentApp {
  constructor() {
    this.binKeys = new Set();
    this.optimistic = new Map(); // key -> expiry (ms): added a moment ago, not confirmed by the studio yet
    this.lastEmitted = -1;
    this.cleanups = [];
    this.intervals = [];
    this.timeouts = new Set();
    this.destroyed = false;
    this.prefs = {};
    this.autoSince = Date.now();
    this.autoSent = new Set(); // keys relayed by auto-collect
    this.pending = []; // user actions waiting for this tab's studio iframe to boot
    this.pendingTimer = null;
    this.tabAttached = false; // a standalone studio tab targets this tab
    this.tabAttachedAt = 0;
    this.activeAt = 0; // last time the panel was shown
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timeouts.delete(t);
      fn();
    }, ms);
    this.timeouts.add(t);
    return t;
  }

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  async start() {
    this.server = new Server({ hasFrame: () => !!this.overlay?.framePresent, onTabStudio: () => this.setTabAttached(true) });
    this.overlay = new Overlay({
      onPort: (port) => this.server.setPort(port),
      onVisibility: (v) => {
        this.server.emit(EVT.UI_VISIBILITY, v);
        if (v.visible) this.activeAt = Date.now();
        this.updateHosting();
      },
      onLayout: () => this.hover?.refresh(),
      onFrame: (present) => {
        if (!present) this.server.resetPort();
        this.updateHosting();
      },
      getAvoid: () => composerRects(),
    });
    await this.overlay.mount();
    this.hosts = new Hosts({ onRelay: (name, payload) => this.onRelayed(name, payload) });
    this.registry = new Registry({ pageUrl: () => location.href, unreadable: (url) => !!this.detector?.isStreamUrl(url) });
    this.autoSince = this.registry.sessionStart;
    this.registry.beginSettle(4000); // media found while the page loads was already there (not "new")
    this.detector = new Detector({ registry: this.registry, onChange: () => this.mediaChanged(), onScan: () => this.afterScan() });
    this.hover = new HoverBar({
      host: this.overlay.host,
      shadow: this.overlay.shadow,
      registry: this.registry,
      isInBin: (key) => this.isInBinKey(key),
      onAction: (act, key, el, info) => this.onHoverAction(act, key, el, info),
      resolveKey: (el) => this.currentKeyOf(el),
    });

    this.server.onEvent(HANDSHAKE_ACK, () => this.onStudioConnected());
    this.server.onReady = () => this.onStudioReady();
    this.server.onEvent(STUDIO_EVT.BIN_KEYS, (p) => this.setBinKeys(p?.keys));
    this.registerHandlers();
    this.listenRuntime();
    this.stopHook = listenToHook({
      onRecords: (records, from, timing) => {
        let changed = false;
        if (timing?.serverDate && timing.clientAt) changed = this.registry.noteServerTime(timing.clientAt, timing.serverDate);
        if (this.registry.applyNet(records)) changed = true;
        if (changed) this.mediaChanged();
        this.detector.scheduleScan(150); // the DOM usually renders the new media right after the response
      },
      onObjectUrl: ({ url, mse, source }) => this.detector.noteObjectUrl(url, { mse, source }),
    });
    this.stopSubmissions = watchSubmissions(
      (text) => {
        this.registry.signalGeneration(); // whatever appears from now on is a new generation
        this.server.emit(EVT.COMPOSER_SUBMITTED, { text, at: Date.now() });
      },
      { onGenerate: () => this.registry.signalGeneration() },
    );
    await Promise.all([this.loadCachedBinKeys(), this.loadPrefs()]);
    this.injectPageStyle();
    this.detector.start();
    this.hover.start();
    this.watchNavigation();
    this.watchStorage();
    this.maybeEarlyFrame();
    this.intervals.push(setInterval(() => this.healthCheck(), HEALTH_MS));
    this.intervals.push(setInterval(() => this.pollTabStudio(), TAB_STUDIO_POLL_MS));
    // A standalone studio tab may already target this tab (it was reloaded): page events go to it only once it is
    // known (see Server.emit), so ask once.
    this.later(() => this.pollTabStudio({ probe: true }), TAB_PROBE_DELAY_MS);
  }

  // -------------------------------------------------------------------------------------------------------
  // Media list, badge, marks
  // -------------------------------------------------------------------------------------------------------

  mediaChanged() {
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => this.flushMedia(), MEDIA_EMIT_DEBOUNCE_MS);
  }

  flushMedia(force = false) {
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.updateBadge();
    if (!force && this.registry.version === this.lastEmitted) return;
    this.lastEmitted = this.registry.version;
    const items = this.registry.list();
    this.server.emit(EVT.PAGE_MEDIA, { items });
    this.autoCollectRelay(items);
  }

  inBinKeys(keys) {
    const now = Date.now();
    for (const k of keys) {
      if (this.binKeys.has(k)) return true;
      const until = this.optimistic.get(k);
      if (until != null && until > now) return true;
    }
    return false;
  }

  /** In the studio bin: by key or by any alias (the bin may hold it under the key an earlier session gave it). */
  isInBinEntry(e) {
    return this.inBinKeys(this.registry.keysOf(e));
  }

  isInBinItem(pm) {
    return !!pm && this.inBinKeys([pm.key, ...(pm.aliases || [])]);
  }

  isInBinKey(key) {
    const pm = this.registry.get(key);
    return pm ? this.isInBinItem(pm) : this.inBinKeys([key]);
  }

  /**
   * The item under the key its bin entry already uses, when the bin holds it under an alias (a key an earlier
   * session gave it): the studio finds bin media by key, so it reuses that entry instead of importing a duplicate.
   */
  withBinKey(pm) {
    if (!pm || this.binKeys.has(pm.key)) return pm;
    const alias = (pm.aliases || []).find((a) => this.binKeys.has(a));
    return alias ? { ...pm, key: alias } : pm;
  }

  updateBadge() {
    let n = 0;
    for (const e of this.registry.iterEntries()) if (e.kind === 'video' && !this.isInBinEntry(e)) n++;
    this.overlay.setBadge(n, n === 1 ? '1 video here is not in your bin yet' : `${n} videos here are not in your bin yet`);
  }

  /** After every DOM scan: element references may have changed (marks, the hover toolbar's media). */
  afterScan() {
    this.applyMarks();
    this.hover?.revalidate();
  }

  /** Key of the media an element shows right now (scans first when the DOM changed since the last scan). */
  currentKeyOf(el) {
    if (this.detector.pending || this.detector.isStale(el)) this.detector.scanNow();
    return this.registry.keyForElement(el);
  }

  /** Subtle outline on page media that is already in the studio bin. */
  applyMarks() {
    try {
      const marked = new Set();
      if (this.binKeys.size || this.optimistic.size) {
        for (const e of this.registry.iterEntries()) {
          if (!e.els.length || !this.isInBinEntry(e)) continue;
          for (const el of e.els) {
            if (!el.hasAttribute('data-gis-in-bin')) el.setAttribute('data-gis-in-bin', '');
            marked.add(el);
          }
        }
      }
      for (const el of document.querySelectorAll('[data-gis-in-bin]')) if (!marked.has(el)) el.removeAttribute('data-gis-in-bin');
    } catch (e) {
      console.warn('[gis] marks failed', e);
    }
  }

  refreshBinUi() {
    this.updateBadge();
    this.applyMarks();
    this.hover?.refresh();
  }

  injectPageStyle() {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PAGE_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      this.pageSheet = sheet;
    } catch {
      const style = document.createElement('style');
      style.id = 'gis-page-style';
      style.textContent = PAGE_CSS;
      (document.head || document.documentElement).appendChild(style);
      this.pageStyleEl = style;
    }
  }

  ensurePageStyle() {
    try {
      if (this.pageSheet && !document.adoptedStyleSheets.includes(this.pageSheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.pageSheet];
      else if (this.pageStyleEl && !this.pageStyleEl.isConnected) (document.head || document.documentElement).appendChild(this.pageStyleEl);
    } catch {
      /* ignore */
    }
  }

  /** Bin keys from this tab's studio (persisted for other tabs), or from another tab's studio via storage. */
  setBinKeys(keys, { persist = true } = {}) {
    if (!Array.isArray(keys)) return;
    this.binKeys = new Set(keys.filter((k) => typeof k === 'string'));
    for (const k of this.binKeys) this.optimistic.delete(k);
    this.refreshBinUi();
    if (!persist) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ [BIN_KEYS_KEY]: [...this.binKeys].slice(0, 5000) });
      } catch {
        /* context gone */
      }
    }, 1000);
  }

  async loadCachedBinKeys() {
    try {
      const got = await chrome.storage.local.get(BIN_KEYS_KEY);
      if (Array.isArray(got?.[BIN_KEYS_KEY])) this.binKeys = new Set(got[BIN_KEYS_KEY].filter((k) => typeof k === 'string'));
    } catch {
      /* ignore */
    }
  }

  async loadPrefs() {
    try {
      const got = await chrome.storage.local.get(UI_PREFS_KEY);
      const p = got?.[UI_PREFS_KEY];
      this.prefs = p && typeof p === 'object' ? p : {};
    } catch {
      this.prefs = {};
    }
  }

  /** Optimistic "in bin" right after an add (reverted if the delivery fails, expires if never confirmed). */
  markInBin(keys) {
    const until = Date.now() + OPTIMISTIC_MS;
    let added = false;
    for (const k of keys) {
      if (!k || this.binKeys.has(k)) continue;
      this.optimistic.set(k, until);
      added = true;
    }
    if (!added) return;
    this.refreshBinUi();
    this.later(() => this.refreshBinUi(), OPTIMISTIC_MS + 50);
  }

  unmarkInBin(keys) {
    let changed = false;
    for (const k of keys) changed = this.optimistic.delete(k) || changed;
    if (changed) this.refreshBinUi();
  }

  // -------------------------------------------------------------------------------------------------------
  // Studio connection, hosting, delivery
  // -------------------------------------------------------------------------------------------------------

  onStudioConnected() {
    this.overlay.acked();
    this.server.markAcked();
  }

  /** The embedded studio is ready (queued events delivered): sync the on-page "in bin" state. */
  onStudioReady() {
    this.pending = [];
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.updateHosting();
    this.server
      .request(STUDIO_REQ.BIN_KEYS)
      .then((r) => this.setBinKeys(r?.keys))
      .catch(() => {});
  }

  openStudio() {
    this.overlay.toggle(true);
  }

  openTabStudio() {
    try {
      chrome.runtime.sendMessage({ gis: 'open-tab' }).catch(() => {});
    } catch {
      /* context gone */
    }
  }

  hostingHere() {
    return this.overlay.framePresent || this.tabAttached;
  }

  /** Tells other grok.com tabs whether a studio runs here (see hosts.js). */
  updateHosting() {
    if (this.destroyed || !this.hosts || !this.overlay) return Promise.resolve();
    let meta = null;
    if (this.overlay.framePresent) {
      meta = { kind: 'embedded', ready: this.server.ready, open: this.overlay.isOpen, activeAt: this.activeAt || this.overlay.frameCreatedAt || 0 };
    } else if (this.tabAttached) {
      meta = { kind: 'tab', ready: true, open: false, activeAt: this.tabAttachedAt };
    }
    return this.hosts.setHosting(meta).catch(() => {});
  }

  setTabAttached(attached) {
    if (attached === this.tabAttached) return;
    this.tabAttached = attached;
    this.tabAttachedAt = attached ? Date.now() : 0;
    this.updateHosting();
  }

  /** Another tab relayed an event to the studio hosted here. */
  onRelayed(name, payload) {
    if (!RELAYABLE.has(name) || !payload || typeof payload !== 'object') return { ok: false, error: 'not relayable' };
    if (this.overlay.framePresent) {
      this.server.emitPort(name, payload);
      return { ok: true };
    }
    if (this.tabAttached) {
      this.server.emitRuntime(name, payload);
      return { ok: true };
    }
    return { ok: false, error: 'no studio in this tab' };
  }

  /**
   * Delivers a user action to exactly one studio: this tab's embedded one when it exists; else a standalone studio
   * tab that targets this tab; else a studio already running in another grok.com tab (relay); else a hidden studio
   * created here (the event is queued until it is ready, with a deadline). keys: PageMedia keys marked "in bin".
   */
  async deliver(name, payload, label, { keys = [] } = {}) {
    if (this.overlay.framePresent) return this.deliverLocal(name, payload, label, keys);
    const res = await this.server.requestTab(STUDIO_REQ.BIN_KEYS, {}, 500);
    if (res) {
      this.setTabAttached(true);
      if (Array.isArray(res.keys)) this.setBinKeys(res.keys);
      this.server.emitRuntime(name, payload);
      if (label) this.overlay.toast(label, { kind: 'success', action: { label: 'Open Studio', run: () => this.openTabStudio() } });
      return true;
    }
    if (relayable(name, payload)) {
      const host = pickHost(await this.hosts.liveHosts(), this.hosts.id);
      if (host) {
        const ack = await this.hosts.relay(host.id, name, payload, RELAY_TIMEOUT_MS);
        if (ack.ok) {
          if (label) this.overlay.toast(label, { kind: 'success', action: { label: 'Open', run: () => this.openStudio() }, dismissOnOpen: true });
          return true;
        }
      }
    }
    if (this.destroyed) return false;
    return this.deliverLocal(name, payload, label, keys);
  }

  deliverLocal(name, payload, label, keys = []) {
    this.overlay.ensureFrame();
    this.server.emitPort(name, payload);
    if (!this.server.ready) this.trackPending({ name, payload, label, keys });
    if (label && !this.overlay.isOpen) this.overlay.toast(label, { kind: 'success', action: { label: 'Open', run: () => this.openStudio() }, dismissOnOpen: true });
    return true;
  }

  trackPending(action) {
    this.pending.push(action);
    if (this.pendingTimer) return;
    const startedAt = this.overlay.frameCreatedAt || Date.now();
    this.pendingTimer = this.later(() => this.checkPending(), Math.max(1000, startedAt + DELIVERY_DEADLINE_MS - Date.now()));
  }

  /** The studio iframe did not come up in time: undo the optimistic marks, tell the user, offer Retry. */
  checkPending() {
    this.pendingTimer = null;
    if (this.server.ready) {
      this.pending = [];
      return;
    }
    if (!this.pending.length || this.destroyed) return;
    const failed = this.pending;
    this.pending = [];
    const payloads = new Set(failed.map((f) => f.payload));
    this.server.dropQueued((q) => payloads.has(q.payload));
    this.unmarkInBin(failed.flatMap((f) => f.keys || []));
    this.overlay.destroyFrame(); // never answered: the next action starts a fresh one
    const n = failed.length;
    this.overlay.toast(n > 1 ? `Imagine Studio did not start: ${n} actions were not delivered` : 'Imagine Studio did not start: nothing was added', {
      kind: 'error',
      duration: 15000,
      actions: [
        { label: 'Retry', run: () => failed.forEach((f) => this.redeliver(f)) },
        { label: 'Open in a tab', run: () => this.openTabStudio() },
      ],
    });
  }

  redeliver(f) {
    this.deliver(f.name, f.payload, f.label, { keys: f.keys })
      .then((ok) => ok && f.keys?.length && this.markInBin(f.keys))
      .catch((e) => console.warn('[gis] retry failed', e));
  }

  async onHoverAction(act, key, el, { inBin = false } = {}) {
    if (act === 'bin' && inBin) {
      if (!this.overlay.framePresent && this.tabAttached) this.openTabStudio();
      else this.openStudio();
      return true;
    }
    const pm = this.registry.get(key);
    if (!pm) {
      this.overlay.toast('This media is no longer on the page', { kind: 'warn' });
      return false;
    }
    if (act === 'ingredient') return this.deliver(EVT.PAGE_INGREDIENT, { item: pm }, 'Saved to Studio ingredients');
    const flag = act === 'pick' ? 'pick' : null;
    const target = act === 'timeline' ? 'timeline' : 'bin';
    const label = act === 'pick' ? 'Added to the Studio bin as a pick' : act === 'timeline' ? 'Added to the Studio timeline' : 'Added to the Studio bin';
    const item = this.withBinKey(pm);
    const ok = await this.deliver(EVT.PAGE_ADD, { items: [item], flag, target }, label, { keys: [item.key] });
    if (ok) this.markInBin([item.key]);
    return ok;
  }

  // -------------------------------------------------------------------------------------------------------
  // Auto-collect
  // -------------------------------------------------------------------------------------------------------

  /** With auto-collect on, boot a hidden studio here, unless one already runs (one host for all grok.com tabs). */
  async maybeEarlyFrame() {
    try {
      const p = this.prefs;
      if (!p?.autoCollect && !p?.autoCollectImages) return;
      if (this.overlay.framePresent || this.tabAttached) return;
      // A standalone studio that targets this tab already auto-collects from it.
      if (await this.server.requestTab(STUDIO_REQ.BIN_KEYS, {}, 600)) {
        this.setTabAttached(true);
        return;
      }
      await this.hosts.elect(async () => {
        if (this.overlay.framePresent || this.destroyed) return;
        if (pickHost(await this.hosts.liveHosts(), this.hosts.id, { needReady: false })) return; // relay to it instead
        this.overlay.ensureFrame(); // hidden; the studio boots and auto-collects new generations
        await this.updateHosting(); // claim hosting before the next tab decides
      });
    } catch (e) {
      console.warn('[gis] auto-collect setup failed', e);
    }
  }

  /**
   * A tab without its own studio sends its new generations to the studio that runs elsewhere. A studio here
   * collects them from PAGE_MEDIA itself, except while it is still booting: what appears then predates its start
   * time, so it gets an explicit PAGE_ADD (queued; imports skip what is already in the bin).
   */
  autoCollectRelay(items) {
    const p = this.prefs;
    if (!p?.autoCollect && !p?.autoCollectImages) return;
    if (this.tabAttached || (this.overlay.framePresent && this.server.ready)) return;
    const fresh = items.filter(
      (it) => it.fresh && it.seenAt >= this.autoSince && ((p.autoCollect && it.kind === 'video') || (p.autoCollectImages && it.kind === 'image')) && !this.autoSent.has(it.key) && !this.isInBinItem(it),
    );
    if (!fresh.length) return;
    for (const it of fresh) this.autoSent.add(it.key);
    this.deliver(EVT.PAGE_ADD, { items: fresh, flag: null, target: 'bin' }, null, { keys: fresh.map((it) => it.key) }).catch((e) => console.warn('[gis] auto-collect relay failed', e));
  }

  // -------------------------------------------------------------------------------------------------------
  // Context menu (background.js)
  // -------------------------------------------------------------------------------------------------------

  resolveMedia(srcUrl, mediaType) {
    let key = this.registry.findByUrl(srcUrl);
    if (!key && isThumbnailUrl(srcUrl)) key = this.registry.findByUrl(videoFromThumbnail(srcUrl));
    if (!key) {
      for (const el of document.querySelectorAll('video, img')) {
        if (el.currentSrc === srcUrl || el.src === srcUrl || el.poster === srcUrl) {
          key = this.registry.keyForElement(el);
          if (key) break;
        }
      }
    }
    if (key) return this.registry.get(key);
    const kind = mediaType === 'video' ? 'video' : mediaType === 'image' ? 'image' : null;
    return adhocPageMedia({ url: srcUrl, kind, pageUrl: location.href, pageOrigin: location.origin });
  }

  resolveImage(srcUrl) {
    const key = this.registry.findByUrl(srcUrl);
    const pm = key ? this.registry.get(key) : null;
    if (pm?.kind === 'image') return pm;
    // A video thumbnail (or an unknown image): the picture itself becomes the ingredient.
    const videoKey = isThumbnailUrl(srcUrl) ? this.registry.findByUrl(videoFromThumbnail(srcUrl)) : null;
    const prompt = pm?.prompt || (videoKey ? this.registry.get(videoKey)?.prompt : null) || null;
    return adhocPageMedia({ url: srcUrl, kind: 'image', preferImage: true, pageUrl: location.href, pageOrigin: location.origin, prompt });
  }

  async onContextAction(msg) {
    const action = msg.action;
    if (action === 'gis-import-text') {
      // getSelection() keeps line breaks (Chrome's selectionText collapses them).
      const live = selectionText().trim();
      const text = live || String(msg.selectionText || '').trim();
      if (!text) {
        this.overlay.toast('Select some text first', { kind: 'warn' });
        return;
      }
      await this.deliver(EVT.PAGE_IMPORT_TEXT, { text }, 'Sent to the Studio prompt list');
      return;
    }
    if (!msg.srcUrl) return;
    this.detector.scanNow();
    if (action === 'gis-add-ingredient') {
      const item = this.resolveImage(msg.srcUrl);
      if (!item) {
        this.overlay.toast('This image cannot be saved to the Studio', { kind: 'warn' });
        return;
      }
      await this.deliver(EVT.PAGE_INGREDIENT, { item }, 'Saved to Studio ingredients');
      return;
    }
    if (action === 'gis-add-media' || action === 'gis-add-timeline') {
      const item = this.withBinKey(this.resolveMedia(msg.srcUrl, msg.mediaType));
      if (!item) {
        this.overlay.toast('This media cannot be added to the Studio', { kind: 'warn' });
        return;
      }
      const toTimeline = action === 'gis-add-timeline';
      const ok = await this.deliver(EVT.PAGE_ADD, { items: [item], flag: null, target: toTimeline ? 'timeline' : 'bin' }, toTimeline ? 'Added to the Studio timeline' : 'Added to the Studio bin', {
        keys: [item.key],
      });
      if (ok) this.markInBin([item.key]);
    }
  }

  listenRuntime() {
    this.onRuntimeMessage = (msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object' || sender.id !== chrome.runtime.id) return false;
      if (msg.gis === 'toggle') {
        sendResponse({ open: this.overlay.toggle() });
        return false;
      }
      if (msg.gis === 'context') {
        Promise.resolve()
          .then(() => this.onContextAction(msg))
          .catch((e) => {
            console.warn('[gis] context action failed', e);
            this.overlay.toast(`Imagine Studio: ${e?.message || e}`, { kind: 'error' });
          });
        sendResponse({ ok: true });
        return false;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
  }

  // -------------------------------------------------------------------------------------------------------
  // Requests from the studio
  // -------------------------------------------------------------------------------------------------------

  registerHandlers() {
    const s = this.server;
    s.handle(REQ.PAGE_INFO, () => pageInfo());
    s.handle(REQ.PAGE_SCAN, () => {
      this.detector.scanNow();
      return { items: this.registry.list() };
    });
    s.handle(REQ.PAGE_FETCH, ({ url }) => this.fetchMedia(url));
    s.handle(REQ.PAGE_REVEAL, ({ key, url }) => this.reveal(key, url));
    s.handle(REQ.PAGE_SELECTION, () => ({ text: selectionText() }));
    s.handle(REQ.PAGE_LAST_REPLY, () => ({ text: lastAssistantReply(document) }));
    s.handle(REQ.PAGE_LOAD_MORE, ({ steps, keepPosition } = {}) => this.loadMore(steps, keepPosition !== false));
    s.handle(REQ.COMPOSER_INSERT, ({ text, mode, submit } = {}) => insertText(text ?? '', { mode: mode === 'append' ? 'append' : 'replace', submit: !!submit }));
    s.handle(REQ.COMPOSER_ATTACH, ({ blob, name } = {}) => attachFile(blob, name, { probe: attachProbe() }));
    s.handle(REQ.COMPOSER_SUBMIT, () => submitComposer());
    s.handle(REQ.COMPOSER_READ, () => {
      const el = findComposer();
      return { text: el ? readText(el) : '', found: !!el };
    });
    s.handle(REQ.UI_SET_DOCK, ({ mode, size } = {}) => this.overlay.setDock(mode, size));
    s.handle(REQ.UI_GET_DOCK, () => this.overlay.getDock());
    s.handle(REQ.UI_CLOSE, () => {
      this.overlay.toggle(false);
      return { ok: true };
    });
    s.handle(REQ.UI_TOAST, ({ message, kind, duration } = {}) => {
      this.overlay.toast(String(message ?? ''), { kind: TOAST_KINDS.has(kind) ? kind : 'info', duration: Number.isFinite(duration) ? duration : undefined });
      return { ok: true };
    });
  }

  /** Page-origin fetch (cookies, page CORS) — and page-owned blob: URLs. */
  async fetchMedia(url) {
    if (typeof url !== 'string' || !url) throw new Error('No URL to fetch');
    if (url.startsWith('blob:')) {
      if (!url.startsWith(`blob:${location.origin}/`)) throw new Error('Not a blob URL of this page');
      if (this.detector.isStreamUrl(url)) throw new Error(STREAM_ERROR);
      try {
        const res = await fetch(url);
        if (res.ok) return { blob: await res.blob() };
      } catch {
        /* blocked by the page CSP or not readable from the isolated world: ask the page itself */
      }
      return { blob: await fetchBlobViaHook(url) };
    }
    if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported URL');
    let res;
    try {
      res = await fetch(url, { credentials: 'include' });
    } catch {
      res = await fetch(url, { credentials: 'omit' }); // hosts that do not allow credentialed CORS
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { blob: await res.blob() };
  }

  reveal(key, url) {
    let el = key ? this.registry.elementsFor(key).find((e) => e.isConnected) : null;
    if (!el) {
      const pm = key ? this.registry.get(key) : null;
      const wanted = new Set([url, pm?.url, ...(pm?.altUrls || []), pm?.thumbUrl].filter(Boolean).map(normalizeUrl));
      if (wanted.size) {
        for (const cand of document.querySelectorAll('video, img')) {
          const srcs = [cand.currentSrc, cand.src, cand.poster].filter(Boolean).map(normalizeUrl);
          if (srcs.some((s) => wanted.has(s))) {
            el = cand;
            break;
          }
        }
      }
    }
    if (!el) return { ok: false, error: 'Not visible on this page' };
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    this.overlay.flash(el);
    return { ok: true };
  }

  findScroller() {
    let first = null;
    for (const e of this.registry.iterEntries()) {
      first = e.els.find((el) => el.isConnected);
      if (first) break;
    }
    for (let node = first?.parentElement; node && !isPageScroller(node); node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 20) return node;
    }
    return document.scrollingElement || document.documentElement;
  }

  /**
   * Scrolls the feed so Grok loads more, waiting for new media after each step. keepPosition (default): the page
   * scrolls back to where the user was once the new media is detected.
   */
  async loadMore(steps = 3, keepPosition = true) {
    const n = Math.max(1, Math.min(10, Number(steps) || 3));
    const before = this.registry.size;
    const scroller = this.findScroller();
    const page = isPageScroller(scroller);
    const height = () => (page ? document.documentElement.scrollHeight : scroller.scrollHeight);
    const top0 = page ? window.scrollY : scroller.scrollTop;
    try {
      for (let i = 0; i < n; i++) {
        const size0 = this.registry.size;
        const h0 = height();
        if (page) window.scrollTo({ top: h0, behavior: 'instant' });
        else scroller.scrollTop = scroller.scrollHeight;
        const t0 = Date.now();
        let grew = false;
        while (Date.now() - t0 < 3000) {
          await sleep(150);
          this.detector.scanNow();
          if (this.registry.size > size0 || height() > h0 + 4) {
            grew = true;
            break;
          }
        }
        if (!grew) break;
        await sleep(250); // let images load / the next page settle
      }
      this.detector.scanNow();
    } finally {
      if (keepPosition) {
        if (page) window.scrollTo({ top: top0, behavior: 'instant' });
        else scroller.scrollTop = top0;
      }
    }
    this.flushMedia();
    return { added: Math.max(0, this.registry.size - before) };
  }

  // -------------------------------------------------------------------------------------------------------
  // Navigation, preferences, health
  // -------------------------------------------------------------------------------------------------------

  watchNavigation() {
    this.lastUrl = location.href;
    const check = () => {
      if (location.href === this.lastUrl) return;
      this.lastUrl = location.href;
      this.onNavigate();
    };
    try {
      if (window.navigation?.addEventListener) this.listen(window.navigation, 'currententrychange', () => setTimeout(check, 0));
    } catch {
      /* Navigation API unavailable */
    }
    this.listen(window, 'popstate', check);
    this.intervals.push(setInterval(check, NAV_POLL_MS));
  }

  onNavigate() {
    this.registry.navigate();
    this.registry.beginSettle(3000);
    this.detector.resetPrompts();
    this.hover.hide();
    const info = pageInfo();
    this.server.emit(EVT.PAGE_NAVIGATED, info);
    this.detector.scheduleScan(120);
    for (const t of [this.pruneA, this.pruneB, this.infoTimer]) clearTimeout(t);
    const prune = () => {
      this.detector.scanNow();
      if (this.registry.prune()) this.mediaChanged();
    };
    this.pruneA = this.later(prune, 2500);
    this.pruneB = this.later(prune, 6000);
    // The new page renders its composer a moment later: refresh composerFound once it settled, and what the panel
    // layout measures in the page (does the document scroll, the scrollbar under the launcher).
    this.infoTimer = this.later(() => {
      const next = pageInfo();
      if (next.url === info.url && next.composerFound !== info.composerFound) this.server.emit(EVT.PAGE_NAVIGATED, next);
      this.overlay.refreshLayout();
    }, 1500);
  }

  watchStorage() {
    const onChanged = (changes, area) => {
      if (area !== 'local' || this.destroyed) return;
      if (changes[UI_PREFS_KEY]) {
        const prev = this.prefs || {};
        const next = changes[UI_PREFS_KEY].newValue || {};
        this.prefs = next;
        if ((next.autoCollect && !prev.autoCollect) || (next.autoCollectImages && !prev.autoCollectImages)) {
          this.autoSince = Date.now();
          this.maybeEarlyFrame();
        }
      }
      // Another tab's studio changed the bin: keep this tab's marks and badge current.
      if (changes[BIN_KEYS_KEY] && !this.hostingHere()) {
        const v = changes[BIN_KEYS_KEY].newValue;
        if (Array.isArray(v)) this.setBinKeys(v, { persist: false });
      }
    };
    try {
      chrome.storage.onChanged.addListener(onChanged);
      this.cleanups.push(() => {
        try {
          chrome.storage.onChanged.removeListener(onChanged);
        } catch {
          /* context gone */
        }
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Keeps track of a standalone studio tab attached to this tab (it answers only while it targets this tab).
   * probe: ask even when none is known (once, at start).
   */
  async pollTabStudio({ probe = false } = {}) {
    if (!probe && !this.tabAttached && !this.server.tabStudioRecent(TAB_ATTACHED_MS)) return;
    const res = await this.server.requestTab(STUDIO_REQ.BIN_KEYS, {}, 800);
    if (this.destroyed) return;
    if (res) {
      const fresh = !this.tabAttached;
      this.setTabAttached(true);
      if (!this.overlay.framePresent && Array.isArray(res.keys)) this.setBinKeys(res.keys);
      if (fresh && probe) this.flushMedia(true); // it has not seen this page's media yet
    } else if (probe) {
      return;
    } else {
      this.server.tabStudioSeenAt = 0;
      this.setTabAttached(false);
    }
  }

  healthCheck() {
    if (!contextAlive()) {
      this.destroy();
      return;
    }
    this.ensurePageStyle();
    this.overlay.ensurePageStyle();
    this.overlay.placeLauncher();
  }

  /** Extension reloaded / updated: this copy of the content script is orphaned. Remove all traces. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const id of this.intervals) clearInterval(id);
    for (const t of this.timeouts) clearTimeout(t);
    clearTimeout(this.emitTimer);
    clearTimeout(this.persistTimer);
    for (const off of this.cleanups) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.detector?.stop();
    this.hover?.stop();
    this.stopHook?.();
    this.stopSubmissions?.();
    this.hosts?.destroy();
    try {
      chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
    } catch {
      /* context gone */
    }
    this.server?.destroy();
    this.overlay?.destroy();
    for (const el of document.querySelectorAll('[data-gis-in-bin]')) el.removeAttribute('data-gis-in-bin');
    try {
      if (this.pageSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== this.pageSheet);
      this.pageStyleEl?.remove();
    } catch {
      /* ignore */
    }
  }
}

/** Entry point called by loader.js (idempotent). */
export async function start() {
  if (window.__gisContent) return window.__gisContent;
  const app = new ContentApp();
  window.__gisContent = app;
  try {
    await app.start();
  } catch (e) {
    console.error('[Imagine Studio] content script failed to start', e);
    app.destroy();
  }
  return app;
}
