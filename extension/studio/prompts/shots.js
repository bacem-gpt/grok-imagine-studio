// Shot list model: immutable operations on project.shots (Prompts tab storyboard) and the links between shots and the
// generated media ("takes"). Pure: no DOM; importable from Node unit tests.
//
// Shot { id, title, prompt, fields: {}, ingredientIds: [], duration, mode, notes,
//        status: 'draft'|'sent'|'generated'|'approved', takes: [mediaId], chosenTake: mediaId|null, createdAt,
//        updatedAt, sentAt: ms|null, sentText: string }   (sentAt/sentText: last prompt sent to Grok, for take matching)
//
// Status flow: draft --send--> sent --take linked--> generated --approve--> approved. Removing the last take of a
// generated shot falls back to sent (or draft if it was never sent). Any status can also be set by hand.

import { uid } from '../core/utils.js';
import * as M from '../core/model.js';

export const SHOT_STATUSES = ['draft', 'sent', 'generated', 'approved'];
export const STATUS_LABELS = { draft: 'Draft', sent: 'Sent', generated: 'Generated', approved: 'Approved' };
export const SHOT_MODE_IDS = ['video', 'animate', 'image'];
export const DEFAULT_SHOT_DURATION = 6;
export const MAX_SHOT_DURATION = 60;

/** Grok Imagine's own video modes; shots created elsewhere may carry them ("normal" + references = image → video). */
const GROK_MODES = new Set(['normal', 'fun', 'custom', 'spicy']);

const str = (v) => (v == null ? '' : String(v));
const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : []);
/** Takes of a shot even when the record is partial (shots created by other tabs / older versions). */
const takesOf = (shot) => (Array.isArray(shot?.takes) ? shot.takes : []);

/** Maps any stored mode to one of SHOT_MODE_IDS. */
export function normalizeMode(mode, ingredientIds = []) {
  if (SHOT_MODE_IDS.includes(mode)) return mode;
  if (GROK_MODES.has(mode)) return Array.isArray(ingredientIds) && ingredientIds.length ? 'animate' : 'video';
  return 'video';
}

/**
 * Creates a shot with defaults (or repairs a partial / imported one).
 * @param {Partial<object>} [partial]
 */
export function createShot(partial = {}) {
  const now = Date.now();
  const takes = ids(partial.takes);
  const duration = Number(partial.duration);
  return {
    id: typeof partial.id === 'string' && partial.id ? partial.id : uid('sht'),
    title: str(partial.title),
    prompt: str(partial.prompt),
    fields: partial.fields && typeof partial.fields === 'object' && !Array.isArray(partial.fields) ? { ...partial.fields } : {},
    ingredientIds: ids(partial.ingredientIds),
    duration: Number.isFinite(duration) && duration > 0 ? Math.min(MAX_SHOT_DURATION, duration) : DEFAULT_SHOT_DURATION,
    mode: normalizeMode(partial.mode, partial.ingredientIds),
    notes: str(partial.notes),
    status: SHOT_STATUSES.includes(partial.status) ? partial.status : 'draft',
    takes,
    chosenTake: takes.includes(partial.chosenTake) ? partial.chosenTake : null,
    createdAt: Number(partial.createdAt) || now,
    updatedAt: Number(partial.updatedAt) || now,
    sentAt: Number(partial.sentAt) || null,
    sentText: str(partial.sentText),
  };
}

/** Repairs a raw shot (from storage or an imported project). */
export const normalizeShot = (raw) => createShot(raw && typeof raw === 'object' ? raw : {});

export const getShots = (project) => (Array.isArray(project?.shots) ? project.shots : []);
export const findShot = (project, id) => getShots(project).find((s) => s.id === id) || null;
export const shotIndex = (project, id) => getShots(project).findIndex((s) => s.id === id);

const touch = (project) => ({ ...project, updatedAt: Date.now() });
const withShots = (project, shots) => touch({ ...project, shots });

/** Inserts shots (partials are completed with createShot) at index (default: end). Returns {project, ids}. */
export function addShots(project, partials, index) {
  const list = getShots(project).slice();
  const fresh = (Array.isArray(partials) ? partials : [partials]).map((p) => createShot({ ...p, id: undefined, takes: [], chosenTake: null, status: 'draft', sentAt: null, sentText: '' }));
  const at = index == null ? list.length : Math.max(0, Math.min(list.length, index));
  list.splice(at, 0, ...fresh);
  return { project: withShots(project, list), ids: fresh.map((s) => s.id) };
}

/** Inserts one shot. Returns {project, id}. */
export function addShot(project, partial = {}, index) {
  const res = addShots(project, [partial], index);
  return { project: res.project, id: res.ids[0] };
}

/**
 * Shallow-merges a patch into a shot (id is immutable; status/mode/duration are validated).
 * Returns the same project when nothing changes.
 */
