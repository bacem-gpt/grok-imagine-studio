// Media pipeline: import (grok page / files / URLs / generated blobs), binary storage, probing, previews
// (thumbnail + filmstrip + waveform peaks), decoded audio and frame grabs. Runtime caches live here too.
//
// Public API (used by all panels):
//   importPageItems(pageItems, {flag, toTimeline}) -> Promise<string[]> media ids
//   importFiles(files, {toTimeline})              -> Promise<string[]>
//   importUrl(url, {kind, name, toTimeline})      -> Promise<string>  (a link already in the bin is reused)
//   addBlobAsMedia(blob, {name, origin, kind, prompt, toTimeline}) -> Promise<string>
//   retryMedia(id), resumePendingMedia()
//   getMediaBlob(id) -> Promise<Blob|null>        getMediaUrl(id) -> Promise<string|null> (object URL, cached)
//   getPreviews(id)  -> Promise<{thumb, strip, stripCount}|null>  (object URLs, cached)
//   getPeaks(id)     -> Promise<Float32Array|null> min/max pairs, PEAKS_PER_SECOND buckets per second
//   getAudioBuffer(id) -> Promise<AudioBuffer|null> decoded at 48 kHz (cached)
//   getAudioStatus(id) -> Promise<'ok'|'none'|'missing'|'undecodable'|'pending'>  why getAudioBuffer() gives null
//   grabFrame(id, time, {maxWidth, type}) -> Promise<Blob>  still image from a video (or the image itself)
//   loadMediabunny() -> Promise<module>
//   onMediaEvent(fn) -> off   events: {type: 'ready'|'error'|'progress', id, ...}

import { projectStore } from './store.js';
import { db } from './db.js';
import * as M from './model.js';
import { bridge } from './bridge.js';
import { REQ } from '../../shared/protocol.js';
import { createQueue, createEmitter, once, extFromMime } from './utils.js';
import { guessKindFromUrl, slugify, hostOf, isGrokMediaHost } from '../../shared/grok-urls.js';
import { openVideoFrames, retagSample, sampleImage } from './video-color.js';

export const PEAKS_PER_SECOND = 50;
const STRIP_FRAMES = 10;
const STRIP_CELL_W = 128;
const STRIP_CELL_H = 72;
const THUMB_MAX = 320;

const events = createEmitter();
export const onMediaEvent = (fn) => events.on('media', fn);
const emit = (e) => events.emit('media', e);

const jobQueue = createQueue(2);
const objectUrls = new Map(); // id -> object URL of the blob
const previewCache = new Map(); // id -> Promise<{thumb, strip, stripCount}> (object URLs, revoked when dropped)
const peaksCache = new Map(); // id -> Promise<Float32Array|null>
const audioCache = new Map(); // id -> Promise<AudioBuffer|null>
const blobCache = new Map(); // id -> Promise<Blob|null> (short-lived, avoids repeated IDB reads)

let mbPromise = null;
/** Lazily loads the vendored Mediabunny ES module. */
export function loadMediabunny() {
  if (!mbPromise) mbPromise = import('../../vendor/mediabunny.min.mjs');
  return mbPromise;
}

// Background status/probe updates reach the current state and every undo/redo snapshot holding the item.
const updateMediaSilently = (id, patch) => projectStore.patchMedia(id, patch);

// Object URLs handed out are revoked a while after they are dropped (an <img>/<video> may still be loading one).
const URL_GRACE_MS = 30000;
const revokeLater = (...urls) => setTimeout(() => urls.forEach((u) => u && URL.revokeObjectURL(u)), URL_GRACE_MS);

/** Forgets (and later revokes) the cached thumbnail / filmstrip URLs of a media item. */
function dropPreviews(id) {
  const p = previewCache.get(id);
  if (!p) return;
  previewCache.delete(id);
  p.then((v) => v && revokeLater(v.thumb, v.strip)).catch(() => {});
}

