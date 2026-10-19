// Registry of media detected on the current grok.com page. Pure (no DOM): page elements are opaque references,
// so the merge rules are unit-testable in Node.
//
// Two feeds:
//  - applyDom(candidates)  — the DOM scanner's full snapshot (detect.js); marks entries present / absent
//  - applyNet(records)     — normalised network records (page-hook.js -> network.js -> records.js)
// Entries are merged by URL (any known URL of an entry) and by post id, so one clip seen as <video>, as a thumbnail
// <img> and in an API response is ONE PageMedia.
//
// Keys (PageMedia.key) do not depend on what arrives first: `${kind}:${apiPostId}` once Grok's API named the post,
// else `${kind}:${postId}` from the asset's /generated/<id>/ folder (or the detail-page route), else
// `url:${normalizedUrl}`. When a stronger identity shows up later (the API record after the DOM card), the entry is
// re-keyed — merged into an entry that already has that key if there is one — and keeps its earlier keys as aliases.
// PageMedia.aliases lists every key the same media could have had in another session ("already in the bin").
//
// Freshness (PageMedia.fresh) and seenAt:
//  - fresh = a new generation that appeared while this page session was open: a streamed generation result
//    (record.live), or an API createTime after the session started (corrected by the clock skew estimated from the
//    responses' Date headers; FRESH_TOLERANCE_MS of slack outside settle windows), or — with no createTime at all —
//    media that appeared after a settle window within GEN_WINDOW_MS of a generation signal (a prompt submitted on
//    grok.com).
//  - fresh media: seenAt = its first detection time (DOM order among media found in the same scan).
//  - everything else (on the page when it loaded or after an SPA navigation, older posts loaded by infinite scroll …):
//    seenAt lies OLD_OFFSET_MS before the session, in page order (settle windows are resequenced by DOM position,
//    later finds follow in detection order). So `seenAt >= <any studio start time>` (the studio's auto-collect, the
//    prompts take watcher) only ever matches fresh media, and "newest first" still follows the page.
// Dating is remembered per key for the whole session (a clip that scrolls away, or is pruned and comes back, keeps it).
// After an SPA navigation, prune() drops entries that are no longer in the DOM and were not confirmed by a network
// response around the navigation.
import { normalizeUrl as normalizeUrlUncached } from '../shared/grok-urls.js';
import { URL_RANK, postIdFromUrl } from './records.js';

// Every scan looks up every URL of every candidate: normalising (URL parsing) is memoised.
const NORM_CACHE_MAX = 20000;
const normCache = new Map();
function normalizeUrl(url) {
  if (!url) return '';
  let v = normCache.get(url);
  if (v === undefined) {
    v = normalizeUrlUncached(url);
    if (normCache.size >= NORM_CACHE_MAX) normCache.delete(normCache.keys().next().value);
    normCache.set(url, v);
  }
  return v;
}

const MAX_URLS = 8;
const MAX_MEMORY = 5000;
const MAX_NET_CACHE = 4000;
const MAX_ALIASES = 12;
export const NAV_GRACE_MS = 2000;
/** Media that was already there is dated this long before the session (see header). */
export const OLD_OFFSET_MS = 30 * 24 * 60 * 60 * 1000;
/** An API createTime this much earlier than the session start still counts as new (outside settle windows). */
export const FRESH_TOLERANCE_MS = 2 * 60 * 1000;
/** Media without any createTime that appears this soon after a generation signal counts as new. */
export const GEN_WINDOW_MS = 10 * 60 * 1000;
const REDATE_MS = 5000; // an entry reported as new may still turn out old this soon after it became new
const MAX_SKEW_MS = 24 * 60 * 60 * 1000;

const round3 = (v) => Math.round(v * 1000) / 1000;
const idKey = (kind, id) => `${kind}:${id}`;
const urlKey = (url) => `url:${normalizeUrl(url)}`;

/** The URL a URL-keyed entry is named after: the plain media URL (not HD, not derived from a poster, not blob:). */
function canonicalUrl(ranked) {
  const http = ranked.filter((u) => u.url && !u.url.startsWith('blob:'));
  return (http.find((u) => u.rank !== URL_RANK.derived && u.rank !== URL_RANK.domHd && u.rank !== URL_RANK.netHd) || http[0] || ranked[0])?.url || null;
}

