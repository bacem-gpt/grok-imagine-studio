// Pure project operations used by the Edit tab on top of core/model.js (immutable; no DOM, no stores).
// Unit-tested in tests/unit/edit.test.mjs.

import * as M from '../../core/model.js';
import { clamp, uid } from '../../core/utils.js';

/** Replaces the whole main track (clips are re-validated; the first clip loses any incoming transition). */
export function setVideoTrack(project, clips) {
  const emptied = { ...project, tracks: { ...project.tracks, video: [] } };
  return M.insertVideoClips(emptied, clips, 0);
}

/** Moves several main-track clips (kept in their current order) so the block starts at `toIndex` among the rest. */
export function moveVideoClips(project, ids, toIndex) {
  const set = new Set(ids);
  const track = project.tracks.video;
  const moving = track.filter((c) => set.has(c.id));
  if (!moving.length) return project;
  if (moving.length === 1) return M.moveVideoClip(project, moving[0].id, toIndex);
  const rest = track.filter((c) => !set.has(c.id));
  const at = clamp(Math.round(toIndex), 0, rest.length);
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (next.every((c, i) => c === track[i])) return project;
  return setVideoTrack(project, next);
}

/** Selected clips as a clipboard payload {video: [clip], audio: [clip], text: [clip], overlay: [clip], base} (deep copies). */
export function copyClips(project, ids) {
  const set = new Set(ids);
  const lay = M.layoutProject(project);
  const video = lay.video.filter((it) => set.has(it.clip.id));
  const audio = project.tracks.audio.filter((c) => set.has(c.id));
  const text = project.tracks.text.filter((c) => set.has(c.id));
  const overlay = (project.tracks.overlay || []).filter((c) => set.has(c.id));
  const starts = [...video.map((it) => it.start), ...audio.map((c) => c.start), ...text.map((c) => c.start), ...overlay.map((c) => c.start)];
  if (!starts.length) return null;
  return {
    video: video.map((it) => structuredClone(it.clip)),
    audio: audio.map((c) => structuredClone(c)),
    text: text.map((c) => structuredClone(c)),
    overlay: overlay.map((c) => structuredClone(c)),
    base: Math.min(...starts),
  };
}

/**
 * Pastes a clipboard at timeline time t: main-track clips are inserted at the nearest boundary to t, audio/text
 * clips keep their offsets relative to the earliest copied clip (lanes: original if free, else the first free).
 * Clips whose media is no longer in the project are skipped. Returns {project, ids}.
 */
export function pasteClips(project, clipboard, t) {
  if (!clipboard) return { project, ids: [] };
  const ids = [];
  let p = project;
  const video = (clipboard.video || []).filter((c) => p.media[c.mediaId]).map((c, i) => ({ ...structuredClone(c), id: uid('clp'), transition: i === 0 ? null : c.transition }));
  if (video.length) {
    const index = M.insertionIndexAt(M.layoutVideo(p.tracks.video), t);
    p = M.insertVideoClips(p, video, index);
    ids.push(...video.map((c) => c.id));
  }
  const base = clipboard.base ?? t;
  const placeLane = (clips, c, start, end) => {
    const wanted = Math.max(0, Math.floor(c.lane || 0));
    const busy = clips.some((o) => (o.lane || 0) === wanted && start < o.start + (o.duration ?? M.audioClipDuration(o)) - 1e-6 && end > o.start + 1e-6);
    return busy ? M.freeLane(clips, start, end) : wanted;
  };
  for (const c of clipboard.audio || []) {
    if (!p.media[c.mediaId]) continue;
    const start = Math.max(0, t + (c.start - base));
    const lane = placeLane(p.tracks.audio, c, start, start + M.audioClipDuration(c));
    const r = M.addAudioClip(p, c.mediaId, { ...structuredClone(c), id: uid('aud'), start, lane });
    p = r.project;
    if (r.id) ids.push(r.id);
  }
  for (const c of clipboard.text || []) {
    const start = Math.max(0, t + (c.start - base));
    const lane = placeLane(p.tracks.text, c, start, start + c.duration);
    const r = M.addTextClip(p, { ...structuredClone(c), id: uid('txt'), start, lane });
    p = r.project;
    ids.push(r.id);
  }
  for (const c of clipboard.overlay || []) {
    if (!p.media[c.mediaId]) continue;
    const start = Math.max(0, t + (c.start - base));
    const spans = (p.tracks.overlay || []).map((o) => ({ ...o, duration: M.clipDuration(o) }));
    const lane = placeLane(spans, c, start, start + M.clipDuration(c));
    const r = M.addOverlayClip(p, c.mediaId, { ...structuredClone(c), id: uid('ovl'), start, lane });
    p = r.project;
    if (r.id) ids.push(r.id);
  }
  return { project: p, ids };
}

