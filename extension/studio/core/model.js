// Project data model and pure timeline operations. No DOM, no chrome.* — importable from Node unit tests.
//
// Timeline model
// --------------
//  * tracks.video  — the main "magnetic" track: clips play back to back, no gaps. A clip may carry
//                    `transition` = the transition INTO it from the previous clip; the two clips overlap for
//                    the transition duration (so total = sum(durations) - sum(transitions)).
//  * tracks.audio  — free-positioned audio clips (music, voice, sfx) with absolute `start`, on lanes (`lane`).
//  * tracks.text   — free-positioned text overlays (titles, captions) with absolute `start`, on lanes.
//  A clip's on-timeline duration = (out - in) / speed. `in`/`out` are source-media seconds.
//  All functions are immutable: they return new objects and never mutate their inputs.

import { clamp, uid, EPS } from './utils.js';

export const SCHEMA_VERSION = 1;
export const DEFAULT_IMAGE_DURATION = 3;
export const MIN_CLIP_DURATION = 0.1;
export const MAX_SPEED = 4;
export const MIN_SPEED = 0.25;
export const DEFAULT_TRANSITION_DURATION = 0.6;

export const RESOLUTION_PRESETS = [
  { id: '720p', label: '1280×720 (16:9)', width: 1280, height: 720 },
  { id: '1080p', label: '1920×1080 (16:9)', width: 1920, height: 1080 },
  { id: '720v', label: '720×1280 (9:16 vertical)', width: 720, height: 1280 },
  { id: '1080v', label: '1080×1920 (9:16 vertical)', width: 1080, height: 1920 },
  { id: 'square', label: '1080×1080 (1:1)', width: 1080, height: 1080 },
  { id: '4x5', label: '1080×1350 (4:5)', width: 1080, height: 1350 },
  { id: '480p', label: '854×480 (16:9 small)', width: 854, height: 480 },
];

export const FPS_PRESETS = [24, 25, 30, 60];

/** Transition catalogue. `kind` groups them in the picker. Renderers live in engine/transitions.js. */
export const TRANSITIONS = [
  { id: 'crossfade', name: 'Dissolve', kind: 'fade' },
  { id: 'fade-black', name: 'Dip to black', kind: 'fade' },
  { id: 'fade-white', name: 'Dip to white', kind: 'fade' },
  { id: 'blur', name: 'Blur dissolve', kind: 'fade' },
  { id: 'wipe-left', name: 'Wipe left', kind: 'wipe' },
  { id: 'wipe-right', name: 'Wipe right', kind: 'wipe' },
  { id: 'wipe-up', name: 'Wipe up', kind: 'wipe' },
  { id: 'wipe-down', name: 'Wipe down', kind: 'wipe' },
  { id: 'slide-left', name: 'Push left', kind: 'slide' },
  { id: 'slide-right', name: 'Push right', kind: 'slide' },
  { id: 'slide-up', name: 'Push up', kind: 'slide' },
  { id: 'slide-down', name: 'Push down', kind: 'slide' },
  { id: 'whip-left', name: 'Whip pan left', kind: 'slide' },
  { id: 'whip-right', name: 'Whip pan right', kind: 'slide' },
  { id: 'zoom-in', name: 'Zoom in', kind: 'zoom' },
  { id: 'zoom-out', name: 'Zoom out', kind: 'zoom' },
  { id: 'spin', name: 'Spin', kind: 'zoom' },
  { id: 'circle-open', name: 'Iris open', kind: 'shape' },
  { id: 'circle-close', name: 'Iris close', kind: 'shape' },
  { id: 'clock', name: 'Clock wipe', kind: 'shape' },
  { id: 'pixelate', name: 'Pixelate', kind: 'stylized' },
  { id: 'glitch', name: 'Glitch', kind: 'stylized' },
];
export const TRANSITION_IDS = new Set(TRANSITIONS.map((t) => t.id));

/** Per-clip visual adjustments (CSS-filter semantics; 1 = neutral for multipliers, 0 for additive). */
export const FILTER_DEFAULTS = Object.freeze({
  brightness: 1, // 0..2
  contrast: 1, // 0..2
  saturate: 1, // 0..3
  hue: 0, // degrees -180..180
  grayscale: 0, // 0..1
  sepia: 0, // 0..1
  invert: 0, // 0..1
  blur: 0, // px at 720p reference height, 0..20
  vignette: 0, // 0..1
});

/** One-click looks (merged over FILTER_DEFAULTS). */
export const FILTER_PRESETS = [
  { id: 'none', name: 'Original', filters: {} },
  { id: 'cinematic', name: 'Cinematic', filters: { contrast: 1.15, saturate: 0.85, vignette: 0.35 } },
  { id: 'warm', name: 'Warm', filters: { sepia: 0.25, saturate: 1.15, hue: -8 } },
  { id: 'cool', name: 'Cool', filters: { hue: 12, saturate: 0.9, brightness: 1.03 } },
  { id: 'vivid', name: 'Vivid', filters: { saturate: 1.5, contrast: 1.1 } },
  { id: 'faded', name: 'Faded film', filters: { contrast: 0.85, saturate: 0.7, brightness: 1.08, sepia: 0.15 } },
  { id: 'noir', name: 'Noir', filters: { grayscale: 1, contrast: 1.35, vignette: 0.5 } },
  { id: 'bw', name: 'Black & white', filters: { grayscale: 1 } },
  { id: 'vintage', name: 'Vintage', filters: { sepia: 0.55, contrast: 1.1, saturate: 0.8, vignette: 0.4 } },
  { id: 'dream', name: 'Dreamy', filters: { blur: 1.2, brightness: 1.1, saturate: 1.2 } },
];