export function updateShot(project, id, patch) {
  const list = getShots(project);
  const i = list.findIndex((s) => s.id === id);
  if (i < 0 || !patch) return project;
  const cur = list[i];
  const next = { ...cur };
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    if (k === 'status' && !SHOT_STATUSES.includes(v)) continue;
    if (k === 'mode' && !SHOT_MODE_IDS.includes(v)) continue;
    let value = v;
    if (k === 'duration') {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      value = Math.min(MAX_SHOT_DURATION, n);
    }
    if (k === 'ingredientIds' || k === 'takes') value = ids(v);
    if (next[k] !== value) {
      next[k] = value;
      changed = true;
    }
  }
  if (!changed) return project;
  if (!Array.isArray(next.takes)) next.takes = [];
  if (!next.takes.includes(next.chosenTake)) next.chosenTake = null;
  next.updatedAt = Date.now();
  const copy = list.slice();
  copy[i] = next;
  return withShots(project, copy);
}

/** Merges builder field values into shot.fields (empty values remove the key). */
export function updateShotFields(project, id, fieldsPatch) {
  const shot = findShot(project, id);
  if (!shot) return project;
  const fields = { ...shot.fields };
  let changed = false;
  for (const [k, v] of Object.entries(fieldsPatch || {})) {
    const s = str(v);
    if (!s.trim()) {
      if (k in fields) {
        delete fields[k];
        changed = true;
      }
    } else if (fields[k] !== s) {
      fields[k] = s;
      changed = true;
    }
  }
  return changed ? updateShot(project, id, { fields }) : project;
}

/** Removes shots; media linked to them lose their shotId. */
export function removeShots(project, shotIds) {
  const set = new Set(Array.isArray(shotIds) ? shotIds : [shotIds]);
  const list = getShots(project);
  if (!list.some((s) => set.has(s.id))) return project;
  let p = withShots(project, list.filter((s) => !set.has(s.id)));
  for (const [mid, m] of Object.entries(p.media || {})) if (m.shotId && set.has(m.shotId)) p = M.updateMedia(p, mid, { shotId: null });
  return p;
}

