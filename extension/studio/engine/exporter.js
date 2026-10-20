// Offline export of the sequence: MP4 / WebM video (H.264 / VP9 + AAC / Opus), PNG frames and WAV mixdowns.
//
//   getExportCapabilities({width, height}) -> {mp4: {video, audio}, webm: {video, audio}, aacEncoder}
//   exportProject(project, opts)          -> {blob, mime, filename, duration, width, height, ...}
//   exportFrame(project, t, opts)         -> Blob (PNG by default)
//   exportAudioWav(project, opts)         -> Blob (16-bit PCM WAV)
//
// Frames are rendered through the same compositor as the live preview (engine/compositor.js drawFrame) so the
// export matches what the user saw. Each main-track clip gets its own Mediabunny Input + VideoSampleSink, decoding
// exactly the source timestamps the output frames need (samplesAtTimestamps, monotonic per clip). Clips are
// opened shortly before they appear and closed after their last frame, so at most two decoders run at once
// (both sides of a transition). Encoding uses CanvasSource; the audio mix (engine/audio-mix.js) is fed in
// one-second chunks interleaved with the video.
//
// Frames are decoded with core/video-color.js (the same colour rule as thumbnails and frame grabs), so untagged SD
// footage exports with the colours Chrome's <video> preview shows. A clip whose frames stop decoding before its
// out-point (truncated or damaged file) keeps its last good frame on screen, and the export reports it.
//
// Pure helpers (planning, bitrates, ranges, validation) are exported for the dialog and unit tests;
// core/media.js is imported lazily so this module stays importable from node.

import { layoutProject, videoItemsAt, sourceTimeAt, overlayItemsAt, layoutItemKey } from '../core/model.js';
import { clamp, sanitizeFilename, formatTime, formatDuration } from '../core/utils.js';
import { openVideoFrames, retagSample } from '../core/video-color.js';
import { drawFrame, createScratch } from './compositor.js';
import { renderAudioMix, hasAudibleContent, mainClipAudible, audioClipAudible, bufferChannels, wavSteps, runStepsSliced, DEFAULT_SAMPLE_RATE } from './audio-mix.js';

export { hasAudibleContent };
export { untaggedVideoMatrix } from '../core/video-color.js';

/** Quality presets: video bits per pixel per frame (scaled by width x height x fps) and audio bitrate. */
export const QUALITY_PRESETS = Object.freeze({
  low: { id: 'low', label: 'Low', bpp: 0.05, audio: 96_000 },
  medium: { id: 'medium', label: 'Medium', bpp: 0.08, audio: 128_000 },
  high: { id: 'high', label: 'High', bpp: 0.12, audio: 192_000 },
  max: { id: 'max', label: 'Max', bpp: 0.2, audio: 256_000 },
});

export const EXPORT_FORMATS = Object.freeze({
  mp4: { id: 'mp4', ext: 'mp4', mime: 'video/mp4', kind: 'video' },
  webm: { id: 'webm', ext: 'webm', mime: 'video/webm', kind: 'video' },
  png: { id: 'png', ext: 'png', mime: 'image/png', kind: 'image' },
  wav: { id: 'wav', ext: 'wav', mime: 'audio/wav', kind: 'audio' },
});

