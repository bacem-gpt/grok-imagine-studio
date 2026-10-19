// Pure timeline geometry for the Edit tab (no DOM, no stores): zoom mapping, ruler ticks, lanes, snapping,
// reorder targets and edit points. Unit-tested in tests/unit/edit.test.mjs.

import { clamp } from '../../core/utils.js';
import { snapPoints, snapTime, insertionIndexAt, layoutProject } from '../../core/model.js';

export const MIN_ZOOM = 4; // px per second
export const MAX_ZOOM = 640;
export const DEFAULT_ZOOM = 80;
/** Snapping distance in screen pixels. */
export const SNAP_PX = 8;

/** Clamps a zoom value (pixels per second). */
export const clampZoom = (z) => clamp(Number.isFinite(Number(z)) && Number(z) > 0 ? Number(z) : DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM);

/** Zoom (px/s) -> slider position 0..1000 on a log scale. */
export const zoomToSlider = (z) => Math.round((Math.log(clampZoom(z) / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 1000);

/** Slider position 0..1000 -> zoom (px/s). */
export const sliderToZoom = (v) => clampZoom(MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, clamp(Number(v) || 0, 0, 1000) / 1000));

/** Zoom that fits `duration` seconds into `width` px, keeping `margin` px free on the right. */
export function fitZoom(duration, width, margin = 36) {
  if (!(duration > 0) || !(width > margin)) return DEFAULT_ZOOM;
  return clampZoom((width - margin) / duration);
}

/** One zoom step in or out (factor ~1.25), as used by the +/- shortcuts and toolbar buttons. */
export const stepZoom = (z, dir) => clampZoom(z * (dir > 0 ? 1.25 : 0.8));

// Timeline toolbar widths (px, measured with the studio's UI font): icon-only tools + zoom buttons + paddings, what
// each label adds to its button, the zoom slider (full / compact, with margins), and slack for wider system fonts.
const TOOLBAR_BASE_W = 333;
const TOOLBAR_LABEL_W = { text: 40, audio: 51, transitions: 86 };
const TOOLBAR_SLIDER_W = { full: 102, small: 62, none: 0 };
const TOOLBAR_SLACK = 20;
// Best first. As space runs out the zoom slider shrinks and goes before any label (zooming stays on the buttons,
// +/- and Ctrl+wheel); then the labels go, Text first and Audio (adding sound is a core task) last.
const TOOLBAR_STEPS = [
  { labels: ['text', 'audio', 'transitions'], slider: 'full' },
  { labels: ['text', 'audio', 'transitions'], slider: 'small' },
  { labels: ['text', 'audio', 'transitions'], slider: 'none' },
  { labels: ['audio', 'transitions'], slider: 'none' },
  { labels: ['audio'], slider: 'small' },
  { labels: ['audio'], slider: 'none' },
  { labels: [], slider: 'none' },
];

/**
 * What the timeline toolbar shows at `width` px (its own measured width, whatever the Edit layout):
 * {text, audio, transitions} label flags and slider 'full' | 'small' | 'none'.
 */
export function toolbarLayout(width) {
  const w = Number(width) || 0;
  const fits = (s) => TOOLBAR_BASE_W + s.labels.reduce((sum, k) => sum + TOOLBAR_LABEL_W[k], 0) + TOOLBAR_SLIDER_W[s.slider] + TOOLBAR_SLACK <= w;
  const step = TOOLBAR_STEPS.find(fits) || TOOLBAR_STEPS[TOOLBAR_STEPS.length - 1];
  return { text: step.labels.includes('text'), audio: step.labels.includes('audio'), transitions: step.labels.includes('transitions'), slider: step.slider };
}

// [major step seconds, minor subdivisions]
const TICK_STEPS = [
  [0.1, 2],
  [0.2, 4],
  [0.5, 5],
  [1, 4],
  [2, 4],
  [5, 5],
  [10, 5],
  [15, 3],
  [30, 6],
  [60, 4],
  [120, 4],
  [300, 5],
  [600, 5],
  [900, 3],
  [1800, 6],
  [3600, 4],
];

/** Ruler label for time t given the major step: "0:05", "1:30", "0:01.5", "1:02:00". */
export function rulerLabel(t, major) {
  const neg = t < 0;
  let s = Math.abs(t);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  let sec;
  if (major < 1) {
    const tenths = Math.round(s * 10) / 10;
    sec = tenths.toFixed(1).padStart(4, '0');
  } else {
    sec = String(Math.round(s)).padStart(2, '0');
  }
  const head = h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m);
  return `${neg ? '-' : ''}${head}:${sec}`;
}