export class Registry {
  /**
   * @param {{now?: () => number, pageUrl?: () => string, unreadable?: (url: string) => boolean}} opts
   *   unreadable: URLs nothing can download (a page's MediaSource stream): kept for matching, never offered as an
   *   alternate URL (only as the URL when nothing else is known).
   */
  constructor({ now = () => Date.now(), pageUrl = () => '', unreadable = null } = {}) {
    this.now = now;
    this.pageUrl = pageUrl;
    this.unreadable = unreadable;
    this.entries = new Map(); // key -> entry
    this.urlIndex = new Map(); // normalized url -> {key, kind}   (also the session's identity memory)
    this.aliasIndex = new Map(); // earlier key -> current key
    this.memory = new Map(); // key -> dating snapshot (session memory)
    this.netCache = new Map(); // 'k:<kind>:<postId>' | 'u:<url>' -> NetRecord (enriches later DOM detections)
    this.elKey = new WeakMap(); // element -> key (rebuilt by every DOM pass)
    this.navAt = 0;
    this.version = 0; // bumps whenever the PageMedia list would change
    this.sessionStart = now();
    this.oldBase = this.sessionStart - 1000 - OLD_OFFSET_MS; // seenAt base for media that was already there
    this.seqCounter = 0; // detection order
    this.settleUntil = 0;
    this.settleWindow = 0;
    this.windowSeq0 = 0;
    this.signalAt = -Infinity; // last generation signal (prompt submitted)
    this.skew = 0; // local clock minus server clock (ms), estimated from Date headers
    this.skewKnown = false;
    this._pass = null; // DOM pass in progress (re-keys move its element lists)
  }

  // -------------------------------------------------------------------------------------------------------
  // Session state
  // -------------------------------------------------------------------------------------------------------

  /** Starts a settle window (page load / SPA navigation): media found until it ends was already on the page. */
  beginSettle(ms = 4000, now = this.now()) {
    this.settleWindow++;
    this.settleUntil = now + ms;
    this.windowSeq0 = this.seqCounter;
  }

  /** Ends the settle window early (what appears next is not "already on the page"). */
  endSettle() {
    this.settleUntil = 0;
  }

  /** A prompt was submitted on grok.com: media without a createTime that appears soon after is a new generation. */
  signalGeneration(now = this.now()) {
    this.signalAt = now;
    this.endSettle();
  }

  /**
   * One server-time observation: `serverDate` (a response's Date header) received at local time `clientAt`.
   * Keeps the smallest offset (latency and the header's 1 s resolution only ever add to it). Returns true when
   * that changed which media counts as new.
   */
  noteServerTime(clientAt, serverDate) {
    const s = typeof serverDate === 'string' ? Date.parse(serverDate) : NaN;
    if (!Number.isFinite(s) || !Number.isFinite(clientAt)) return false;
    const sample = clientAt - s;
    if (Math.abs(sample) > MAX_SKEW_MS || (this.skewKnown && sample >= this.skew)) return false;
    this.skew = sample;
    this.skewKnown = true;
    const v0 = this.version;
    const now = this.now();
    for (const e of this.entries.values()) this._classify(e, now);
    return this.version !== v0;
  }

  _settling(now) {
    return now <= this.settleUntil;
  }

  get size() {
    return this.entries.size;
  }

  _touch() {
    this.version++;
  }

  // -------------------------------------------------------------------------------------------------------
  // Entries, keys, aliases
  // -------------------------------------------------------------------------------------------------------

  _remember(e) {
    this.memory.delete(e.key);
    this.memory.set(e.key, {
      apiId: e.apiId,
      guessId: e.guessId,
      seq: e.seq,
      bornAt: e.bornAt,
      scanIdx: e.scanIdx,
      window: e.window,
      signal: e.signal,
      live: e.live,
      fresh: e.fresh,
      freshAt: e.freshAt,
    });
    if (this.memory.size > MAX_MEMORY) this.memory.delete(this.memory.keys().next().value);
  }