export const CODEC_LABELS = Object.freeze({ avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', aac: 'AAC', opus: 'Opus' });

const MIN_DIM = 16;
const MAX_DIM = 7680;
const KEYFRAME_INTERVAL = 2; // seconds
const OPEN_AHEAD = 0.75; // seconds: start decoding a clip this long before it appears
const AAC_PRIMING_SAMPLES = 1024; // encoder delay of FFmpeg's AAC encoder (vendored WASM fallback)
const MIN_REPORTED_GAP = 0.2; // seconds of a clip without decodable frames before the export warns about it

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

/** Video bitrate (bits/s) for a quality preset, scaled by pixels per second. */
export function videoBitrateFor({ width, height, fps, quality = 'high' }) {
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high;
  return Math.round(clamp(width * height * fps * preset.bpp, 250_000, 60_000_000));
}

/** Audio bitrate (bits/s) for a quality preset. */
export const audioBitrateFor = (quality = 'high') => (QUALITY_PRESETS[quality] || QUALITY_PRESETS.high).audio;

/** Encoder-friendly output size: even dimensions within codec limits. */
export function evenDimensions(width, height) {
  const fix = (v) => clamp(Math.round((Number(v) || 0) / 2) * 2, MIN_DIM, MAX_DIM);
  return { width: fix(width), height: fix(height) };
}

/** Clamps an optional {start, end} range to the sequence; falls back to the whole sequence. */
export function resolveRange(range, duration) {
  const d = Math.max(0, duration || 0);
  if (!range) return { start: 0, end: d };
  let start = clamp(Number(range.start) || 0, 0, d);
  let end = clamp(Number.isFinite(Number(range.end)) ? Number(range.end) : d, 0, d);
  if (end < start) [start, end] = [end, start];
  if (end - start < 1e-3) return { start: 0, end: d };
  return { start, end };
}

/**
 * Frame plan for rendering [start, end) at fps: the frame count and, per layout item (main track, then overlay
 * track), the frames it is visible in plus the source timestamps those frames need (non-decreasing). Uses
 * videoItemsAt() / overlayItemsAt() exactly like drawFrame(), so decoders stay in lockstep with the compositor.
 * Entries carry `key` = layoutItemKey(item) (main-track index, or `ov:<clip id>`), the key frames are looked up by.
 */
export function planFrames(layout, { start, end, fps }) {
  const frames = Math.max(1, Math.round((end - start) * fps));
  const byIndex = new Map();
  for (let k = 0; k < frames; k++) {
    const t = start + k / fps;
    for (const item of [...videoItemsAt(layout.video, t), ...overlayItemsAt(layout.overlay, t)]) {
      const key = layoutItemKey(item);
      let entry = byIndex.get(key);
      if (!entry) byIndex.set(key, (entry = { item, key, first: k, last: k, times: [] }));
      entry.last = k;
      entry.times.push(sourceTimeAt(item, t));
    }
  }
  return { frames, duration: frames / fps, items: [...byIndex.values()].sort((a, b) => a.first - b.first) };
}

/** Rough output size in bytes (container overhead included). */
export function estimateExportBytes({ duration, videoBitrate = 0, audioBitrate = 0 }) {
  return Math.round(((videoBitrate + audioBitrate) / 8) * Math.max(0, duration) * 1.02);
}

/** Default download name for a project and extension. */
export function exportFilename(projectName, ext) {
  const base = sanitizeFilename(String(projectName || '').trim() || 'sequence').replace(/\.+$/, '');
  return `${base}.${ext}`;
}

/**
 * Media that would block an export of [start, end): still downloading, failed, or missing.
 * `video` covers the pictures of main-track clips, `audio` the sound of main-track and audio-track clips.
 * @returns {Array<{mediaId, name, status, message}>}
 */
export function exportProblems(project, { start = 0, end = Infinity, video = true, audio = true } = {}) {
  const lay = layoutProject(project);
  const ids = new Set();
  const overlaps = (it) => it.end > start + 1e-6 && it.start < end - 1e-6;
  for (const it of lay.video) if (overlaps(it) && (video || mainClipAudible(project, it.clip))) ids.add(it.clip.mediaId);
  if (audio) for (const it of lay.audio) if (overlaps(it) && audioClipAudible(project, it.clip)) ids.add(it.clip.mediaId);
  for (const it of lay.overlay || []) if (overlaps(it) && (video || (audio && mainClipAudible(project, it.clip)))) ids.add(it.clip.mediaId);
  const out = [];
  for (const id of ids) {
    const m = project.media[id];
    if (!m || m.status === 'ready') continue;
    const failed = m.status === 'error';
    out.push({
      mediaId: id,
      name: m.name,
      status: m.status,
      message: failed ? `"${m.name}" failed to download${m.error ? ` (${m.error})` : ''}` : `"${m.name}" is still downloading`,
    });
  }
  return out;
}

/**
 * The end of [start, end) that comes after the last main-track clip, where the export shows only the background
 * colour (music or titles that run on past the pictures): `{from, duration, sound, titles, clips}` or null when
 * pictures fill the range to its end. `sound` / `titles`: whether something is heard / written over it; `clips`:
 * whether the range shows any clip at all before it.
 */
export function pictureTail(project, { start = 0, end = Infinity } = {}) {
  const lay = layoutProject(project);
  const stop = Math.min(end, lay.duration);
  const pictureEnd = Math.max(lay.videoEnd, ...(lay.overlay || []).map((it) => it.end)); // overlays are pictures too
  const from = clamp(pictureEnd, start, stop);
  if (!(stop - from > 1e-6)) return null;
  const over = (it) => it.end > from + 1e-6 && it.start < stop - 1e-6;
  return {
    from,
    duration: stop - from,
    sound: lay.audio.some((it) => over(it) && audioClipAudible(project, it.clip)),
    titles: lay.text.some(over),
    clips: pictureEnd > start + 1e-6,
  };
}

/**
 * Media whose decoded sound an export may drop from core/media.js's cache when it is done: the ones heard only
 * through main-track clips (the preview plays those through its <video> elements). Audio-track sources stay cached:
 * the preview Player schedules the very same decoded buffers, so dropping the cache entry frees nothing while the
 * Player holds it — it only makes the next export decode the whole file again (for an hour of music: seconds of
 * work and a second full-length copy in memory).
 * @param {Object} project
 * @param {string[]} ids  media ids the export decoded sound for
 * @returns {string[]}
 */
export function releasableAudioIds(project, ids) {
  const scheduled = new Set((project.tracks?.audio || []).map((c) => c.mediaId));
  return ids.filter((id) => !scheduled.has(id));
}

/**
 * Warning for a main-track clip whose frames stopped decoding (truncated or damaged file), or null when too little
 * was lost to notice. `gap`: {from: source seconds of the first frame the decoder had nothing for, at: the timeline
 * seconds that frame belongs to, frames: how many frames had nothing, fps, decoded: whether a frame decoded before
 * the first gap (it is held; otherwise the background shows), resumed: whether decoding picked up again later}.
 * @returns {string|null}
 */
export function decodeGapMessage(name, { from, at, frames, fps, decoded, resumed }) {
  const lost = frames / fps;
  if (!(lost >= MIN_REPORTED_GAP - 1e-9)) return null;
  const why = 'the file may be damaged or incomplete';
  const where = `${formatTime(at)} on the timeline`;
  if (resumed) return `Parts of "${name}" couldn't be decoded (${why}), so ${decoded ? 'its last good frame' : 'the background'} stands in for ${formatDuration(lost)}, first at ${where}.`;
  if (!decoded) return `"${name}" couldn't be decoded (${why}), so the background shows instead of it for ${formatDuration(lost)} from ${where}.`;
  return `"${name}" stops decoding at ${formatTime(from)} (${why}), so its last good frame is held for ${formatDuration(lost)} from ${where}.`;
}

const abortError = () => new DOMException('Export cancelled', 'AbortError');
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError();
};
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------------------------------------------------
// Capabilities (+ WASM AAC encoder registration where the browser has no native AAC encoder)
// ---------------------------------------------------------------------------------------------------------

let mediaModule = null;
const mediaApi = () => (mediaModule ||= import('../core/media.js'));
const loadMB = async () => (await mediaApi()).loadMediabunny();
/** Drops decoded sound from core/media.js's cache once an export no longer needs it. */
const releaseAudio = (ids) => mediaApi().then((m) => m.releaseAudioBuffers(ids), () => {});

const AUDIO_PROBE = { numberOfChannels: 2, sampleRate: DEFAULT_SAMPLE_RATE };
const defaultAacLoader = () => import('../../vendor/mediabunny-aac-encoder.mjs');
let aacLoader = defaultAacLoader;
let aacPromise = null;
let aacRegistered = false; // the WASM encoder stays registered with Mediabunny once added

/** Encodes a few milliseconds of silence to prove an audio codec works end to end. */
async function probeAudioEncode(MB, codec) {
  const output = new MB.Output({ format: new MB.Mp4OutputFormat(), target: new MB.BufferTarget() });
  const source = new MB.AudioBufferSource({ codec, quality: new MB.Quality({ bitrate: 128_000 }) });
  output.addAudioTrack(source);
  const run = (async () => {
    await output.start();
    await source.add(new AudioBuffer({ length: 4800, numberOfChannels: 2, sampleRate: DEFAULT_SAMPLE_RATE }));
    source.close();
    await output.finalize();
    return (output.target.buffer?.byteLength || 0) > 0;
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('AAC encoder timed out')), 15000);
  });
  try {
    return await Promise.race([run, timeout]);
  } catch (e) {
    output.cancel().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Makes AAC encodable: native WebCodecs when available, otherwise the vendored WASM encoder
 * (@mediabunny/aac-encoder, worker shipped as extension/vendor/aac-encoder-worker.js).
 * @returns {Promise<'native'|'wasm'|null>}
 */
export function ensureAacEncoder() {
  if (!aacPromise) {
    aacPromise = (async () => {
      const MB = await loadMB();
      if (aacRegistered) return 'wasm';
      if (await MB.canEncodeAudio('aac', AUDIO_PROBE)) return 'native';
      try {
        const mod = await aacLoader();
        mod.registerAacEncoder();
        aacRegistered = true;
        if ((await MB.canEncodeAudio('aac', AUDIO_PROBE)) && (await probeAudioEncode(MB, 'aac'))) return 'wasm';
      } catch (e) {
        console.warn('[gis] AAC encoder unavailable, MP4 audio falls back to Opus', e);
      }
      return null;
    })();
  }
  return aacPromise;
}

const capsCache = new Map();

/**
 * Forgets the cached encoder probes so the next getExportCapabilities() checks again (e.g. after a failed
 * probe). `aacLoader` replaces the loader of the WASM AAC module — the E2E suite uses it to simulate a browser
 * where that encoder can't start; pass null to restore the vendored module.
 */
export function resetExportCapabilities({ aacLoader: loader } = {}) {
  capsCache.clear();
  aacPromise = null;
  if (loader !== undefined) aacLoader = loader || defaultAacLoader;
}

/**
 * Which codecs this browser can encode at the given size.
 * @returns {Promise<{mp4: {video: 'avc'|null, audio: 'aac'|'opus'|null}, webm: {video: 'vp9'|'av1'|'vp8'|null,
 *   audio: 'opus'|null}, aacEncoder: 'native'|'wasm'|null}>}
 */
export function getExportCapabilities({ width = 1280, height = 720, fps = 30 } = {}) {
  const dims = evenDimensions(width, height);
  const key = `${dims.width}x${dims.height}@${fps}`;
  if (!capsCache.has(key)) {
    const p = (async () => {
      const MB = await loadMB();
      const opts = { width: dims.width, height: dims.height, frameRate: fps };
      const [aacEncoder, avc, webmVideo, opus] = await Promise.all([
        ensureAacEncoder(),
        MB.getFirstEncodableVideoCodec(['avc'], opts),
        MB.getFirstEncodableVideoCodec(['vp9', 'av1', 'vp8'], opts),
        MB.canEncodeAudio('opus', AUDIO_PROBE),
      ]);
      return {
        mp4: { video: avc || null, audio: aacEncoder ? 'aac' : opus ? 'opus' : null },
        webm: { video: webmVideo || null, audio: opus ? 'opus' : null },
        aacEncoder,
      };
    })();
    p.catch(() => capsCache.delete(key));
    capsCache.set(key, p);
  }
  return capsCache.get(key);
}

// ---------------------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------------------

async function requireBlob(project, mediaId) {
  const m = project.media[mediaId];
  const blob = await (await mediaApi()).getMediaBlob(mediaId);
  if (!blob) throw new Error(`"${m?.name || 'A clip'}" is not available offline any more — re-import it from the Clips tab`);
  return blob;
}

/** Decoded still for an image clip, pre-scaled when much larger than the output (kept sharp for Ken Burns). */
async function decodeImage(project, mediaId, W, H) {
  const blob = await requireBlob(project, mediaId);
  const probe = await createImageBitmap(blob);
  const limit = Math.max(W, H) * 2;
  if (Math.max(probe.width, probe.height) <= limit) return probe;
  const s = limit / Math.max(probe.width, probe.height);
  const resized = await createImageBitmap(probe, {
    resizeWidth: Math.max(1, Math.round(probe.width * s)),
    resizeHeight: Math.max(1, Math.round(probe.height * s)),
    resizeQuality: 'high',
  });
  probe.close();
  return resized;
}

/**
 * Decoded stills shared by the clips that show them. A bitmap is closed as soon as no open clip uses it any
 * more, so a long slideshow only keeps the stills on screen (and about to appear) in memory; a still that comes
 * back later is decoded again.
 */
export class StillCache {
  /** @param {(mediaId:string)=>Promise<ImageBitmap>} decode */
  constructor(decode) {
    this.decode = decode;
    this.entries = new Map();
  }

  /** Promise<ImageBitmap> for mediaId; pair every call with release(mediaId). */
  acquire(mediaId) {
    let e = this.entries.get(mediaId);
    if (!e) {
      e = { users: 0, bitmap: Promise.resolve().then(() => this.decode(mediaId)) };
      e.bitmap.catch(() => {}); // surfaced by the clip that awaits it
      this.entries.set(mediaId, e);
    }
    e.users++;
    return e.bitmap;
  }

  release(mediaId) {
    const e = this.entries.get(mediaId);
    if (!e || --e.users > 0) return;
    this.entries.delete(mediaId);
    e.bitmap.then((b) => b.close(), () => {});
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    for (const e of this.entries.values()) e.bitmap.then((b) => b.close(), () => {});
    this.entries.clear();
  }
}

/** Opens a clip's video track for frame access (core/video-color.js), with errors that name the clip. */
async function openVideoTrack(MB, project, mediaId) {
  const name = project.media[mediaId]?.name || 'a clip';
  const blob = await requireBlob(project, mediaId);
  let v;
  try {
    v = await openVideoFrames(MB, blob);
  } catch (e) {
    throw new Error(/no video track/i.test(e?.message || '') ? `"${name}" has no video track` : `Couldn't read "${name}": ${e?.message || e}`);
  }
  let decodable = false;
  try {
    decodable = await v.track.canDecode();
  } catch {
    /* treated as not decodable */
  }
  if (!decodable) {
    v.input.dispose();
    throw new Error(`This browser can't decode "${name}"`);
  }
  return v;
}

/** Canvas image source for a decoded frame (applies rotation / flip metadata when present). */
function frameSource(frame) {
  if (!frame) return null;
  if (frame.bitmap) return { image: frame.bitmap, width: frame.bitmap.width, height: frame.bitmap.height };
  const s = frame.sample;
  const w = s.displayWidth;
  const h = s.displayHeight;
  if (!s.rotation && !s.flip) return { image: s.toCanvasImageSource(), width: w, height: h };
  let c = frame.owner.rotCanvas;
  if (!c || c.width !== w || c.height !== h) c = frame.owner.rotCanvas = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  s.draw(g, 0, 0, w, h);
  return { image: c, width: w, height: h };
}

/**
 * Samples for output timestamps in any order (a reversed clip's run backwards, a freeze frame's repeat): every
 * `window` output frames are decoded in one forward samplesAtTimestamps() pass over their distinct timestamps
 * (sorted), so a GOP is decoded once per window instead of once per frame, then handed out in the requested order.
 * Yields VideoSample | null (the caller owns and closes each); at most `window` decoded frames are held at a time.
 * @param {{samplesAtTimestamps: (t: number[]) => AsyncIterable<Object|null>}} sink  Mediabunny VideoSampleSink
 * @param {number[]} times  source seconds, in output order
 */
export async function* orderedSamples(sink, times, { window = 30 } = {}) {
  for (let i = 0; i < times.length; i += window) {
    const block = times.slice(i, i + window);
    const uniq = [...new Set(block)].sort((a, b) => a - b);
    const got = new Map();
    try {
      let k = 0;
      for await (const sample of sink.samplesAtTimestamps(uniq)) got.set(uniq[k++], sample);
      for (const t of block) {
        const sample = got.get(t);
        yield sample ? sample.clone() : null;
      }
    } finally {
      for (const sample of got.values()) sample?.close();
    }
  }
}

/**
 * Streams the frames one main-track clip needs, in output order. When the decoder has nothing for a frame (data
 * missing from a truncated file, a damaged packet) the last good frame stands in, and `gap` records it.
 */
class ClipStream {
  constructor({ MB, project, entry, stills }) {
    Object.assign(this, { MB, project, entry, stills });
    this.mediaId = entry.item.clip.mediaId;
    this.kind = project.media[this.mediaId]?.kind || 'video';
    this.last = null; // clone of the last decoded sample (reused if the decoder yields nothing)
    this.rotCanvas = null;
    this.closed = false;
    this.pos = 0; // index (into entry.times) of the next frame
    this.gap = null; // frames the decoder had nothing for: {index (first), last, frames, after (decoded since), decoded (before)}
    this.still = this.kind === 'image' ? stills.acquire(this.mediaId) : null;
    this.ready = this.open();
    this.ready.catch(() => {}); // surfaced when awaited
  }

  async open() {
    if (this.still) {
      const bitmap = await this.still;
      if (!this.closed) this.bitmap = bitmap; // owned by the StillCache, which closes it
      return;
    }
    const { input, sink, first, retag } = await openVideoTrack(this.MB, this.project, this.mediaId);
    if (this.closed) {
      input.dispose();
      return;
    }
    this.input = input;
    this.retag = retag;
    // A hair past each target so float rounding never selects the previous frame.
    const times = this.entry.times.map((t) => Math.max(first, t) + 1e-4);
    // Reversed clips need their timestamps backwards and freeze frames one timestamp over and over: both decode in
    // forward windows (orderedSamples) instead of one decode from the previous keyframe per frame.
    const clip = this.entry.item.clip;
    this.iter = (clip.reverse || clip.freeze ? orderedSamples(sink, times) : sink.samplesAtTimestamps(times))[Symbol.asyncIterator]();
  }

  /** Next frame: {bitmap} | {sample, owner} | null. The caller closes it with closeFrame(). */
  async next() {
    await this.ready;
    if (this.bitmap) return { bitmap: this.bitmap };
    const index = this.pos++;
    const { value, done } = await this.iter.next();
    let sample = done ? null : value;
    if (sample && this.retag) sample = await retagSample(this.MB, sample, this);
    if (sample) {
      if (this.gap) this.gap.after++;
      this.last?.close();
      this.last = sample.clone();
    } else {
      if (this.gap) this.gap.frames++;
      else this.gap = { index, frames: 1, after: 0, decoded: !!this.last };
      this.gap.last = index;
      if (this.last) sample = this.last.clone();
    }
    return sample ? { sample, owner: this } : null;
  }

  /**
   * What decodeGapMessage() needs about this clip's missing frames, once all of them were requested (null if none).
   * A file that stops decoding mid-clip often still yields a stray frame or two after the first missing one (the
   * decoder drains what it can); that still reads as "stops decoding", not as parts missing here and there.
   */
  gapReport(start, fps) {
    const g = this.gap;
    if (!g) return null;
    const endsInGap = g.last === this.entry.times.length - 1;
    return {
      from: this.entry.times[g.index],
      at: start + (this.entry.first + g.index) / fps,
      frames: g.frames,
      fps,
      decoded: g.decoded,
      resumed: !endsInGap || g.after / fps >= MIN_REPORTED_GAP,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.still) this.stills.release(this.mediaId);
    this.bitmap = null;
    try {
      await this.ready;
    } catch {
      /* failed to open: nothing to release */
    }
    try {
      await this.iter?.return?.();
    } catch {
      /* ignore */
    }
    this.last?.close();
    this.last = null;
    this.input?.dispose();
    this.input = null;
    this.rotCanvas = null;
    this.retagBuf = null;
  }
}

const closeFrame = (frame) => frame?.sample?.close();

// ---------------------------------------------------------------------------------------------------------
// Video export
// ---------------------------------------------------------------------------------------------------------

/**
 * Renders the sequence (or a range of it) to an MP4 or WebM file.
 * @param {Object} project
 * @param {Object} [opts]
 * @param {'mp4'|'webm'} [opts.format='mp4']
 * @param {number} [opts.width]  defaults to the project size (rounded to even numbers)
 * @param {number} [opts.height]
 * @param {number} [opts.fps]    defaults to the project frame rate
 * @param {'low'|'medium'|'high'|'max'} [opts.quality='high']
 * @param {number} [opts.videoBitrate]  overrides the quality preset (bits/s)
 * @param {number} [opts.audioBitrate]  overrides the quality preset (bits/s)
 * @param {{start:number,end:number}|null} [opts.range]
 * @param {boolean} [opts.includeAudio=true]
 * @param {(p:{progress:number, stage:string, frame:number, frames:number, eta:number|null, elapsed:number})=>void} [opts.onProgress]
 * @param {(canvas:OffscreenCanvas, frame:number)=>void} [opts.onFrame]  throttled live preview of rendered frames
 * @param {(w:{mediaId:string, name:string, message:string})=>void} [opts.onWarning]  e.g. a clip whose sound can't be
 *   decoded, or whose frames / sound stop before its out-point (truncated or damaged file)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{blob:Blob, mime:string, filename:string, duration:number, width:number, height:number,
 *   fps:number, frames:number, videoCodec:string, audioCodec:string|null, size:number, warnings:Array}>}
 */
export async function exportProject(project, opts = {}) {
  const { format = 'mp4', quality = 'high', range = null, includeAudio = true, onProgress = null, onFrame = null, onWarning = null, signal = null } = opts;
  const fmt = EXPORT_FORMATS[format];
  if (!fmt || fmt.kind !== 'video') throw new Error(`Unsupported video format: ${format}`);
  throwIfAborted(signal);

  const layout = layoutProject(project);
  if (!(layout.duration > 0)) throw new Error('The timeline is empty — add clips in the Edit tab first');
  const { start, end } = resolveRange(range, layout.duration);
  const fps = clamp(Number(opts.fps) || project.settings?.fps || 30, 1, 120);
  const { width: W, height: H } = evenDimensions(opts.width || project.settings?.width || 1280, opts.height || project.settings?.height || 720);
  const problems = exportProblems(project, { start, end, audio: includeAudio });
  if (problems.length) throw new Error(problems.length > 1 ? `${problems[0].message} (+${problems.length - 1} more)` : problems[0].message);

  const startedAt = now();
  let stage = 'prepare';
  let frame = 0;
  let lastEmit = -Infinity;
  const plan = planFrames(layout, { start, end, fps });
  const total = plan.frames;
  const audible = includeAudio && hasAudibleContent(project, { start, end });
  // Retimed clip sound goes through the (slower) pitch-preserving stretch: give the audio stage more of the bar.
  const retimedSound = audible && [...layout.video, ...layout.overlay].some((it) => it.end > start && it.start < end && mainClipAudible(project, it.clip) && Math.abs((it.clip.speed || 1) - 1) > 1e-3);
  const weights = { prepare: 0.02, audio: audible ? (retimedSound ? 0.2 : 0.08) : 0.02, video: 0.97 };
  const warnings = [];
  const warn = (w) => {
    warnings.push(w);
    try {
      onWarning?.(w);
    } catch {
      /* best effort */
    }
  };
  let videoStartedAt = 0;
  const emit = (progress, force = false) => {
    const t = now();
    if (!onProgress || (!force && t - lastEmit < 100)) return;
    lastEmit = t;
    let eta = null;
    if (stage === 'video' && frame > 2) {
      const perFrame = (t - videoStartedAt) / frame;
      eta = ((total - frame) * perFrame * 1.04) / 1000; // + finalize
    } else if (stage === 'finalize') eta = 0;
    try {
      onProgress({ progress: clamp(progress, 0, 1), stage, frame, frames: total, eta, elapsed: (t - startedAt) / 1000 });
    } catch (e) {
      console.warn('[gis] export progress listener failed', e);
    }
  };
  emit(0, true);

  const MB = await loadMB();
  const caps = await getExportCapabilities({ width: W, height: H, fps });
  const videoCodec = caps[format].video;
  if (!videoCodec) {
    throw new Error(format === 'mp4' ? `This browser can't encode H.264 at ${W}×${H} — try a smaller size or WebM` : `This browser can't encode WebM video at ${W}×${H} — try a smaller size or MP4`);
  }
  const audioCodec = audible ? caps[format].audio : null;
  const videoBitrate = Math.round(opts.videoBitrate || videoBitrateFor({ width: W, height: H, fps, quality }));
  const audioBitrate = Math.round(opts.audioBitrate || audioBitrateFor(quality));

  let output = null;
  const streams = new Map(); // layoutItemKey -> ClipStream
  const stills = new StillCache((mediaId) => decodeImage(project, mediaId, W, H));
  let audioIds = [];
  try {
    // 1. Audio mixdown (fast, offline) — rendered to the exact video duration.
    let mix = null;
    if (audioCodec) {
      stage = 'audio';
      emit(weights.prepare, true);
      const plannedIds = new Set();
      for (const it of layout.video) if (mainClipAudible(project, it.clip)) plannedIds.add(it.clip.mediaId);
      for (const it of layout.audio) if (audioClipAudible(project, it.clip)) plannedIds.add(it.clip.mediaId);
      for (const it of layout.overlay) if (mainClipAudible(project, it.clip)) plannedIds.add(it.clip.mediaId);
      audioIds = [...plannedIds];
      mix = await renderAudioMix(project, {
        start,
        end: start + plan.duration,
        sampleRate: DEFAULT_SAMPLE_RATE,
        signal,
        onWarning: warn,
        onProgress: (f) => emit(weights.prepare + (weights.audio - weights.prepare) * f),
      });
      throwIfAborted(signal);
    }

    // 2. Output + sources.
    output = new MB.Output({
      format: format === 'mp4' ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.WebMOutputFormat(),
      target: new MB.BufferTarget(),
    });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    const videoSource = new MB.CanvasSource(canvas, { codec: videoCodec, quality: new MB.Quality({ bitrate: videoBitrate }), keyFrameInterval: KEYFRAME_INTERVAL });
    output.addVideoTrack(videoSource, { frameRate: fps });
    let audioSource = null;
    if (mix) {
      // FFmpeg's AAC encoder (the WASM fallback) prepends 1024 samples of priming. Starting the track that much
      // earlier makes Mediabunny write an edit list that trims them, keeping audio sample-aligned with the video.
      const startTimestamp = audioCodec === 'aac' && caps.aacEncoder === 'wasm' ? -AAC_PRIMING_SAMPLES / mix.sampleRate : 0;
      audioSource = new MB.AudioBufferSource({ codec: audioCodec, quality: new MB.Quality({ bitrate: audioBitrate }) }, { startTimestamp });
      output.addAudioTrack(audioSource);
    }
    await output.start();
    throwIfAborted(signal);

    let audioPos = 0;
    const feedAudio = async (untilSeconds) => {
      if (!audioSource) return;
      const sr = mix.sampleRate;
      while (audioPos < mix.length && audioPos / sr < untilSeconds) {
        const n = Math.min(sr, mix.length - audioPos);
        const chunk = new AudioBuffer({ length: n, numberOfChannels: mix.numberOfChannels, sampleRate: sr });
        for (let c = 0; c < mix.numberOfChannels; c++) chunk.copyToChannel(mix.getChannelData(c).subarray(audioPos, audioPos + n), c);
        await audioSource.add(chunk);
        audioPos += n;
      }
    };

    // 3. Frames.
    stage = 'video';
    videoStartedAt = now();
    emit(weights.audio, true);
    const scratch = createScratch();
    const openAhead = Math.ceil(OPEN_AHEAD * fps);
    let nextToOpen = 0;
    let active = [];
    let lastPreview = -Infinity;
    const gapsReported = new Set(); // media ids (one warning per file, however many clips use it)
    const reportGap = (s) => {
      const report = s.gapReport(start, fps);
      const message = report && !gapsReported.has(s.mediaId) && decodeGapMessage(project.media[s.mediaId]?.name || 'A clip', report);
      if (!message) return;
      gapsReported.add(s.mediaId);
      warn({ mediaId: s.mediaId, name: project.media[s.mediaId]?.name || 'A clip', message });
    };
    for (let k = 0; k < total; k++) {
      throwIfAborted(signal);
      while (nextToOpen < plan.items.length && plan.items[nextToOpen].first <= k + openAhead) {
        const entry = plan.items[nextToOpen++];
        const stream = new ClipStream({ MB, project, entry, stills });
        streams.set(entry.key, stream);
        active.push(stream);
      }
      const frames = new Map();
      try {
        for (const s of active) if (s.entry.first <= k && s.entry.last >= k) frames.set(s.entry.key, await s.next());
        const t = start + k / fps;
        drawFrame(ctx, { project, layout, t, getSource: (item) => frameSource(frames.get(layoutItemKey(item))), scratch });
      } finally {
        for (const f of frames.values()) closeFrame(f);
      }
      // Retire clips whose last frame has been drawn.
      const done = active.filter((s) => s.entry.last <= k);
      if (done.length) {
        active = active.filter((s) => s.entry.last > k);
        for (const s of done) {
          streams.delete(s.entry.key);
          reportGap(s);
          s.close();
        }
      }
      if (onFrame && (now() - lastPreview > 400 || k === total - 1)) {
        lastPreview = now();
        try {
          onFrame(canvas, k);
        } catch {
          /* preview is best effort */
        }
      }
      await feedAudio(k / fps + 1);
      await videoSource.add(k / fps, 1 / fps);
      frame = k + 1;
      emit(weights.audio + (weights.video - weights.audio) * (frame / total));
    }
    await feedAudio(Infinity);
    throwIfAborted(signal);

    // 4. Finalize.
    stage = 'finalize';
    emit(weights.video, true);
    videoSource.close();
    audioSource?.close();
    await output.finalize();
    throwIfAborted(signal);
    const blob = new Blob([output.target.buffer], { type: fmt.mime });
    stage = 'done';
    emit(1, true);
    return {
      blob,
      mime: fmt.mime,
      filename: exportFilename(project.name, fmt.ext),
      duration: plan.duration,
      width: W,
      height: H,
      fps,
      frames: total,
      videoCodec,
      audioCodec,
      videoBitrate,
      audioBitrate: audioCodec ? audioBitrate : 0,
      size: blob.size,
      warnings,
    };
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    if (signal?.aborted) throw abortError();
    throw err;
  } finally {
    await Promise.all([...streams.values()].map((s) => s.close()));
    stills.clear();
    const release = releasableAudioIds(project, audioIds);
    if (release.length) releaseAudio(release);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Single frame & audio-only exports
// ---------------------------------------------------------------------------------------------------------

/**
 * Composited frame of the sequence at timeline time t.
 * @param {Object} project
 * @param {number} t  timeline seconds (clamped into the sequence)
 * @param {{width?:number, height?:number, type?:string, quality?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<Blob>}
 */
export async function exportFrame(project, t, { width, height, type = 'image/png', quality = 0.95, signal = null } = {}) {
  throwIfAborted(signal);
  const layout = layoutProject(project);
  const W = Math.round(clamp(Number(width) || project.settings?.width || 1280, 1, MAX_DIM));
  const H = Math.round(clamp(Number(height) || project.settings?.height || 720, 1, MAX_DIM));
  const tt = clamp(Number(t) || 0, 0, Math.max(0, layout.duration - 1e-3));
  const items = [...videoItemsAt(layout.video, tt), ...overlayItemsAt(layout.overlay, tt)];
  const problems = exportProblems(project, { start: tt, end: tt + 1e-3, audio: false });
  if (problems.length) throw new Error(problems[0].message);
  const MB = items.some((it) => project.media[it.clip.mediaId]?.kind !== 'image') ? await loadMB() : null;
  const frames = new Map();
  const inputs = [];
  const release = () => {
    for (const f of frames.values()) {
      closeFrame(f);
      if (f.ownsBitmap) f.bitmap.close();
    }
    frames.clear();
    for (const input of inputs) input.dispose();
    inputs.length = 0;
  };
  try {
    for (const item of items) {
      const mediaId = item.clip.mediaId;
      if (project.media[mediaId]?.kind === 'image') {
        frames.set(layoutItemKey(item), { bitmap: await decodeImage(project, mediaId, W, H), ownsBitmap: true });
        throwIfAborted(signal);
        continue;
      }
      const { input, sink, first, retag } = await openVideoTrack(MB, project, mediaId);
      inputs.push(input);
      throwIfAborted(signal);
      const at = Math.max(first, sourceTimeAt(item, tt));
      let sample = await sink.getSample(at + 1e-4);
      if (!sample) {
        // Past the data a truncated file still lists there is no such frame: say so rather than show another one.
        if (at > first + 0.1) throw new Error(`Couldn't decode "${project.media[mediaId]?.name || 'a clip'}" at ${formatTime(at)} — the file may be damaged or incomplete`);
        sample = await sink.getSample(first);
      }
      if (sample && retag) sample = await retagSample(MB, sample, {});
      if (sample) frames.set(layoutItemKey(item), { sample, owner: {} });
      throwIfAborted(signal);
    }
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    drawFrame(ctx, { project, layout, t: tt, getSource: (item) => frameSource(frames.get(layoutItemKey(item))), scratch: createScratch() });
    release(); // decoders and frames aren't needed for the (possibly slow) image encode
    throwIfAborted(signal);
    const blob = await canvas.convertToBlob({ type, quality });
    throwIfAborted(signal);
    return blob;
  } finally {
    release();
  }
}

/**
 * 16-bit PCM WAV (48 kHz stereo) of the sequence's sound, optionally limited to a range.
 * `onProgress({progress, stage})` reports the mix ('audio') and the file encoding ('finalize').
 * @param {Object} project
 * @param {{range?:{start:number,end:number}|null, sampleRate?:number, signal?:AbortSignal,
 *   onProgress?:(p:{progress:number, stage:string, frame:number, frames:number, eta:null})=>void,
 *   onWarning?:(w:{mediaId:string, name:string, message:string})=>void}} [opts]
 * @returns {Promise<Blob>}
 */
export async function exportAudioWav(project, { range = null, sampleRate = DEFAULT_SAMPLE_RATE, signal = null, onProgress = null, onWarning = null } = {}) {
  throwIfAborted(signal);
  const layout = layoutProject(project);
  if (!(layout.duration > 0)) throw new Error('The timeline is empty — add clips in the Edit tab first');
  const { start, end } = resolveRange(range, layout.duration);
  const problems = exportProblems(project, { start, end, video: false });
  if (problems.length) throw new Error(problems[0].message);
  let lastReport = -Infinity;
  let lastStage = null;
  const report = (progress, stage) => {
    const t = now();
    if (!onProgress || (stage === lastStage && progress < 1 && t - lastReport < 100)) return; // ~10 updates/s
    lastReport = t;
    lastStage = stage;
    try {
      onProgress({ progress: clamp(progress, 0, 1), stage, frame: 0, frames: 0, eta: null });
    } catch (e) {
      console.warn('[gis] export progress listener failed', e);
    }
  };
  const MIX_SHARE = 0.92;
  const ids = [
    ...new Set(
      [...layout.video, ...layout.overlay]
        .filter((it) => mainClipAudible(project, it.clip))
        .map((it) => it.clip.mediaId)
        .concat(layout.audio.filter((it) => audioClipAudible(project, it.clip)).map((it) => it.clip.mediaId)),
    ),
  ];
  try {
    report(0, 'audio');
    const buffer = await renderAudioMix(project, { start, end, sampleRate, signal, onWarning, onProgress: (f) => report(f * MIX_SHARE, 'audio') });
    throwIfAborted(signal);
    report(MIX_SHARE, 'finalize');
    const wav = await runStepsSliced(wavSteps(bufferChannels(buffer), buffer.sampleRate), { signal, onProgress: (f) => report(MIX_SHARE + (1 - MIX_SHARE) * f, 'finalize') });
    report(1, 'done');
    return new Blob([wav], { type: 'audio/wav' });
  } finally {
    const release = releasableAudioIds(project, ids);
    if (release.length) releaseAudio(release);
  }
}