/** Whether a main-track clip's sound can be detached onto an audio lane (video with sound, 1x speed). */
export function canDetachAudio(project, clip) {
  const m = project.media[clip?.mediaId];
  return !!m && m.kind === 'video' && m.hasAudio !== false && Math.abs((clip.speed || 1) - 1) < 1e-6 && !clip.reverse && !clip.freeze;
}

/**
 * Moves a main-track clip's sound to an audio lane (same timing, volume and fades) and mutes the video clip.
 * Returns {project, id} (id null when not possible).
 */
export function detachAudio(project, clipId) {
  const found = M.findClip(project, clipId);
  if (!found || found.track !== 'video' || !canDetachAudio(project, found.clip)) return { project, id: null };
  const item = M.layoutVideo(project.tracks.video).find((it) => it.clip.id === clipId);
  const c = found.clip;
  const r = M.addAudioClip(project, c.mediaId, {
    start: item.start,
    in: c.in,
    out: c.out,
    volume: c.muted ? 0 : c.volume ?? 1,
    fadeIn: c.fadeIn || 0,
    fadeOut: c.fadeOut || 0,
    label: c.label || '',
  });
  if (!r.id) return { project, id: null };
  return { project: M.updateClip(r.project, clipId, { muted: true }), id: r.id };
}

/**
 * Trims one edge of any clip to timeline time t ("trim start/end to playhead").
 * Main track: the source in/out moves to the frame under t (the track ripples). Returns the new project.
 */
export function trimEdgeTo(project, clipId, edge, t) {
  const found = M.findClip(project, clipId);
  if (!found) return project;
  if (found.track === 'video') {
    const item = M.layoutVideo(project.tracks.video).find((it) => it.clip.id === clipId);
    if (!item || t <= item.start + M.MIN_CLIP_DURATION / 2 || t >= item.end - M.MIN_CLIP_DURATION / 2) return project;
    return M.updateClip(project, clipId, M.trimPatchAt(item, edge, t)); // (a reversed clip's left edge is its out-point)
  }
  if (found.track === 'audio') {
    const c = found.clip;
    if (t <= c.start || t >= c.start + M.audioClipDuration(c)) return project;
    return M.trimAudioClip(project, clipId, edge, t);
  }
  if (found.track === 'overlay') {
    const c = found.clip;
    if (t <= c.start || t >= c.start + M.clipDuration(c)) return project;
    return M.trimOverlayClip(project, clipId, edge, t);
  }
  const c = found.clip;
  if (t <= c.start || t >= c.start + c.duration) return project;
  return edge === 'in' ? M.updateClip(project, clipId, { start: t, duration: c.start + c.duration - t }) : M.updateClip(project, clipId, { duration: t - c.start });
}

/** Trims a text clip edge to timeline time t during a drag (keeps the opposite edge fixed). */
export function trimTextTo(project, clipId, edge, t, original) {
  const o = original || M.findClip(project, clipId)?.clip;
  if (!o) return project;
  const end = o.start + o.duration;
  if (edge === 'in') {
    const start = clamp(t, 0, end - M.MIN_CLIP_DURATION);
    return M.updateClip(project, clipId, { start, duration: end - start });
  }
  return M.updateClip(project, clipId, { duration: Math.max(M.MIN_CLIP_DURATION, t - o.start) });
}

