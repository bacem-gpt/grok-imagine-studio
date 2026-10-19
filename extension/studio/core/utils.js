// Small framework-free helpers shared across the studio. Pure unless noted.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const round3 = (v) => Math.round(v * 1000) / 1000;
export const EPS = 1e-6;

let idCounter = 0;
/** Short unique id with a type prefix, e.g. uid('clp') -> "clp_lq3x9a_4f2k". */
export function uid(prefix = 'id') {
  idCounter = (idCounter + 1) % 1679616;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rnd}`;
}

/** 75.5 -> "1:15.50" (or "1:15:12" frames when fps given and opts.frames). */
export function formatTime(seconds, { fps = 30, frames = false, hours = false } = {}) {
  if (!Number.isFinite(seconds)) seconds = 0;
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const whole = Math.floor(s + EPS);
  let tail;
  if (frames) {
    const f = Math.min(fps - 1, Math.floor((s - whole) * fps + 1e-4));
    tail = ':' + String(f).padStart(2, '0');
  } else {
    const cs = Math.min(99, Math.floor((s - whole) * 100 + 1e-4));
    tail = '.' + String(cs).padStart(2, '0');
  }
  const mm = h > 0 || hours ? String(m).padStart(2, '0') : String(m);
  const head = h > 0 || hours ? `${h}:${mm}` : mm;
  return `${neg ? '-' : ''}${head}:${String(whole).padStart(2, '0')}${tail}`;
}

/** Short human duration: 4.2 -> "4.2s", 75 -> "1:15". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Parses "1:15.5", "75.5", "1:02:03.25", "00:01:15:12@30fps" (frames when fps given and 4 parts). */
export function parseTime(text, fps = 30) {
  if (typeof text === 'number') return text;
  const t = String(text || '').trim();
  if (!t) return NaN;
  const parts = t.split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return NaN;
  const nums = parts.map(Number);
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 4) return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / fps;
  return NaN;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/**
 * Debounced fn. d.flush(...args) runs it now (with these args, else with the pending call's args; nothing when no
 * call is pending and no args are given). d.pending: a call is waiting. d.cancel() drops it.
 */
export function debounce(fn, ms) {
  let timer = null;
  let pendingArgs = null;
  const d = (...args) => {
    pendingArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const a = pendingArgs;
      pendingArgs = null;
      timer = null;
      fn(...a);
    }, ms);
  };
  d.flush = (...args) => {
    clearTimeout(timer);
    timer = null;
    const a = args.length ? args : pendingArgs;
    pendingArgs = null;
    return a ? fn(...a) : undefined;
  };
  d.cancel = () => {
    clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };
  Object.defineProperty(d, 'pending', { get: () => pendingArgs !== null });
  return d;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    pending = args;
    if (now - last >= ms) {
      last = now;
      fn(...pending);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...pending);
      }, ms - (now - last));
    }
  };
}

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
  return true;
}

/** Runs async tasks with a concurrency limit. Returns results in input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A queue that runs at most `limit` async jobs at a time. queue.push(() => promise) -> promise. */
export function createQueue(limit = 2) {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < limit && waiting.length) {
      const { job, resolve, reject } = waiting.shift();
      active++;
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return {
    push(job) {
      return new Promise((resolve, reject) => {
        waiting.push({ job, resolve, reject });
        pump();
      });
    },
    get size() {
      return waiting.length + active;
    },
  };
}

/** Tiny event emitter. */
export function createEmitter() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => map.get(name)?.delete(fn);
    },
    off(name, fn) {
      map.get(name)?.delete(fn);
    },
    emit(name, payload) {
      for (const fn of [...(map.get(name) || [])]) {
        try {
          fn(payload);
        } catch (e) {
          console.error('[gis] listener error', name, e);
        }
      }
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a DOM/media event once, with optional timeout (DOM helper). */
export function once(target, event, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const onEvent = (e) => {
      cleanup();
      resolve(e);
    };
    const onError = (e) => {
      cleanup();
      reject(e?.error || new Error(`${event} failed`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      if (event !== 'error') target.removeEventListener('error', onError);
    };
    target.addEventListener(event, onEvent, { once: true });
    if (event !== 'error') target.addEventListener('error', onError, { once: true });
    if (timeoutMs) timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
  });
}

/**
 * Trigger a browser download of a Blob (DOM helper). Uses chrome.downloads when available. The name goes through
 * sanitizeFilename(); should Chrome still reject it ("Invalid filename"), the download is retried once under a plain
 * ASCII version of the name instead of failing.
 */
export async function downloadBlob(blob, filename, { saveAs = false } = {}) {
  const url = URL.createObjectURL(blob);
  const name = sanitizeFilename(filename);
  try {
    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
      try {
        await chrome.downloads.download({ url, filename: name, saveAs, conflictAction: 'uniquify' });
      } catch (e) {
        if (!/file ?name/i.test(String(e?.message || e))) throw e;
        await chrome.downloads.download({ url, filename: asciiFilename(name), saveAs, conflictAction: 'uniquify' });
      }
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

let graphemeSegmenter;
/** Splits text into grapheme clusters (user-perceived characters: an emoji with modifiers / ZWJ stays whole). */
export function splitGraphemes(text) {
  const s = String(text ?? '');
  if (graphemeSegmenter === undefined) {
    try {
      graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      graphemeSegmenter = null;
    }
  }
  if (!graphemeSegmenter) return Array.from(s); // code points: never splits a surrogate pair
  return Array.from(graphemeSegmenter.segment(s), (x) => x.segment);
}

const utf8Length = (s) => new TextEncoder().encode(s).length;

/** Longest prefix of `s` made of whole grapheme clusters that fits in maxBytes of UTF-8. */
function truncateUtf8(s, maxBytes) {
  if (utf8Length(s) <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const g of splitGraphemes(s)) {
    const b = utf8Length(g);
    if (bytes + b > maxBytes) break;
    out += g;
    bytes += b;
  }
  return out;
}

// What Chrome's downloads API (and Windows/macOS/Linux file systems) refuse in a file name.
const FILENAME_ILLEGAL = /[\\/:*?"<>|]+/g;
// Control and format characters (ZWJ, ZWSP, LRM/RLM, bidi embeddings and isolates, BOM, tag characters…), lone
// surrogates, line/paragraph separators, non-characters.
const FILENAME_INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\uFDD0-\uFDEF]/gu;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(\.|$)/i;
const SHELL_MAGIC = /^(desktop\.ini|thumbs\.db)$/i;

/**
 * A file name every download target accepts, keeping it as readable as possible: invisible / control characters
 * and reserved punctuation go, leading dots, tildes and spaces and trailing dots and spaces are trimmed, Windows
 * device names (CON, NUL, COM1… also as "CON.txt") get a leading "_", and long names are shortened by whole
 * characters (emoji stay intact) to at most maxBytes of UTF-8 — the extension is always kept.
 */
export function sanitizeFilename(name, { fallback = 'file', maxBytes = 200 } = {}) {
  let s = String(name ?? '').normalize('NFC');
  s = Array.from(s.replace(/\s+/g, ' ')) // tabs / line breaks / exotic spaces become plain spaces first
    .filter((ch) => (ch.codePointAt(0) & 0xfffe) !== 0xfffe) // U+FFFE / U+FFFF in every plane
    .join('')
    .replace(FILENAME_INVISIBLE, '')
    .replace(FILENAME_ILLEGAL, '_')
    .replace(/ {2,}/g, ' ');
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(s);
  let base = m ? s.slice(0, m.index) : s;
  let ext = m ? m[1] : '';
  if (/^(lnk|local)$/i.test(ext)) ext += '_'; // shell-integrated extensions are refused
  base = base.replace(/^[\s.~]+/, '').replace(/[\s.]+$/, '');
  if (/\.\{[^.]*\}$/.test(base) && !ext) base = base.replace(/[{}]/g, '_'); // a CLSID-like "extension"
  if (WINDOWS_DEVICE.test(base) || SHELL_MAGIC.test(ext ? `${base}.${ext}` : base)) base = `_${base}`;
  base = truncateUtf8(base, Math.max(16, maxBytes - (ext ? ext.length + 1 : 0))).replace(/[\s.]+$/, '');
  if (!base) base = fallback;
  return ext ? `${base}.${ext}` : base;
}

/** Plain ASCII variant of a (sanitized) file name: accents dropped, other characters become "-". */
export function asciiFilename(name, fallback = 'file') {
  const s = sanitizeFilename(name, { fallback });
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(s);
  const base = (m ? s.slice(0, m.index) : s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _()-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '');
  return sanitizeFilename(`${base || fallback}${m ? m[0] : ''}`, { fallback });
}

export function extFromMime(mime, fallback = 'bin') {
  const map = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'image/png': 'png', 'image/jpeg': 'jpg',
    'image/webp': 'webp', 'image/gif': 'gif', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'weba', 'audio/flac': 'flac',
    'application/json': 'json', 'text/plain': 'txt', 'text/csv': 'csv',
  };
  return map[(mime || '').split(';')[0]] || fallback;
}

/** Copy text to clipboard (DOM helper). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Copy an image Blob to clipboard as PNG (DOM helper). */
export async function copyImage(blob) {
  let png = blob;
  if (blob.type !== 'image/png') {
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    png = await c.convertToBlob({ type: 'image/png' });
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export function pluralize(n, word, plural = word + 's') {
  return `${n} ${n === 1 ? word : plural}`;
}