export const TEXT_ANIMATIONS = ['none', 'fade', 'slide-up', 'pop', 'typewriter'];

export const TEXT_STYLE_DEFAULTS = Object.freeze({
  font: 'Inter, system-ui, sans-serif',
  size: 0.07, // fraction of output height
  weight: 700,
  color: '#ffffff',
  background: '', // css color or '' for none
  align: 'center', // left | center | right
  x: 0.5, // anchor position, fraction of width
  y: 0.86, // anchor position (baseline block centre), fraction of height
  shadow: true,
  outline: false,
  italic: false,
  maxWidth: 0.9, // fraction of width used for wrapping
});

// ---------------------------------------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------------------------------------

export function createProject(name = 'Untitled sequence') {
  const now = Date.now();
  return {
    id: uid('prj'),
    schema: SCHEMA_VERSION,
    name,
    createdAt: now,
    updatedAt: now,
    settings: { width: 1280, height: 720, fps: 30, background: '#000000' },
    media: {}, // id -> MediaItem
    mediaOrder: [], // bin order, newest first
    tracks: { video: [], audio: [], text: [] },
    markers: [], // {id, time, label, color}
    shots: [], // storyboard / prompt list (owned by the Prompts tab, see prompts/prompt-model.js)
    bible: { characters: [], locations: [], style: '', notes: '' },
    exportSettings: null, // last used export options
  };
}

/**
 * @typedef {Object} MediaItem
 * @property {string} id
 * @property {'video'|'image'|'audio'} kind
 * @property {string} name
 * @property {'grok'|'file'|'url'|'frame'|'export'} origin
 * @property {string|null} sourceUrl   remote URL used for (re)fetching
 * @property {string[]} altUrls
 * @property {string|null} pageUrl
 * @property {string|null} pageKey     PageMedia.key when collected from grok.com
 * @property {string|null} postId
 * @property {string|null} prompt
 * @property {string} mime
 * @property {number} size
 * @property {number} duration          seconds (0 for images)
 * @property {number} width
 * @property {number} height
 * @property {boolean} hasAudio
 * @property {number|null} fps
 * @property {'pending'|'loading'|'ready'|'error'} status
 * @property {string|null} error
 * @property {number} rating            0..5
 * @property {'pick'|'reject'|null} flag
 * @property {string[]} tags
 * @property {string} note
 * @property {number} addedAt
 * @property {string|null} shotId
 */
export function createMediaItem(partial = {}) {
  return {
    id: partial.id || uid('med'),
    kind: partial.kind || 'video',
    name: partial.name || 'Untitled',
    origin: partial.origin || 'file',
    sourceUrl: partial.sourceUrl ?? null,
    altUrls: partial.altUrls || [],
    pageUrl: partial.pageUrl ?? null,
    pageKey: partial.pageKey ?? null,
    postId: partial.postId ?? null,
    prompt: partial.prompt ?? null,
    mime: partial.mime || '',
    size: partial.size || 0,
    duration: partial.duration || 0,
    width: partial.width || 0,
    height: partial.height || 0,
    hasAudio: !!partial.hasAudio,
    fps: partial.fps ?? null,
    status: partial.status || 'pending',
    error: partial.error ?? null,
    rating: partial.rating || 0,
    flag: partial.flag ?? null,
    tags: partial.tags || [],
    note: partial.note || '',
    addedAt: partial.addedAt || Date.now(),
    shotId: partial.shotId ?? null,
  };
}

/** Default source range for a media item placed on the timeline. */
export function defaultRange(media) {
  if (!media || media.kind === 'image') return { in: 0, out: DEFAULT_IMAGE_DURATION };
  const d = media.duration > 0 ? media.duration : DEFAULT_IMAGE_DURATION;
  return { in: 0, out: d };
}

export function createVideoClip(media, opts = {}) {
  const range = defaultRange(media);
  // A video placed before its duration is known gets a placeholder length; core/media.js widens it to the
  // real duration once probed (unless the user trimmed it meanwhile — any in/out/speed edit clears autoOut).
  const autoOut = media.kind === 'video' && !(media.duration > 0) && opts.out == null;
  return {
    id: opts.id || uid('clp'),
    autoOut,
    mediaId: media.id,
    in: opts.in ?? range.in,
    out: opts.out ?? range.out,
    speed: opts.speed ?? 1,
    volume: opts.volume ?? 1,
    muted: opts.muted ?? false,
    fit: opts.fit || (media.kind === 'image' ? 'contain' : 'cover'),
    filters: opts.filters ? { ...opts.filters } : null, // null = untouched (FILTER_DEFAULTS)
    fadeIn: opts.fadeIn ?? 0,
    fadeOut: opts.fadeOut ?? 0,
    transition: opts.transition ?? null, // {type, duration} into this clip
    kenBurns: opts.kenBurns ?? (media.kind === 'image' ? defaultKenBurns() : null),
    label: opts.label || '',
  };
}

export function defaultKenBurns() {
  return { from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.5, y: 0.5, zoom: 1.12 } };
}

export function createAudioClip(media, opts = {}) {
  const d = media.duration > 0 ? media.duration : 10;
  return {
    id: opts.id || uid('aud'),
    autoOut: !(media.duration > 0) && opts.out == null,
    mediaId: media.id,
    start: Math.max(0, opts.start ?? 0),
    in: opts.in ?? 0,
    out: opts.out ?? d,
    volume: opts.volume ?? 1,
    fadeIn: opts.fadeIn ?? 0,
    fadeOut: opts.fadeOut ?? 0,
    lane: opts.lane ?? 0,
    label: opts.label || '',
  };
}

