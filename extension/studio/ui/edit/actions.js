// Edit-tab commands shared by the toolbar, keyboard shortcuts, context menus and the inspector. Every project edit
// goes through projectStore.update with a label (one undo step each); errors surface as toasts.

import { projectStore, uiStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import * as Ops from './edit-ops.js';
import { importFiles, importUrl, addBlobAsMedia } from '../../core/media.js';
import { addIngredient } from '../../core/ingredients.js';
import { appEvents } from '../../core/app-state.js';
import { downloadBlob, copyImage, formatTime, sanitizeFilename, pluralize } from '../../core/utils.js';
import { toast, dismissToast, promptDialog, pickFiles } from '../kit.js';

import { MEDIA_DRAG_TYPE } from '../kit.js';
export { MEDIA_DRAG_TYPE };

let clipboard = null;

const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export const getSelection = () => uiStore.get().selection || [];

/** The selected ids that still exist in the project (undo can remove clips that are still selected). */
export function liveSelection(project = projectStore.get()) {
  const sel = getSelection();
  return project ? sel.filter((id) => M.findClip(project, id)) : [];
}

/** Drops selected ids whose clips no longer exist (called whenever the project changes). */
export function pruneSelection(project = projectStore.get()) {
  const sel = getSelection();
  if (!sel.length || !project) return;
  const live = liveSelection(project);
  if (live.length !== sel.length) setSelection(live);
}

export function setSelection(ids) {
  const next = [...new Set(ids.filter(Boolean))];
  uiStore.set((s) => (sameIds(s.selection || [], next) ? s : { ...s, selection: next }));
}

/** Click selection: plain click selects only `id`; additive (shift/ctrl/cmd) toggles it. */
export function clickSelect(id, additive = false) {
  const sel = getSelection();
  if (additive) setSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  else setSelection([id]);
}

export const clearSelection = () => setSelection([]);

export function selectAll() {
  const p = projectStore.get();
  if (p) setSelection(Ops.allClipIds(p));
}

/** Splits the selected clips under the playhead (or the main-track clip under it when none is selected there). */
export function splitAtPlayhead(session) {
  const t = session.time();
  const sel = getSelection();
  let count = 0;
  projectStore.update(
    (p) => {
      let q = p;
      const lay = M.layoutProject(q);
      const under = sel
        .map((id) => M.findClip(q, id))
        .filter(Boolean)
        .filter((f) => {
          const it = [...lay.video, ...lay.audio, ...lay.text].find((x) => x.clip.id === f.clip.id);
          return it && t > it.start + 1e-3 && t < it.end - 1e-3;
        });
      if (!under.length) {
        const r = M.splitVideoAt(q, t);
        if (r.rightId) count++;
        return r.project;
      }
      for (const f of under) {
        const r = f.track === 'video' ? M.splitVideoAt(q, t, f.clip.id) : f.track === 'audio' ? M.splitAudioAt(q, f.clip.id, t) : M.splitTextAt(q, f.clip.id, t);
        if (r.rightId) {
          q = r.project;
          count++;
        }
      }
      return q;
    },
    { label: 'Split' },
  );
  if (!count) toast('Move the playhead over a clip to split it', { kind: 'info' });
  return count;
}

export function deleteSelection() {
  const sel = liveSelection();
  if (!sel.length) {
    if (getSelection().length) setSelection([]);
    return false;
  }
  projectStore.update((p) => M.removeClips(p, sel), { label: sel.length > 1 ? `Delete ${sel.length} clips` : 'Delete clip' });
  setSelection([]);
  return true;
}

export function duplicateSelection() {
  const sel = liveSelection();
  if (!sel.length) return false;
  let ids = [];
  projectStore.update(
    (p) => {
      const r = M.duplicateClips(p, sel);
      ids = r.ids;
      return r.project;
    },
    { label: sel.length > 1 ? 'Duplicate clips' : 'Duplicate clip' },
  );
  setSelection(ids);
  return true;
}

export function copySelection({ quiet = false } = {}) {
  const p = projectStore.get();
  const cb = p && Ops.copyClips(p, liveSelection(p));
  if (!cb) return false;
  clipboard = cb;
  if (!quiet) toast(`Copied ${pluralize(cb.video.length + cb.audio.length + cb.text.length, 'clip')}`);
  return true;
}

export function cutSelection() {
  if (!copySelection({ quiet: true })) return false;
  deleteSelection();
  return true;
}

export const hasClipboard = () => !!clipboard;

export function pasteAt(t) {
  if (!clipboard) {
    toast('Nothing to paste — copy clips first (Ctrl+C)', { kind: 'info' });
    return false;
  }
  let ids = [];
  projectStore.update(
    (p) => {
      const r = Ops.pasteClips(p, clipboard, t);
      ids = r.ids;
      return r.project;
    },
    { label: 'Paste' },
  );
  if (!ids.length) toast('The copied clips’ media is no longer in this sequence', { kind: 'warn' });
  setSelection(ids);
  return ids.length > 0;
}

/** Adds a title at time t on the first free text lane, selects it and asks the inspector to focus its text. */
export function addTextAt(session, t, opts = {}) {
  let id = null;
  projectStore.update(
    (p) => {
      const r = M.addTextClip(p, { start: Math.max(0, t), duration: 3, text: 'Your title', ...opts });
      id = r.id;
      return r.project;
    },
    { label: 'Add text' },
  );
  setSelection([id]);
  uiStore.set((s) => (s.inspectorOpen ? s : { ...s, inspectorOpen: true }));
  // The inspector (or its drawer) may only mount after this: the session keeps the request until it can be honoured,
  // so the typing goes into the title instead of firing timeline shortcuts (S split, M marker…).
  session?.requestTextFocus(id);
  return id;
}

export function addMarkerAt(t, label = '') {
  const p = projectStore.get();
  if ((p.markers || []).some((m) => Math.abs(m.time - t) < 0.02)) {
    toast('There is already a marker here', { kind: 'info' });
    return null;
  }
  let id = null;
  projectStore.update(
    (q) => {
      const r = M.addMarker(q, t, label);
      id = r.id;
      return r.project;
    },
    { label: 'Add marker' },
  );
  return id;
}

export function renameMarker(id, label) {
  projectStore.update(
    (p) => {
      const cur = (p.markers || []).find((m) => m.id === id);
      if (!cur || (cur.label || '') === label) return p;
      return { ...p, updatedAt: Date.now(), markers: p.markers.map((m) => (m.id === id ? { ...m, label } : m)) };
    },
    { label: 'Rename marker' },
  );
}

/** Moves a marker during a drag (one undo step per gesture via `merge`). */
export function moveMarker(id, time, merge = null) {
  projectStore.update((p) => Ops.moveMarker(p, id, time), { label: 'Move marker', merge });
}

export function removeMarker(id) {
  projectStore.update((p) => M.removeMarker(p, id), { label: 'Delete marker' });
}

/**
 * Places media on the timeline in one undo step: visual media is inserted on the main track at the boundary nearest
 * to `time` (appended when time is null), audio goes to an audio lane starting at `audioTime` (lane `audioLane` if
 * free). Returns the new clip ids (and selects them).
 */
export function placeMedia(ids, { time = null, audioTime = null, audioLane = null, label = 'Add to timeline' } = {}) {
  const added = [];
  projectStore.update(
    (p) => {
      let q = p;
      const visual = ids.filter((id) => q.media[id] && q.media[id].kind !== 'audio');
      const audio = ids.filter((id) => q.media[id]?.kind === 'audio');
      if (visual.length) {
        const index = time == null ? q.tracks.video.length : M.insertionIndexAt(M.layoutVideo(q.tracks.video), time);
        const r = M.appendMediaToTimeline(q, visual, { index });
        q = r.project;
        added.push(...r.ids);
      }
      let cursor = Math.max(0, audioTime ?? time ?? 0);
      for (const id of audio) {
        const m = q.media[id];
        const dur = m.duration > 0 ? m.duration : 10;
        let lane = audioLane;
        const busy = lane != null && q.tracks.audio.some((c) => (c.lane || 0) === lane && cursor < c.start + M.audioClipDuration(c) - 1e-6 && cursor + dur > c.start + 1e-6);
        if (busy) lane = null;
        const r = M.addAudioClip(q, id, lane != null ? { start: cursor, lane } : { start: cursor });
        q = r.project;
        if (r.id) added.push(r.id);
        cursor += dur;
      }
      return q;
    },
    { label },
  );
  if (added.length) setSelection(added);
  return added;
}

/** Adds media as audio-track clips (audio files or the sound of videos) from time t, one after another. */
export function placeAsAudio(ids, t) {
  const added = [];
  projectStore.update(
    (p) => {
      let q = p;
      let cursor = Math.max(0, t);
      for (const id of ids) {
        const m = q.media[id];
        if (!m || m.kind === 'image' || m.status === 'error' || (m.kind === 'video' && m.hasAudio === false)) continue;
        const r = M.addAudioClip(q, id, { start: cursor });
        if (!r.id) continue;
        q = r.project;
        added.push(r.id);
        cursor += M.audioClipDuration(M.findClip(q, r.id).clip);
      }
      return q;
    },
    { label: 'Add audio' },
  );
  if (added.length) setSelection(added);
  return added;
}

/** Imports dropped/picked files and places them (visual -> main track at `time`, audio -> lane at `audioTime`). */
export async function importAndPlace(files, opts = {}) {
  if (!files?.length) return [];
  const tid = toast(`Importing ${pluralize(files.length, 'file')}…`, { duration: 0 });
  try {
    const ids = await importFiles(files);
    const p = projectStore.get();
    const ok = ids.filter((id) => p.media[id]?.status === 'ready');
    if (ok.length < ids.length) toast(`${ids.length - ok.length} file(s) could not be imported`, { kind: 'error' });
    if (!ids.length) toast('Unsupported file type — use video, image or audio files', { kind: 'error' });
    return ok.length ? placeMedia(ok, opts) : [];
  } catch (e) {
    toast(`Import failed: ${e.message || e}`, { kind: 'error' });
    return [];
  } finally {
    dismissToast(tid);
  }
}

/** "Add audio → From file…" */
export async function addAudioFromFiles(session) {
  const files = await pickFiles({ accept: 'audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.webm', multiple: true });
  if (!files.length) return [];
  const t = session.time();
  const tid = toast(`Importing ${pluralize(files.length, 'file')}…`, { duration: 0 });
  try {
    const ids = await importFiles(files);
    const added = placeAsAudio(ids, t);
    if (!added.length) toast('No usable sound in the selected file(s)', { kind: 'error' });
    else toast(`Added ${pluralize(added.length, 'audio clip')}`, { kind: 'success' });
    return added;
  } catch (e) {
    toast(`Import failed: ${e.message || e}`, { kind: 'error' });
    return [];
  } finally {
    dismissToast(tid);
  }
}

/**
 * "Add audio → From URL…" (the permission prompt needs the dialog's click as user gesture). `url` pre-fills the
 * dialog (used by the "Try again" action of the error toast).
 */
export async function addAudioFromUrl(session, { url: initial = '' } = {}) {
  const url = await promptDialog({
    title: 'Add audio from a link',
    label: 'Direct link to an audio or video file (mp3, wav, m4a, ogg, mp4…). Its sound goes on a new audio clip at the playhead.',
    value: initial,
    placeholder: 'https://example.com/music.mp3',
    confirmLabel: 'Add audio',
  });
  const clean = (url || '').trim();
  if (!clean) return null;
  const t = session.time();
  const before = new Set(projectStore.get()?.mediaOrder || []);
  const tid = toast('Downloading audio…', { duration: 0 });
  try {
    const id = await importUrl(clean, { kind: 'audio' });
    const added = placeAsAudio([id], t);
    if (added.length) toast('Audio added to the timeline', { kind: 'success' });
    else toast('That file has no usable sound — it was added to the bin', { kind: 'warn' });
    return added[0] || null;
  } catch (e) {
    discardFailedImport(before, clean);
    toast(e.message || 'Could not import that link', {
      kind: 'error',
      duration: 9000,
      action: { label: 'Try again', run: () => addAudioFromUrl(session, { url: clean }) },
    });
    return null;
  } finally {
    dismissToast(tid);
  }
}

/**
 * importUrl() puts the item in the bin before downloading it: when the download fails, take that broken item out
 * again (silently — the "Import URL" step it recorded then simply undoes to the same state).
 */
function discardFailedImport(before, url) {
  const p = projectStore.get();
  if (!p) return;
  const failed = p.mediaOrder.filter((id) => !before.has(id) && p.media[id]?.sourceUrl === url && p.media[id].status === 'error');
  if (failed.length) projectStore.update((q) => M.removeMedia(q, failed), { history: false });
}

export function fitAudioToVideoEnd() {
  const p = projectStore.get();
  if (!p.tracks.video.length) {
    toast('Add video clips first — audio is trimmed to the end of the main track', { kind: 'info' });
    return;
  }
  const next = M.fitAudioToVideo(p);
  if (next === p || JSON.stringify(next.tracks.audio) === JSON.stringify(p.tracks.audio)) {
    toast('Audio already ends with the video', { kind: 'info' });
    return;
  }
  projectStore.update(() => next, { label: 'Fit audio to video' });
}

export function detachAudio(clipId) {
  let id = null;
  projectStore.update(
    (p) => {
      const r = Ops.detachAudio(p, clipId);
      id = r.id;
      return r.project;
    },
    { label: 'Detach audio' },
  );
  if (id) {
    setSelection([id]);
    toast('Sound moved to an audio lane (the clip is muted)', { kind: 'success' });
  } else toast('This clip has no sound to detach (or is speed-changed)', { kind: 'info' });
  return id;
}

/** Trims the selected clips (or the main-track clip under the playhead) so `edge` lands on the playhead. */
export function trimToPlayhead(session, edge) {
  const t = session.time();
  const p = projectStore.get();
  let ids = getSelection();
  if (!ids.length) {
    const under = M.videoItemsAt(M.layoutVideo(p.tracks.video), t);
    ids = under.length ? [under[under.length - 1].clip.id] : [];
  }
  if (!ids.length) {
    toast('Move the playhead over a clip to trim it', { kind: 'info' });
    return false;
  }
  let changed = false;
  projectStore.update(
    (q) => {
      let r = q;
      for (const id of ids) r = Ops.trimEdgeTo(r, id, edge, t);
      changed = r !== q;
      return r;
    },
    { label: edge === 'in' ? 'Trim start to playhead' : 'Trim end to playhead' },
  );
  if (!changed) toast('Put the playhead inside the clip to trim it', { kind: 'info' });
  return changed;
}

export function setTransitionAll(type, duration = M.DEFAULT_TRANSITION_DURATION) {
  projectStore.update(
    (p) => {
      const next = M.setAllTransitions(p, type ? { type, duration } : null);
      return Ops.sameTransitions(p, next) ? p : next;
    },
    { label: type ? 'Transition on every cut' : 'Remove all transitions' },
  );
}

/**
 * Shows a media item in the Edit tab's bin: opens the bin panel (or drawer) and asks the Edit view to select,
 * scroll to and flash the item (see EditView). Deliberately leaves uiStore.binSelection alone — that is the Clips
 * tab's selection.
 */
export function revealInBin(mediaId, session) {
  const p = projectStore.get();
  if (!p?.media[mediaId]) {
    toast('That media is no longer in the bin', { kind: 'info' });
    return;
  }
  session?.emit('showBin', { mediaId });
}

export const openInSource = (mediaId) => appEvents.emit('source.open', { mediaId });

/** Picks for "Add from Clips": the bin selection, else picked clips, else every visual clip (oldest first). */
export function clipsToAdd() {
  const p = projectStore.get();
  const ui = uiStore.get();
  if (!p) return { ids: [], what: 'none' };
  const usable = (id) => p.media[id] && p.media[id].kind !== 'audio' && p.media[id].status !== 'error';
  let ids = (ui.binSelection || []).filter(usable);
  if (ids.length) return { ids, what: 'selected' };
  ids = p.mediaOrder.filter((id) => usable(id) && p.media[id].flag === 'pick').reverse();
  if (ids.length) return { ids, what: 'picked' };
  ids = p.mediaOrder.filter((id) => usable(id) && p.media[id].flag !== 'reject').reverse();
  return { ids, what: ids.length ? 'all' : 'none' };
}

export function addFromClips() {
  const { ids, what } = clipsToAdd();
  if (!ids.length) {
    uiStore.set((s) => ({ ...s, tab: 'clips' }));
    return [];
  }
  const added = placeMedia(ids, { label: 'Add clips to timeline' });
  toast(`Added ${pluralize(added.length, what === 'picked' ? 'picked clip' : 'clip')} to the timeline`, { kind: 'success' });
  return added;
}

const canvasToBlob = (canvas, type) => (canvas.convertToBlob ? canvas.convertToBlob({ type }) : new Promise((r) => canvas.toBlob(r, type)));

/** Grabs the composited frame under the playhead: mode 'bin' | 'ingredient' | 'download' | 'copy'. */
export async function grabFrame(session, mode = 'bin') {
  const player = session.player;
  const p = projectStore.get();
  if (!player || !p) return null;
  if (!p.tracks.video.length && !p.tracks.text.length) {
    toast('Nothing to grab yet — add clips to the timeline first', { kind: 'info' });
    return null;
  }
  try {
    if (player.playing) player.pause();
    const t = session.time();
    // strict: never save a half-loaded frame or a "Media offline" placeholder as if it were the picture
    const canvas = await player.captureFrame({ strict: true });
    const blob = await canvasToBlob(canvas, 'image/png');
    if (!blob) throw new Error('encoding failed');
    const stamp = formatTime(t);
    if (mode === 'bin') {
      const id = await addBlobAsMedia(blob, { name: `Frame ${stamp}`, origin: 'frame', kind: 'image' });
      toast('Frame added to the bin', { kind: 'success', action: { label: 'Reveal', run: () => revealInBin(id, session) } });
      return id;
    }
    if (mode === 'ingredient') {
      const id = await addIngredient(blob, { name: `${p.name} · ${stamp}`, origin: 'frame' });
      toast('Frame saved to Ingredients', { kind: 'success', action: { label: 'Open', run: () => uiStore.set((s) => ({ ...s, tab: 'ingredients' })) } });
      return id;
    }
    if (mode === 'copy') {
      await copyImage(blob);
      toast('Frame copied to the clipboard', { kind: 'success' });
      return true;
    }
    const filename = sanitizeFilename(`${p.name} - frame ${stamp.replace(/[:.]/g, '-')}.png`);
    await downloadBlob(blob, filename);
    toast(`Frame saved as ${filename}`, { kind: 'success' });
    return true;
  } catch (e) {
    console.warn('[gis] grab frame failed', e);
    toast(`Could not grab the frame: ${e.message || e}`, { kind: 'error' });
    return null;
  }
}
