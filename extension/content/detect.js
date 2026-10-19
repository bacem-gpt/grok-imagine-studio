// DOM media scanner for grok.com. Collects <video>/<img> candidates (see records.js for the rules) and feeds full
// snapshots to the Registry. Throttled: a MutationObserver (childList + src/poster attribute changes) and media
// load events schedule a scan; a cheap periodic check catches what the observers miss (a video's currentSrc,
// responsive images) and only then scans.
// Scans stay cheap on big feeds: candidates are memoised per element (rebuilt only when the element's URLs change),
// only cheap properties are read (no layout), and DOM prompt fallbacks are computed lazily, once per element, within
// a time budget per scan (the rest in the next scans): detail page meta/article text, descriptive alt text,
// feed-card text, the chat message before the media (one message index per scan, so long discussions stay linear).
// Page blob: videos learn from page-hook.js which media URL their bytes came from, and MediaSource streams (nothing
// to download) are only kept when their feed card names the post.
import { videoCandidate, imageCandidate, postIdFromPath, routeOf, plausiblePrompt, URL_RANK } from './records.js';
import { inlineText, precedingUserText, messageIndex } from './text.js';

const SCAN_THROTTLE_MS = 500;
const PERIODIC_MS = 2500;
const PROMPT_BUDGET_MS = 25; // DOM prompt work per scan; elements left over get theirs in the next scans
const PROMPT_RETRY_MS = 150;
const MAX_OBJECT_URLS = 600;
const EXCLUDE_SEL = '.query-bar, [contenteditable="true"], gis-studio-root';
const CARD_SEL = 'div[class*="media-post-masonry-card"], [role="listitem"]';
const MESSAGE_SEL = '[id^="response-"], .message-bubble, [data-message-author-role]';
const POST_LINK_SEL = 'a[href*="/imagine/post/"]';

function metaContent(names) {
  for (const n of names) {
    const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    const c = el?.getAttribute('content');
    if (c && c.trim()) return c.trim();
  }
  return null;
}

/** Longest leaf text inside the detail-page article (Grok prints the prompt under the video). */
function articlePrompt(el) {
  const art = el.closest('article') || document.querySelector('main article');
  if (!art) return null;
  const tagged = art.querySelector('[data-testid*="prompt" i], [class*="prompt" i]');
  const t = tagged && plausiblePrompt(inlineText(tagged), { min: 12 });
  if (t) return t;
  let best = '';
  let n = 0;
  for (const node of art.querySelectorAll('p, span, div, h1, h2, h3')) {
    if (++n > 400) break;
    if (node.childElementCount > 0 || node.closest('button, textarea, label, [role="button"], [role="menu"]')) continue;
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > best.length) best = text;
  }
  return plausiblePrompt(best, { min: 12 });
}

/** Absolute URL of the post page a feed card links to, or null. */
function postLinkFor(el) {
  const a = el.closest(POST_LINK_SEL) || el.closest(CARD_SEL)?.querySelector(POST_LINK_SEL);
  return a?.href || null;
}

function sourcesOf(v) {
  const out = [];
  for (const s of v.getElementsByTagName('source')) if (s.getAttribute('src')) out.push(s.src);
  return out;
}

/** What an <img> candidate depends on (it is rebuilt when this changes). */
const imageSig = (img) => `${img.currentSrc || img.src || ''}|${img.getAttribute('alt') || ''}|${img.complete ? `${img.naturalWidth}x${img.naturalHeight}` : '-'}`;