export function createTextClip(opts = {}) {
  return {
    id: opts.id || uid('txt'),
    text: opts.text ?? 'Title',
    start: Math.max(0, opts.start ?? 0),
    duration: Math.max(MIN_CLIP_DURATION, opts.duration ?? 3),
    style: { ...TEXT_STYLE_DEFAULTS, ...(opts.style || {}) },
    animation: opts.animation || 'fade',
    lane: opts.lane ?? 0,
  };
}

export function createTransition(type = 'crossfade', duration = DEFAULT_TRANSITION_DURATION) {
  return { type: TRANSITION_IDS.has(type) ? type : 'crossfade', duration: Math.max(0.05, duration) };
}

// ---------------------------------------------------------------------------------------------------------
// Durations & layout
// ---------------------------------------------------------------------------------------------------------

export const clipDuration = (clip) => Math.max(0, (clip.out - clip.in) / (clip.speed || 1));
export const audioClipDuration = (clip) => Math.max(0, clip.out - clip.in);

/**
 * Effective transition duration into clips[i], clamped so adjacent transitions never overlap:
 * at most half of each neighbour's duration.
 */
export function effectiveTransition(clips, i) {
  const clip = clips[i];
  if (i <= 0 || !clip?.transition || clip.transition.type === 'cut') return 0;
  const prev = clips[i - 1];
  const max = Math.min(clipDuration(prev), clipDuration(clip)) / 2;
  return clamp(clip.transition.duration || 0, 0, Math.max(0, max));
}

/**
 * @typedef {Object} VideoLayoutItem
 * @property {Object} clip
 * @property {number} index
 * @property {number} start          timeline seconds
 * @property {number} end            timeline seconds (exclusive)
 * @property {number} duration
 * @property {{type:string,start:number,end:number,duration:number}|null} transIn   window where this clip blends in over the previous one
 */

/** Positions of the main-track clips. */
export function layoutVideo(clips) {
  const out = [];
  let cursor = 0;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const duration = clipDuration(clip);
    const td = effectiveTransition(clips, i);
    const start = Math.max(0, cursor - td);
    const end = start + duration;
    out.push({
      clip,
      index: i,
      start,
      end,
      duration,
      transIn: td > EPS ? { type: clip.transition.type, start, end: start + td, duration: td } : null,
    });
    cursor = end;
  }
  return out;
}

export function layoutProject(project) {
  const video = layoutVideo(project.tracks.video);
  const audio = project.tracks.audio.map((clip) => ({
    clip,
    start: clip.start,
    end: clip.start + audioClipDuration(clip),
    duration: audioClipDuration(clip),
  }));
  const text = project.tracks.text.map((clip) => ({ clip, start: clip.start, end: clip.start + clip.duration, duration: clip.duration }));
  const videoEnd = video.length ? video[video.length - 1].end : 0;
  const duration = Math.max(videoEnd, ...audio.map((a) => a.end), ...text.map((t) => t.end), 0);
  return { video, audio, text, videoEnd, duration };
}

export const sequenceDuration = (project) => layoutProject(project).duration;

/** Main-track layout items active at time t (0, 1, or 2 during a transition), in track order. */
export function videoItemsAt(videoLayout, t) {
  const res = [];
  for (const item of videoLayout) {
    if (t >= item.start - EPS && t < item.end - EPS) res.push(item);
    else if (item.start > t) break;
  }
  return res.slice(-2);
}

/** Source-media time shown by a main-track item at timeline time t. */
export function sourceTimeAt(item, t) {
  const { clip } = item;
  const local = clamp(t - item.start, 0, item.duration);
  const src = clip.in + local * (clip.speed || 1);
  return clamp(src, clip.in, Math.max(clip.in, clip.out - 1e-3));
}

/** Inverse of sourceTimeAt for a main-track item. */
export function timelineTimeOf(item, sourceTime) {
  return item.start + (sourceTime - item.clip.in) / (item.clip.speed || 1);
}

/** Opacity multiplier from clip fades at timeline time t (1 = fully visible). */
export function fadeFactor(item, t) {
  const { clip } = item;
  const local = t - item.start;
  let f = 1;
  if (clip.fadeIn > 0) f = Math.min(f, clamp(local / clip.fadeIn, 0, 1));
  if (clip.fadeOut > 0) f = Math.min(f, clamp((item.duration - local) / clip.fadeOut, 0, 1));
  return f;
}

/**
 * Progress (0..1) of the incoming transition of `item` at time t, or null when not transitioning. Uses the same EPS
 * tolerance as videoItemsAt(): whenever both clips are active, the transition is too (a frame time a hair before
 * the window's floating-point start gives p = 0, never "no transition" — which would flash the incoming clip).
 */
export function transitionProgress(item, t) {
  if (!item.transIn) return null;
  if (t < item.transIn.start - EPS || t >= item.transIn.end - EPS) return null;
  return clamp((t - item.transIn.start) / item.transIn.duration, 0, 1);
}

export const textItemsAt = (textLayout, t) => textLayout.filter((a) => t >= a.start && t < a.end);

/** Index in the main track where an item dropped at time t should be inserted (nearest boundary). */
export function insertionIndexAt(videoLayout, t) {
  for (let i = 0; i < videoLayout.length; i++) {
    const it = videoLayout[i];
    if (t < (it.start + it.end) / 2) return i;
  }
  return videoLayout.length;
}

