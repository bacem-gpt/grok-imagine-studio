// Validation of what the grok.com page side sends the studio (PageMedia, PageInfo, text). Pure (no DOM).
// The content script only reports media it found on Grok's hosts, but the studio cannot tell its messages from
// those of a script running on grok.com, so every payload is checked again here before anything reaches the bin,
// the library or a fetch: URLs must be https on a Grok media host (or a blob: URL owned by grok.com); only explicit
// user targets (hover / context-menu actions) may point at another http(s) site, and media.js fetches those through
// the page, never with the extension's privileges.
import { isGrokMediaHost } from '../../shared/grok-urls.js';

const MAX_URL = 4096;
const KINDS = new Set(['video', 'image']);
const SOURCES = new Set(['dom', 'network', 'both']);
const ROUTES = new Set(['imagine', 'post', 'favorites', 'chat', 'other']);
const DOCK_MODES = new Set(['right', 'bottom', 'float', 'max']);
const FLAGS = new Set(['pick', 'reject']);

const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The URL itself when it is an http(s) link (the only kind the studio stores, renders or fetches), else null. */
export function cleanHttpUrl(url) {
  if (typeof url !== 'string' || !url || url.length > MAX_URL) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** True for a grok.com page URL. */
export const isGrokPageUrl = (url) => typeof url === 'string' && url.length <= MAX_URL && /^https:\/\/grok\.com(\/|$)/.test(url);

/**
 * A media URL the page may hand over: https on a Grok media host, or a blob: URL owned by grok.com. userTarget
 * (the user picked that very element: hover button, context menu): any http(s) link as well.
 */
export function isPageMediaUrl(url, { userTarget = false } = {}) {
  if (typeof url !== 'string' || !url || url.length > MAX_URL) return false;
  if (url.startsWith('blob:')) return url.startsWith('blob:https://grok.com/');
  if (userTarget) return !!cleanHttpUrl(url);
  return /^https:\/\//i.test(url) && isGrokMediaHost(url);
}

/** Extra fields a newer content script may add: kept when they are small primitives. */
function extras(raw, known) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (known.has(k) || k === '__proto__') continue;
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 512)) out[k] = v;
  }
  return out;
}

const PAGE_MEDIA_FIELDS = new Set(['key', 'kind', 'url', 'altUrls', 'thumbUrl', 'postId', 'prompt', 'model', 'createdAt', 'width', 'height', 'duration', 'source', 'pageUrl', 'seenAt', 'fresh', 'aliases']);

/** A validated copy of a PageMedia (see shared/protocol.js), or null when it is unusable or points elsewhere. */
export function sanitizePageMedia(raw, { userTarget = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const ok = (u) => isPageMediaUrl(u, { userTarget });
  const key = str(raw.key, 512);
  if (!key || !KINDS.has(raw.kind) || !ok(raw.url)) return null;
  const out = {
    ...extras(raw, PAGE_MEDIA_FIELDS),
    key,
    kind: raw.kind,
    url: raw.url,
    altUrls: (Array.isArray(raw.altUrls) ? raw.altUrls : []).filter(ok).slice(0, 8),
    thumbUrl: ok(raw.thumbUrl) ? raw.thumbUrl : null,
    postId: str(raw.postId, 128),
    prompt: str(raw.prompt, 8000),
    model: str(raw.model, 128),
    createdAt: str(raw.createdAt, 64),
    width: num(raw.width),
    height: num(raw.height),
    duration: num(raw.duration),
    source: SOURCES.has(raw.source) ? raw.source : 'dom',
    pageUrl: isGrokPageUrl(raw.pageUrl) ? raw.pageUrl : '',
    seenAt: num(raw.seenAt) ?? 0,
  };
  if (typeof raw.fresh === 'boolean') out.fresh = raw.fresh;
  if (Array.isArray(raw.aliases)) out.aliases = raw.aliases.filter((a) => typeof a === 'string' && a && a.length <= 512).slice(0, 16);
  return out;
}

/** sanitizePageMedia() over a list (at most `max` items; invalid ones dropped). */
export function sanitizePageMediaList(list, opts = {}, max = 2000) {
  return (Array.isArray(list) ? list : []).slice(0, max).map((it) => sanitizePageMedia(it, opts)).filter(Boolean);
}

/** A validated PageInfo (null for garbage). */
export function sanitizePageInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    ...extras(raw, new Set(['url', 'title', 'route', 'composerFound'])),
    url: isGrokPageUrl(raw.url) ? raw.url : 'https://grok.com/',
    title: str(raw.title, 300) || '',
    route: ROUTES.has(raw.route) ? raw.route : 'other',
    composerFound: raw.composerFound === true,
  };
}

/** Text sent to the studio (selected text, prompt lists): a string of bounded length, else ''. */
export const sanitizeText = (text, max = 200000) => (typeof text === 'string' ? text.slice(0, max) : '');

/** 'pick' | 'reject' | null. */
export const sanitizeFlag = (flag) => (FLAGS.has(flag) ? flag : null);

/** A dock mode the overlay knows, else null. */
export const sanitizeDockMode = (mode) => (DOCK_MODES.has(mode) ? mode : null);

/**
 * URL fields of a media item from an imported project file: only http(s) (and inline data: media) links survive, so
 * nothing else is ever fetched or rendered as a link.
 */
export function sanitizeMediaUrls(m) {
  const media = (u) => cleanHttpUrl(u) || (typeof u === 'string' && /^data:(image|video|audio)\//i.test(u) ? u : null);
  return {
    ...m,
    sourceUrl: media(m.sourceUrl),
    altUrls: (Array.isArray(m.altUrls) ? m.altUrls : []).map(media).filter(Boolean),
    pageUrl: cleanHttpUrl(m.pageUrl),
  };
}
