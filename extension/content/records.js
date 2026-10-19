// Pure helpers for the grok.com content script (no DOM, no chrome.* — unit-tested in Node):
//  - URL validation (which remote URLs may be handed to the studio)
//  - normalisation of the compact network records posted by page-hook.js
//  - DOM candidate factories for <video> / <img> elements (fed with plain values read from the DOM)
//  - ad-hoc PageMedia for context-menu targets that were never detected
import {
  absolutize,
  isGrokMediaHost,
  guessKindFromUrl,
  isThumbnailUrl,
  videoFromThumbnail,
  looksLikeMediaUrl,
  mediaKey,
  extractUuid,
} from '../shared/grok-urls.js';

/**
 * URL quality ranks: the best-ranked URL becomes PageMedia.url, the rest altUrls (best first). An explicit HD
 * source (API hdMediaUrl, detail page video#hd-video) beats any plain URL; API URLs beat DOM ones of the same
 * quality; URLs derived from a thumbnail are guesses; page blob: URLs only work while the page lives.
 */
export const URL_RANK = Object.freeze({ netHd: 6, domHd: 5, net: 4, dom: 3, derived: 2, blob: 1 });

const GEN_ID_RE = /\/generated\/([0-9a-z][0-9a-z_-]{5,63})(?:\/|$)/i;
const ID_RE = /^[0-9A-Za-z_-]{6,64}$/;
const UUID_FULL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXCLUDED_ALT_RE = /^(pfp|moderated|avatar|profile( picture| photo| image)?|user avatar)$/i;
const UI_PATH_RE = /profile|avatar|pfp|favicon|\/logo/i;
// Grok's own showcase catalogues (e.g. imagine-public.x.ai/agent-skills/photo_edit/*.jpg on the logged-out Imagine page,
// seen live 2026-10-19): template thumbnails with instruction prompts, not generated media.
const CATALOG_PATH_RE = /\/(agent-skills|skills|templates|presets|examples|showcase|onboarding)\//i;
// On imagine-public.x.ai only shared/generated paths are user media.
const PUBLIC_MEDIA_PATH_RE = /\/generated\/|\/imagine-public\/|share-(videos|images)/i;

const cleanStr = (v, max = 4000) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+\n/g, '\n').slice(0, max) : null);
const posNum = (v) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v) || null;
  return null;
};

/** Normalised post id (UUIDs lower-cased) or null. */
export function cleanId(v) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string' || !ID_RE.test(v)) return null;
  return UUID_FULL_RE.test(v) ? v.toLowerCase() : v;
}

/** Post id embedded in a generated-asset or public-share URL; null for anything else (never a user id). */
export function postIdFromUrl(url) {
  if (!url || typeof url !== 'string' || url.startsWith('blob:') || url.startsWith('data:')) return null;
  const m = GEN_ID_RE.exec(url);
  if (m) return cleanId(m[1]);
  if (/imagine-public|share-videos|share-images/i.test(url)) return extractUuid(url);
  return null;
}

/** Post id of a /imagine/post/<id> page path, or null. */
export function postIdFromPath(pathname) {
  const m = /\/imagine\/post\/([0-9a-z][0-9a-z_-]{5,63})/i.exec(pathname || '');
  return m ? cleanId(m[1]) : null;
}

/** Route name of a grok.com path (see PageInfo.route). */
export function routeOf(pathname = '/') {
  const p = pathname || '/';
  if (p.startsWith('/imagine/post/')) return 'post';
  if (p.startsWith('/imagine/favorites') || p.startsWith('/imagine/saved')) return 'favorites';
  if (p.startsWith('/imagine')) return 'imagine';
  if (p.startsWith('/c/') || p === '/' || p.startsWith('/chat')) return 'chat';
  return 'other';
}

/**
 * True for URLs the content script may hand to the studio automatically: https on a Grok media host, or a blob:
 * URL owned by the page. (Records from the page world are untrusted; this keeps them from pointing the studio at
 * arbitrary origins.)
 */