/** All snap candidate times: 0, clip boundaries on every track, markers, and optional extras (playhead). */
export function snapPoints(project, extra = []) {
  const lay = layoutProject(project);
  const pts = new Set([0, ...extra]);
  for (const v of lay.video) {
    pts.add(v.start);
    pts.add(v.end);
  }
  for (const a of lay.audio) {
    pts.add(a.start);
    pts.add(a.end);
  }
  for (const x of lay.text) {
    pts.add(x.start);
    pts.add(x.end);
  }
  for (const m of project.markers || []) pts.add(m.time);
  return [...pts].sort((a, b) => a - b);
}

/** Snap t to the nearest point within threshold seconds; returns {time, snapped, point}. */
export function snapTime(t, points, threshold) {
  let best = null;
  let bestD = threshold;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= bestD) {
      bestD = d;
      best = p;
    }
  }
  return best === null ? { time: t, snapped: false, point: null } : { time: best, snapped: true, point: best };
}

// ---------------------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------------------

/** Finds a clip on any track: {track: 'video'|'audio'|'text', index, clip} or null. */
export function findClip(project, id) {
  for (const track of ['video', 'audio', 'text']) {
    const index = project.tracks[track].findIndex((c) => c.id === id);
    if (index >= 0) return { track, index, clip: project.tracks[track][index] };
  }
  return null;
}

/** Max source time for a clip's media (Infinity for images: stills can be stretched freely). */
export function mediaMaxTime(project, mediaId) {
  const m = project.media[mediaId];
  if (!m) return Infinity;
  if (m.kind === 'image') return Infinity;
  return m.duration > 0 ? m.duration : Infinity;
}

// ---------------------------------------------------------------------------------------------------------
// Immutable update helpers
// ---------------------------------------------------------------------------------------------------------

const touch = (project) => ({ ...project, updatedAt: Date.now() });

function withTrack(project, track, clips) {
  return touch({ ...project, tracks: { ...project.tracks, [track]: clips } });
}

export function updateSettings(project, patch) {
  return touch({ ...project, settings: { ...project.settings, ...patch } });
}

export function renameProject(project, name) {
  return touch({ ...project, name: String(name || '').trim() || 'Untitled sequence' });
}

// --- media ---

export function addMedia(project, item, { front = true } = {}) {
  if (project.media[item.id]) return updateMedia(project, item.id, item);
  return touch({
    ...project,
    media: { ...project.media, [item.id]: item },
    mediaOrder: front ? [item.id, ...project.mediaOrder] : [...project.mediaOrder, item.id],
  });
}

export function updateMedia(project, id, patch) {
  const cur = project.media[id];
  if (!cur) return project;
  return touch({ ...project, media: { ...project.media, [id]: { ...cur, ...patch } } });
}

/** Removes media items and every clip that references them. */
export function removeMedia(project, ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const media = { ...project.media };
  for (const id of set) delete media[id];
  return touch({
    ...project,
    media,
    mediaOrder: project.mediaOrder.filter((id) => !set.has(id)),
    tracks: {
      video: fixFirstTransition(project.tracks.video.filter((c) => !set.has(c.mediaId))),
      audio: project.tracks.audio.filter((c) => !set.has(c.mediaId)),
      text: project.tracks.text,
    },
  });
}

export function findMediaByPageKey(project, key) {
  if (!key) return null;
  for (const id of project.mediaOrder) if (project.media[id]?.pageKey === key) return project.media[id];
  return null;
}

/** Bin item for a PageMedia, matching its key or any of its aliases (keys it carried before Grok named the post). */
export function findMediaForPageItem(project, item) {
  for (const k of [item?.key, ...(item?.aliases || [])]) {
    const m = findMediaByPageKey(project, k);
    if (m) return m;
  }
  return null;
}

/** Clips referencing a media item: [{track, clip}] */
export function mediaUsage(project, mediaId) {
  const res = [];
  for (const track of ['video', 'audio']) for (const clip of project.tracks[track]) if (clip.mediaId === mediaId) res.push({ track, clip });
  return res;
}

// --- generic clip ops ---

/** Shallow-merge patch into any clip by id (any track). Video clips are re-validated. */
export function updateClip(project, id, patch) {
  const found = findClip(project, id);
  if (!found) return project;
  const clips = project.tracks[found.track].slice();
  let next = { ...found.clip, ...patch };
  if (next.autoOut && ('in' in patch || 'out' in patch || 'speed' in patch)) next.autoOut = false; // user-defined range now
  if (found.track === 'video') next = sanitizeVideoClip(project, next);
  if (found.track === 'audio') next = sanitizeAudioClip(project, next);
  if (found.track === 'text') next = { ...next, start: Math.max(0, next.start), duration: Math.max(MIN_CLIP_DURATION, next.duration) };
  clips[found.index] = next;
  return withTrack(project, found.track, found.track === 'video' ? fixFirstTransition(clips) : clips);
}

/** Removes clips by id from any track. On the main track, later clips ripple left. */
export function removeClips(project, ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  return touch({
    ...project,
    tracks: {
      video: fixFirstTransition(project.tracks.video.filter((c) => !set.has(c.id))),
      audio: project.tracks.audio.filter((c) => !set.has(c.id)),
      text: project.tracks.text.filter((c) => !set.has(c.id)),
    },
  });
}