export class Detector {
  /**
   * @param {{registry: import('./registry.js').Registry, onChange: () => void, onScan?: () => void}} opts
   *   onChange: the PageMedia list changed; onScan: after every scan (element references may have changed).
   */
  constructor({ registry, onChange, onScan }) {
    this.registry = registry;
    this.onChange = onChange;
    this.onScan = onScan;
    this.promptCache = new WeakMap(); // element -> prompt string | null
    this.memo = new WeakMap(); // element -> {sig, cand}: the URL part of its candidate, rebuilt when sig changes
    this.objectUrls = new Map(); // page blob: URL -> {mse, source} (from page-hook.js)
    this.objVersion = 0;
    this.msgIndex = null; // chat messages of the scan in progress (built on first use)
    this.promptSpent = 0; // ms of DOM prompt work in the scan in progress
    this.promptDeferred = false;
    this.timer = null;
    this.lastScan = 0;
    this.running = false;
    this._onMutations = this._onMutations.bind(this);
    this._onLoad = this._onLoad.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.observer = new MutationObserver(this._onMutations);
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'poster', 'srcset', 'alt'],
    });
    // load / loadedmetadata / durationchange do not bubble but can be captured at the document.
    document.addEventListener('load', this._onLoad, true);
    document.addEventListener('loadedmetadata', this._onLoad, true);
    document.addEventListener('durationchange', this._onLoad, true);
    this.interval = setInterval(() => {
      if (document.visibilityState === 'visible' && !this.timer && this.staleMedia()) this.scheduleScan(0);
    }, PERIODIC_MS);
    this.scanNow();
  }

  stop() {
    this.running = false;
    this.observer?.disconnect();
    document.removeEventListener('load', this._onLoad, true);
    document.removeEventListener('loadedmetadata', this._onLoad, true);
    document.removeEventListener('durationchange', this._onLoad, true);
    clearInterval(this.interval);
    clearTimeout(this.timer);
  }

  /** True while a scan is scheduled (the registry may not reflect the latest DOM changes yet). */
  get pending() {
    return !!this.timer;
  }

  /** Forget cached DOM prompts (the route changed, so meta tags / articles changed). */
  resetPrompts() {
    this.promptCache = new WeakMap();
  }

  /**
   * What page-hook.js learned about a page blob: URL: {mse: true} = a MediaSource stream (nothing to download),
   * {source} = the media URL its bytes were fetched from (validated by the caller).
   */
  noteObjectUrl(url, { mse = false, source = null } = {}) {
    if (typeof url !== 'string' || !url.startsWith('blob:')) return;
    this.objectUrls.delete(url);
    this.objectUrls.set(url, { mse: !!mse, source: source || null });
    while (this.objectUrls.size > MAX_OBJECT_URLS) this.objectUrls.delete(this.objectUrls.keys().next().value);
    this.objVersion++;
    this.scheduleScan(100);
  }

  /** True for a page blob: URL of a MediaSource stream. */
  isStreamUrl(url) {
    return !!this.objectUrls.get(url)?.mse;
  }

  _onMutations(records) {
    for (const r of records) {
      if (r.type === 'attributes') {
        const t = r.target;
        if (t.tagName === 'VIDEO' || t.tagName === 'IMG' || t.tagName === 'SOURCE') return this.scheduleScan();
        continue;
      }
      for (const n of r.addedNodes) if (n.nodeType === 1) return this.scheduleScan();
      for (const n of r.removedNodes) if (n.nodeType === 1) return this.scheduleScan();
    }
    return undefined;
  }

  _onLoad(e) {
    const t = e.target;
    if (t && (t.tagName === 'IMG' || t.tagName === 'VIDEO')) this.scheduleScan(120);
  }

  /** Throttled scan (trailing edge). */
  scheduleScan(delay = null) {
    if (!this.running || this.timer) return;
    const wait = delay ?? Math.max(0, SCAN_THROTTLE_MS - (Date.now() - this.lastScan));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scanNow();
    }, wait);
  }

  /** Scans synchronously; returns true when the registry changed. */
  scanNow() {
    clearTimeout(this.timer);
    this.timer = null;
    this.lastScan = Date.now();
    this.promptSpent = 0;
    this.promptDeferred = false;
    this.msgIndex = null;
    let changed = false;
    try {
      changed = this.registry.applyDom(this.collect());
    } catch (e) {
      console.warn('[gis] media scan failed', e);
    }
    this.msgIndex = null;
    if (this.promptDeferred) this.scheduleScan(PROMPT_RETRY_MS);
    if (changed) this.onChange?.();
    try {
      this.onScan?.();
    } catch (e) {
      console.warn('[gis] scan listener failed', e);
    }
    return changed;
  }

  /** Cheap check for media changes the observers do not report (no layout reads): true when a scan is due. */
  staleMedia() {
    const routePostId = routeOf(location.pathname) === 'post' ? postIdFromPath(location.pathname) : null;
    for (const v of document.getElementsByTagName('video')) if (this.memo.get(v)?.sig !== this._videoSig(v, routePostId)) return true;
    for (const img of document.getElementsByTagName('img')) if (this.memo.get(img)?.sig !== imageSig(img)) return true;
    return false;
  }

  /** True when this media element changed (src, poster …) since the last scan saw it. */
  isStale(el) {
    if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'IMG')) return false;
    const m = this.memo.get(el);
    if (!m) return true;
    if (el.tagName === 'IMG') return m.sig !== imageSig(el);
    return m.sig !== this._videoSig(el, routeOf(location.pathname) === 'post' ? postIdFromPath(location.pathname) : null);
  }

  /** DOM candidates in document order. */
  collect() {
    const origin = location.origin;
    const route = routeOf(location.pathname);
    const routePostId = route === 'post' ? postIdFromPath(location.pathname) : null;
    const out = [];
    for (const v of document.getElementsByTagName('video')) {
      try {
        const c = this._video(v, origin, route, routePostId);
        if (c) out.push(c);
      } catch {
        /* one odd element must not stop the scan */
      }
    }
    for (const img of document.getElementsByTagName('img')) {
      try {
        const c = this._image(img, origin, route, routePostId);
        if (c) out.push(c);
      } catch {
        /* ignore */
      }
    }
    // Blob-only videos (MediaSource streams, page blobs) take the post id of the feed card linking to them, unless
    // several of them link to the same post (the link then does not say which is which). A stream that nothing
    // names cannot be downloaded or matched to Grok's records: it is not page media.
    const links = new Map();
    for (const c of out) if (c.linkId) links.set(c.linkId, (links.get(c.linkId) || 0) + 1);
    return out.filter((c) => {
      if (c.linkId && links.get(c.linkId) === 1) c.postId = c.linkId;
      return !(c.mse && !c.postId);
    });
  }

  _memo(el, sig, build) {
    let m = this.memo.get(el);
    if (!m || m.sig !== sig) {
      m = { sig, cand: null };
      this.memo.set(el, m); // set first: an element whose build throws is not retried until it changes
      m.cand = build();
    }
    return m;
  }

  _videoSig(v, routePostId) {
    const src = v.getAttribute('src') || '';
    const cur = v.currentSrc || '';
    let sig = `${cur}|${src}|${v.getAttribute('poster') || ''}|${v.id}|${routePostId || ''}`;
    if (v.firstElementChild) sig += `|${sourcesOf(v).join(' ')}`;
    if (sig.includes('blob:')) sig += `|${this.objVersion}`; // what the hook knows about page blobs changes it too
    return sig;
  }

  _buildVideo(v, origin, routePostId) {
    const extra = [];
    let stream = null;
    // Page blob: URLs: add the media URL the bytes came from; leave MediaSource URLs out (they cannot be read).
    const known = (u) => {
      if (!u || !u.startsWith('blob:')) return u;
      const info = this.objectUrls.get(u);
      if (info?.source) extra.push(info.source);
      if (!info?.mse) return u;
      stream ||= u;
      return '';
    };
    const c = videoCandidate({
      src: known(v.getAttribute('src') ? v.src : ''),
      currentSrc: known(v.currentSrc || ''),
      sources: [...sourcesOf(v).map(known).filter(Boolean), ...extra],
      poster: v.getAttribute('poster') ? v.poster : '',
      id: v.id || '',
      routePostId,
      pageOrigin: origin,
    });
    if (c || !stream) return c;
    // Only a MediaSource stream: kept when its card names the post (collect()), merged with Grok's record of it.
    return { kind: 'video', urls: [{ url: stream, rank: URL_RANK.blob }], thumbUrl: null, postId: null, blobOnly: true, mse: true };
  }

  _video(v, origin, route, routePostId) {
    const m = this._memo(v, this._videoSig(v, routePostId), () => this._buildVideo(v, origin, routePostId));
    if (!m.cand || v.closest(EXCLUDE_SEL)) return null;
    const c = { ...m.cand };
    // Page blob: videos without any other identity: only when they look like content, not UI decoration.
    if (c.blobOnly && !c.postId && !v.closest(`${CARD_SEL}, article, ${MESSAGE_SEL}`)) return null;
    c.el = v;
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
    }
    if (Number.isFinite(v.duration) && v.duration > 0) c.duration = v.duration;
    const link = postLinkFor(v);
    if (link) {
      c.pageUrl = link;
      c.pageUrlRank = 2;
      if (c.blobOnly && !c.postId) c.linkId = postIdFromPath(link);
    } else if (route === 'post' && (v.id === 'hd-video' || v.id === 'sd-video' || (routePostId && c.postId === routePostId))) {
      c.pageUrl = location.href;
      c.pageUrlRank = 2;
    }
    c.promptFn = () => this._prompt(v, c, route, routePostId);
    return c;
  }

  _image(img, origin, route, routePostId) {
    const m = this._memo(img, imageSig(img), () => {
      if (!img.complete || !img.naturalWidth) return null; // not loaded yet: the load listener rescans
      const c = imageCandidate({
        src: img.currentSrc || img.src || '',
        alt: img.getAttribute('alt') || '',
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        pageOrigin: origin,
      });
      if (c?.kind === 'image') {
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
      }
      return c;
    });
    if (!m.cand || img.closest(EXCLUDE_SEL)) return null;
    const c = { ...m.cand };
    c.el = img;
    const link = postLinkFor(img);
    if (link) {
      c.pageUrl = link;
      c.pageUrlRank = 2;
    }
    c.promptFn = () => this._prompt(img, c, route, routePostId);
    return c;
  }

  _prompt(el, c, route, routePostId) {
    if (this.promptCache.has(el)) return this.promptCache.get(el);
    if (this.promptSpent > PROMPT_BUDGET_MS) {
      this.promptDeferred = true; // the next scan computes it
      return null;
    }
    const t0 = performance.now();
    let p = null;
    try {
      p = this._computePrompt(el, c, route, routePostId);
    } catch {
      p = null;
    }
    this.promptSpent += performance.now() - t0;
    this.promptCache.set(el, p);
    return p;
  }

  _computePrompt(el, c, route, routePostId) {
    // Detail page: the main media's prompt is in the meta description / under the video.
    if (route === 'post' && (el.id === 'hd-video' || el.id === 'sd-video' || (routePostId && c.postId === routePostId))) {
      const p = plausiblePrompt(metaContent(['og:description', 'twitter:description', 'description'])) || articlePrompt(el);
      if (p) return p;
    }
    const alt = plausiblePrompt(el.getAttribute('alt'), { min: 16 });
    if (alt) return alt;
    const card = el.closest(CARD_SEL);
    if (card) {
      const t = plausiblePrompt(inlineText(card), { min: 12, max: 1200 });
      if (t) return t;
    }
    if (el.closest(MESSAGE_SEL)) {
      this.msgIndex ||= messageIndex(document);
      return plausiblePrompt(precedingUserText(el, document, this.msgIndex), { min: 4, max: 1200 });
    }
    return null;
  }
}
