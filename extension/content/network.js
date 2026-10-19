// Isolated-world side of the network sniffer: receives the compact media records page-hook.js posts from the
// MAIN world, validates them (the page world is untrusted: only Grok media hosts pass) and hands NetRecords to the
// registry, and what the hook learned about the page's blob: URLs (MediaSource streams, the media URL a blob was
// read from). Also asks the hook to read page-owned blob: URLs that the isolated world cannot fetch itself.
import { normalizeNetRecord, isMediaAssetUrl } from './records.js';

const HOOK_SOURCE = 'gis-hook';
const CONTENT_SOURCE = 'gis-content';
const MAX_ITEMS_PER_MESSAGE = 500;

let nextId = 1;
const pendingFetches = new Map(); // id -> {resolve, reject, timer}
const pendingProbes = new Map(); // `${id}:${on}` -> {resolve, timer}

/**
 * Starts listening for hook messages. onRecords(NetRecord[], from, timing) is called for every batch with valid
 * records; timing = {serverDate: string|null, clientAt: number|null} (the response's Date header and the local time
 * its headers arrived, for clock-skew estimation). onObjectUrl({url, mse, source}) for a page blob: URL the hook
 * knows about: mse = a MediaSource stream, source = the Grok media URL its bytes came from (validated) or null.
 * Returns a stop() function.
 */
export function listenToHook({ onRecords, onObjectUrl = null }) {
  const origin = location.origin;
  const handler = (e) => {
    if (e.source !== window || e.origin !== origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.source !== HOOK_SOURCE) return;
    if (d.type === 'media' && Array.isArray(d.items)) {
      const out = [];
      for (const raw of d.items.slice(0, MAX_ITEMS_PER_MESSAGE)) {
        const rec = normalizeNetRecord(raw, origin);
        if (rec) out.push(rec);
      }
      if (out.length) {
        const timing = {
          serverDate: typeof d.serverDate === 'string' && d.serverDate.length < 64 ? d.serverDate : null,
          clientAt: Number.isFinite(d.clientAt) ? d.clientAt : null,
        };
        try {
          onRecords(out, typeof d.from === 'string' ? d.from : '', timing);
        } catch (err) {
          console.warn('[gis] network records handler failed', err);
        }
      }
    } else if (d.type === 'object-url') {
      if (typeof d.url !== 'string' || d.url.length > 256 || !d.url.startsWith(`blob:${origin}/`)) return;
      const source = typeof d.src === 'string' && !d.src.startsWith('blob:') && isMediaAssetUrl(d.src, origin) ? d.src : null;
      const mse = d.mse === true;
      if (!mse && !source) return;
      try {
        onObjectUrl?.({ url: d.url, mse, source });
      } catch (err) {
        console.warn('[gis] object URL handler failed', err);
      }
    } else if (d.type === 'attach-probe') {
      const p = pendingProbes.get(`${d.id}:${d.on ? 1 : 0}`);
      if (!p) return;
      pendingProbes.delete(`${d.id}:${d.on ? 1 : 0}`);
      clearTimeout(p.timer);
      p.resolve({ read: d.read === true, used: d.used === true });
    } else if (d.type === 'fetch-result') {
      const p = pendingFetches.get(d.id);
      if (!p) return;
      pendingFetches.delete(d.id);
      clearTimeout(p.timer);
      if (d.ok && d.blob instanceof Blob) p.resolve(d.blob);
      else p.reject(new Error(d.error || 'Could not read the page blob'));
    }
  };
  window.addEventListener('message', handler);
  // Ask the hook to replay what it saw before we were listening (Grok's first API calls precede document_idle).
  window.postMessage({ source: CONTENT_SOURCE, type: 'hello' }, origin);
  return () => window.removeEventListener('message', handler);
}

/** Reads a page-owned blob: URL through the MAIN-world hook (requires listenToHook to be active). */
export function fetchBlobViaHook(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const id = `f${nextId++}`;
    const timer = setTimeout(() => {
      pendingFetches.delete(id);
      reject(new Error('The page did not answer (reload grok.com)'));
    }, timeout);
    pendingFetches.set(id, { resolve, reject, timer });
    window.postMessage({ source: CONTENT_SOURCE, type: 'fetch-blob', id, url }, location.origin);
  });
}

function probeMessage(id, on, timeout) {
  return new Promise((resolve) => {
    const key = `${id}:${on ? 1 : 0}`;
    const timer = setTimeout(() => {
      pendingProbes.delete(key);
      resolve(null);
    }, timeout);
    pendingProbes.set(key, { resolve, timer });
    window.postMessage({ source: CONTENT_SOURCE, type: 'attach-probe', id, on }, location.origin);
  });
}

/**
 * Attach probe (requires listenToHook to be active): start() resolves true once the MAIN-world hook watches what page
 * code does with a pasted / dropped file (false: no hook answered); stop() resolves {read, used} since start() —
 * read: the page looked at the event's files; used: it inspected or read a file (it is taking it) — or null.
 */
export function attachProbe() {
  const id = `p${nextId++}`;
  return {
    start: async () => !!(await probeMessage(id, true, 400)),
    stop: () => probeMessage(id, false, 400),
  };
}