  _create(key, kind, { now = this.now(), scanIdx = 0, settle = false } = {}) {
    const mem = this.memory.get(key);
    const e = {
      key,
      kind,
      apiId: mem?.apiId || null, // post id named by Grok's API (authoritative)
      guessId: mem?.guessId || null, // post id from the asset folder / detail-page route
      urlKey: key.startsWith('url:') ? key : null,
      aliases: new Set(), // earlier keys of this entry
      urls: new Map(), // normalized -> {url, rank}
      thumbUrl: null,
      thumbRank: 0,
      prompt: null,
      promptRank: 0, // 1 = DOM fallback, 2 = network
      model: null,
      createdAt: null,
      createdMs: null, // createTime in server-clock ms
      width: null,
      height: null,
      dimsRank: 0, // 1 = network, 2 = decoded element
      duration: null,
      pageUrl: this.pageUrl() || null,
      pageUrlRank: 0,
      // dating (restored from the session memory when this key was seen before)
      seq: mem ? mem.seq : this.seqCounter++,
      bornAt: mem ? mem.bornAt : now,
      scanIdx: mem ? mem.scanIdx : scanIdx,
      window: mem ? mem.window : settle ? this.settleWindow : 0, // settle window it was found in (0 = after one)
      signal: mem ? mem.signal : !settle && now - this.signalAt <= GEN_WINDOW_MS,
      live: mem ? mem.live : false,
      fresh: mem ? mem.fresh : false,
      freshAt: mem ? mem.freshAt : 0,
      inDom: false,
      everDom: false,
      fromNet: false,
      netAt: 0,
      shownBeforeNav: false,
      els: [],
    };
    this.entries.set(key, e);
    this._remember(e);
    this._touch();
    return e;
  }

  /** Current key for a key or one of its aliases. */
  resolveKey(key) {
    if (!key) return null;
    if (this.entries.has(key)) return key;
    const cur = this.aliasIndex.get(key);
    return cur && this.entries.has(cur) ? cur : null;
  }

  _entry(key) {
    const k = this.resolveKey(key);
    return k ? this.entries.get(k) : null;
  }

  /** Entry known under one of these URLs (same kind), or the key the session already gave them. */
  _lookup(urls, kind) {
    for (const u of urls) {
      if (!u) continue;
      const hit = this.urlIndex.get(normalizeUrl(u));
      if (!hit || hit.kind !== kind) continue;
      const cur = this.resolveKey(hit.key);
      if (cur) return { entry: this.entries.get(cur), key: cur };
      return { entry: null, key: this.aliasIndex.get(hit.key) || hit.key };
    }
    return { entry: null, key: null };
  }

  _keyFor(kind, apiId, guessId, canon) {
    if (apiId) return idKey(kind, apiId);
    if (guessId) return idKey(kind, guessId);
    return canon ? urlKey(canon) : null;
  }

  /** The entry under `key` if it holds media of this kind (URL keys carry no kind). */
  _entryOfKind(key, kind) {
    const e = this.entries.get(key) || this.entries.get(`${key}#${kind}`);
    return e && e.kind === kind ? e : null;
  }

  /** `key`, or a kind-qualified variant when another kind already holds that (URL) key. */
  _kindSafeKey(key, kind) {
    const e = this.entries.get(key);
    return e && e.kind !== kind ? `${key}#${kind}` : key;
  }

  /** API id of a cached network record for these URLs / this post id (picks the right key for DOM-first media). */
  _cachedApiId(urls, guessId, kind) {
    if (guessId) {
      const r = this.netCache.get(`k:${kind}:${guessId}`);
      if (r?.apiPostId) return r.apiPostId;
    }
    for (const u of urls) {
      const r = u && this.netCache.get(`u:${normalizeUrl(u)}`);
      if (r && r.kind === kind && r.apiPostId) return r.apiPostId;
    }
    return null;
  }

  _alias(e, oldKey) {
    if (!oldKey || oldKey === e.key) return;
    e.aliases.add(oldKey);
    this.aliasIndex.set(oldKey, e.key);
    for (const a of e.aliases) this.aliasIndex.set(a, e.key);
    while (this.aliasIndex.size > MAX_MEMORY * 2) this.aliasIndex.delete(this.aliasIndex.keys().next().value);
  }

  _reindex(e) {
    for (const norm of e.urls.keys()) this.urlIndex.set(norm, { key: e.key, kind: e.kind });
  }

  /** Re-keys an entry to the key its identity calls for; returns the entry that now holds it. */
  _ensureKey(e, depth = 0) {
    const want = e.apiId ? idKey(e.kind, e.apiId) : e.guessId ? idKey(e.kind, e.guessId) : e.urlKey || e.key;
    if (want === e.key || depth > 2) return e;
    const old = e.key;
    const other = this.entries.get(want);
    if (other && other !== e) return this._ensureKey(this._absorb(other, e), depth + 1);
    this.entries.delete(old);
    e.key = want;
    this.entries.set(want, e);
    this._alias(e, old);
    this._reindex(e);
    this._remember(e);
    this._touch();
    return e;
  }