/** Duplicates clips (main-track copies are inserted right after their originals; others placed after themselves). */
export function duplicateClips(project, ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const newIds = [];
  const video = [];
  for (const c of project.tracks.video) {
    video.push(c);
    if (set.has(c.id)) {
      const copy = { ...c, id: uid('clp'), transition: null, filters: c.filters ? { ...c.filters } : null };
      newIds.push(copy.id);
      video.push(copy);
    }
  }
  const audio = [...project.tracks.audio];
  for (const c of project.tracks.audio) {
    if (!set.has(c.id)) continue;
    const copy = { ...c, id: uid('aud'), start: c.start + audioClipDuration(c) };
    newIds.push(copy.id);
    audio.push(copy);
  }
  const text = [...project.tracks.text];
  for (const c of project.tracks.text) {
    if (!set.has(c.id)) continue;
    const copy = { ...c, id: uid('txt'), start: c.start + c.duration, style: { ...c.style } };
    newIds.push(copy.id);
    text.push(copy);
  }
  return { project: touch({ ...project, tracks: { video, audio, text } }), ids: newIds };
}

// --- main (video) track ---

/** The first clip can't have an incoming transition. */
function fixFirstTransition(clips) {
  if (clips.length && clips[0].transition) {
    const copy = clips.slice();
    copy[0] = { ...copy[0], transition: null };
    return copy;
  }
  return clips;
}

export function sanitizeVideoClip(project, clip) {
  const max = mediaMaxTime(project, clip.mediaId);
  const speed = clamp(Number(clip.speed) || 1, MIN_SPEED, MAX_SPEED);
  let inP = clamp(Number(clip.in) || 0, 0, Number.isFinite(max) ? Math.max(0, max - MIN_CLIP_DURATION * speed) : Infinity);
  let outP = Number(clip.out);
  if (!Number.isFinite(outP)) outP = inP + DEFAULT_IMAGE_DURATION;
  outP = clamp(outP, inP + MIN_CLIP_DURATION * speed, max);
  if (outP - inP < MIN_CLIP_DURATION * speed) inP = Math.max(0, outP - MIN_CLIP_DURATION * speed);
  return {
    ...clip,
    in: inP,
    out: outP,
    speed,
    volume: clamp(Number(clip.volume ?? 1), 0, 2),
    fadeIn: clamp(Number(clip.fadeIn) || 0, 0, (outP - inP) / speed),
    fadeOut: clamp(Number(clip.fadeOut) || 0, 0, (outP - inP) / speed),
    transition: clip.transition && clip.transition.type !== 'cut' ? createTransition(clip.transition.type, clip.transition.duration) : null,
  };
}

/** Inserts main-track clips at index (default: end). */
export function insertVideoClips(project, clips, index = project.tracks.video.length) {
  const arr = project.tracks.video.slice();
  const at = clamp(index, 0, arr.length);
  arr.splice(at, 0, ...clips.map((c) => sanitizeVideoClip(project, c)));
  return withTrack(project, 'video', fixFirstTransition(arr));
}

/** Appends media items to the main track (videos and images only), optionally with a default transition. */
export function appendMediaToTimeline(project, mediaIds, { index, transition = null, ranges = {} } = {}) {
  const clips = [];
  for (const id of mediaIds) {
    const m = project.media[id];
    if (!m || m.kind === 'audio') continue;
    const r = ranges[id] || {};
    clips.push(createVideoClip(m, { in: r.in, out: r.out, transition: transition ? { ...transition } : null }));
  }
  return { project: insertVideoClips(project, clips, index ?? project.tracks.video.length), ids: clips.map((c) => c.id) };
}

/** Moves a main-track clip to a new index (index counted in the array after removal semantics: final position). */
export function moveVideoClip(project, id, toIndex) {
  const arr = project.tracks.video.slice();
  const from = arr.findIndex((c) => c.id === id);
  if (from < 0) return project;
  const [clip] = arr.splice(from, 1);
  const to = clamp(toIndex, 0, arr.length);
  arr.splice(to, 0, clip);
  return withTrack(project, 'video', fixFirstTransition(arr));
}

/**
 * Trims a main-track clip edge to a new source time.
 * edge 'in' moves the source in-point (the clip's left edge), 'out' the out-point.
 */
export function trimVideoClip(project, id, edge, sourceTime) {
  const found = findClip(project, id);
  if (!found || found.track !== 'video') return project;
  const patch = edge === 'in' ? { in: sourceTime } : { out: sourceTime };
  return updateClip(project, id, patch);
}

/** Splits the main-track clip under timeline time t. Returns {project, leftId, rightId} (ids null if no split). */
export function splitVideoAt(project, t, clipId = null) {
  const lay = layoutVideo(project.tracks.video);
  let item = null;
  if (clipId) item = lay.find((it) => it.clip.id === clipId) || null;
  if (!item) {
    const items = videoItemsAt(lay, t);
    item = items[items.length - 1] || null; // during a transition split the incoming clip
  }
  if (!item) return { project, leftId: null, rightId: null };
  const local = t - item.start;
  if (local < MIN_CLIP_DURATION - EPS || item.duration - local < MIN_CLIP_DURATION - EPS) return { project, leftId: null, rightId: null };
  const { clip } = item;
  const srcSplit = clip.in + local * (clip.speed || 1);
  const left = { ...clip, out: srcSplit, fadeOut: 0, autoOut: false };
  const right = { ...clip, id: uid('clp'), in: srcSplit, transition: null, fadeIn: 0, filters: clip.filters ? { ...clip.filters } : null, autoOut: false };
  if (clip.kenBurns) {
    // Keep the Ken Burns motion continuous across the cut.
    const k = local / item.duration;
    const mid = {
      x: clip.kenBurns.from.x + (clip.kenBurns.to.x - clip.kenBurns.from.x) * k,
      y: clip.kenBurns.from.y + (clip.kenBurns.to.y - clip.kenBurns.from.y) * k,
      zoom: clip.kenBurns.from.zoom + (clip.kenBurns.to.zoom - clip.kenBurns.from.zoom) * k,
    };
    left.kenBurns = { from: { ...clip.kenBurns.from }, to: mid };
    right.kenBurns = { from: { ...mid }, to: { ...clip.kenBurns.to } };
  }
  const arr = project.tracks.video.slice();
  arr.splice(item.index, 1, left, right);
  return { project: withTrack(project, 'video', arr), leftId: left.id, rightId: right.id };
}