/**
 * Adaptive ruler ticks for the visible time range [from, to] at `zoom` px/s.
 * Major ticks are at least `minLabelPx` apart and carry a label; minor ticks are only emitted when >= 6 px apart.
 * Returns {major, minor, ticks: [{t, major, label}]}.
 */
export function rulerTicks(zoom, from, to, { minLabelPx = 72 } = {}) {
  const z = Math.max(1e-6, zoom);
  const spec = TICK_STEPS.find(([s]) => s * z >= minLabelPx) || TICK_STEPS[TICK_STEPS.length - 1];
  const [major, div] = spec;
  const minor = major / div;
  const showMinor = minor * z >= 6;
  const ticks = [];
  const i0 = Math.max(0, Math.floor(Math.max(0, from) / minor));
  const i1 = Math.ceil(Math.max(0, to) / minor);
  for (let i = i0; i <= i1 && ticks.length < 5000; i++) {
    const isMajor = i % div === 0;
    if (!isMajor && !showMinor) continue;
    const t = Math.round(i * minor * 1e6) / 1e6;
    ticks.push({ t, major: isMajor, label: isMajor ? rulerLabel(t, major) : null });
  }
  return { major, minor, ticks };
}

/** Number of lanes to show for the text and audio tracks (at least one each). */
export function laneCounts(project) {
  const maxLane = (clips) => clips.reduce((m, c) => Math.max(m, Math.floor(c.lane || 0)), -1);
  return {
    text: Math.max(1, maxLane(project.tracks.text) + 1),
    audio: Math.max(1, maxLane(project.tracks.audio) + 1),
  };
}

/**
 * Vertical geometry of the track area: text lanes on top (highest lane first), the main video track, then audio
 * lanes A1..An. Returns {rows: [{kind, lane, top, height, label}], videoTop, height, laneTop(kind, lane)}.
 */
export function trackGeometry({ text, audio }, { textH = 30, videoH = 64, audioH = 44, extraAudio = 0 } = {}) {
  const rows = [];
  let y = 0;
  for (let lane = text - 1; lane >= 0; lane--) {
    rows.push({ kind: 'text', lane, top: y, height: textH, label: `T${lane + 1}` });
    y += textH;
  }
  const videoTop = y;
  rows.push({ kind: 'video', lane: 0, top: y, height: videoH, label: 'V1' });
  y += videoH;
  for (let lane = 0; lane < audio + extraAudio; lane++) {
    rows.push({ kind: 'audio', lane, top: y, height: audioH, label: `A${lane + 1}`, extra: lane >= audio });
    y += audioH;
  }
  const laneTop = (kind, lane = 0) => rows.find((r) => r.kind === kind && r.lane === lane)?.top ?? 0;
  return { rows, videoTop, height: y, laneTop };
}

/** Which row a y coordinate (relative to the track area top) falls in; clamps to the first/last row. */
export function rowAt(geometry, y) {
  const { rows } = geometry;
  if (!rows.length) return null;
  if (y < rows[0].top) return rows[0];
  for (const r of rows) if (y >= r.top && y < r.top + r.height) return r;
  return rows[rows.length - 1];
}

/**
 * Lane index for a dragged audio/text clip at y. Rows of another kind clamp to the nearest lane of `kind`;
 * below the last audio lane returns `count` (a new lane).
 */
export function laneAt(geometry, kind, y) {
  const lanes = geometry.rows.filter((r) => r.kind === kind);
  if (!lanes.length) return 0;
  if (kind === 'text') {
    // text lanes are drawn highest-first: the topmost row is the highest lane
    const top = lanes[0].top;
    const bottom = lanes[lanes.length - 1].top + lanes[lanes.length - 1].height;
    if (y < top) return lanes[0].lane + 1;
    if (y >= bottom) return 0;
    for (const r of lanes) if (y >= r.top && y < r.top + r.height) return r.lane;
    return 0;
  }
  const first = lanes[0];
  const last = lanes[lanes.length - 1];
  if (y < first.top) return 0;
  for (const r of lanes) if (y >= r.top && y < r.top + r.height) return r.lane;
  return last.lane + (y >= last.top + last.height ? 1 : 0);
}