  /** Merges entry `src` into `target` (they turned out to be the same media). Returns target. */
  _absorb(target, src) {
    // Unlink src first: copying its URLs below must not find it again.
    if (this.entries.get(src.key) === src) this.entries.delete(src.key);
    this._alias(target, src.key);
    for (const a of src.aliases) this._alias(target, a);
    for (const { url, rank } of src.urls.values()) this._addUrl(target, url, rank);
    for (const el of src.els) if (!target.els.includes(el)) target.els.push(el);
    if (!target.apiId && src.apiId) target.apiId = src.apiId;
    if (!target.guessId && src.guessId) target.guessId = src.guessId;
    if (!target.urlKey && src.urlKey) target.urlKey = src.urlKey;
    if (src.thumbUrl && src.thumbRank > target.thumbRank) {
      target.thumbUrl = src.thumbUrl;
      target.thumbRank = src.thumbRank;
    }
    if (src.prompt && src.promptRank > target.promptRank) {
      target.prompt = src.prompt;
      target.promptRank = src.promptRank;
    }
    if (!target.model && src.model) target.model = src.model;
    if (!target.createdAt && src.createdAt) {
      target.createdAt = src.createdAt;
      target.createdMs = src.createdMs;
    }
    if (src.width && src.height && src.dimsRank > target.dimsRank) {
      target.width = src.width;
      target.height = src.height;
      target.dimsRank = src.dimsRank;
    }
    if (!target.duration && src.duration) target.duration = src.duration;
    if (src.pageUrl && src.pageUrlRank > target.pageUrlRank) {
      target.pageUrl = src.pageUrl;
      target.pageUrlRank = src.pageUrlRank;
    }
    // Dating: the earlier detection wins.
    if (src.bornAt < target.bornAt) {
      target.bornAt = src.bornAt;
      target.scanIdx = src.scanIdx;
      target.window = src.window;
      target.signal = src.signal;
    }
    target.seq = Math.min(target.seq, src.seq);
    target.live = target.live || src.live;
    if (src.fresh && !target.fresh) {
      target.fresh = true;
      target.freshAt = src.freshAt;
    }
    target.inDom = target.inDom || src.inDom;
    target.everDom = target.everDom || src.everDom;
    target.fromNet = target.fromNet || src.fromNet;
    target.shownBeforeNav = target.shownBeforeNav || src.shownBeforeNav;
    target.netAt = Math.max(target.netAt, src.netAt);
    this._reindex(target);
    const pass = this._pass;
    if (pass?.touched.has(src)) {
      pass.touched.delete(src);
      pass.touched.add(target);
      const moved = pass.els.get(src) || [];
      pass.els.delete(src);
      const list = pass.els.get(target) || [];
      for (const el of moved) if (!list.includes(el)) list.push(el);
      pass.els.set(target, list);
    }
    this._classify(target, this.now());
    this._remember(target);
    this._touch();
    return target;
  }

  _addUrl(e, url, rank) {
    if (!url) return;
    const norm = normalizeUrl(url);
    const cur = e.urls.get(norm);
    if (!cur || rank > cur.rank) {
      if (!cur && e.urls.size >= MAX_URLS) {
        let low = null;
        for (const [k, v] of e.urls) if (!low || v.rank < low[1].rank) low = [k, v];
        if (low && low[1].rank >= rank) return;
        if (low) e.urls.delete(low[0]);
      }
      e.urls.set(norm, { url, rank });
      this._touch();
    }
    const idx = this.urlIndex.get(norm);
    if (!idx || idx.key !== e.key) {
      // The URL belonged to another live entry of the same kind: they are the same media, merge it in.
      const otherKey = idx && idx.kind === e.kind ? this.resolveKey(idx.key) : null;
      const other = otherKey ? this.entries.get(otherKey) : null;
      this.urlIndex.set(norm, { key: e.key, kind: e.kind });
      if (this.urlIndex.size > MAX_MEMORY * 2) this.urlIndex.delete(this.urlIndex.keys().next().value);
      if (other && other !== e) this._absorb(e, other);
    }
  }

  _set(e, field, value) {
    if (value == null || value === '' || e[field] === value) return;
    e[field] = value;
    this._touch();
  }

  // -------------------------------------------------------------------------------------------------------
  // Freshness
  // -------------------------------------------------------------------------------------------------------