export function setTransition(project, clipId, transition) {
  const found = findClip(project, clipId);
  if (!found || found.track !== 'video' || found.index === 0) return project;
  return updateClip(project, clipId, { transition: transition ? createTransition(transition.type, transition.duration) : null });
}

/** Applies one transition to every junction (null clears all). */
export function setAllTransitions(project, transition) {
  const arr = project.tracks.video.map((c, i) => (i === 0 ? { ...c, transition: null } : { ...c, transition: transition ? createTransition(transition.type, transition.duration) : null }));
  return withTrack(project, 'video', arr);
}

// --- audio track ---

export function sanitizeAudioClip(project, clip) {
  const max = mediaMaxTime(project, clip.mediaId);
  let inP = clamp(Number(clip.in) || 0, 0, Number.isFinite(max) ? Math.max(0, max - MIN_CLIP_DURATION) : Infinity);
  let outP = clamp(Number(clip.out) || inP + MIN_CLIP_DURATION, inP + MIN_CLIP_DURATION, max);
  return {
    ...clip,
    start: Math.max(0, Number(clip.start) || 0),
    in: inP,
    out: outP,
    volume: clamp(Number(clip.volume ?? 1), 0, 2),
    fadeIn: clamp(Number(clip.fadeIn) || 0, 0, outP - inP),
    fadeOut: clamp(Number(clip.fadeOut) || 0, 0, outP - inP),
    lane: Math.max(0, Math.floor(Number(clip.lane) || 0)),
  };
}

/** First lane where [start, end) doesn't overlap an existing clip. */
export function freeLane(clips, start, end, ignoreId = null) {
  for (let lane = 0; lane < 16; lane++) {
    const busy = clips.some((c) => c.id !== ignoreId && (c.lane || 0) === lane && start < c.start + (c.duration ?? audioClipDuration(c)) - EPS && end > c.start + EPS);
    if (!busy) return lane;
  }
  return 0;
}

export function addAudioClip(project, mediaId, opts = {}) {
  const m = project.media[mediaId];
  if (!m) return { project, id: null };
  const clip = createAudioClip(m, opts);
  if (opts.lane == null) clip.lane = freeLane(project.tracks.audio, clip.start, clip.start + audioClipDuration(clip));
  const safe = sanitizeAudioClip(project, clip);
  return { project: withTrack(project, 'audio', [...project.tracks.audio, safe]), id: safe.id };
}

export function moveAudioClip(project, id, start, lane) {
  const found = findClip(project, id);
  if (!found || found.track !== 'audio') return project;
  return updateClip(project, id, { start: Math.max(0, start), ...(lane != null ? { lane } : {}) });
}

/** Trim an audio clip edge given a new timeline time for that edge. */
export function trimAudioClip(project, id, edge, timelineTime) {
  const found = findClip(project, id);
  if (!found || found.track !== 'audio') return project;
  const c = found.clip;
  if (edge === 'in') {
    const delta = Math.max(0, timelineTime) - c.start; // >0 trims in, <0 extends left (never before 0:00, keeping sync)
    const newIn = clamp(c.in + delta, 0, c.out - MIN_CLIP_DURATION);
    const applied = newIn - c.in;
    return updateClip(project, id, { in: newIn, start: c.start + applied });
  }
  const newOut = c.in + (timelineTime - c.start);
  return updateClip(project, id, { out: newOut });
}

/** Splits an audio clip at timeline time t. */
export function splitAudioAt(project, id, t) {
  const found = findClip(project, id);
  if (!found || found.track !== 'audio') return { project, rightId: null };
  const c = found.clip;
  const local = t - c.start;
  if (local < MIN_CLIP_DURATION || audioClipDuration(c) - local < MIN_CLIP_DURATION) return { project, rightId: null };
  const left = { ...c, out: c.in + local, fadeOut: 0, autoOut: false };
  const right = { ...c, id: uid('aud'), start: t, in: c.in + local, fadeIn: 0, autoOut: false };
  const arr = project.tracks.audio.slice();
  arr.splice(found.index, 1, left, right);
  return { project: withTrack(project, 'audio', arr), rightId: right.id };
}

// --- text track ---

export function addTextClip(project, opts = {}) {
  const clip = createTextClip(opts);
  if (opts.lane == null) clip.lane = freeLane(project.tracks.text, clip.start, clip.start + clip.duration);
  return { project: withTrack(project, 'text', [...project.tracks.text, clip]), id: clip.id };
}

