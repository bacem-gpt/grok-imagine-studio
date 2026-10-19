// Pure helpers for recognising and normalising Grok Imagine media URLs. Shared by the content script and the studio.
// Known facts (2026): generated media is served from assets.grok.com (and assets.grokusercontent.com);
// shared/public posts from imagine-public.x.ai. Typical paths:
//   https://assets.grok.com/users/<uid>/generated/<postId>/generated_video.mp4
//   https://assets.grok.com/users/<uid>/generated/<postId>/preview_image.jpg   (thumbnail of a video post)
//   https://assets.grok.com/users/<uid>/generated/<postId>/image.jpg           (full image)
//   https://imagine-public.x.ai/imagine-public/share-videos/<id>_thumbnail.jpg -> <id>.mp4
// Grok's REST API (/rest/media/post/list) returns posts with mediaUrl / hdMediaUrl / mediaType / prompt / childPosts.

export const MEDIA_HOSTS = [
  'assets.grok.com',
  'assets.grokusercontent.com',
  'imagine-public.x.ai',
  'cdn.grok.com',
];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)(?:[?#]|$)/i;

/** Returns the last UUID found in the string (Grok post ids are UUIDs), lower-cased, or null. */
export function extractUuid(str) {
  if (!str) return null;
  const m = String(str).match(UUID_RE);
  return m ? m[m.length - 1].toLowerCase() : null;
}

/** Post id embedded in a ".../generated/<uuid>/..." path, else the last UUID. */
export function extractPostId(url) {
  if (!url) return null;
  const m = String(url).match(/\/generated\/([0-9a-f-]{36})\//i);
  return m ? m[1].toLowerCase() : extractUuid(url);
}

/** Make relative asset paths absolute ("users/..../generated_video.mp4" -> https://assets.grok.com/users/...). */
export function absolutize(url, base = 'https://grok.com/') {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  if (/^(https?:|blob:|data:)/i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (/^\/?users\/[^/]+\/generated\//i.test(u)) return 'https://assets.grok.com/' + u.replace(/^\//, '');
  try { return new URL(u, base).href; } catch { return null; }
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

export function isGrokMediaHost(url) {
  const h = hostOf(url);
  return MEDIA_HOSTS.some((m) => h === m || h.endsWith('.' + m)) || /(^|\.)grokusercontent\.com$/.test(h);
}

/** Heuristic: does this URL point at a generated media file (not an avatar / ui asset)? */
export function looksLikeMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('blob:')) return true;
  if (url.startsWith('data:image/') || url.startsWith('data:video/')) return true;
  if (/\/generated\//i.test(url) || /share-videos|share-images|imagine-public/i.test(url)) return true;
  if (isGrokMediaHost(url) && (VIDEO_EXT_RE.test(url) || IMAGE_EXT_RE.test(url))) return true;
  return false;
}

export function guessKindFromUrl(url, mime) {
  if (mime) {
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
  }
  if (!url) return null;
  if (/^data:video\//i.test(url) || VIDEO_EXT_RE.test(url) || /generated_video|share-videos/i.test(url)) return 'video';
  if (/^data:image\//i.test(url) || IMAGE_EXT_RE.test(url)) return 'image';
  if (/^data:audio\//i.test(url) || AUDIO_EXT_RE.test(url)) return 'audio';
  return null;
}

export function isThumbnailUrl(url) {
  return /_thumbnail\.(jpe?g|png|webp)|\/preview_image\.(jpe?g|png|webp)/i.test(url || '');
}

/** Video URL derived from a video post thumbnail URL, or null. */
export function videoFromThumbnail(url) {
  if (!url) return null;
  if (/_thumbnail\.(jpe?g|png|webp)/i.test(url)) return url.replace(/_thumbnail\.(jpe?g|png|webp)/i, '.mp4');
  if (/\/preview_image\.(jpe?g|png|webp)/i.test(url)) return url.replace(/\/preview_image\.(jpe?g|png|webp)/i, '/generated_video.mp4');
  return null;
}

/** Full-resolution image URL derived from a preview URL, or the URL itself. */
export function fullImageFromPreview(url) {
  if (!url) return url;
  return url.replace(/\/preview_image\.(jpe?g|png|webp)/i, '/image.jpg');
}

/** Identity used for de-duplication: strips hash and volatile query params, lower-cases host. */
export function normalizeUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url.slice(0, 96);
  if (url.startsWith('blob:')) return url;
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of ['cache', 'cb', 't', 'ts', '_', 'v', 'download']) u.searchParams.delete(p);
    u.hostname = u.hostname.toLowerCase();
    return u.href;
  } catch {
    return url.split('#')[0];
  }
}

/** Stable PageMedia key: prefers post id (+ kind, since an image post and its video share ids), else normalized URL. */
export function mediaKey({ postId, url, kind }) {
  if (postId) return `${kind || 'media'}:${postId}`;
  return `url:${normalizeUrl(url)}`;
}

/** Filename-safe slug from a prompt or name. */
export function slugify(text, max = 60) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .toLowerCase() || 'untitled';
}