export function isAllowedMediaUrl(url, pageOrigin = 'https://grok.com') {
  if (typeof url !== 'string' || url.length > 4096) return false;
  if (url.startsWith('blob:')) return url.startsWith(`blob:${pageOrigin}/`);
  if (!/^https:\/\//i.test(url)) return false;
  return isGrokMediaHost(url);
}

const FILE_LIKE_RE = /\.(mp4|webm|mov|m4v|jpe?g|png|webp|gif|avif)$/i;

// isMediaAssetUrl runs for every URL found on the page (it parses URLs): memoised.
const ASSET_CACHE_MAX = 10000;
const assetCache = new Map();

/**
 * Stricter than isAllowedMediaUrl, for media found automatically (DOM scan, network records): the same rules as
 * page-hook.js mediaUrl(). Asset hosts (assets.grok.com, *.grokusercontent.com, imagine-public.x.ai) serve
 * generated media; other grok.com hosts (cdn.grok.com is Grok's static/UI CDN) only count for /generated/ or
 * share-* paths, so decorative images and looping UI videos never become page media.
 */
export function isMediaAssetUrl(url, pageOrigin = 'https://grok.com') {
  if (typeof url !== 'string') return false;
  const key = `${pageOrigin} ${url}`;
  let v = assetCache.get(key);
  if (v === undefined) {
    v = mediaAssetCheck(url, pageOrigin);
    if (assetCache.size >= ASSET_CACHE_MAX) assetCache.delete(assetCache.keys().next().value);
    assetCache.set(key, v);
  }
  return v;
}

function mediaAssetCheck(url, pageOrigin) {
  if (!isAllowedMediaUrl(url, pageOrigin)) return false;
  if (url.startsWith('blob:')) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (UI_PATH_RE.test(path) || CATALOG_PATH_RE.test(path)) return false;
  if ((host === 'imagine-public.x.ai' || host.endsWith('.imagine-public.x.ai')) && !PUBLIC_MEDIA_PATH_RE.test(path)) return false;
  const generated = /\/generated\//i.test(path) || /share-(videos|images)/i.test(path);
  const assetHost =
    host === 'assets.grok.com' || host === 'imagine-public.x.ai' || host.endsWith('.imagine-public.x.ai') || host === 'grokusercontent.com' || host.endsWith('.grokusercontent.com');
  if (assetHost) return generated || FILE_LIKE_RE.test(path);
  return generated;
}

/** ISO string for an API timestamp (ISO string, epoch seconds or ms), else null. */
export function toIso(v) {
  if (v == null || v === '') return null;
  let d = null;
  if (typeof v === 'number' && Number.isFinite(v)) d = new Date(v < 1e11 ? v * 1000 : v);
  else if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{9,13}$/.test(s)) d = new Date(Number(s) < 1e11 ? Number(s) * 1000 : Number(s));
    else d = new Date(s);
  } else if (v && typeof v === 'object' && Number.isFinite(v.seconds)) d = new Date(v.seconds * 1000);
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y > 2000 && y < 2200 ? d.toISOString() : null;
}

/**
 * Validates and normalises a raw record posted by page-hook.js into a NetRecord:
 * {kind, url, hdUrl, thumbUrl, derived, postId, apiPostId, parentId, prompt, model, createdAt, width, height, duration, live}
 * postId is the best known id (API id, else the asset folder id); apiPostId only the id the API record itself
 * carried (authoritative for PageMedia keys). Returns null when the record has no usable Grok media URL.
 */