// Media removed from the project (and not brought back meanwhile): release its object URL.
let knownMedia = null;
projectStore.subscribe((p) => {
  const media = p?.media || null;
  if (media === knownMedia) return;
  knownMedia = media;
  for (const [id, url] of objectUrls) {
    if (media?.[id]) continue;
    objectUrls.delete(id);
    revokeLater(url);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------------------

function looksLikeErrorPage(blob, kindHint) {
  const t = (blob.type || '').toLowerCase();
  if (t.startsWith('text/html') || t.startsWith('application/json')) return true;
  if (kindHint === 'video' && t.startsWith('image/')) return true;
  return blob.size < 64;
}

/**
 * Fetches the first working URL. Order: extension-origin fetch (host permissions, bypasses CORS) for each URL,
 * then the grok.com content script (page origin + cookies; also handles blob: URLs).
 *  refetch: bypass the HTTP cache (a retry must not get the same broken response back).
 *  extensionHost(url): when given, only URLs it accepts are fetched with the extension's privileges; the others
 *    (links that came from the grok.com page, e.g. a context-menu target on another site) only through the page.
 */
export async function fetchMediaBlob(urls, { kindHint = null, signal, refetch = false, extensionHost = null } = {}) {
  const list = [...new Set(urls.filter(Boolean))];
  const errors = [];
  for (const url of list) {
    if (url.startsWith('blob:') && !url.startsWith(`blob:${location.origin}`)) continue; // page-owned blob URL
    if (extensionHost && !url.startsWith('blob:') && !extensionHost(url)) continue;
    try {
      const res = await fetch(url, { credentials: 'include', signal, cache: refetch ? 'reload' : 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (looksLikeErrorPage(blob, kindHint)) throw new Error(`unexpected content (${blob.type || 'unknown'}, ${blob.size} B)`);
      return { blob, url };
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(`${hostOf(url) || url.slice(0, 30)}: ${e.message || e}`);
    }
  }
  if (bridge.connected) {
    for (const url of list) {
      try {
        const { blob } = await bridge.request(REQ.PAGE_FETCH, { url }, { timeout: 120000 });
        if (blob && !looksLikeErrorPage(blob, kindHint)) return { blob, url };
        errors.push(`page: unexpected content`);
      } catch (e) {
        errors.push(`page: ${e.message || e}`);
      }
    }
  }
  const blocked = errors.length && errors.every((e) => /Failed to fetch|NetworkError|CORS|HTTP 40[13]/i.test(e));
  if (blocked) {
    throw new Error(
      `Could not download media: the server refused the request (${errors[0]}). If you denied site access, try again and allow it — or save the file and drop it into the bin.`,
    );
  }
  throw new Error(`Could not download media (${errors.slice(0, 3).join('; ') || 'no URL'})`);
}

// ---------------------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------------------

export function kindFromBlob(blob, nameOrUrl = '') {
  const t = (blob?.type || '').toLowerCase();
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  return guessKindFromUrl(nameOrUrl) || null;
}

/** Duration, size and track info. Uses Mediabunny, falling back to media elements. */
export async function probeBlob(blob, kindHint) {
  let kind = kindHint || kindFromBlob(blob);
  if (kind === 'image') {
    const bmp = await createImageBitmap(blob);
    const r = { kind: 'image', duration: 0, width: bmp.width, height: bmp.height, hasAudio: false, fps: null };
    bmp.close();
    return r;
  }
  try {
    const MB = await loadMediabunny();
    const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(blob) });
    try {
      const [vt, at] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
      const duration = await input.computeDuration();
      let fps = null;
      if (vt) {
        try {
          const stats = await vt.computePacketStats(120);
          fps = stats?.averagePacketRate ? Math.round(stats.averagePacketRate * 100) / 100 : null;
        } catch {
          /* optional */
        }
      }
      if (!vt && !at) throw new Error('no tracks');
      return {
        kind: vt ? 'video' : 'audio',
        duration: Number.isFinite(duration) ? duration : 0,
        width: vt ? vt.displayWidth : 0,
        height: vt ? vt.displayHeight : 0,
        hasAudio: !!at,
        fps,
      };
    } finally {
      input.dispose?.();
    }
  } catch (err) {
    // Fallback: HTML media element metadata.
    const url = URL.createObjectURL(blob);
    try {
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      el.preload = 'metadata';
      el.muted = true;
      el.src = url;
      await once(el, 'loadedmetadata', 15000);
      let duration = el.duration;
      if (!Number.isFinite(duration)) {
        el.currentTime = 1e7; // forces duration computation for some webm files
        await once(el, 'durationchange', 5000).catch(() => {});
        duration = Number.isFinite(el.duration) ? el.duration : 0;
      }
      const isVideo = el.videoWidth > 0;
      // Elements can't tell reliably whether a video has sound: assume yes (decoding later fails gracefully).
      return { kind: isVideo ? 'video' : 'audio', duration, width: el.videoWidth || 0, height: el.videoHeight || 0, hasAudio: true, fps: null };
    } catch {
      throw new Error(`Unsupported media (${blob.type || 'unknown type'}): ${err.message || err}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------------------

function drawCover(ctx, img, iw, ih, dx, dy, dw, dh) {
  const s = Math.max(dw / iw, dh / ih);
  const sw = dw / s;
  const sh = dh / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, dx, dy, dw, dh);
}

async function canvasToJpeg(canvas, quality = 0.78) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
}

async function videoPreviews(blob, meta) {
  const MB = await loadMediabunny();
  const v = await openVideoFrames(MB, blob);
  try {
    const dw = v.track.displayWidth || meta.width || 16;
    const dh = v.track.displayHeight || meta.height || 9;
    const scale = Math.min(1, THUMB_MAX / Math.max(dw, dh));
    const tw = Math.max(2, Math.round(dw * scale));
    const th = Math.max(2, Math.round(dh * scale));
    const dur = meta.duration || 1;
    const thumbTime = v.first + Math.min(dur * 0.15, 1);
    const stripTimes = Array.from({ length: STRIP_FRAMES }, (_, i) => v.first + ((i + 0.5) / STRIP_FRAMES) * dur);
    // One monotonic pass decodes the thumbnail frame and every filmstrip frame.
    const times = [...stripTimes, thumbTime].map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
    const strip = new OffscreenCanvas(STRIP_CELL_W * STRIP_FRAMES, STRIP_CELL_H);
    const sctx = strip.getContext('2d');
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, strip.width, strip.height);
    const thumb = new OffscreenCanvas(tw, th);
    const tctx = thumb.getContext('2d');
    let k = 0;
    for await (let sample of v.sink.samplesAtTimestamps(times.map((x) => x.t))) {
      const slot = times[k++].i;
      if (!sample) continue;
      try {
        if (v.retag) sample = await retagSample(MB, sample, v);
        const src = sampleImage(sample);
        if (slot === STRIP_FRAMES) tctx.drawImage(src.image, 0, 0, tw, th);
        else drawCover(sctx, src.image, src.width, src.height, slot * STRIP_CELL_W, 0, STRIP_CELL_W, STRIP_CELL_H);
      } finally {
        sample.close();
      }
    }
    return { thumb: await canvasToJpeg(thumb), strip: await canvasToJpeg(strip, 0.7), stripCount: STRIP_FRAMES };
  } finally {
    v.input.dispose?.();
  }
}

async function imagePreviews(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.max(2, Math.round(bmp.width * scale)), Math.max(2, Math.round(bmp.height * scale)));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return { thumb: await canvasToJpeg(c, 0.82), strip: null, stripCount: 0 };
}

/** Computes min/max peak pairs (Float32Array length = 2 * buckets) from decoded audio. */
export function computePeaks(audioBuffer, perSecond = PEAKS_PER_SECOND) {
  const buckets = Math.max(1, Math.ceil(audioBuffer.duration * perSecond));
  const out = new Float32Array(buckets * 2);
  const chans = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));
  const len = audioBuffer.length;
  const per = len / buckets;
  for (let b = 0; b < buckets; b++) {
    let min = 1;
    let max = -1;
    const s = Math.floor(b * per);
    const e = Math.min(len, Math.floor((b + 1) * per));
    const step = Math.max(1, Math.floor((e - s) / 400)); // subsample long buckets
    for (let i = s; i < e; i += step) {
      for (const ch of chans) {
        const v = ch[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (min > max) min = max = 0;
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

async function buildPreviews(id, blob, meta) {
  let previews = { thumb: null, strip: null, stripCount: 0, peaks: null };
  try {
    if (meta.kind === 'video') previews = { ...previews, ...(await videoPreviews(blob, meta)) };
    else if (meta.kind === 'image') previews = { ...previews, ...(await imagePreviews(blob)) };
  } catch (e) {
    console.warn('[gis] preview generation failed', id, e);
  }
  if (meta.kind === 'audio') {
    const buf = await getAudioBuffer(id, blob).catch(() => null);
    if (buf) previews.peaks = computePeaks(buf);
  }
  await db.putThumbs(id, previews);
  dropPreviews(id);
  if (previews.peaks) peaksCache.set(id, Promise.resolve(previews.peaks));
  return previews;
}

// ---------------------------------------------------------------------------------------------------------
// Runtime accessors
// ---------------------------------------------------------------------------------------------------------

export function getMediaBlob(id) {
  if (!blobCache.has(id)) {
    const p = db.getBlob(id).then((b) => b || null);
    blobCache.set(id, p);
    p.then((b) => {
      if (b) return;
      blobCache.delete(id);
      // A "ready" item whose file is gone (storage cleared, removed elsewhere): show it as failed, so Retry or a
      // re-import is offered instead of a clip that silently never plays.
      const m = projectStore.get()?.media[id];
      if (m?.status === 'ready' && !processing.has(id)) {
        const error = m.sourceUrl ? 'The file is missing from storage: Retry downloads it again' : 'The file is missing from storage: import it again';
        updateMediaSilently(id, { status: 'error', errorStage: 'missing', error });
        emit({ type: 'error', id, error });
      }
    });
    // keep the cache small: forget after a while (the object URL keeps the blob alive when needed)
    setTimeout(() => blobCache.delete(id), 30000);
  }
  return blobCache.get(id);
}

export async function getMediaUrl(id) {
  if (objectUrls.has(id)) return objectUrls.get(id);
  const blob = await getMediaBlob(id);
  if (!blob) return null;
  if (objectUrls.has(id)) return objectUrls.get(id);
  const url = URL.createObjectURL(blob);
  objectUrls.set(id, url);
  return url;
}

/** Synchronous lookup of an already-created object URL (null if getMediaUrl() hasn't resolved yet). */
export const peekMediaUrl = (id) => objectUrls.get(id) || null;

export function getPreviews(id) {
  if (!previewCache.has(id)) {
    previewCache.set(
      id,
      db.getThumbs(id).then((t) => {
        if (!t) {
          previewCache.delete(id);
          return null;
        }
        return {
          thumb: t.thumb ? URL.createObjectURL(t.thumb) : null,
          strip: t.strip ? URL.createObjectURL(t.strip) : null,
          stripCount: t.stripCount || 0,
        };
      }),
    );
  }
  return previewCache.get(id);
}

/** Waveform peaks for audio or video-with-audio media; computed on demand and cached in IDB. */
export function getPeaks(id) {
  if (!peaksCache.has(id)) {
    peaksCache.set(
      id,
      (async () => {
        const t = await db.getThumbs(id);
        if (t?.peaks) return t.peaks;
        const buf = await getAudioBuffer(id);
        if (!buf) return null;
        const peaks = computePeaks(buf);
        await db.putThumbs(id, { ...(t || {}), peaks });
        return peaks;
      })()
        .catch(() => null)
        .then((peaks) => {
          if (!peaks && !isSettled(id)) peaksCache.delete(id); // not downloaded yet: allow a later retry
          return peaks;
        }),
    );
  }
  return peaksCache.get(id);
}

/** True once a media item finished processing (a null decode result is then definitive: no audio). */
const isSettled = (id) => {
  const m = projectStore.get()?.media[id];
  return !!m && (m.status === 'ready' || m.status === 'error');
};

let decodeCtx = null;
/** Decoded audio (48 kHz, original channel count) or null if the media has no decodable audio. */
export function getAudioBuffer(id, blobHint = null) {
  if (!audioCache.has(id)) {
    audioCache.set(
      id,
      (async () => {
        const blob = blobHint || (await getMediaBlob(id));
        if (!blob) return null;
        decodeCtx ||= new OfflineAudioContext(2, 1, 48000);
        try {
          return await decodeCtx.decodeAudioData(await blob.arrayBuffer());
        } catch {
          return null;
        }
      })().then((buf) => {
        if (!buf && !blobHint && !isSettled(id)) audioCache.delete(id); // not downloaded yet: allow a later retry
        return buf;
      }),
    );
  }
  return audioCache.get(id);
}

/**
 * Why getAudioBuffer(id) has (or has no) sound, for wording warnings: 'ok' (decodes), 'none' (no audio track, or a
 * still), 'missing' (the file is not stored), 'undecodable' (stored but its sound can't be decoded), 'pending'
 * (still downloading / processing).
 */
export async function getAudioStatus(id) {
  const m = projectStore.get()?.media[id];
  if (m && (m.status === 'pending' || m.status === 'loading')) return 'pending';
  if (m?.kind === 'image') return 'none';
  if (!(await db.hasBlob(id))) return 'missing';
  if (m?.kind === 'video' && m.status === 'ready' && m.hasAudio === false) return 'none';
  return (await getAudioBuffer(id)) ? 'ok' : 'undecodable';
}

/** Frees decoded audio (call when memory matters, e.g. after export). */
export function releaseAudioBuffers(ids = null) {
  if (!ids) audioCache.clear();
  else for (const id of ids) audioCache.delete(id);
}

/**
 * Still image from a media item at `time` seconds (video) or the image itself, as PNG/JPEG Blob.
 * maxWidth limits the output size (0 = native).
 */
export async function grabFrame(id, time = 0, { maxWidth = 0, type = 'image/png', quality = 0.92 } = {}) {
  const project = projectStore.get();
  const media = project?.media[id];
  const blob = await getMediaBlob(id);
  if (!blob) throw new Error('Media not downloaded yet');
  const kind = media?.kind || kindFromBlob(blob);
  let canvas;
  if (kind === 'image') {
    const bmp = await createImageBitmap(blob);
    const s = maxWidth && bmp.width > maxWidth ? maxWidth / bmp.width : 1;
    canvas = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
  } else if (kind === 'video') {
    const MB = await loadMediabunny();
    const v = await openVideoFrames(MB, blob);
    try {
      const dur = media?.duration || (await v.input.computeDuration());
      const t = Math.max(0, Math.min(time, Math.max(0, dur - 0.001)));
      let sample = (await v.sink.getSample(v.first + t)) || (await v.sink.getSample(v.first));
      if (!sample) throw new Error('Could not decode frame');
      try {
        if (v.retag) sample = await retagSample(MB, sample, v);
        const src = sampleImage(sample);
        const s = maxWidth && src.width > maxWidth ? maxWidth / src.width : 1;
        canvas = new OffscreenCanvas(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
        canvas.getContext('2d').drawImage(src.image, 0, 0, canvas.width, canvas.height);
      } finally {
        sample.close();
      }
    } finally {
      v.input.dispose?.();
    }
  } else {
    throw new Error('Audio has no frames');
  }
  return canvas.convertToBlob({ type, quality });
}

// ---------------------------------------------------------------------------------------------------------
// Import flows
// ---------------------------------------------------------------------------------------------------------

const processing = new Set(); // ids processMedia() is working on

/**
 * Downloads (if needed), probes, stores and previews one media item. Updates its status as it goes.
 * The binary is stored only once it probed fine, so a broken download never sits in storage looking like the file.
 * refetch: download again from the URLs even when a stored copy exists (Retry).
 */
async function processMedia(id, { blob = null, urls = [], kindHint = null, refetch = false } = {}) {
  // Results computed before (or for an earlier version of) this media are stale.
  audioCache.delete(id);
  peaksCache.delete(id);
  dropPreviews(id);
  processing.add(id);
  updateMediaSilently(id, { status: 'loading', error: null, errorStage: null });
  emit({ type: 'progress', id, stage: 'download' });
  let stage = 'download';
  const hasUrl = urls.some(Boolean);
  try {
    let stored = false; // the blob already sits in IndexedDB under this id
    if (!blob && !(refetch && hasUrl)) {
      const b = await db.getBlob(id);
      if (b) {
        blob = b;
        stored = true;
      }
    }
    if (!blob) {
      if (!hasUrl) throw new Error('The original file is no longer available: import it again');
      // Items collected from grok.com: only Grok's media hosts are fetched with the extension's privileges.
      const fromPage = projectStore.get()?.media[id]?.origin === 'grok';
      const res = await fetchMediaBlob(urls, { kindHint, refetch, extensionHost: fromPage ? isGrokMediaHost : null });
      blob = res.blob;
    }
    stage = 'probe';
    emit({ type: 'progress', id, stage: 'probe' });
    let meta;
    try {
      meta = await probeBlob(blob, kindHint || kindFromBlob(blob, urls[0]));
    } catch (e) {
      // Unreadable bytes must not stay stored: a retry would re-check them forever instead of downloading again.
      if (stored && hasUrl) await db.deleteBlob(id).catch(() => {});
      throw e;
    }
    stage = 'store';
    if (!stored) await db.putBlob(id, blob);
    blobCache.delete(id);
    updateMediaSilently(id, {
      kind: meta.kind,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
      fps: meta.fps,
      mime: blob.type || '',
      size: blob.size,
    });
    // Clips created before the duration was known: placeholder ranges (autoOut) take the real length,
    // and any out-point beyond the media end is clamped.
    if (meta.kind !== 'image' && meta.duration > 0) {
      projectStore.update(
        (p) => {
          let q = p;
          for (const track of ['video', 'audio', 'overlay']) {
            for (const c of p.tracks[track] || []) {
              if (c.mediaId !== id) continue;
              if (c.autoOut) q = M.updateClip(q, c.id, { out: meta.duration }); // updateClip clears autoOut
              else if (c.out > meta.duration + 1e-3) q = M.updateClip(q, c.id, { out: meta.duration });
            }
          }
          return q;
        },
        { history: false },
      );
    }
    stage = 'previews';
    emit({ type: 'progress', id, stage: 'previews' });
    await buildPreviews(id, blob, meta);
    updateMediaSilently(id, { status: 'ready', error: null, errorStage: null });
    emit({ type: 'ready', id });
    return true;
  } catch (e) {
    console.warn('[gis] media import failed', id, e);
    updateMediaSilently(id, { status: 'error', error: String(e.message || e), errorStage: stage });
    emit({ type: 'error', id, error: String(e.message || e) });
    return false;
  } finally {
    processing.delete(id);
  }
}

function nameFromPrompt(prompt, fallback) {
  const p = (prompt || '').trim().replace(/\s+/g, ' ');
  if (!p) return fallback;
  return p.length > 48 ? p.slice(0, 47) + '…' : p;
}

/**
 * Adds grok.com PageMedia items to the bin (skipping ones already there) and downloads them in the background.
 * toTimeline: also append video/image items to the end of the main track.
 */
export async function importPageItems(items, { flag = null, toTimeline = false } = {}) {
  const project = projectStore.get();
  const ids = [];
  const fresh = [];
  for (const it of items) {
    const existing = M.findMediaForPageItem(project, it);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const media = M.createMediaItem({
      kind: it.kind,
      name: nameFromPrompt(it.prompt, it.kind === 'video' ? 'Grok video' : 'Grok image'),
      origin: 'grok',
      sourceUrl: it.url,
      altUrls: it.altUrls || [],
      pageUrl: it.pageUrl || null,
      pageKey: it.key,
      postId: it.postId || null,
      prompt: it.prompt || null,
      width: it.width || 0,
      height: it.height || 0,
      duration: it.duration || 0,
      status: 'pending',
      flag,
    });
    fresh.push(media);
    ids.push(media.id);
  }
  if (fresh.length || (toTimeline && ids.length) || flag) {
    projectStore.update(
      (p) => {
        let q = p;
        for (const m of fresh.slice().reverse()) q = M.addMedia(q, m);
        if (flag) for (const id of ids) q = M.updateMedia(q, id, { flag });
        if (toTimeline) q = M.appendMediaToTimeline(q, ids).project;
        return q;
      },
      { label: toTimeline ? 'Add to timeline' : 'Add to bin' },
    );
  }
  for (const m of fresh) jobQueue.push(() => processMedia(m.id, { urls: [m.sourceUrl, ...m.altUrls], kindHint: m.kind }));
  return ids;
}

/** Imports local files (video / image / audio). Audio files go to the audio track when toTimeline. */
export async function importFiles(files, { toTimeline = false } = {}) {
  const items = [];
  for (const file of files) {
    const kind = kindFromBlob(file, file.name);
    if (!kind) continue;
    items.push({ file, media: M.createMediaItem({ kind, name: file.name.replace(/\.[^.]+$/, ''), origin: 'file', mime: file.type, size: file.size, status: 'loading' }) });
  }
  if (!items.length) return [];
  projectStore.update(
    (p) => {
      let q = p;
      for (const { media } of items) q = M.addMedia(q, media);
      return q;
    },
    { label: 'Import files' },
  );
  await Promise.all(items.map(({ file, media }) => jobQueue.push(() => processMedia(media.id, { blob: file, kindHint: media.kind }))));
  if (toTimeline) placeOnTimeline(items.map((i) => i.media.id));
  return items.map((i) => i.media.id);
}

/** Appends media to the timeline: visual media to the main track, audio to the first free audio lane at 0. */
export function placeOnTimeline(ids) {
  projectStore.update(
    (p) => {
      let q = p;
      const visual = ids.filter((id) => q.media[id] && q.media[id].kind !== 'audio');
      if (visual.length) q = M.appendMediaToTimeline(q, visual).project;
      for (const id of ids) if (q.media[id]?.kind === 'audio') q = M.addAudioClip(q, id, { start: 0 }).project;
      return q;
    },
    { label: 'Add to timeline' },
  );
}

/** Ensures the extension may fetch from url's origin (prompts the user once per origin; needs a user gesture). */
export async function ensureHostPermission(url) {
  if (typeof chrome === 'undefined' || !chrome.permissions) return true;
  let origin;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return true;
    origin = `${u.protocol}//${u.hostname}/*`;
  } catch {
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

/** Resolves once a media item is no longer pending / loading: true when it ended 'ready'. */
function settled(id) {
  const status = () => projectStore.get()?.media[id]?.status;
  if (status() === 'ready') return Promise.resolve(true);
  if (!status() || status() === 'error') return Promise.resolve(false);
  return new Promise((resolve) => {
    const off = onMediaEvent((e) => {
      if (e.id !== id || (e.type !== 'ready' && e.type !== 'error')) return;
      off();
      resolve(e.type === 'ready');
    });
  });
}

/**
 * Imports any media URL (e.g. a music file). Call from a click handler so the permission prompt can show.
 * A link that is already in the bin is not downloaded again: that item is reused (a failed one is retried).
 */
export async function importUrl(url, { kind = null, name = null, toTimeline = false } = {}) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean) && !clean.startsWith('data:')) throw new Error('Enter an http(s) URL');
  const permissionPromise = ensureHostPermission(clean); // start inside the user gesture
  const cur = projectStore.get();
  const existing = cur?.mediaOrder.map((id) => cur.media[id]).find((m) => m?.sourceUrl === clean && m.origin === 'url');
  if (existing) {
    await permissionPromise;
    // ready: reuse as is; being processed here: wait for it; failed or stuck (e.g. merged from a window that closed
    // mid-download): download it again.
    const ok = existing.status === 'ready' ? true : processing.has(existing.id) ? await settled(existing.id) : await retryMedia(existing.id);
    if (!ok) throw new Error(projectStore.get().media[existing.id]?.error || 'Import failed');
    if (toTimeline) placeOnTimeline([existing.id]);
    return existing.id;
  }
  const guessed = kind || guessKindFromUrl(clean) || 'video';
  const media = M.createMediaItem({
    kind: guessed,
    name: name || decodeURIComponent(clean.split('?')[0].split('/').pop() || 'Imported media').replace(/\.[^.]+$/, '') || 'Imported media',
    origin: 'url',
    sourceUrl: clean,
    status: 'pending',
  });
  projectStore.update((p) => M.addMedia(p, media), { label: 'Import URL' });
  await permissionPromise;
  const ok = await jobQueue.push(() => processMedia(media.id, { urls: [clean], kindHint: kind }));
  if (!ok) throw new Error(projectStore.get().media[media.id]?.error || 'Import failed');
  if (toTimeline) placeOnTimeline([media.id]);
  return media.id;
}

/** Stores a generated blob (frame grab, export, edited image) as a new bin item. */
export async function addBlobAsMedia(blob, { name = 'Untitled', origin = 'frame', kind = null, prompt = null, toTimeline = false, flag = null } = {}) {
  const k = kind || kindFromBlob(blob) || 'image';
  const media = M.createMediaItem({ kind: k, name, origin, prompt, mime: blob.type, size: blob.size, status: 'loading', flag });
  projectStore.update((p) => M.addMedia(p, media), { label: `Add ${k}` });
  await jobQueue.push(() => processMedia(media.id, { blob, kindHint: k }));
  if (toTimeline) placeOnTimeline([media.id]);
  return media.id;
}

/** Processes a media item again; with a source URL it is downloaded again (never re-checks the same stored bytes). */
export async function retryMedia(id) {
  const m = projectStore.get()?.media[id];
  if (!m) return false;
  return jobQueue.push(() => processMedia(id, { urls: [m.sourceUrl, ...(m.altUrls || [])], kindHint: m.kind, refetch: true }));
}

/** Startup: (re)process items whose binary is missing or whose processing was interrupted. */
export async function resumePendingMedia() {
  const p = projectStore.get();
  if (!p) return;
  for (const id of p.mediaOrder) {
    const m = p.media[id];
    if (!m) continue;
    // A file that could not be read stays failed until the user retries: re-checking it on every open is pointless.
    if (m.status === 'error' && m.errorStage === 'probe') continue;
    const has = await db.hasBlob(id);
    if (m.status === 'ready' && has) continue;
    if (m.status === 'error' && has) continue; // stored bytes that failed to process (older versions kept them)
    if (!has && !m.sourceUrl) {
      if (m.status !== 'error') updateMediaSilently(id, { status: 'error', error: 'Original file is no longer available' });
      continue;
    }
    jobQueue.push(() => processMedia(id, { urls: [m.sourceUrl, ...(m.altUrls || [])], kindHint: m.kind }));
  }
}

/** Suggested download filename for a media item. */
export function mediaFilename(media) {
  const ext = extFromMime(media.mime, media.kind === 'video' ? 'mp4' : media.kind === 'image' ? 'jpg' : 'mp3');
  return `${slugify(media.prompt || media.name, 50)}.${ext}`;
}

/** Releases object URLs of media no longer in the project (call on project switch). */
export function releaseRuntime(keepIds = []) {
  const keep = new Set(keepIds);
  for (const [id, url] of objectUrls) {
    if (keep.has(id)) continue;
    URL.revokeObjectURL(url);
    objectUrls.delete(id);
  }
  for (const id of [...previewCache.keys()]) if (!keep.has(id)) dropPreviews(id);
  for (const id of [...audioCache.keys()]) if (!keep.has(id)) audioCache.delete(id);
  for (const id of [...peaksCache.keys()]) if (!keep.has(id)) peaksCache.delete(id);
}
