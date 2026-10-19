// Page side of the page <-> studio channel. Routes requests from the studio (MessagePort when embedded,
// chrome.runtime messages from a standalone studio tab) to handlers, and emits events to whichever studio is listening.
//
// Events for the embedded studio are queued until it can handle them, so actions taken before the iframe finished
// booting (hover "+ Bin" with no studio open yet) are delivered in order. The studio acknowledges the handshake only
// once every event listener and request handler is registered (core/bridge.js appReady()), so the acknowledgement
// marks it ready.
//  - state events (PAGE_MEDIA, PAGE_NAVIGATED, UI_VISIBILITY) coalesce in the queue: only the latest matters
//  - transient events (COMPOSER_SUBMITTED) describe a moment: they are not queued when no studio frame exists or a
//    standalone studio tab already receives them, and are dropped when older than TRANSIENT_MAX_AGE_MS at delivery
// chrome.runtime broadcasts (for a standalone studio tab) only go out while such a tab talks to this tab: each one
// wakes the extension's service worker. Payloads without Blobs are sent as they are (no encoding pass).
import { encodeForRuntime, decodeFromRuntime, EVT } from '../shared/protocol.js';

const MAX_QUEUE = 200;
const TRANSIENT_MAX_AGE_MS = 30000;
const TAB_STUDIO_ACTIVE_MS = 120000;
const COALESCE = new Set([EVT.PAGE_MEDIA, EVT.PAGE_NAVIGATED, EVT.UI_VISIBILITY]);
const TRANSIENT = new Set([EVT.COMPOSER_SUBMITTED]);

/** True when a value holds a Blob anywhere (it then needs encodeForRuntime() to survive chrome.runtime messaging). */
export function hasBlob(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 24) return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (Array.isArray(value)) return value.some((v) => hasBlob(v, depth + 1));
  for (const k in value) if (hasBlob(value[k], depth + 1)) return true;
  return false;
}

/** encodeForRuntime() without the async walk when there is nothing to encode. */
const forRuntime = async (value) => (hasBlob(value) ? encodeForRuntime(value) : value);

