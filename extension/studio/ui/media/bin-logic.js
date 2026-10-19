// Pure logic behind the Clips tab: bin filtering / sorting / search, multi-selection, neighbour lookup, source
// monitor marks, J/K/L shuttle and frame-step maths, page-item views and small project ops for flags & ratings.
// No DOM, no Preact, no chrome.* — importable from Node unit tests (tests/unit/clips.test.mjs).
import { clamp, formatTime } from '../../core/utils.js';
import { updateMedia, MIN_CLIP_DURATION } from '../../core/model.js';

/** dataTransfer type carrying a JSON array of media ids (bin -> timeline drops). */
import { MEDIA_DRAG_TYPE } from '../kit.js';
export { MEDIA_DRAG_TYPE };

export const KIND_OPTIONS = [
  { value: 'all', label: 'All kinds' },
  { value: 'video', label: 'Videos' },
  { value: 'image', label: 'Images' },
  { value: 'audio', label: 'Audio' },
];

export const FLAG_OPTIONS = [
  { value: 'all', label: 'All flags' },
  { value: 'pick', label: 'Picked' },
  { value: 'unflagged', label: 'Unflagged' },
  { value: 'reject', label: 'Rejected' },
  { value: 'hide-rejected', label: 'Hide rejected' },
];

export const RATING_OPTIONS = [
  { value: '0', label: 'Any rating' },
  { value: '1', label: '★ and up' },
  { value: '2', label: '★★ and up' },
  { value: '3', label: '★★★ and up' },
  { value: '4', label: '★★★★ and up' },
  { value: '5', label: '★★★★★ only' },
];

export const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'rating', label: 'Top rated' },
  { value: 'duration', label: 'Longest first' },
  { value: 'name', label: 'Name A–Z' },
];

export const DEFAULT_FILTER = Object.freeze({ kind: 'all', flag: 'all', minRating: 0, search: '', sort: 'newest' });

const KINDS = new Set(KIND_OPTIONS.map((o) => o.value));
const FLAGS = new Set(FLAG_OPTIONS.map((o) => o.value));
const SORTS = new Set(SORT_OPTIONS.map((o) => o.value));

/** Fills defaults and repairs unknown values (the filter is persisted, so it may come from an older version). */
export function normalizeFilter(filter) {
  const f = { ...DEFAULT_FILTER, ...(filter || {}) };
  return {
    kind: KINDS.has(f.kind) ? f.kind : 'all',
    flag: FLAGS.has(f.flag) ? f.flag : 'all',
    minRating: clamp(Math.round(Number(f.minRating) || 0), 0, 5),
    search: typeof f.search === 'string' ? f.search : '',
    sort: SORTS.has(f.sort) ? f.sort : 'newest',
  };
}

/** True when the filter hides anything (sort order doesn't count). */
export function isFilterActive(filter) {
  const f = normalizeFilter(filter);
  return f.kind !== 'all' || f.flag !== 'all' || f.minRating > 0 || f.search.trim() !== '';
}

