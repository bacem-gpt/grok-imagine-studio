// Studio side of the page <-> studio channel (see shared/protocol.js for the message contract).
//   bridge.request(type, payload, {timeout}) -> Promise<result>
//   bridge.on(eventName, fn) -> off()
//   bridge.handle(type, fn)   answer requests coming from the page
//   bridge.connected / bridge.mode ('embedded' | 'tab' | 'none')

import { HANDSHAKE, HANDSHAKE_ACK, HANDSHAKE_TOKEN_REQUIRED, PROTOCOL_VERSION, encodeForRuntime, decodeFromRuntime } from '../../shared/protocol.js';
import { createEmitter } from './utils.js';

const GROK_URL_PATTERNS = ['https://grok.com/*'];

class Bridge {
  constructor() {
    this.mode = 'none';
    this.connected = false;
    this.port = null;
    this.tabId = null;
    this.pending = new Map();
    this.handlers = new Map();
    this.nextId = 1;
    this.emitter = createEmitter();
    this.status = createEmitter();
  }

  on(name, fn) {
    return this.emitter.on(name, fn);
  }

  onStatus(fn) {
    return this.status.on('change', fn);
  }

  handle(type, fn) {
    this.handlers.set(type, fn);
  }

  /** Embedded mode: wait for the content script's MessageChannel handshake. Tab mode: target the latest grok tab. */
  init() {
    if (this._initialized) return this;
    this._initialized = true;
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode') || (window.parent !== window ? 'embedded' : 'tab');
    if (mode === 'embedded') this._initEmbedded();
    else this._initTab();
    return this;
  }

  _setConnected(connected, mode) {
    this.connected = connected;
    this.mode = mode;
    this.status.emit('change', { connected, mode });
  }

  _initEmbedded() {
    this.mode = 'embedded';
    this._verified = new Set(); // handshake tokens the service worker confirmed for this tab
    let seq = 0;
    let adopted = 0; // sequence number of the handshake whose port is in use
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent || e.origin !== 'https://grok.com') return;
      if (!e.data || e.data.type !== HANDSHAKE || !e.ports?.[0]) return;
      const port = e.ports[0];
      const token = typeof e.data.token === 'string' && e.data.token.length <= 128 ? e.data.token : null;
      const n = ++seq;
      this._checkHandshake(token).then((ok) => {
        // Not from the content script (a page script cannot get a token), or older than the port in use.
        if (!ok || n < adopted) {
          if (!ok) console.warn('[gis] ignored a connection request the extension did not set up');
          port.close();
          return;
        }
        adopted = n;
        this._adoptPort(port);
      });
    });
  }

  /**
   * Whether a handshake comes from this tab's content script: its token must be one the service worker issued for
   * this tab. Without a token only while tokens are not required yet and no tokened handshake was accepted before.
   */
  async _checkHandshake(token) {
    if (!token) return !HANDSHAKE_TOKEN_REQUIRED && !this._verified.size;
    if (this._verified.has(token)) return true;
    try {
      const res = await chrome.runtime.sendMessage({ gis: 'studio-token-check', token });
      if (!res?.ok) return false;
      this._verified.add(token);
      return true;
    } catch {
      return false;
    }
  }

  _adoptPort(port) {
    if (this.port && this.port !== port) this.port.close();
    this.port = port;
    port.onmessage = (ev) => this._onPortMessage(ev.data);
    port.start?.();
    // Acknowledge only once the app registered its handlers (appReady()), so the page never sends
    // events into the void while the studio is still booting.
    if (this._appReady) this._ack();
    this._setConnected(true, 'embedded');
  }

  _ack() {
    try {
      this.port?.postMessage({ kind: 'evt', name: HANDSHAKE_ACK, payload: { version: PROTOCOL_VERSION } });
    } catch {
      /* port closed */
    }
  }

  /** Called by the app once every bridge.on()/handle() is registered: acknowledges the page connection. */
  appReady() {
    if (this._appReady) return;
    this._appReady = true;
    if (this.mode === 'embedded' && this.port) this._ack();
  }

  _initTab() {
    this.mode = 'tab';
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
      this._setConnected(false, 'none');
      return;
    }
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return false;
      if (msg.gis === 'evt' && sender.tab) {
        if (this.tabId == null || sender.tab.id === this.tabId) {
          if (this.tabId == null) {
            this.tabId = sender.tab.id;
            this._setConnected(true, 'tab');
          }
          this.emitter.emit(msg.name, decodeFromRuntime(msg.payload));
        }
        return false;
      }
      if (msg.gis === 'studio-req' && sender.tab && sender.tab.id === this.tabId) {
        const fn = this.handlers.get(msg.type);
        if (!fn) return false;
        Promise.resolve(fn(decodeFromRuntime(msg.payload)))
          .then(async (result) => sendResponse({ ok: true, result: await encodeForRuntime(result) }))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true;
      }
      return false;
    });
    this.findTab();
    setInterval(() => this.findTab(), 5000);
  }

  /** Tab mode: pick the most recently used grok.com tab. */
  async findTab() {
    try {
      const tabs = await chrome.tabs.query({ url: GROK_URL_PATTERNS });
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      const tab = tabs[0];
      const id = tab ? tab.id : null;
      if (id !== this.tabId || this.connected !== !!tab) {
        this.tabId = id;
        this._setConnected(!!tab, 'tab');
      }
    } catch {
      /* not available */
    }
  }

  _onPortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'Request failed'));
    } else if (msg.kind === 'evt') {
      this.emitter.emit(msg.name, msg.payload);
    } else if (msg.kind === 'req') {
      const fn = this.handlers.get(msg.type);
      const reply = (ok, resultOrError) =>
        this.port?.postMessage(ok ? { kind: 'res', id: msg.id, ok: true, result: resultOrError } : { kind: 'res', id: msg.id, ok: false, error: String(resultOrError) });
      if (!fn) return reply(false, `No handler for ${msg.type}`);
      Promise.resolve()
        .then(() => fn(msg.payload))
        .then((r) => reply(true, r), (e) => reply(false, e?.message || e));
    }
  }

  async request(type, payload = {}, { timeout = 20000 } = {}) {
    if (this.mode === 'embedded') {
      if (!this.port) throw new Error('Not connected to grok.com');
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
    if (this.mode === 'tab') {
      if (this.tabId == null) await this.findTab();
      if (this.tabId == null) throw new Error('Open grok.com in a tab first');
      const encoded = await encodeForRuntime(payload);
      const res = await Promise.race([
        chrome.tabs.sendMessage(this.tabId, { gis: 'req', type, payload: encoded }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${type} timed out`)), timeout)),
      ]);
      if (!res) throw new Error('grok.com tab did not answer (reload the tab)');
      if (!res.ok) throw new Error(res.error || 'Request failed');
      return decodeFromRuntime(res.result);
    }
    throw new Error('Not connected to grok.com');
  }

  /** Fire-and-forget event to the page (embedded mode only). */
  emit(name, payload) {
    if (this.mode === 'embedded' && this.port) this.port.postMessage({ kind: 'evt', name, payload });
  }
}

export const bridge = new Bridge();