/**
 * Snaps a block [start, start + duration) so that its start or its end lands on the nearest point within
 * `threshold` seconds. Returns {start, snapped, point}.
 */
export function snapMove(start, duration, points, threshold) {
  const a = snapTime(start, points, threshold);
  const b = snapTime(start + duration, points, threshold);
  const da = a.snapped ? Math.abs(a.time - start) : Infinity;
  const db = b.snapped ? Math.abs(b.time - (start + duration)) : Infinity;
  if (da === Infinity && db === Infinity) return { start, snapped: false, point: null };
  if (da <= db) return { start: a.time, snapped: true, point: a.time };
  return { start: b.time - duration, snapped: true, point: b.time };
}

/**
 * Snap candidates while dragging: every boundary/marker of the project except those belonging to `excludeIds`,
 * plus `extra` (e.g. the playhead).
 */
export function snapCandidates(project, excludeIds = [], extra = []) {
  const ex = new Set(excludeIds);
  if (!ex.size) return snapPoints(project, extra);
  const filtered = {
    ...project,
    tracks: {
      video: project.tracks.video,
      audio: project.tracks.audio.filter((c) => !ex.has(c.id)),
      text: project.tracks.text.filter((c) => !ex.has(c.id)),
    },
  };
  return snapPoints(filtered, extra);
}

/**
 * Drop target while dragging main-track clips (`movingIds`) with the pointer at time t, in the coordinates of the
 * current (unchanged) layout. Returns {slot, toIndex, time, noop}: slot = boundary index in the original track,
 * toIndex = final index among the remaining clips (for moveVideoClips), time = where to draw the indicator.
 */
export function reorderTarget(videoLayout, movingIds, t) {
  const moving = movingIds instanceof Set ? movingIds : new Set(movingIds);
  const slot = insertionIndexAt(videoLayout, t);
  let toIndex = 0;
  for (let i = 0; i < slot; i++) if (!moving.has(videoLayout[i].clip.id)) toIndex++;
  const n = videoLayout.length;
  const time = slot < n ? videoLayout[slot].start : n ? videoLayout[n - 1].end : 0;
  // A contiguous block dropped onto its own position is a no-op.
  const idx = videoLayout.map((it, i) => (moving.has(it.clip.id) ? i : -1)).filter((i) => i >= 0);
  const contiguous = idx.length > 0 && idx[idx.length - 1] - idx[0] === idx.length - 1;
  const noop = contiguous && slot >= idx[0] && slot <= idx[idx.length - 1] + 1;
  return { slot, toIndex, time, noop };
}

/** Sorted unique times the playhead can jump to (Up/Down): 0, every clip boundary, markers and the end. */
export function editPoints(project) {
  const lay = layoutProject(project);
  const pts = snapPoints(project, [lay.duration]);
  const out = [];
  for (const p of pts) if (!out.length || Math.abs(p - out[out.length - 1]) > 1e-4) out.push(Math.round(p * 1e6) / 1e6);
  return out;
}

/** Next (dir > 0) or previous (dir < 0) edit point strictly after/before t; null when there is none. */
export function nextEditPoint(points, t, dir, eps = 1e-3) {
  if (dir > 0) return points.find((p) => p > t + eps) ?? null;
  for (let i = points.length - 1; i >= 0; i--) if (points[i] < t - eps) return points[i];
  return null;
}

/** Filmstrip tiles for a main-track clip: [{x, index}] with strip frame indices sampled by timeline time. */
export function filmstripTiles({ widthPx, tileW, zoom, clipIn, speed = 1, mediaDuration, stripCount, max = 240 }) {
  if (!(widthPx > 0) || !(tileW > 0) || !(stripCount > 0)) return [];
  const n = Math.min(max, Math.ceil(widthPx / tileW));
  const step = n >= max ? widthPx / n : tileW;
  const tiles = [];
  for (let k = 0; k < n; k++) {
    const x = k * step;
    const local = (x + Math.min(tileW, widthPx - x) / 2) / zoom;
    const src = clipIn + local * (speed || 1);
    const frac = mediaDuration > 0 ? src / mediaDuration : 0;
    tiles.push({ x, index: clamp(Math.floor(frac * stripCount), 0, stripCount - 1) });
  }
  return tiles;
}

/** Scroll position that keeps time `t` under the same screen x after a zoom change. */
export function anchoredScroll(t, newZoom, screenX) {
  return Math.max(0, t * newZoom - screenX);
}