export function normalizeNetRecord(raw, pageOrigin = 'https://grok.com') {
  if (!raw || typeof raw !== 'object') return null;
  const fix = (u) => {
    if (typeof u !== 'string' || !u) return null;
    const abs = absolutize(u, `${pageOrigin}/`);
    return abs && !abs.startsWith('blob:') && isMediaAssetUrl(abs, pageOrigin) ? abs : null;
  };
  let url = fix(raw.url);
  let hdUrl = fix(raw.hdUrl);
  const thumbUrl = fix(raw.thumbUrl);
  let kind = raw.kind === 'video' || raw.kind === 'image' ? raw.kind : null;
  const mime = cleanStr(raw.mime, 80);
  if (!kind) {
    const g = guessKindFromUrl(hdUrl || url || '', mime || undefined);
    if (g === 'video' || g === 'image') kind = g;
  }
  let derived = false;
  if (!url && !hdUrl && thumbUrl && isThumbnailUrl(thumbUrl)) {
    url = videoFromThumbnail(thumbUrl);
    kind = 'video';
    derived = true;
  }
  if (!kind && thumbUrl && isThumbnailUrl(thumbUrl)) kind = 'video';
  if (kind !== 'video' && kind !== 'image') return null;
  if (!url && !hdUrl) return null;
  if (!url) {
    url = hdUrl;
    hdUrl = null;
  }
  if (hdUrl === url) hdUrl = null;
  // page-hook.js sends apiId only for ids read from the record's own id fields (postId / videoId / id ...).
  const apiPostId = cleanId(raw.apiId);
  const postId = apiPostId || cleanId(raw.postId) || postIdFromUrl(hdUrl || url) || postIdFromUrl(thumbUrl);
  return {
    kind,
    url,
    hdUrl,
    thumbUrl: thumbUrl || (kind === 'image' ? url : null),
    derived,
    postId,
    apiPostId,
    parentId: cleanId(raw.parentId),
    prompt: cleanStr(raw.prompt),
    model: cleanStr(raw.model, 80),
    createdAt: toIso(raw.createdAt),
    width: posNum(raw.width),
    height: posNum(raw.height),
    duration: posNum(raw.duration),
    live: raw.live === true, // a generation result streamed while the user waited (always "new")
  };
}

/**
 * DOM candidate for a <video> element, from plain values the DOM reports (absolute URLs).
 * Returns {kind: 'video', urls: [{url, rank}], thumbUrl, postId, blobOnly} or null when nothing looks generated.
 * On a detail page, #hd-video ranks above #sd-video and both fall back to the post id of the route.
 */
export function videoCandidate({ src = '', currentSrc = '', sources = [], poster = '', id = '', routePostId = null, pageOrigin = 'https://grok.com' } = {}) {
  const urls = [];
  const add = (u, rank) => {
    if (!u) return;
    const hit = urls.find((x) => x.url === u);
    if (hit) hit.rank = Math.max(hit.rank, rank);
    else urls.push({ url: u, rank });
  };
  const isDetail = id === 'hd-video' || id === 'sd-video';
  for (const s of [currentSrc, src, ...sources]) {
    if (!s || typeof s !== 'string') continue;
    if (s.startsWith('blob:')) {
      if (s.startsWith(`blob:${pageOrigin}/`)) add(s, URL_RANK.blob);
      continue;
    }
    if (!isMediaAssetUrl(s, pageOrigin)) continue;
    const kind = guessKindFromUrl(s);
    if (kind === 'image' || kind === 'audio') continue;
    if (!looksLikeMediaUrl(s) && !kind) continue;
    add(s, id === 'hd-video' ? URL_RANK.domHd : URL_RANK.dom);
  }
  poster = unwrapProxyUrl(poster);
  const posterOk = poster && typeof poster === 'string' && !poster.startsWith('blob:') && isMediaAssetUrl(poster, pageOrigin) ? poster : null;
  if (posterOk && isThumbnailUrl(posterOk)) add(videoFromThumbnail(posterOk), URL_RANK.derived);
  if (!urls.length) return null;
  urls.sort((a, b) => b.rank - a.rank);
  const firstHttp = urls.find((u) => !u.url.startsWith('blob:'));
  let postId = postIdFromUrl(firstHttp?.url) || postIdFromUrl(posterOk);
  let idFromRoute = false;
  if (!postId && isDetail && routePostId) {
    postId = routePostId;
    idFromRoute = true;
  }
  return { kind: 'video', urls, thumbUrl: posterOk, postId, idFromRoute, blobOnly: !firstHttp };
}

/**
 * Original asset URL behind an image-optimizer URL (Next.js `/_next/image?url=…`, Cloudflare `/cdn-cgi/image/…`),
 * or the input unchanged.
 */