  _evidenceFresh(e) {
    if (e.live) return true;
    if (Number.isFinite(e.createdMs)) return e.createdMs + this.skew >= this.sessionStart - (e.window ? 0 : FRESH_TOLERANCE_MS);
    if (e.window) return false;
    return !!e.signal;
  }

  /** Re-evaluates whether an entry is a new generation. Returns true when that changed. */
  _classify(e, now = this.now()) {
    const want = this._evidenceFresh(e);
    if (want === e.fresh) return false;
    if (want) {
      e.fresh = true;
      e.freshAt = now;
    } else {
      if (now - e.freshAt > REDATE_MS) return false; // reported as new for a while already: keep it stable
      e.fresh = false;
    }
    this._remember(e);
    this._touch();
    return true;
  }

  _seenAt(e) {
    return e.fresh ? e.bornAt - e.scanIdx / 1000 : this.oldBase - e.seq / 1000;
  }

  // -------------------------------------------------------------------------------------------------------
  // DOM feed
  // -------------------------------------------------------------------------------------------------------

  /**
   * Applies a full DOM snapshot. Candidate: {kind, urls: [{url, rank}], thumbUrl, postId, width, height, duration,
   * pageUrl, pageUrlRank, prompt | promptFn, el}. Returns true when the PageMedia list changed.
   */
  applyDom(cands, now = this.now()) {
    const v0 = this.version;
    const settling = this._settling(now);
    const pass = { touched: new Set(), els: new Map() };
    this._pass = pass;
    let scanIdx = 0;
    try {
      for (const c of cands) {
        if (!c || !Array.isArray(c.urls) || !c.urls.length || (c.kind !== 'video' && c.kind !== 'image')) continue;
        const urls = c.urls.map((u) => u && u.url).filter((u) => typeof u === 'string' && u);
        if (!urls.length) continue;
        const guessId = typeof c.postId === 'string' && c.postId ? c.postId : null;
        let { entry: e, key } = this._lookup(urls, c.kind);
        if (!e) {
          key = key || this._keyFor(c.kind, this._cachedApiId(urls, guessId, c.kind), guessId, canonicalUrl(c.urls));
          e = this._entryOfKind(key, c.kind) || this._create(this._kindSafeKey(key, c.kind), c.kind, { now, scanIdx: scanIdx++, settle: settling });
          this._enrichFromCache(e, urls, guessId, now);
        }
        if (guessId && !e.guessId) e.guessId = guessId;
        this._mergeDom(e, c);
        e = this._ensureKey(e);
        if (!e.everDom) {
          e.everDom = true;
          this._touch();
        }
        pass.touched.add(e);
        let list = pass.els.get(e);
        if (!list) pass.els.set(e, (list = []));
        if (c.el && !list.includes(c.el)) list.push(c.el);
        this._classify(e, now);
      }
    } finally {
      this._pass = null;
    }
    const elKey = new WeakMap();
    for (const e of this.entries.values()) {
      const list = pass.els.get(e);
      if (list) {
        e.inDom = true;
        e.els = list;
        for (const el of list) elKey.set(el, e.key);
      } else if (e.inDom || e.els.length) {
        e.inDom = false;
        e.els = [];
      }
    }
    this.elKey = elKey;
    if (settling) this._resequence(pass.touched);
    return this.version !== v0;
  }

  /** Settle window: order the window's entries by page position (DOM order first, then network-only ones). */
  _resequence(touched) {
    const inWindow = (e) => e && this.entries.get(e.key) === e && e.window === this.settleWindow;
    const domOrder = [...touched].filter(inWindow);
    const rest = [...this.entries.values()].filter((e) => inWindow(e) && !touched.has(e)).sort((a, b) => a.seq - b.seq);
    let i = this.windowSeq0;
    for (const e of [...domOrder, ...rest]) {
      if (e.seq !== i) {
        e.seq = i;
        this._remember(e);
        if (!e.fresh) this._touch();
      }
      i++;
    }
    this.seqCounter = Math.max(this.seqCounter, i);
  }