/** Duplicates a shot right after the original (fresh draft: no takes, not sent). Returns {project, id}. */
export function duplicateShot(project, id) {
  const i = shotIndex(project, id);
  if (i < 0) return { project, id: null };
  const src = getShots(project)[i];
  const copy = createShot({
    ...src,
    id: undefined,
    title: src.title ? `${src.title} (copy)` : '',
    fields: { ...(src.fields || {}) },
    ingredientIds: [...(Array.isArray(src.ingredientIds) ? src.ingredientIds : [])],
    status: 'draft',
    takes: [],
    chosenTake: null,
    sentAt: null,
    sentText: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const list = getShots(project).slice();
  list.splice(i + 1, 0, copy);
  return { project: withShots(project, list), id: copy.id };
}

/** Moves a shot to its final index `toIndex` (clamped). */
export function moveShot(project, id, toIndex) {
  const list = getShots(project).slice();
  const from = list.findIndex((s) => s.id === id);
  if (from < 0) return project;
  const to = Math.max(0, Math.min(list.length - 1, Math.round(Number(toIndex) || 0)));
  if (to === from) return project;
  const [shot] = list.splice(from, 1);
  list.splice(to, 0, shot);
  return withShots(project, list);
}

/** Reorders shots by id (unknown ids ignored, missing shots keep their relative order at the end). */
export function reorderShots(project, orderedIds) {
  const list = getShots(project);
  const byId = new Map(list.map((s) => [s.id, s]));
  const seen = new Set();
  const next = [];
  for (const id of orderedIds || []) {
    if (byId.has(id) && !seen.has(id)) {
      next.push(byId.get(id));
      seen.add(id);
    }
  }
  for (const s of list) if (!seen.has(s.id)) next.push(s);
  if (next.every((s, i) => s === list[i])) return project;
  return withShots(project, next);
}

/** Sets the status by hand. */
export const setShotStatus = (project, id, status) => updateShot(project, id, { status });

/** Status after a send (draft -> sent; later stages keep their status). */
export function statusAfterSend(status) {
  return status === 'draft' || !SHOT_STATUSES.includes(status) ? 'sent' : status;
}

/** Records that a shot's prompt was sent to Grok (status draft -> sent, remembers the text for take matching). */
export function markShotSent(project, id, { text = '', at = Date.now() } = {}) {
  const shot = findShot(project, id);
  if (!shot) return project;
  return updateShot(project, id, { status: statusAfterSend(shot.status), sentAt: at, sentText: str(text) || shot.prompt });
}

/**
 * Links a media item to a shot as a take (removing it from any other shot) and sets media.shotId.
 * draft/sent shots become 'generated'. opts.choose also makes it the chosen take.
 */
export function linkTake(project, shotId, mediaId, { choose = false } = {}) {
  const shot = findShot(project, shotId);
  if (!shot || !project.media?.[mediaId]) return project;
  let p = project;
  // Detach from other shots first.
  for (const other of getShots(p)) {
    if (other.id !== shotId && takesOf(other).includes(mediaId)) p = unlinkTake(p, other.id, mediaId);
  }
  const cur = findShot(p, shotId);
  const curTakes = takesOf(cur);
  const takes = curTakes.includes(mediaId) ? curTakes : [...curTakes, mediaId];
  const status = cur.status === 'draft' || cur.status === 'sent' ? 'generated' : cur.status;
  p = updateShot(p, shotId, { takes, status, ...(choose ? { chosenTake: mediaId } : {}) });
  if (p.media[mediaId]?.shotId !== shotId) p = M.updateMedia(p, mediaId, { shotId });
  return p;
}

/** Links several {shotId, mediaId} pairs. */
export function linkTakes(project, pairs) {
  let p = project;
  for (const { shotId, mediaId, choose } of pairs || []) p = linkTake(p, shotId, mediaId, { choose });
  return p;
}

/** Unlinks a take (clears media.shotId; a generated shot with no takes left falls back to sent/draft). */
export function unlinkTake(project, shotId, mediaId) {
  const shot = findShot(project, shotId);
  if (!shot || !takesOf(shot).includes(mediaId)) return project;
  const takes = takesOf(shot).filter((t) => t !== mediaId);
  const patch = { takes };
  if (shot.chosenTake === mediaId) patch.chosenTake = null;
  if (!takes.length && shot.status === 'generated') patch.status = shot.sentAt ? 'sent' : 'draft';
  let p = updateShot(project, shotId, patch);
  if (p.media?.[mediaId]?.shotId === shotId) p = M.updateMedia(p, mediaId, { shotId: null });
  return p;
}

/** Makes a take the chosen ("best") one; links it first when needed. null clears the choice. */
export function chooseTake(project, shotId, mediaId) {
  const shot = findShot(project, shotId);
  if (!shot) return project;
  if (mediaId == null) return updateShot(project, shotId, { chosenTake: null });
  const has = takesOf(shot).includes(mediaId);
  const p = has ? project : linkTake(project, shotId, mediaId);
  if (p === project && !has) return project;
  return updateShot(p, shotId, { chosenTake: mediaId });
}

/** Takes of a shot that still exist in the bin. */
export function validTakes(project, shot) {
  if (!shot) return [];
  return takesOf(shot).filter((id) => !!project.media?.[id]);
}

/** True when a media item can go on the timeline as a take: visual and not failed (pending / loading / ready). */
export const isUsableTake = (media) => !!media && media.kind !== 'audio' && media.status !== 'error';

/**
 * The take used for the sequence: the chosen take when it is usable, else the first usable take, else null.
 * Failed downloads (status 'error') are never used: they have no file and would become placeholder clips.
 */
export function effectiveTake(project, shot) {
  const usable = validTakes(project, shot).filter((id) => isUsableTake(project.media[id]));
  if (shot?.chosenTake && usable.includes(shot.chosenTake)) return shot.chosenTake;
  return usable[0] || null;
}

/** The shot a media item is linked to (by media.shotId, falling back to shot.takes). */
export function shotForMedia(project, mediaId) {
  const sid = project.media?.[mediaId]?.shotId;
  if (sid) {
    const s = findShot(project, sid);
    if (s) return s;
  }
  return getShots(project).find((s) => takesOf(s).includes(mediaId)) || null;
}

/**
 * Repairs take links: drops takes whose media is gone, clears dangling chosenTake, and adds takes for media whose
 * shotId points at an existing shot. Returns the same project when everything is consistent.
 */
export function syncTakes(project) {
  let p = project;
  for (const shot of getShots(project)) {
    const valid = validTakes(project, shot);
    if (valid.length !== takesOf(shot).length || !Array.isArray(shot.takes)) p = updateShot(p, shot.id, { takes: valid });
  }
  for (const [mid, m] of Object.entries(project.media || {})) {
    if (!m.shotId) continue;
    const s = findShot(p, m.shotId);
    if (!s) p = M.updateMedia(p, mid, { shotId: null });
    else if (!takesOf(s).includes(mid)) p = updateShot(p, s.id, { takes: [...takesOf(s), mid] });
  }
  return p;
}

/**
 * Media ids for the sequence, in shot order (or in opts.order): each shot's chosen (or first) usable take.
 * @returns {{mediaIds: string[], used: Array<{shotId, mediaId, fallback: boolean}>, skipped: string[], failed: string[]}}
 *   skipped = shot ids without a usable take; failed = the skipped shots whose takes all failed to download;
 *   used[].fallback = the chosen take failed, another take is used instead.
 */
export function takesInShotOrder(project, { approvedOnly = false, shotIds = null, order = null } = {}) {
  const only = shotIds ? new Set(shotIds) : null;
  const used = [];
  const skipped = [];
  const failed = [];
  // `order`: shot ids to use in that order (e.g. dialogue parts) instead of the shot list order.
  const list = order ? order.map((id) => findShot(project, id)).filter(Boolean) : getShots(project);
  for (const shot of list) {
    if (only && !only.has(shot.id)) continue;
    if (approvedOnly && shot.status !== 'approved') continue;
    const mediaId = effectiveTake(project, shot);
    if (mediaId) {
      used.push({ shotId: shot.id, mediaId, fallback: !!shot.chosenTake && shot.chosenTake !== mediaId });
      continue;
    }
    skipped.push(shot.id);
    if (validTakes(project, shot).some((id) => project.media[id].status === 'error')) failed.push(shot.id);
  }
  return { mediaIds: used.map((u) => u.mediaId), used, skipped, failed };
}

/**
 * Builds the main track from the shots' takes (chosen or first take, in shot order).
 * opts.replace clears the main track first; opts.transition ({type, duration}) goes between clips.
 * @returns {{project, clipIds: string[], used: Array<{shotId, mediaId, fallback}>, skipped: string[], failed: string[]}}
 */
export function assembleTimeline(project, { replace = false, transition = null, approvedOnly = false, shotIds = null, order = null } = {}) {
  const { mediaIds, used, skipped, failed } = takesInShotOrder(project, { approvedOnly, shotIds, order });
  if (!mediaIds.length) return { project, clipIds: [], used, skipped, failed };
  let p = project;
  if (replace && p.tracks.video.length) p = M.removeClips(p, p.tracks.video.map((c) => c.id));
  const res = M.appendMediaToTimeline(p, mediaIds, { transition: transition && transition.type && transition.type !== 'cut' ? transition : null });
  return { project: res.project, clipIds: res.ids, used, skipped, failed };
}

/** Sum of the shots' planned durations (seconds). */
export const totalDuration = (shots) => (Array.isArray(shots) ? shots : []).reduce((s, sh) => s + (Number(sh.duration) || 0), 0);

/** Count of shots per status. */
export function statusCounts(shots) {
  const out = { draft: 0, sent: 0, generated: 0, approved: 0 };
  for (const s of Array.isArray(shots) ? shots : []) if (out[s.status] != null) out[s.status]++;
  return out;
}

/** "Shot 3" or "Shot 3 · The arrival". */
export const shotLabel = (shot, index) => `Shot ${index + 1}${shot?.title ? ` · ${shot.title}` : ''}`;

/**
 * The next shot to send for the manual "Send next" flow: the first draft shot after `afterId` (wrapping around),
 * or the first draft shot overall. Returns null when every shot was sent.
 */
export function nextDraftShot(project, afterId = null) {
  const list = getShots(project);
  if (!list.length) return null;
  const start = afterId ? list.findIndex((s) => s.id === afterId) + 1 : 0;
  for (let k = 0; k < list.length; k++) {
    const s = list[(start + k) % list.length];
    if ((s.status || 'draft') === 'draft' && str(s.prompt).trim()) return s;
  }
  return null;
}

const SHOT_KEYS = ['id', 'title', 'prompt', 'fields', 'ingredientIds', 'duration', 'mode', 'notes', 'status', 'takes', 'chosenTake', 'createdAt', 'updatedAt', 'sentAt', 'sentText'];

/** True when a stored shot already has the full, valid shape (so repairShots can leave it untouched). */
function isWellFormed(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id) return false;
  if (!SHOT_KEYS.every((k) => k in s)) return false;
  return (
    typeof s.title === 'string' &&
    typeof s.prompt === 'string' &&
    s.fields && typeof s.fields === 'object' && !Array.isArray(s.fields) &&
    Array.isArray(s.ingredientIds) &&
    Array.isArray(s.takes) &&
    SHOT_STATUSES.includes(s.status) &&
    SHOT_MODE_IDS.includes(s.mode) &&
    Number(s.duration) > 0 &&
    (s.chosenTake == null || s.takes.includes(s.chosenTake))
  );
}

/**
 * Completes partial shots (e.g. created by another tab or an older version) and drops non-objects.
 * Returns the same project when every shot is already well formed.
 */
export function repairShots(project) {
  const list = Array.isArray(project?.shots) ? project.shots : null;
  if (!list) return project && !Array.isArray(project.shots) ? { ...project, shots: [] } : project;
  if (list.every(isWellFormed)) return project;
  const seen = new Set();
  const shots = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const shot = isWellFormed(raw) ? raw : normalizeShot(raw);
    if (seen.has(shot.id)) continue;
    seen.add(shot.id);
    shots.push(shot);
  }
  return { ...project, shots };
}