export class Server {
  /**
   * @param {{hasFrame?: () => boolean, onTabStudio?: () => void}} opts
   *   hasFrame: whether an embedded studio iframe exists (booting or ready);
   *   onTabStudio: a standalone studio tab just sent this tab a request.
   */
  constructor({ hasFrame = () => false, onTabStudio = null } = {}) {
    this.hasFrame = hasFrame;
    this.onTabStudio = onTabStudio;
    this.handlers = new Map();
    this.port = null;
    this.ready = false; // the embedded studio acknowledged the current port (its listeners exist)
    this.onReady = null; // callback after the queue was flushed
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.eventListeners = new Map();
    this.tabStudioSeenAt = 0; // last sign of life from a standalone studio tab that targets this tab
    this._onRuntime = (msg, sender, sendResponse) => {
      if (!msg || msg.gis !== 'req' || sender.id !== chrome.runtime.id) return false;
      this.tabStudioSeenAt = Date.now();
      try {
        this.onTabStudio?.();
      } catch {
        /* ignore */
      }
      this._dispatch(msg.type, decodeFromRuntime(msg.payload))
        .then(async (result) => sendResponse({ ok: true, result: await forRuntime(result) }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    };
    chrome.runtime.onMessage.addListener(this._onRuntime);
  }

  /** Register a request handler: fn(payload) -> result | Promise<result>. */
  handle(type, fn) {
    this.handlers.set(type, fn);
  }

  /** Listen to events sent by the studio over the port. */
  onEvent(name, fn) {
    if (!this.eventListeners.has(name)) this.eventListeners.set(name, new Set());
    this.eventListeners.get(name).add(fn);
  }

  setPort(port) {
    this.port = port;
    this.ready = false; // until the studio acknowledges this port
    port.onmessage = (e) => this._onPortMessage(e.data);
    port.start?.();
  }

  /** The embedded studio frame went away (removed after it never answered): forget its port. */
  resetPort() {
    this.port = null;
    this.ready = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Studio closed'));
    }
    this.pending.clear();
  }

  get embeddedConnected() {
    return !!this.port && this.ready;
  }

  /** The embedded studio acknowledged the handshake: its handlers exist, deliver queued events in order. */
  markAcked() {
    this.markReady();
  }

  markReady() {
    if (this.ready || !this.port) return;
    this.ready = true;
    const queued = this.queue;
    this.queue = [];
    const now = Date.now();
    for (const q of queued) {
      if (q.transient && now - q.at > TRANSIENT_MAX_AGE_MS) continue; // too late to mean anything
      this._post(q.name, q.payload);
    }
    try {
      this.onReady?.();
    } catch (e) {
      console.warn('[gis] onReady failed', e);
    }
  }

  /** A standalone studio tab answered recently (it receives runtime broadcasts). */
  get tabStudioActive() {
    return this.tabStudioRecent(TAB_STUDIO_ACTIVE_MS);
  }

  tabStudioRecent(ms) {
    return Date.now() - this.tabStudioSeenAt < ms;
  }

  async _dispatch(type, payload) {
    const fn = this.handlers.get(type);
    if (!fn) throw new Error(`Unknown request: ${type}`);
    return fn(payload || {});
  }

  _post(name, payload) {
    try {
      this.port?.postMessage({ kind: 'evt', name, payload });
    } catch (e) {
      console.warn('[gis] could not post event', name, e);
    }
  }

  _onPortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'req') {
      this._dispatch(msg.type, msg.payload)
        .then((result) => this.port?.postMessage({ kind: 'res', id: msg.id, ok: true, result }))
        .catch((e) => this.port?.postMessage({ kind: 'res', id: msg.id, ok: false, error: String(e?.message || e) }));
    } else if (msg.kind === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    } else if (msg.kind === 'evt') {
      for (const fn of this.eventListeners.get(msg.name) || []) {
        try {
          fn(msg.payload);
        } catch (e) {
          console.error('[Imagine Studio] event handler failed', msg.name, e);
        }
      }
    }
  }

  /** Event to the embedded studio only (queued until it is ready). */
  emitPort(name, payload) {
    if (this.port && this.ready) {
      this._post(name, payload);
      return;
    }
    const transient = TRANSIENT.has(name);
    // Nobody will read a transient event later: no studio frame here, or a standalone studio tab already got it.
    if (transient && (!this.hasFrame() || this.tabStudioRecent(30000))) return;
    if (COALESCE.has(name)) this.queue = this.queue.filter((q) => q.name !== name);
    this.queue.push({ name, payload, at: Date.now(), transient });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  /** Removes queued (undelivered) events matching pred({name, payload}); returns how many. */
  dropQueued(pred) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => !pred(q));
    return before - this.queue.length;
  }

  /** Event to standalone studio tabs only (chrome.runtime broadcast; "no receiver" errors are ignored). */
  emitRuntime(name, payload) {
    let ok = true;
    try {
      ok = !!chrome.runtime?.id;
    } catch {
      ok = false;
    }
    if (!ok) return;
    forRuntime(payload)
      .then((encoded) => chrome.runtime.sendMessage({ gis: 'evt', name, payload: encoded }))
      .catch(() => {});
  }

  /**
   * Emit an event to the embedded studio (queued until ready), and broadcast it to a standalone studio tab while one
   * talks to this tab (a new one pulls the current state with its first requests).
   */
  emit(name, payload) {
    this.emitPort(name, payload);
    if (this.tabStudioActive) this.emitRuntime(name, payload);
  }

  /** Request to the embedded studio (page -> studio). */
  request(type, payload = {}, timeout = 10000) {
    if (!this.port || !this.ready) return Promise.reject(new Error('Studio not open'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ kind: 'req', id, type, payload });
    });
  }

  /**
   * Request to a standalone studio tab (it answers only if it targets this grok.com tab).
   * Resolves the result, or null when no studio tab answered within `timeout`.
   */
  async requestTab(type, payload = {}, timeout = 600) {
    try {
      if (!chrome.runtime?.id) return null;
      const res = await Promise.race([
        chrome.runtime.sendMessage({ gis: 'studio-req', type, payload: await forRuntime(payload) }),
        new Promise((r) => setTimeout(() => r(null), timeout)),
      ]);
      if (!res || !res.ok) return null;
      this.tabStudioSeenAt = Date.now();
      return decodeFromRuntime(res.result);
    } catch {
      return null;
    }
  }

  destroy() {
    try {
      chrome.runtime.onMessage.removeListener(this._onRuntime);
    } catch {
      /* context gone */
    }
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.queue = [];
  }
}
