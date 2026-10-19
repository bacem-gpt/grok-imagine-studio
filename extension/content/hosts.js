// Cross-tab coordination between grok.com tabs (one content script per tab). A tab "hosts" a studio while its
// embedded studio iframe exists, or while a standalone studio tab is attached to it. A user action (hover "+ Bin",
// context menu) in a tab without a studio is relayed to the studio already running in another tab instead of
// booting one more hidden studio, and only one tab boots a hidden studio for auto-collect (see elect()).
//  - liveness: Web Locks. A hosting tab holds the lock 'gis-host:<id>'; the browser releases it when the tab
//    closes, crashes or navigates away, so dead tabs never look alive.
//  - metadata ({kind, open, ready, activeAt}) and relay messages: chrome.storage.local, which is private to the
//    extension (grok.com can neither read nor forge it). A relay is the key 'gis:relay:<msgId>' addressed to one tab,
//    answered with 'gis:relay-ack:<msgId>'; both keys are removed once handled. Leftovers are swept after a minute.
// Without Web Locks (or chrome.storage) everything degrades to "no other host": each tab uses its own studio.

const LOCK_PREFIX = 'gis-host:';
const META_PREFIX = 'gis:host:';
const RELAY_PREFIX = 'gis:relay:';
const ACK_PREFIX = 'gis:relay-ack:';
const ELECTION_LOCK = 'gis-host-election';
const SWEEP_MS = 60000;

/**
 * Best studio to relay to among live hosts (not this tab). Prefers an open panel, then a standalone studio tab, then
 * the most recently active one. needReady: only hosts whose studio finished booting.
 * @param {Array<{id: string, kind: 'embedded'|'tab', open?: boolean, ready?: boolean, activeAt?: number}>} hosts
 */
export function pickHost(hosts, selfId, { needReady = true } = {}) {
  const score = (h) => (h.open ? 4 : 0) + (h.kind === 'tab' ? 2 : 0);
  const list = (Array.isArray(hosts) ? hosts : []).filter((h) => h && h.id && h.id !== selfId && (h.kind === 'embedded' || h.kind === 'tab') && (!needReady || h.ready));
  list.sort((a, b) => score(b) - score(a) || (b.activeAt || 0) - (a.activeAt || 0));
  return list[0] || null;
}

const randomId = () => {
  try {
    return crypto.randomUUID().slice(0, 13);
  } catch {
    return Math.random().toString(36).slice(2, 15);
  }
};

export class Hosts {
  /**
   * @param {{storage?: object, onChanged?: object, locks?: object, onRelay?: (name: string, payload: any) => any,
   *          now?: () => number}} opts  storage/onChanged/locks default to chrome.storage.local, chrome.storage.onChanged
   *          and navigator.locks (injectable for tests). onRelay returns {ok, error?} (or a Promise of it).
   */
  constructor({ storage, onChanged, locks, onRelay = null, now = () => Date.now() } = {}) {
    this.storage = storage ?? globalThis.chrome?.storage?.local ?? null;
    this.onChangedApi = onChanged ?? globalThis.chrome?.storage?.onChanged ?? null;
    this.locks = locks ?? globalThis.navigator?.locks ?? null;
    this.onRelay = onRelay;
    this.now = now;
    this.id = randomId();
    this.meta = null; // what this tab advertises (null = not hosting)
    this.metaJson = '';
    this.release = null; // releases the host lock
    this.lockPromise = null;
    this.lockGen = 0; // invalidates a lock request that is granted after hosting ended
    this.waiting = new Map(); // ack key -> resolve
    this.seq = 0;
    this.lastSweep = 0;
    this.destroyed = false;
    this._onChanged = (changes, area) => this.onStorageChanged(changes, area);
    try {
      this.onChangedApi?.addListener(this._onChanged);
    } catch {
      /* extension context gone */
    }
  }

  get available() {
    return !!(this.storage && this.locks && !this.destroyed);
  }

  /**
   * Declares (meta object) or ends (null) hosting for this tab: holds the host lock and publishes the metadata.
   * Resolves once both are in place.
   */
  async setHosting(meta) {
    if (!this.available) return;
    if (!meta) {
      if (!this.meta && !this.release && !this.lockPromise) return;
      this.meta = null;
      this.metaJson = '';
      this.lockGen++;
      const release = this.release;
      this.release = null;
      this.lockPromise = null;
      release?.();
      await this.storage.remove(META_PREFIX + this.id).catch(() => {});
      return;
    }
    this.meta = { kind: meta.kind, open: !!meta.open, ready: !!meta.ready, activeAt: meta.activeAt || 0 };
    if (!this.lockPromise) {
      const gen = ++this.lockGen;
      this.lockPromise = new Promise((resolve) => {
        this.locks
          .request(LOCK_PREFIX + this.id, { mode: 'exclusive' }, () => {
            resolve(true);
            if (gen !== this.lockGen || !this.meta || this.destroyed) return undefined; // hosting ended meanwhile
            return new Promise((done) => {
              this.release = done;
            });
          })
          .catch(() => resolve(false));
      });
    }
    await this.lockPromise;
    if (!this.meta) return; // ended meanwhile
    const json = JSON.stringify(this.meta);
    if (json === this.metaJson) return;
    this.metaJson = json;
    await this.storage.set({ [META_PREFIX + this.id]: { ...this.meta, at: this.now() } }).catch(() => {});
  }