export function splitTextAt(project, id, t) {
  const found = findClip(project, id);
  if (!found || found.track !== 'text') return { project, rightId: null };
  const c = found.clip;
  const local = t - c.start;
  if (local < MIN_CLIP_DURATION || c.duration - local < MIN_CLIP_DURATION) return { project, rightId: null };
  const left = { ...c, duration: local };
  const right = { ...c, id: uid('txt'), start: t, duration: c.duration - local, style: { ...c.style } };
  const arr = project.tracks.text.slice();
  arr.splice(found.index, 1, left, right);
  return { project: withTrack(project, 'text', arr), rightId: right.id };
}

/** Splits whatever is under the playhead: the main-track clip plus any selected audio/text clips. */
export function splitAllAt(project, t, selectedIds = []) {
  let p = splitVideoAt(project, t).project;
  for (const id of selectedIds) {
    const f = findClip(p, id);
    if (!f) continue;
    if (f.track === 'audio') p = splitAudioAt(p, id, t).project;
    if (f.track === 'text') p = splitTextAt(p, id, t).project;
  }
  return p;
}

// --- markers ---

export function addMarker(project, time, label = '') {
  const m = { id: uid('mrk'), time: Math.max(0, time), label, color: '#ffd166' };
  return { project: touch({ ...project, markers: [...(project.markers || []), m].sort((a, b) => a.time - b.time) }), id: m.id };
}

export function removeMarker(project, id) {
  return touch({ ...project, markers: (project.markers || []).filter((m) => m.id !== id) });
}

// --- convenience ---

/** Trims every audio clip so nothing extends past the end of the main track; adds a short fade-out where cut. */
export function fitAudioToVideo(project, fade = 1) {
  const end = layoutVideo(project.tracks.video).reduce((m, it) => Math.max(m, it.end), 0);
  if (end <= 0) return project;
  const audio = project.tracks.audio
    .filter((c) => c.start < end - MIN_CLIP_DURATION)
    .map((c) => {
      const cEnd = c.start + audioClipDuration(c);
      if (cEnd <= end + EPS) return c;
      const newOut = c.in + (end - c.start);
      return { ...c, out: newOut, fadeOut: Math.min(fade, newOut - c.in) };
    });
  return withTrack(project, 'audio', audio);
}

/** Effective filters for a clip (defaults merged). */
export const clipFilters = (clip) => ({ ...FILTER_DEFAULTS, ...(clip.filters || {}) });

export function filtersAreNeutral(filters) {
  if (!filters) return true;
  return Object.keys(FILTER_DEFAULTS).every((k) => (filters[k] ?? FILTER_DEFAULTS[k]) === FILTER_DEFAULTS[k]);
}

// ---------------------------------------------------------------------------------------------------------
// Loading / migration
// ---------------------------------------------------------------------------------------------------------

/** Fills defaults and repairs a project loaded from storage or an imported JSON file. */
export function normalizeProject(raw) {
  const base = createProject(raw?.name || 'Untitled sequence');
  if (!raw || typeof raw !== 'object') return base;
  const p = {
    ...base,
    ...raw,
    id: raw.id || base.id,
    settings: { ...base.settings, ...(raw.settings || {}) },
    tracks: {
      video: Array.isArray(raw.tracks?.video) ? raw.tracks.video : [],
      audio: Array.isArray(raw.tracks?.audio) ? raw.tracks.audio : [],
      text: Array.isArray(raw.tracks?.text) ? raw.tracks.text : [],
    },
    media: {},
    markers: Array.isArray(raw.markers) ? raw.markers : [],
    shots: Array.isArray(raw.shots) ? raw.shots : [],
    bible: { ...base.bible, ...(raw.bible || {}) },
  };
  for (const [id, m] of Object.entries(raw.media || {})) {
    const item = { ...m, ...createMediaItem({ ...m, id }) }; // keep unknown (newer) fields
    // A load that was interrupted can't resume across sessions: mark for refetch.
    if (item.status === 'loading' || item.status === 'pending') item.status = item.sourceUrl ? 'pending' : 'error';
    p.media[id] = item;
  }
  const order = Array.isArray(raw.mediaOrder) ? raw.mediaOrder.filter((id) => p.media[id]) : [];
  for (const id of Object.keys(p.media)) if (!order.includes(id)) order.push(id);
  p.mediaOrder = order;
  const known = (c) => !!p.media[c.mediaId];
  p.tracks.video = fixFirstTransition(p.tracks.video.filter(known).map((c) => sanitizeVideoClip(p, { ...createVideoClip(p.media[c.mediaId]), ...c })));
  p.tracks.audio = p.tracks.audio.filter(known).map((c) => sanitizeAudioClip(p, { ...createAudioClip(p.media[c.mediaId]), ...c }));
  p.tracks.text = p.tracks.text.map((c) => ({ ...createTextClip(), ...c, style: { ...TEXT_STYLE_DEFAULTS, ...(c.style || {}) } }));
  p.schema = SCHEMA_VERSION;
  return dedupeMedia(p);
}