/** Ken Burns presets for the inspector. */
export const KEN_BURNS_PRESETS = [
  { id: 'zoom-in', name: 'Zoom in', kb: { from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.5, y: 0.5, zoom: 1.25 } } },
  { id: 'zoom-out', name: 'Zoom out', kb: { from: { x: 0.5, y: 0.5, zoom: 1.25 }, to: { x: 0.5, y: 0.5, zoom: 1 } } },
  { id: 'pan-left', name: 'Pan left', kb: { from: { x: 0.62, y: 0.5, zoom: 1.2 }, to: { x: 0.38, y: 0.5, zoom: 1.2 } } },
  { id: 'pan-right', name: 'Pan right', kb: { from: { x: 0.38, y: 0.5, zoom: 1.2 }, to: { x: 0.62, y: 0.5, zoom: 1.2 } } },
  { id: 'pan-up', name: 'Pan up', kb: { from: { x: 0.5, y: 0.62, zoom: 1.2 }, to: { x: 0.5, y: 0.38, zoom: 1.2 } } },
  { id: 'pan-down', name: 'Pan down', kb: { from: { x: 0.5, y: 0.38, zoom: 1.2 }, to: { x: 0.5, y: 0.62, zoom: 1.2 } } },
];

/** Deep copy of a preset's Ken Burns motion (null for unknown ids). */
export function kenBurnsPreset(id) {
  const p = KEN_BURNS_PRESETS.find((x) => x.id === id);
  return p ? structuredClone(p.kb) : null;
}

/** Id of the preset matching a Ken Burns motion, or null. */
export function matchKenBurnsPreset(kb) {
  if (!kb) return null;
  const eq = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-3;
  const same = (a, b) => eq(a.x, b.x) && eq(a.y, b.y) && eq(a.zoom, b.zoom);
  return KEN_BURNS_PRESETS.find((p) => same(p.kb.from, kb.from) && same(p.kb.to, kb.to))?.id || null;
}

/** Filters object for a FILTER_PRESETS id (null = neutral). */
export function filterPresetValues(id) {
  const preset = M.FILTER_PRESETS.find((p) => p.id === id);
  if (!preset || !Object.keys(preset.filters).length) return null;
  return { ...M.FILTER_DEFAULTS, ...preset.filters };
}

/** Id of the FILTER_PRESETS entry equal to the clip's filters ('none' when neutral, null when custom). */
export function matchFilterPreset(filters) {
  if (M.filtersAreNeutral(filters)) return 'none';
  const f = M.clipFilters({ filters });
  for (const p of M.FILTER_PRESETS) {
    const v = { ...M.FILTER_DEFAULTS, ...p.filters };
    if (Object.keys(M.FILTER_DEFAULTS).every((k) => Math.abs(v[k] - f[k]) < 1e-6)) return p.id;
  }
  return null;
}

/** RESOLUTION_PRESETS id matching the settings, or 'custom'. */
export function resolutionPresetId(settings) {
  return M.RESOLUTION_PRESETS.find((r) => r.width === settings.width && r.height === settings.height)?.id || 'custom';
}

/** Output size matching a media item's aspect ratio (even numbers, long side capped at `maxSide`). */
export function sizeForMedia(media, maxSide = 1920) {
  if (!media?.width || !media?.height) return null;
  const s = Math.min(1, maxSide / Math.max(media.width, media.height));
  const even = (v) => Math.max(16, Math.round((v * s) / 2) * 2);
  return { width: even(media.width), height: even(media.height) };
}