export function unwrapProxyUrl(src) {
  if (!src || typeof src !== 'string' || src.startsWith('blob:') || src.startsWith('data:')) return src;
  try {
    const u = new URL(src);
    if (/\/_next\/image\/?$/.test(u.pathname)) {
      const inner = u.searchParams.get('url');
      return inner ? new URL(inner, u.origin).href : src;
    }
    const cf = /\/cdn-cgi\/image\/[^/]+\/(.+)$/.exec(u.pathname);
    if (cf) return new URL(/^https?:/i.test(cf[1]) ? cf[1] : `/${cf[1]}`, u.origin).href;
  } catch {
    /* not a URL */
  }
  return src;
}

/** True for alt texts that mark avatars / moderated placeholders (never media). */
export const isExcludedAlt = (alt) => EXCLUDED_ALT_RE.test(String(alt || '').trim());

/**
 * DOM candidate for an <img>. Generated images need a natural size of at least 160 px; video thumbnails
 * (preview_image / _thumbnail) become video candidates with the image as thumbnail.
 */
export function imageCandidate({ src = '', alt = '', naturalWidth = 0, naturalHeight = 0, pageOrigin = 'https://grok.com' } = {}) {
  if (isExcludedAlt(alt)) return null;
  src = unwrapProxyUrl(src);
  if (!src || typeof src !== 'string' || src.startsWith('blob:') || src.startsWith('data:')) return null;
  if (!isMediaAssetUrl(src, pageOrigin) || !looksLikeMediaUrl(src)) return null;
  const postId = postIdFromUrl(src);
  if (isThumbnailUrl(src)) {
    if (naturalWidth < 48 || naturalHeight < 48) return null;
    return { kind: 'video', urls: [{ url: videoFromThumbnail(src), rank: URL_RANK.derived }], thumbUrl: src, postId, fromThumb: true };
  }
  if (guessKindFromUrl(src) === 'video') return null;
  if (naturalWidth < 160 || naturalHeight < 160) return null;
  return { kind: 'image', urls: [{ url: src, rank: URL_RANK.dom }], thumbUrl: src, postId };
}

/**
 * PageMedia for an explicit user target (context menu) that the registry does not know. User-initiated, so any
 * http(s) URL is accepted (the studio still needs permission to fetch non-Grok hosts).
 * kind: 'video' | 'image' | null; preferImage keeps a thumbnail as an image (ingredients).
 */
export function adhocPageMedia({ url, kind = null, pageUrl = '', pageOrigin = 'https://grok.com', now = Date.now(), prompt = null, preferImage = false } = {}) {
  const abs = typeof url === 'string' ? absolutize(url, `${pageOrigin}/`) : null;
  if (!abs || !(/^https?:\/\//i.test(abs) || abs.startsWith(`blob:${pageOrigin}/`))) return null;
  let k = kind === 'video' || kind === 'image' ? kind : guessKindFromUrl(abs);
  let mediaUrl = abs;
  let thumbUrl = null;
  if (!preferImage && isThumbnailUrl(abs)) {
    k = 'video';
    mediaUrl = videoFromThumbnail(abs);
    thumbUrl = abs;
  }
  if (preferImage) k = 'image';
  if (k !== 'video' && k !== 'image') return null;
  const postId = postIdFromUrl(mediaUrl) || postIdFromUrl(thumbUrl);
  return {
    key: mediaKey({ postId, url: mediaUrl, kind: k }),
    kind: k,
    url: mediaUrl,
    altUrls: [],
    thumbUrl: thumbUrl || (k === 'image' ? mediaUrl : null),
    postId,
    prompt: cleanStr(prompt),
    model: null,
    createdAt: null,
    width: null,
    height: null,
    duration: null,
    source: 'dom',
    pageUrl: pageUrl || '',
    seenAt: now,
  };
}

/** Rejects generic site texts so they are not mistaken for prompts (meta descriptions, labels). */
export function plausiblePrompt(text, { min = 8, max = 4000 } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < min || t.length > max) return null;
  if (/^(grok( imagine)?|imagine|explore|untitled|image|video|thumbnail( \d+)?|generated (image|video)|moderated|pfp|loading…?|share|download)$/i.test(t)) return null;
  if (/\b(xAI|Grok is (an?|your))\b/.test(t) && t.length < 200) return null;
  return t;
}