  /** Hosts that are alive right now: [{id, kind, open, ready, activeAt}] (this tab included when hosting). */
  async liveHosts() {
    if (!this.available) return [];
    let held = [];
    try {
      held = (await this.locks.query())?.held || [];
    } catch {
      return [];
    }
    const ids = [...new Set(held.map((l) => l?.name).filter((n) => typeof n === 'string' && n.startsWith(LOCK_PREFIX)).map((n) => n.slice(LOCK_PREFIX.length)))];
    let metas = {};
    if (ids.length) {
      try {
        metas = (await this.storage.get(ids.map((id) => META_PREFIX + id))) || {};
      } catch {
        metas = {};
      }
    }
    this.sweep(new Set(ids)).catch(() => {});
    return ids.map((id) => ({ id, ...(metas[META_PREFIX + id] || {}) })).filter((h) => h.kind);
  }

  /** Removes metadata of tabs that no longer hold their lock and relay keys nobody handled (at most once a minute). */
  async sweep(liveIds) {
    const now = this.now();
    if (now - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = now;
    const all = (await this.storage.get(null)) || {};
    const stale = [];
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(META_PREFIX) && !liveIds.has(k.slice(META_PREFIX.length))) stale.push(k);
      else if ((k.startsWith(RELAY_PREFIX) || k.startsWith(ACK_PREFIX)) && !(v && now - (v.at || 0) < SWEEP_MS)) stale.push(k);
    }
    if (stale.length) await this.storage.remove(stale);
  }

  /** Runs fn() while holding the cross-tab election lock (one tab at a time decides whether to become a host). */
  async elect(fn) {
    if (!this.available) return fn();
    let ran = false;
    try {
      return await this.locks.request(ELECTION_LOCK, { mode: 'exclusive' }, () => {
        ran = true;
        return fn();
      });
    } catch (e) {
      if (ran) throw e;
      console.warn('[gis] host election failed', e);
      return fn();
    }
  }

  /**
   * Sends an event to the studio hosted by tab `toId`. Resolves {ok, error?} once that tab handed it to its
   * studio, or {ok: false} after `timeout`.
   */
  relay(toId, name, payload, timeout = 2500) {
    if (!this.available || !toId) return Promise.resolve({ ok: false, error: 'unavailable' });
    const msgId = `${this.id}-${++this.seq}-${this.now().toString(36)}`;
    const relayKey = RELAY_PREFIX + msgId;
    const ackKey = ACK_PREFIX + msgId;
    return new Promise((resolve) => {
      let timer = null;
      const finish = (res) => {
        if (!this.waiting.has(ackKey)) return;
        clearTimeout(timer);
        this.waiting.delete(ackKey);
        this.storage.remove([relayKey, ackKey]).catch(() => {});
        resolve(res);
      };
      this.waiting.set(ackKey, (ack) => finish({ ok: !!ack?.ok, error: ack?.error || null }));
      timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeout);
      this.storage.set({ [relayKey]: { to: toId, from: this.id, name, payload, at: this.now() } }).catch((e) => finish({ ok: false, error: String(e?.message || e) }));
    });
  }

  onStorageChanged(changes, area) {
    if (area !== 'local' || !changes || this.destroyed) return;
    for (const [k, ch] of Object.entries(changes)) {
      const v = ch?.newValue;
      if (!v) continue;
      if (k.startsWith(ACK_PREFIX)) this.waiting.get(k)?.(v);
      else if (k.startsWith(RELAY_PREFIX) && v.to === this.id) this.handleRelay(k.slice(RELAY_PREFIX.length), v);
    }
  }

  async handleRelay(msgId, msg) {
    let res;
    try {
      res = this.onRelay ? await this.onRelay(msg.name, msg.payload, msg) : { ok: false, error: 'no handler' };
    } catch (e) {
      res = { ok: false, error: String(e?.message || e) };
    }
    try {
      await this.storage.set({ [ACK_PREFIX + msgId]: { ok: !!res?.ok, error: res?.error || null, at: this.now() } });
      await this.storage.remove(RELAY_PREFIX + msgId);
    } catch {
      /* extension context gone */
    }
  }

  destroy() {
    if (this.destroyed) return;
    try {
      this.onChangedApi?.removeListener(this._onChanged);
    } catch {
      /* context gone */
    }
    this.lockGen++;
    const release = this.release;
    this.release = null;
    release?.();
    try {
      this.storage?.remove(META_PREFIX + this.id)?.catch?.(() => {});
    } catch {
      /* context gone */
    }
    for (const fn of this.waiting.values()) fn({ ok: false, error: 'destroyed' });
    this.waiting.clear();
    this.destroyed = true;
  }
}