/** Clips (any track) under timeline time t: [{track, clip}]. */
export function clipsAt(project, t) {
  const lay = M.layoutProject(project);
  const res = [];
  for (const it of M.videoItemsAt(lay.video, t)) res.push({ track: 'video', clip: it.clip });
  for (const it of lay.audio) if (t >= it.start && t < it.end) res.push({ track: 'audio', clip: it.clip });
  for (const it of lay.text) if (t >= it.start && t < it.end) res.push({ track: 'text', clip: it.clip });
  for (const it of lay.overlay) if (t >= it.start && t < it.end) res.push({ track: 'overlay', clip: it.clip });
  return res;
}

/** Timeline [start, end] covered by the given clip ids (null when none). */
export function selectionRange(project, ids) {
  const set = new Set(ids);
  const lay = M.layoutProject(project);
  const spans = [...lay.video, ...lay.audio, ...lay.text, ...lay.overlay].filter((it) => set.has(it.clip.id));
  if (!spans.length) return null;
  return { start: Math.min(...spans.map((s) => s.start)), end: Math.max(...spans.map((s) => s.end)) };
}

/**
 * updateClip, but returns the same project when the patch changes nothing once validated (e.g. clicking the active
 * option again, or dragging a slider past its limit), so no empty undo step is recorded.
 */
export function updateClipIfChanged(project, clipId, patch) {
  const before = M.findClip(project, clipId)?.clip;
  if (!before) return project;
  const next = M.updateClip(project, clipId, patch);
  const after = M.findClip(next, clipId)?.clip;
  return JSON.stringify(before) === JSON.stringify(after) ? project : next;
}

/** True when both projects have the same incoming transition (type and duration) on every main-track clip. */
export function sameTransitions(a, b) {
  const va = a.tracks.video;
  const vb = b.tracks.video;
  if (va.length !== vb.length) return false;
  return va.every((c, i) => {
    const x = c.transition;
    const y = vb[i].transition;
    if (!x || !y) return !x && !y;
    return x.type === y.type && Math.abs((x.duration || 0) - (y.duration || 0)) < 1e-9;
  });
}

/**
 * The transitions on the main track's cuts: {cuts, withTransition, kind, type, duration, types}. kind 'none' = hard
 * cuts only; 'same' = every cut has a transition of one type (type / duration: the first cut's); 'mixed' = they
 * differ (several types, or only some cuts have one). `types` = the distinct types in timeline order.
 */
export function cutTransitions(project) {
  const cuts = project.tracks.video.slice(1).map((c) => (c.transition?.type && c.transition.type !== 'cut' ? c.transition : null));
  const used = cuts.filter(Boolean);
  const types = [...new Set(used.map((t) => t.type))];
  const same = used.length > 0 && used.length === cuts.length && types.length === 1;
  return {
    cuts: cuts.length,
    withTransition: used.length,
    kind: !used.length ? 'none' : same ? 'same' : 'mixed',
    type: same ? types[0] : null,
    duration: same ? used[0].duration : null,
    types,
  };
}

/** The main-track transitions by clip id, to count (replacedTransitions) or put back (restoreTransitions) later. */
export const transitionSnapshot = (project) => Object.fromEntries(project.tracks.video.map((c) => [c.id, c.transition ? { ...c.transition } : null]));

/** How many transitions of a snapshot are now removed or of another type (clips deleted since are not counted). */
export function replacedTransitions(snapshot, project) {
  const now = new Map(project.tracks.video.map((c) => [c.id, c.transition || null]));
  return Object.entries(snapshot).filter(([id, tr]) => tr && now.has(id) && now.get(id)?.type !== tr.type).length;
}

/** Puts a snapshot's transitions back on the clips that still exist (the same project when that changes nothing). */
export function restoreTransitions(project, snapshot) {
  let p = project;
  for (const c of project.tracks.video) if (Object.prototype.hasOwnProperty.call(snapshot, c.id)) p = M.setTransition(p, c.id, snapshot[c.id]);
  return sameTransitions(project, p) ? project : p;
}