/** Lower-cased search terms; every term must match (AND). */
export function searchTerms(text) {
  return String(text || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Text a media item is searchable by: name, prompt, tags and note. */
export function mediaSearchText(m) {
  return [m.name, m.prompt, ...(Array.isArray(m.tags) ? m.tags : []), m.note].filter(Boolean).join('\n').toLowerCase();
}

/** Whether a media item passes the filter (kind, flag, minimum rating, search terms). */
export function matchesFilter(m, filter, terms = searchTerms(filter?.search)) {
  if (!m) return false;
  const f = filter || DEFAULT_FILTER;
  if (f.kind && f.kind !== 'all' && m.kind !== f.kind) return false;
  if (f.flag === 'pick' && m.flag !== 'pick') return false;
  if (f.flag === 'reject' && m.flag !== 'reject') return false;
  if (f.flag === 'unflagged' && m.flag) return false;
  if (f.flag === 'hide-rejected' && m.flag === 'reject') return false;
  if ((m.rating || 0) < (Number(f.minRating) || 0)) return false;
  if (terms.length) {
    const hay = mediaSearchText(m);
    for (const t of terms) if (!hay.includes(t)) return false;
  }
  return true;
}

const flagRank = (m) => (m.flag === 'pick' ? 0 : m.flag === 'reject' ? 2 : 1);

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * True when an item's name is just its prompt, possibly truncated with '…' (the name Grok imports get), rather than
 * a name the user gave it. An empty name counts as "not chosen".
 */
export function isPromptName(m) {
  const name = oneLine(m?.name);
  const prompt = oneLine(m?.prompt);
  if (!name) return true;
  if (!prompt) return false;
  if (name === prompt) return true;
  return name.length > 1 && name.endsWith('…') && prompt.startsWith(name.slice(0, -1).trimEnd());
}

/** Title shown for a bin item: the name the user gave it, else its prompt (Grok clips), else its file name. */
export function displayTitle(m) {
  const prompt = oneLine(m?.prompt);
  if (prompt && isPromptName(m)) return prompt;
  return oneLine(m?.name) || prompt || 'Untitled';
}

/** Second line under a user-given title: the prompt. null when the title already is the prompt (or there is none). */
export function displaySubtitle(m) {
  const prompt = oneLine(m?.prompt);
  return prompt && !isPromptName(m) ? prompt : null;
}

/**
 * Bin ids that pass the filter, in the filter's sort order.
 * "Newest" is the bin order itself (project.mediaOrder: new items go to the front, and one import keeps the order of
 * its items, e.g. the feed's). addedAt is not used: the items of one import get their own Date.now() each, so a batch
 * that spans a millisecond tick would put its end first. Other sorts fall back to "newest" on ties. "Name" sorts by
 * the title the card shows (displayTitle), so the order matches what's on screen.
 */
export function filterAndSort(project, filter) {
  const f = normalizeFilter(filter);
  const terms = searchTerms(f.search);
  const order = project?.mediaOrder || [];
  const pos = new Map(order.map((id, i) => [id, i]));
  const list = [];
  for (const id of order) {
    const m = project.media[id];
    if (matchesFilter(m, f, terms)) list.push(m);
  }
  const newest = (a, b) => pos.get(a.id) - pos.get(b.id);
  let cmp = newest;
  if (f.sort === 'oldest') cmp = (a, b) => newest(b, a);
  else if (f.sort === 'rating') cmp = (a, b) => (b.rating || 0) - (a.rating || 0) || flagRank(a) - flagRank(b) || newest(a, b);
  else if (f.sort === 'duration') cmp = (a, b) => (b.duration || 0) - (a.duration || 0) || newest(a, b);
  else if (f.sort === 'name') {
    const titles = new Map(list.map((m) => [m.id, displayTitle(m)]));
    cmp = (a, b) => titles.get(a.id).localeCompare(titles.get(b.id), undefined, { numeric: true, sensitivity: 'base' }) || newest(a, b);
  }
  return list.sort(cmp).map((m) => m.id);
}

/**
 * The filter with only the criteria that hide `m` reset (the sort and every criterion it passes are kept): what a
 * bin shows to reveal one item. Returns the normalized filter unchanged when `m` already passes.
 */
export function filterShowing(filter, m) {
  const f = normalizeFilter(filter);
  if (!m) return f;
  const out = { ...f };
  if (f.kind !== 'all' && m.kind !== f.kind) out.kind = 'all';
  if (f.flag !== 'all' && !matchesFilter(m, { flag: f.flag })) out.flag = 'all';
  if ((m.rating || 0) < f.minRating) out.minRating = 0;
  if (searchTerms(f.search).length && !matchesFilter(m, { search: f.search })) out.search = '';
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------------------

/**
 * Click-selection semantics shared by the bin grid, the page strip and BinCompact.
 * plain click: only this item · mod (Ctrl/Cmd): toggle this item · shift: range from the anchor (mod+shift: add range).
 * Returns {selection, anchor}.
 */
export function nextSelection({ selection = [], anchor = null, orderedIds = [], id, shift = false, mod = false }) {
  if (shift && anchor != null && anchor !== id) {
    const a = orderedIds.indexOf(anchor);
    const b = orderedIds.indexOf(id);
    if (a >= 0 && b >= 0) {
      const range = orderedIds.slice(Math.min(a, b), Math.max(a, b) + 1);
      return { selection: mod ? [...new Set([...selection, ...range])] : range, anchor };
    }
  }
  if (mod) {
    return { selection: selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id], anchor: id };
  }
  return { selection: [id], anchor: id };
}

/** Selected ids in display order (ids not currently displayed keep their selection order, at the end). */
export function orderedSelection(selection, orderedIds) {
  const set = new Set(selection);
  const res = orderedIds.filter((id) => set.has(id));
  const seen = new Set(res);
  for (const id of selection) if (!seen.has(id)) res.push(id);
  return res;
}

/** The ids a card-level action applies to: the whole selection when the card is part of it, else just the card. */
export const actionTargets = (id, selection) => (selection.includes(id) && selection.length > 1 ? selection : [id]);

/**
 * Neighbour of currentId in orderedIds (delta -1 / +1), or null at either end.
 * When the current item is no longer listed (flagged out by the filter, removed), lastIndex — where it was —
 * keeps prev/next walking from the same place.
 */
export function neighborId(orderedIds, currentId, delta, lastIndex = -1) {
  if (!orderedIds.length) return null;
  let i = orderedIds.indexOf(currentId);
  if (i < 0) {
    const base = clamp(lastIndex < 0 ? 0 : lastIndex, 0, orderedIds.length);
    i = delta > 0 ? base - 1 : base;
  }
  const j = i + delta;
  return j >= 0 && j < orderedIds.length ? orderedIds[j] : null;
}

/** Keyboard navigation in a grid with `columns` columns. Returns the id to move to (or currentId). */
export function gridMove(orderedIds, currentId, key, columns = 1) {
  if (!orderedIds.length) return null;
  const i = orderedIds.indexOf(currentId);
  if (i < 0) return key === 'end' ? orderedIds[orderedIds.length - 1] : orderedIds[0];
  const cols = Math.max(1, columns | 0);
  let j = i;
  if (key === 'arrowleft') j = i - 1;
  else if (key === 'arrowright') j = i + 1;
  else if (key === 'arrowup') j = i - cols;
  else if (key === 'arrowdown') j = i + cols;
  else if (key === 'home') j = 0;
  else if (key === 'end') j = orderedIds.length - 1;
  if (j < 0 || j >= orderedIds.length) {
    // Down from the last (partial) row: land on the final item instead of doing nothing.
    if (key === 'arrowdown' && Math.floor(i / cols) < Math.floor((orderedIds.length - 1) / cols)) return orderedIds[orderedIds.length - 1];
    return currentId;
  }
  return orderedIds[j];
}

// ---------------------------------------------------------------------------------------------------------
// Source monitor: marks, shuttle, frame stepping
// ---------------------------------------------------------------------------------------------------------

export const EMPTY_MARKS = Object.freeze({ in: null, out: null });

/** IN/OUT marks stored on a media item (`media.marks`), with junk values dropped: {in, out} (nulls when unset). */
export function mediaMarks(m) {
  const k = m?.marks;
  if (!k || typeof k !== 'object') return EMPTY_MARKS;
  const a = Number.isFinite(k.in) ? k.in : null;
  const b = Number.isFinite(k.out) ? k.out : null;
  return a == null && b == null ? EMPTY_MARKS : { in: a, out: b };
}

export const hasMarks = (m) => mediaMarks(m) !== EMPTY_MARKS;

const finiteDuration = (d) => (Number.isFinite(d) && d > 0 ? d : Infinity);

/**
 * Sets the IN or OUT mark at time t (I / O keys). A mark that would leave less than MIN_CLIP_DURATION against
 * the other mark clears the other one (marking a new IN after the OUT starts a fresh range).
 */
export function applyMark(marks, which, t, duration) {
  const d = finiteDuration(duration);
  const time = clamp(Number(t) || 0, 0, d);
  let a = marks?.in ?? null;
  let b = marks?.out ?? null;
  if (which === 'in') {
    a = time;
    if (b != null && b - a < MIN_CLIP_DURATION) b = null;
  } else {
    b = time;
    if (a != null && b - a < MIN_CLIP_DURATION) a = null;
  }
  return { in: a, out: b };
}

/**
 * Time to store for an I/O key press at playback time t: IN snaps to the start of the frame on screen, OUT to its
 * end so the frame you're looking at is included (as in NLEs). fps 0/unknown keeps t as is.
 */
export function markTime(which, t, fps, duration) {
  const d = finiteDuration(duration);
  const time = clamp(Number(t) || 0, 0, d);
  if (!(fps > 0)) return time;
  const n = Math.floor(time * fps + 1e-3);
  return clamp(which === 'in' ? n / fps : (n + 1) / fps, 0, d);
}

/** Moves a mark while dragging its handle: clamped against the other mark instead of clearing it. */
export function dragMark(marks, which, t, duration) {
  const d = finiteDuration(duration);
  const a = marks?.in ?? null;
  const b = marks?.out ?? null;
  if (which === 'in') {
    const max = (b ?? (Number.isFinite(d) ? d : Infinity)) - MIN_CLIP_DURATION;
    return { in: clamp(Number(t) || 0, 0, Math.max(0, max)), out: b };
  }
  const min = (a ?? 0) + MIN_CLIP_DURATION;
  return { in: a, out: clamp(Number(t) || 0, Math.min(min, d), d) };
}

/**
 * Source range to use for a timeline clip from the marks: {in, out}, or null for "the whole clip"
 * (no marks, an image, or marks that don't form a usable range).
 */
export function markedRange(media, sIn, sOut) {
  if (!media || media.kind === 'image') return null;
  if (sIn == null && sOut == null) return null;
  const d = finiteDuration(media.duration);
  const a = clamp(Number(sIn ?? 0) || 0, 0, d);
  const b = sOut == null ? d : clamp(Number(sOut) || 0, 0, d);
  if (!Number.isFinite(b)) return a > 0 ? { in: a } : null;
  if (b - a < MIN_CLIP_DURATION) return null;
  return { in: a, out: b };
}

/** "IN/OUT marks set: adding it uses 0:01.00–0:03.03" for an item with usable marks (null without). */
export function trimLabel(m) {
  const k = mediaMarks(m);
  const r = markedRange(m, k.in, k.out);
  if (!r) return null;
  return `IN/OUT marks set: adding it uses ${formatTime(r.in)}–${formatTime(r.out ?? m.duration)}`;
}

/** Display bounds of the marked range on a scrub bar of `duration` seconds: {start, end, active}. */
export function markBounds(marks, duration) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const active = marks?.in != null || marks?.out != null;
  const start = clamp(marks?.in ?? 0, 0, d);
  const end = clamp(marks?.out ?? d, start, d);
  return { start, end, active };
}

export const SHUTTLE_MAX = 8;

/** NLE-style J/K/L shuttle: L speeds up forward (1, 2, 4, 8), J backward (-1 … -8), K stops. */
export function shuttleRate(rate, key) {
  const r = Number(rate) || 0;
  if (key === 'k') return 0;
  if (key === 'l') return r <= 0 ? 1 : Math.min(SHUTTLE_MAX, r * 2);
  if (key === 'j') return r >= 0 ? -1 : Math.max(-SHUTTLE_MAX, r * 2);
  return r;
}

/** Time of the previous/next frame from t at fps (frame index = floor), clamped to the clip. */
export function frameStepTime(t, fps, dir, duration) {
  const f = fps > 0 ? fps : 30;
  const n = Math.floor((Number(t) || 0) * f + 1e-3);
  const next = (n + (dir < 0 ? -1 : 1)) / f;
  const d = finiteDuration(duration);
  const last = Number.isFinite(d) ? Math.max(0, Math.floor(d * f - 1e-3) / f) : Infinity;
  return clamp(next, 0, last);
}

/** Filmstrip cell under the pointer: x in [0, width) -> 0 … count-1. */
export function stripCell(x, width, count) {
  if (!(count > 0) || !(width > 0)) return 0;
  return clamp(Math.floor((x / width) * count), 0, count - 1);
}

/** Source time represented by a filmstrip cell (cells sample the middle of equal slices, see media.js). */
export const stripCellTime = (cell, count, duration) => (count > 0 && duration > 0 ? ((cell + 0.5) / count) * duration : 0);

/** Time the generated poster thumbnail shows (mirrors media.js videoPreviews). */
export const posterTime = (duration) => (duration > 0 ? Math.min(duration * 0.15, 1) : 0);

// ---------------------------------------------------------------------------------------------------------
// Review walk: a snapshot of ids taken when review starts; items removed since (undo, removal, sequence switch)
// are skipped instead of being shown. alive(id) tells whether an id still exists.
// ---------------------------------------------------------------------------------------------------------

/** Index of the item to show for cursor `pos`: pos itself when alive, else the next alive one; list.length = none left. */
export function resolveWalk(list, pos, alive) {
  let i = clamp(Math.floor(Number(pos) || 0), 0, list.length);
  while (i < list.length && !alive(list[i])) i++;
  return i;
}

/**
 * Next (dir > 0) or previous (dir < 0) alive index from `at`. Forward past the last item gives list.length (the
 * summary); backward from the summary lands on the last alive item; backward from the first stays put.
 */
export function walkStep(list, at, dir, alive) {
  if (dir > 0) {
    let i = Math.min(at, list.length) + 1;
    while (i < list.length && !alive(list[i])) i++;
    return Math.min(i, list.length);
  }
  let i = Math.min(at, list.length) - 1;
  while (i >= 0 && !alive(list[i])) i--;
  return i < 0 ? at : i;
}

// ---------------------------------------------------------------------------------------------------------
// Placeholder clip lengths. A clip placed before its media was probed gets a stand-in length (3 s video, 10 s
// audio) and `autoOut: true` (core/model.js); core/media.js widens it to the real duration when the probe finishes,
// and any trim clears the flag. Undo / redo can bring back a snapshot from before that widening after the probe is
// done: placeholderFixes() finds such clips so they can be repaired.
// ---------------------------------------------------------------------------------------------------------

/** [{id, track, out}] for clips still flagged autoOut whose media duration is now known and differs from their out. */
export function placeholderFixes(project) {
  const fixes = [];
  if (!project?.tracks) return fixes;
  for (const track of ['video', 'audio']) {
    for (const clip of project.tracks[track] || []) {
      if (!clip.autoOut) continue;
      const m = project.media[clip.mediaId];
      if (!m || m.kind === 'image' || !(m.duration > 0)) continue;
      if (Math.abs(m.duration - clip.out) > 1e-3) fixes.push({ id: clip.id, track, out: m.duration });
    }
  }
  return fixes;
}

// ---------------------------------------------------------------------------------------------------------
// Project-derived lookups (cached per immutable project slice)
// ---------------------------------------------------------------------------------------------------------

const usageCache = new WeakMap();

/** Map mediaId -> number of timeline clips (video + audio tracks) that use it. Cached per `project.tracks`. */
export function mediaUsageCounts(project) {
  const key = project?.tracks;
  if (!key) return new Map();
  let counts = usageCache.get(key);
  if (!counts) {
    counts = new Map();
    for (const track of ['video', 'audio']) for (const c of key[track] || []) counts.set(c.mediaId, (counts.get(c.mediaId) || 0) + 1);
    usageCache.set(key, counts);
  }
  return counts;
}

/**
 * The ids (of `ids`, same order) already on the timeline where "Add to timeline" puts them: videos and images on the
 * main track, audio files on an audio track. A video whose sound alone is used on an audio track is not placed.
 */
export function placedOnTimeline(project, ids) {
  const tracks = project?.tracks;
  if (!tracks) return [];
  const video = new Set((tracks.video || []).map((c) => c.mediaId));
  const audio = new Set((tracks.audio || []).map((c) => c.mediaId));
  return ids.filter((id) => {
    const m = project.media?.[id];
    return !!m && (m.kind === 'audio' ? audio.has(id) : video.has(id));
  });
}

/** "pageKey<TAB>mediaId" lines for bin items collected from grok.com (stable string for store selectors). */
export function binPageIndexString(project) {
  if (!project) return '';
  const rows = [];
  for (const id of project.mediaOrder) {
    const k = project.media[id]?.pageKey;
    if (k) rows.push(`${k}\t${id}`);
  }
  return rows.join('\n');
}

/** Parses binPageIndexString() into Map pageKey -> mediaId. */
export function parsePageIndex(text) {
  const map = new Map();
  for (const row of String(text || '').split('\n')) {
    const tab = row.indexOf('\t');
    if (tab > 0 && !map.has(row.slice(0, tab))) map.set(row.slice(0, tab), row.slice(tab + 1));
  }
  return map;
}

/** Stats for a set of ids: {total, picked, rejected, unflagged, rated}. */
export function flagStats(project, ids) {
  const s = { total: 0, picked: 0, rejected: 0, unflagged: 0, rated: 0 };
  for (const id of ids) {
    const m = project?.media[id];
    if (!m) continue;
    s.total++;
    if (m.flag === 'pick') s.picked++;
    else if (m.flag === 'reject') s.rejected++;
    else s.unflagged++;
    if (m.rating > 0) s.rated++;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------
// Flags & ratings (pure project ops; callers wrap them in projectStore.update with a label)
// ---------------------------------------------------------------------------------------------------------

/** Sets flag ('pick' | 'reject' | null) on media ids; returns the same project when nothing changes. */
export function setFlagOp(project, ids, flag) {
  let p = project;
  for (const id of ids) if (p.media[id] && (p.media[id].flag ?? null) !== flag) p = updateMedia(p, id, { flag });
  return p;
}

/** Sets a 0..5 rating on media ids; returns the same project when nothing changes. */
export function setRatingOp(project, ids, rating) {
  const r = clamp(Math.round(Number(rating) || 0), 0, 5);
  let p = project;
  for (const id of ids) if (p.media[id] && (p.media[id].rating || 0) !== r) p = updateMedia(p, id, { rating: r });
  return p;
}

/** Flag value a toggle button should apply: clears the flag when every target already has it. */
export function toggledFlag(project, ids, flag) {
  const list = ids.map((id) => project?.media[id]).filter(Boolean);
  return list.length && list.every((m) => m.flag === flag) ? null : flag;
}

export const flagLabel = (flag, n = 1) => {
  const what = n > 1 ? ` ${n} items` : '';
  return flag === 'pick' ? `Pick${what}` : flag === 'reject' ? `Reject${what}` : `Unflag${what}`;
};

// ---------------------------------------------------------------------------------------------------------
// Page items (media detected on grok.com)
// ---------------------------------------------------------------------------------------------------------

export const PAGE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'video', label: 'Videos' },
  { value: 'image', label: 'Images' },
  { value: 'new', label: 'Not in bin' },
];

/** Page items to show, newest first: filter 'all' | 'video' | 'image' | 'new' (not in the bin yet). */
export function pageItemsView(items, filter = 'all', inBin = new Set()) {
  const list = (items || []).filter((it) => {
    if (!it || !it.key) return false;
    if (filter === 'video' || filter === 'image') return it.kind === filter;
    if (filter === 'new') return !inBin.has(it.key);
    return true;
  });
  return list
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (b.it.seenAt || 0) - (a.it.seenAt || 0) || a.i - b.i)
    .map((x) => x.it);
}

/** Page items not yet in the bin, optionally of one kind. */
export const missingFromBin = (items, inBin, kind = null) => (items || []).filter((it) => it?.key && !inBin.has(it.key) && (!kind || it.kind === kind));

// ---------------------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------------------

/** Parses a MEDIA_DRAG_TYPE payload; returns [] on anything unexpected. */
export function parseMediaDrag(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}

/**
 * Why a typed link can't be imported (null when it can): empty, not a web link, or not a valid URL. data: URLs are
 * accepted like core/media.js importUrl() does.
 */
export function urlProblem(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'Paste the link to a video, image or audio file.';
  if (/^data:/i.test(t)) return null;
  if (!/^https?:\/\//i.test(t)) return /^[\w-]+(\.[\w-]+)+(\/|$)/.test(t) ? 'Links start with https:// — add it in front.' : 'That is not a web link: it should start with https://';
  try {
    const u = new URL(t);
    if (!u.hostname) throw new Error('no host');
  } catch {
    return 'That link is not valid. Check it and try again.';
  }
  return null;
}

/** Short one-line snippet of a prompt for compact displays. */
export function snippet(text, max = 90) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}