/** Summary used by the project picker. */
export function projectSummary(project) {
  const lay = layoutProject(project);
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
    duration: lay.duration,
    clipCount: project.tracks.video.length,
    mediaCount: project.mediaOrder.length,
    shotCount: project.shots?.length || 0,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Merging concurrent saves (several studio windows: embedded frames in different grok tabs, standalone tabs)
// ---------------------------------------------------------------------------------------------------------

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of arrays of {id} records. Additions and deletions from both sides are kept; when both sides
 * changed the same record, `mine` wins. Order: mine's order, with theirs' additions inserted at the front
 * (or at the end when `appendTheirs`).
 */
export function mergeById(base = [], mine = [], theirs = [], { appendTheirs = false } = {}) {
  const b = new Map(base.map((x) => [x.id, x]));
  const m = new Map(mine.map((x) => [x.id, x]));
  const t = new Map(theirs.map((x) => [x.id, x]));
  const out = [];
  for (const x of mine) {
    const tb = b.get(x.id);
    const tt = t.get(x.id);
    if (tb && !tt) {
      if (same(x, tb)) continue; // deleted by them, untouched by me
      out.push(x); // deleted by them but edited by me: keep mine
    } else if (tb && tt && same(x, tb)) out.push(tt); // only they changed it
    else out.push(x);
  }
  const added = theirs.filter((x) => !b.has(x.id) && !m.has(x.id));
  return appendTheirs ? [...out, ...added] : [...added, ...out];
}

/**
 * Three-way merge of project versions: `base` = what this window last loaded/saved, `mine` = its current state,
 * `theirs` = what another window saved meanwhile. Nothing either side added is lost; per field/record, a side's change
 * wins over an untouched value, and `mine` wins real conflicts. Tracks merge as whole arrays (timeline edits from two
 * windows at once are not interleaved), then drop clips whose media was deleted.
 */
export function mergeProjects(base, mine, theirs) {
  if (!base || !theirs) return mine;
  if (!mine) return theirs;
  const pick = (key) => (same(mine[key], base[key]) ? theirs[key] : mine[key]);
  // media: records keyed by id
  const asList = (p) => Object.entries(p.media || {}).map(([id, m]) => ({ ...m, id }));
  const mergedMedia = mergeById(asList(base), asList(mine), asList(theirs));
  const media = Object.fromEntries(mergedMedia.map((m) => [m.id, m]));
  // bin order: mine's order (minus deletions) with their new items first, in their order
  const theirNew = (theirs.mediaOrder || []).filter((id) => media[id] && !(base.mediaOrder || []).includes(id) && !(mine.mediaOrder || []).includes(id));
  const mediaOrder = [...theirNew, ...(mine.mediaOrder || []).filter((id) => media[id])];
  for (const id of Object.keys(media)) if (!mediaOrder.includes(id)) mediaOrder.push(id);
  const known = (c) => !!media[c.mediaId];
  const tracks = {};
  for (const track of ['video', 'audio', 'text']) {
    const chosen = same(mine.tracks?.[track], base.tracks?.[track]) ? theirs.tracks?.[track] || [] : mine.tracks?.[track] || [];
    tracks[track] = track === 'text' ? chosen : chosen.filter(known);
  }
  if (tracks.video.length && tracks.video[0].transition) tracks.video = [{ ...tracks.video[0], transition: null }, ...tracks.video.slice(1)];
  return dedupeMedia({
    ...mine,
    name: pick('name'),
    settings: pick('settings'),
    bible: pick('bible'),
    markers: pick('markers'),
    exportSettings: pick('exportSettings'),
    media,
    mediaOrder,
    tracks,
    shots: mergeById(base.shots || [], mine.shots || [], theirs.shots || [], { appendTheirs: true }),
    updatedAt: Math.max(mine.updatedAt || 0, theirs.updatedAt || 0),
  });
}

/** The grok.com generation a bin item was collected from (null for files, links, frames…). */
export function mediaIdentity(m) {
  if (!m || m.origin !== 'grok') return null;
  if (m.postId) return `${m.kind}:${m.postId}`;
  return m.pageKey ? `key:${m.pageKey}` : null;
}

/**
 * Collapses bin items collected from the same grok.com generation (two studio windows that both imported it).
 * The copy added first stays (earliest addedAt, then smallest id: every window picks the same one, whatever it
 * merged from where); clips, takes and chosen takes pointing at a dropped copy are moved to it, and its rating,
 * flag, tags, note and shot link absorb the dropped copy's. Returns the same object when nothing is duplicated.
 */
export function dedupeMedia(project) {
  const groups = new Map();
  for (const m of Object.values(project.media || {})) {
    const key = mediaIdentity(m);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const remap = new Map();
  const media = { ...project.media };
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let keep = list[0];
    for (const dup of list.slice(1)) {
      remap.set(dup.id, keep.id);
      keep = {
        ...keep,
        rating: Math.max(keep.rating || 0, dup.rating || 0),
        flag: keep.flag ?? dup.flag ?? null,
        tags: [...new Set([...(keep.tags || []), ...(dup.tags || [])])],
        note: keep.note || dup.note || '',
        prompt: keep.prompt ?? dup.prompt ?? null,
        shotId: keep.shotId ?? dup.shotId ?? null,
      };
      delete media[dup.id];
    }
    media[keep.id] = keep;
  }
  if (!remap.size) return project;
  const to = (id) => remap.get(id) || id;
  const moveClip = (c) => (remap.has(c.mediaId) ? { ...c, mediaId: to(c.mediaId) } : c);
  return {
    ...project,
    media,
    mediaOrder: [...new Set((project.mediaOrder || []).map(to))].filter((id) => media[id]),
    tracks: { ...project.tracks, video: project.tracks.video.map(moveClip), audio: project.tracks.audio.map(moveClip) },
    shots: (project.shots || []).map((sh) => {
      const moved = (Array.isArray(sh.takes) && sh.takes.some((id) => remap.has(id))) || remap.has(sh.chosenTake);
      if (!moved) return sh;
      return { ...sh, takes: Array.isArray(sh.takes) ? [...new Set(sh.takes.map(to))] : sh.takes, chosenTake: sh.chosenTake ? to(sh.chosenTake) : sh.chosenTake };
    }),
  };
}