  _mergeDom(e, c) {
    for (const u of c.urls) if (u && u.url) this._addUrl(e, u.url, u.rank);
    if (c.thumbUrl && e.thumbRank <= 2 && (e.thumbRank < 2 || !e.thumbUrl)) {
      this._set(e, 'thumbUrl', c.thumbUrl);
      e.thumbRank = 2;
    }
    if (c.width > 0 && c.height > 0) {
      this._set(e, 'width', c.width);
      this._set(e, 'height', c.height);
      e.dimsRank = 2;
    }
    if (c.duration > 0 && Number.isFinite(c.duration) && (!e.duration || Math.abs(e.duration - c.duration) > 0.05)) this._set(e, 'duration', round3(c.duration));
    const pr = c.pageUrlRank || 1;
    if (c.pageUrl && pr > e.pageUrlRank) {
      this._set(e, 'pageUrl', c.pageUrl);
      e.pageUrlRank = pr;
    }
    if (e.promptRank < 1) {
      let p = c.prompt || null;
      if (!p && typeof c.promptFn === 'function') {
        try {
          p = c.promptFn();
        } catch {
          p = null;
        }
      }
      if (p) {
        this._set(e, 'prompt', p);
        e.promptRank = 1;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Network feed
  // -------------------------------------------------------------------------------------------------------

  /** Applies normalised network records (see records.normalizeNetRecord). Returns true when the list changed. */
  applyNet(records, now = this.now()) {
    const v0 = this.version;
    const settling = this._settling(now);
    let scanIdx = 0;
    for (const r of records) {
      if (!r || (r.kind !== 'video' && r.kind !== 'image') || !(r.url || r.hdUrl)) continue;
      this._cacheNet(r, now);
      const urls = [r.hdUrl, r.url].filter(Boolean);
      let { entry: e, key } = this._lookup(urls, r.kind);
      if (!e) {
        key = key || this._keyFor(r.kind, r.apiPostId || null, this._guessOf(r), r.url || r.hdUrl);
        e = this._entryOfKind(key, r.kind) || this._create(this._kindSafeKey(key, r.kind), r.kind, { now, scanIdx: scanIdx++, settle: settling && !r.live });
      }
      e.netAt = now;
      this._mergeNet(e, r);
      e = this._ensureKey(e);
      this._classify(e, now);
    }
    return this.version !== v0;
  }

  _guessOf(r) {
    if (!r.apiPostId) return r.postId || null;
    return postIdFromUrl(r.hdUrl || r.url) || postIdFromUrl(r.thumbUrl) || null;
  }

  _mergeNet(e, r) {
    if (!e.fromNet) {
      e.fromNet = true;
      this._touch();
    }
    if (r.hdUrl) this._addUrl(e, r.hdUrl, URL_RANK.netHd);
    if (r.url) this._addUrl(e, r.url, r.derived ? URL_RANK.derived : URL_RANK.net);
    if (r.apiPostId && !e.apiId) {
      e.apiId = r.apiPostId;
      this._touch();
    }
    const guess = this._guessOf(r);
    if (guess && !e.guessId) e.guessId = guess;
    if (r.prompt) {
      this._set(e, 'prompt', r.prompt);
      e.promptRank = 2;
    }
    if (r.model) this._set(e, 'model', r.model);
    if (r.createdAt && !e.createdAt) {
      const c = Date.parse(r.createdAt);
      this._set(e, 'createdAt', r.createdAt);
      e.createdMs = Number.isFinite(c) ? c : null;
    }
    if (r.live && !e.live) {
      e.live = true;
      this._touch();
    }
    if (r.width && r.height && e.dimsRank < 2) {
      this._set(e, 'width', r.width);
      this._set(e, 'height', r.height);
      e.dimsRank = 1;
    }
    if (r.duration && !e.duration) this._set(e, 'duration', round3(r.duration));
    if (r.thumbUrl && e.thumbRank < 1) {
      this._set(e, 'thumbUrl', r.thumbUrl);
      e.thumbRank = 1;
    }
  }

  _cacheNet(r, now) {
    const keys = new Set();
    if (r.postId) keys.add(`k:${r.kind}:${r.postId}`);
    if (r.apiPostId) keys.add(`k:${r.kind}:${r.apiPostId}`);
    for (const u of [r.url, r.hdUrl]) if (u) keys.add(`u:${normalizeUrl(u)}`);
    for (const k of keys) {
      const prev = this.netCache.get(k);
      const merged = prev ? { ...prev } : { at: now };
      for (const [f, v] of Object.entries(r)) {
        if (v == null || v === '') continue;
        if (f === 'live') merged.live = merged.live === true || v === true;
        else if (merged[f] == null || f === 'prompt' || f === 'hdUrl') merged[f] = v;
      }
      merged.at = now;
      this.netCache.delete(k);
      this.netCache.set(k, merged);
    }
    while (this.netCache.size > MAX_NET_CACHE) this.netCache.delete(this.netCache.keys().next().value);
  }

  _enrichFromCache(e, urls, guessId = null, now = this.now()) {
    const hits = new Set();
    for (const id of [e.apiId, guessId]) {
      const r = id && this.netCache.get(`k:${e.kind}:${id}`);
      if (r) hits.add(r);
    }
    for (const u of urls) {
      const r = u && this.netCache.get(`u:${normalizeUrl(u)}`);
      if (r && r.kind === e.kind) hits.add(r);
    }
    for (const r of hits) {
      this._mergeNet(e, r);
      e.netAt = Math.max(e.netAt, Math.min(r.at || 0, now));
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------------------------------------

  /** Call on SPA navigation; prune() later removes what the new page no longer shows. */
  navigate(now = this.now()) {
    this.navAt = now;
    for (const e of this.entries.values()) e.shownBeforeNav = e.everDom;
  }

  /**
   * Drops entries absent from the DOM, except network-only records that arrived around the navigation and were
   * never shown on the previous page (the data Grok fetched for the new page).
   */
  prune() {
    let removed = 0;
    for (const [k, e] of this.entries) {
      if (e.inDom) continue;
      if (!e.shownBeforeNav && e.netAt && e.netAt >= this.navAt - NAV_GRACE_MS) continue;
      this.entries.delete(k);
      removed++;
    }
    if (removed) this._touch();
    return removed;
  }

  // -------------------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------------------

  /** Every other key the same media could carry (earlier keys, id keys, URL keys of its non-blob URLs). */
  _aliasesOf(e) {
    const out = new Set(e.aliases);
    if (e.apiId) out.add(idKey(e.kind, e.apiId));
    if (e.guessId) out.add(idKey(e.kind, e.guessId));
    for (const norm of e.urls.keys()) if (!norm.startsWith('blob:') && !norm.startsWith('data:')) out.add(`url:${norm}`);
    out.delete(e.key);
    return [...out].slice(0, MAX_ALIASES);
  }

  _toPageMedia(e) {
    let ranked = [...e.urls.values()].sort((a, b) => b.rank - a.rank);
    if (this.unreadable && ranked.length > 1) {
      const readable = ranked.filter((u) => !this.unreadable(u.url));
      if (readable.length) ranked = readable;
    }
    return {
      key: e.key,
      kind: e.kind,
      url: ranked[0]?.url || null,
      altUrls: ranked.slice(1).map((x) => x.url),
      thumbUrl: e.thumbUrl || null,
      postId: e.apiId || e.guessId || null,
      prompt: e.prompt || null,
      model: e.model || null,
      createdAt: e.createdAt || null,
      width: e.width || null,
      height: e.height || null,
      duration: e.duration || null,
      source: e.everDom ? (e.fromNet ? 'both' : 'dom') : 'network',
      pageUrl: e.pageUrl || this.pageUrl() || '',
      seenAt: this._seenAt(e),
      fresh: !!e.fresh,
      aliases: this._aliasesOf(e),
    };
  }

  /** Current PageMedia[] — newest first. */
  list() {
    return [...this.entries.values()].map((e) => this._toPageMedia(e)).sort((a, b) => b.seenAt - a.seenAt);
  }

  /** PageMedia for a key (or an alias of it), or null. */
  get(key) {
    const e = this._entry(key);
    return e ? this._toPageMedia(e) : null;
  }

  has(key) {
    return !!this.resolveKey(key);
  }

  /** The key and every alias of an entry (internal entry from iterEntries()). */
  keysOf(e) {
    return e ? [e.key, ...this._aliasesOf(e)] : [];
  }

  keyForElement(el) {
    const k = (el && this.elKey.get(el)) || null;
    return k ? this.resolveKey(k) : null;
  }

  /** Elements currently showing the media (may be empty for network-only items). */
  elementsFor(key) {
    return this._entry(key)?.els.slice() || [];
  }

  /** Key of the entry owning this URL (any of its URLs), or null. */
  findByUrl(url) {
    if (!url) return null;
    const hit = this.urlIndex.get(normalizeUrl(url));
    return hit ? this.resolveKey(hit.key) : null;
  }

  /** Iterates live entries (internal shape; read-only use). */
  *iterEntries() {
    yield* this.entries.values();
  }
}