/** Moves a marker to time t (clamped at 0), keeping the markers sorted. Same project when nothing moves. */
export function moveMarker(project, markerId, t) {
  const markers = project.markers || [];
  const cur = markers.find((m) => m.id === markerId);
  const time = Math.max(0, Number(t) || 0);
  if (!cur || Math.abs(cur.time - time) < 1e-9) return project;
  return {
    ...project,
    updatedAt: Date.now(),
    markers: markers.map((m) => (m.id === markerId ? { ...m, time } : m)).sort((a, b) => a.time - b.time),
  };
}

/**
 * Lowest timeline time an audio clip's left edge can be trimmed to: extending left stops where the source in-point
 * reaches 0 and at timeline 0 (beyond that core's trimAudioClip would clamp the start but not the in-point, which
 * would shift the clip's sound against the picture).
 */
export const audioTrimFloor = (clip) => Math.max(0, clip.start - clip.in);

/** All clip ids in the project, main track first. */
export const allClipIds = (project) => [...project.tracks.video, ...project.tracks.audio, ...project.tracks.text, ...(project.tracks.overlay || [])].map((c) => c.id);

/** Short summary numbers for the inspector's sequence panel. */
export function sequenceStats(project) {
  const lay = M.layoutProject(project);
  return {
    duration: lay.duration,
    videoEnd: lay.videoEnd,
    clips: project.tracks.video.length,
    transitions: lay.video.filter((it) => it.transIn).length,
    audio: project.tracks.audio.length,
    text: project.tracks.text.length,
    overlay: (project.tracks.overlay || []).length,
    markers: (project.markers || []).length,
    media: project.mediaOrder.length,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Clip tools: crop presets, title styles, backgrounds (pure data / helpers; UI in inspector-tools.js)
// ---------------------------------------------------------------------------------------------------------

/** Crop aspect presets (output aspect width / height; null = free). 'frame' = the sequence's own aspect. */
export const CROP_ASPECTS = [
  { id: 'free', label: 'Free', aspect: null },
  { id: 'frame', label: 'Frame', aspect: 'frame' },
  { id: '16:9', label: '16:9', aspect: 16 / 9 },
  { id: '9:16', label: '9:16', aspect: 9 / 16 },
  { id: '1:1', label: '1:1', aspect: 1 },
  { id: '4:5', label: '4:5', aspect: 4 / 5 },
];

/**
 * Largest centred crop of a (w x h) source whose picture — after the clip's rotation — has the given aspect
 * (width / height). Returns a normalized crop (null when that is the whole picture).
 */
export function cropForAspect(aspect, w, h, rotate = 0) {
  if (!(aspect > 0) || !(w > 0) || !(h > 0)) return null;
  const quarter = (rotate || 0) % 180 !== 0;
  const want = quarter ? 1 / aspect : aspect; // in the unrotated source
  const src = w / h;
  let cw = 1;
  let ch = 1;
  if (src > want) cw = want / src;
  else ch = src / want;
  return M.normalizeCrop({ x: (1 - cw) / 2, y: (1 - ch) / 2, w: cw, h: ch });
}

/**
 * Resizes / moves a normalized crop rectangle during a drag. `handle`: 'move' or a corner ('nw', 'ne', 'sw', 'se');
 * dx / dy: pointer movement as fractions of the source picture; `ratio`: locked aspect in normalized units (crop w / h)
 * or null. The opposite corner stays put when resizing. Returns a crop clamped inside the picture.
 */
export function dragCrop(start, handle, dx, dy, ratio = null) {
  const c = start || { x: 0, y: 0, w: 1, h: 1 };
  const min = M.MIN_CROP;
  if (handle === 'move') {
    return { x: clamp(c.x + dx, 0, 1 - c.w), y: clamp(c.y + dy, 0, 1 - c.h), w: c.w, h: c.h };
  }
  const west = handle.includes('w');
  const north = handle.includes('n');
  const ax = west ? c.x + c.w : c.x; // anchor (fixed corner)
  const ay = north ? c.y + c.h : c.y;
  let w = clamp(c.w + (west ? -dx : dx), min, west ? ax : 1 - ax);
  let h = clamp(c.h + (north ? -dy : dy), min, north ? ay : 1 - ay);
  if (ratio > 0) {
    const maxW = west ? ax : 1 - ax;
    const maxH = north ? ay : 1 - ay;
    // Follow the larger relative change, then fit both inside the picture.
    if (w / c.w >= h / c.h) h = w / ratio;
    else w = h * ratio;
    const s = Math.min(1, maxW / w, maxH / h);
    w = Math.max(min, w * s);
    h = Math.max(min, h * s);
  }
  return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
}

const FONT = {
  sans: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  condensed: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif',
  impact: 'Impact, Haettenschweiler, "Arial Black", sans-serif',
  serif: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
};

/**
 * One-click title styles (iMovie's Titles browser), built on TextClip fields: {id, name, text, duration, animation,
 * style} — style is merged over TEXT_STYLE_DEFAULTS.
 */
export const TITLE_PRESETS = [
  { id: 'standard', name: 'Standard', text: 'Your title', duration: 3, animation: 'fade', style: {} },
  {
    id: 'lower-third',
    name: 'Lower third',
    text: 'Name Surname\nTitle or place',
    duration: 4,
    animation: 'slide-up',
    style: { align: 'left', x: 0.06, y: 0.8, size: 0.05, weight: 600, background: 'rgba(0,0,0,0.55)', shadow: false, maxWidth: 0.6 },
  },
  { id: 'centered-bold', name: 'Centered bold', text: 'YOUR TITLE', duration: 3, animation: 'fade', style: { y: 0.5, size: 0.12, weight: 900 } },
  {
    id: 'cinematic',
    name: 'Cinematic',
    text: 'A FILM BY YOU',
    duration: 4,
    animation: 'fade',
    style: { font: FONT.serif, y: 0.5, size: 0.06, weight: 400, shadow: false, letterbox: true },
  },
  {
    id: 'subtitle',
    name: 'Subtitle',
    text: 'Subtitle text',
    duration: 3,
    animation: 'none',
    style: { y: 0.9, size: 0.045, weight: 600, background: 'rgba(0,0,0,0.6)', shadow: false, maxWidth: 0.8 },
  },
  { id: 'typewriter', name: 'Typewriter', text: 'Once upon a time…', duration: 4, animation: 'typewriter', style: { font: FONT.mono, y: 0.5, size: 0.06, weight: 600 } },
  { id: 'pop', name: 'Pop', text: 'WOW!', duration: 2, animation: 'pop', style: { font: FONT.impact, y: 0.5, size: 0.15, color: '#ffd166', outline: true } },
  { id: 'boxed', name: 'Boxed', text: 'Chapter one', duration: 3, animation: 'fade', style: { y: 0.5, size: 0.065, color: '#111111', background: '#ffffff', shadow: false } },
  { id: 'headline', name: 'Big headline', text: 'BREAKING', duration: 3, animation: 'slide-up', style: { font: FONT.condensed, y: 0.5, size: 0.17, weight: 900, outline: true } },
  { id: 'end', name: 'The End', text: 'The End', duration: 3, animation: 'fade', style: { font: FONT.serif, y: 0.5, size: 0.1, weight: 400, italic: true } },
  {
    id: 'credits',
    name: 'End credits',
    text: 'Directed by\nYOUR NAME\n\nStarring\nTHE CAST\n\nMade with Grok Imagine',
    duration: 8,
    animation: 'scroll-up',
    style: { y: 0.5, size: 0.05, weight: 600, maxWidth: 0.8 },
  },
];

/** TextClip options (text, duration, animation, full style) for a title preset (null for unknown ids). */
export function titlePresetClip(id) {
  const p = TITLE_PRESETS.find((x) => x.id === id);
  if (!p) return null;
  return { text: p.text, duration: p.duration, animation: p.animation, style: { ...M.TEXT_STYLE_DEFAULTS, ...p.style } };
}

/**
 * Applies a title preset's look (style + animation) to an existing title. Its text is kept unless it is still a
 * preset's placeholder text; the duration is kept unless the preset needs a longer one (credits).
 */
export function applyTitlePreset(project, clipId, id) {
  const found = M.findClip(project, clipId);
  const preset = TITLE_PRESETS.find((x) => x.id === id);
  if (!found || found.track !== 'text' || !preset) return project;
  const c = found.clip;
  const placeholder = !c.text || c.text === 'Your title' || c.text === 'Title' || TITLE_PRESETS.some((x) => x.text === c.text);
  return updateClipIfChanged(project, clipId, {
    style: { ...M.TEXT_STYLE_DEFAULTS, ...preset.style },
    animation: preset.animation,
    ...(placeholder ? { text: preset.text } : {}),
    ...(preset.duration > c.duration ? { duration: preset.duration } : {}),
  });
}

/** Id of the title preset whose look (style + animation) a text clip has, or null. */
export function matchTitlePreset(clip) {
  if (!clip) return null;
  const style = { ...M.TEXT_STYLE_DEFAULTS, ...(clip.style || {}) };
  for (const p of TITLE_PRESETS) {
    const want = { ...M.TEXT_STYLE_DEFAULTS, ...p.style };
    if (p.animation === (clip.animation || 'none') && Object.keys(want).every((k) => want[k] === style[k])) return p.id;
  }
  return null;
}

/** Solid colour / gradient backgrounds (iMovie's Backgrounds) for titles: {id, name, kind, colors}. */
export const BACKGROUND_PRESETS = [
  { id: 'black', name: 'Black', kind: 'solid', colors: ['#000000'] },
  { id: 'white', name: 'White', kind: 'solid', colors: ['#ffffff'] },
  { id: 'charcoal', name: 'Charcoal', kind: 'solid', colors: ['#22252e'] },
  { id: 'blue', name: 'Blue gradient', kind: 'linear', colors: ['#1e3c72', '#2a5298'] },
  { id: 'sunset', name: 'Sunset', kind: 'linear', colors: ['#ff7e5f', '#feb47b'] },
  { id: 'ocean', name: 'Ocean', kind: 'linear', colors: ['#2193b0', '#6dd5ed'] },
  { id: 'purple', name: 'Purple haze', kind: 'linear', colors: ['#41295a', '#2f0743'] },
  { id: 'forest', name: 'Forest', kind: 'linear', colors: ['#134e5e', '#71b280'] },
  { id: 'spotlight', name: 'Spotlight', kind: 'radial', colors: ['#4a4a58', '#0b0b10'] },
  { id: 'paper', name: 'Warm paper', kind: 'radial', colors: ['#fbf1dc', '#e3cfa6'] },
];

/** CSS background of a background preset (swatches). */
export function backgroundCss(preset) {
  const [a, b = a] = preset.colors;
  if (preset.kind === 'linear') return `linear-gradient(135deg, ${a}, ${b})`;
  if (preset.kind === 'radial') return `radial-gradient(circle at 50% 45%, ${a}, ${b})`;
  return a;
}

/** Paints a background preset into a (W x H) 2D context (canvas or OffscreenCanvas). */
export function paintBackground(ctx, preset, W, H) {
  const [a, b = a] = preset.colors;
  let fill = a;
  if (preset.kind === 'linear') {
    fill = ctx.createLinearGradient(0, 0, W, H);
    fill.addColorStop(0, a);
    fill.addColorStop(1, b);
  } else if (preset.kind === 'radial') {
    fill = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.hypot(W, H) / 1.6);
    fill.addColorStop(0, a);
    fill.addColorStop(1, b);
  }
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, W, H);
}
