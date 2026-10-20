// Actions shared by the Clips tab (bin grid, page strip, source monitor, review mode) and BinCompact:
// flags & ratings, IN/OUT marks, timeline adds (honouring the marks), frame grabs, grok.com bridge calls, downloads,
// rename / remove (undoable), imports (with the "Import from a URL" dialog), "reveal in bin" and the frame-grab
// offer dialog.
import { html, useState, useEffect, useRef } from '../../../vendor/preact-htm.mjs';
import { projectStore, uiStore, createStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { bridge } from '../../core/bridge.js';
import { REQ } from '../../../shared/protocol.js';
import { slugify } from '../../../shared/grok-urls.js';
import { appEvents } from '../../core/app-state.js';
import { importFiles, importUrl, addBlobAsMedia, getMediaBlob, grabFrame, mediaFilename } from '../../core/media.js';
import { downloadBlob, copyText, copyImage, formatTime, formatDuration, pluralize, sleep } from '../../core/utils.js';
import { useStore } from '../hooks.js';
import { toast, confirmDialog, promptDialog, pickFiles, Modal, Button, Icon, cx } from '../kit.js';
import {
  setFlagOp,
  setRatingOp,
  toggledFlag,
  flagLabel,
  markedRange,
  mediaMarks,
  hasMarks,
  placeholderFixes,
  EMPTY_MARKS,
  displayTitle,
  isPromptName,
  snippet,
  urlProblem,
} from './bin-logic.js';

export const GROK_IMAGINE_URL = 'https://grok.com/imagine';
export const openGrokTab = () => window.open(GROK_IMAGINE_URL, '_blank', 'noopener');

/** One name (and tooltip) for "put this item's prompt in Grok's prompt box", wherever it is offered. */
export const SEND_PROMPT_LABEL = 'Send prompt to Grok';
export const SEND_PROMPT_HINT = "Put this prompt in Grok's prompt box to generate a new take";

const media = (id) => projectStore.get()?.media[id] || null;
const failed = (m) => m?.status === 'error';

// ---------------------------------------------------------------------------------------------------------
// Reveal in bin. appEvents 'bin.reveal' {mediaId} shows an item in the bin views that are on screen (BinCompact in
// the Edit tab, the Clips bin while its tab is active): the search / filters that hide it are cleared, it is
// selected, scrolled into view and flashed. A request is kept for a moment so that a bin panel which is still
// opening (the Edit tab's drawer) handles it when it mounts.
// ---------------------------------------------------------------------------------------------------------

const REVEAL_TTL = 2000;
const revealStore = createStore(null); // {mediaId, n, at}
let revealSeq = 0;
appEvents.on('bin.reveal', ({ mediaId } = {}) => {
  if (mediaId && media(mediaId)) revealStore.set(() => ({ mediaId, n: ++revealSeq, at: Date.now() }));
});

/** Shows a media item in the bin on screen (see above). */
export const revealInBin = (mediaId) => appEvents.emit('bin.reveal', { mediaId });

/**
 * Calls onReveal(mediaId) for every 'bin.reveal' that arrives while shown() is true. pending: also handle a request
 * made shortly before this component mounted (a bin panel opened to show the item).
 */
export function useBinReveal(onReveal, { shown = () => true, pending = true } = {}) {
  const r = useStore(revealStore, (s) => s, Object.is);
  const handled = useRef(pending ? 0 : r?.n || 0);
  const latest = useRef(null);
  latest.current = { onReveal, shown };
  useEffect(() => {
    if (!r || r.n <= handled.current) return;
    handled.current = r.n;
    if (Date.now() - r.at > REVEAL_TTL || !media(r.mediaId) || !latest.current.shown()) return;
    latest.current.onReveal(r.mediaId);
  }, [r]);
}

// ---------------------------------------------------------------------------------------------------------
// IN/OUT marks. Stored on the media item (`media.marks = {in, out}`), so they are undoable like any edit, travel
// with the project (export, duplicate) and are used by every "add to timeline". uiStore.sourceIn / sourceOut
// mirror the marks of the item open in the source monitor, in both directions.
// ---------------------------------------------------------------------------------------------------------

/** IN/OUT marks of a media item: {in, out}, nulls when unset. */
export const getMarks = (id, project = projectStore.get()) => mediaMarks(project?.media[id]);

/**
 * Sets the IN/OUT marks of a media item as an undoable edit. label: the undo label; merge: one key per drag
 * gesture so a handle drag is a single undo step. No-op when nothing changes.
 */
export function setMarks(id, marks, { label = 'Set IN/OUT', merge = null } = {}) {
  const p = projectStore.get();
  if (!id || !p?.media[id]) return;
  const next = { in: Number.isFinite(marks?.in) ? marks.in : null, out: Number.isFinite(marks?.out) ? marks.out : null };
  const cur = mediaMarks(p.media[id]);
  if (cur.in === next.in && cur.out === next.out) return;
  const value = next.in == null && next.out == null ? null : next;
  projectStore.update((q) => M.updateMedia(q, id, { marks: value }), { label, merge });
}

export const clearMarks = (id) => setMarks(id, EMPTY_MARKS, { label: 'Clear IN/OUT' });

// Project -> monitor: undo/redo (or any edit) of the open item's marks shows up in uiStore.
projectStore.subscribe((p) => {
  const s = uiStore.get();
  if (!p || !s.sourceMediaId || !p.media[s.sourceMediaId]) return;
  const k = mediaMarks(p.media[s.sourceMediaId]);
  if (k.in !== s.sourceIn || k.out !== s.sourceOut) uiStore.set((st) => ({ ...st, sourceIn: k.in, sourceOut: k.out }));
});

// Monitor -> project: marks written straight into uiStore for the open item (by another panel or a test) are kept.
uiStore.subscribe((s, prev) => {
  if (!s.sourceMediaId || s.sourceMediaId !== prev.sourceMediaId) return;
  if (s.sourceIn !== prev.sourceIn || s.sourceOut !== prev.sourceOut) setMarks(s.sourceMediaId, { in: s.sourceIn, out: s.sourceOut });
});

/** Ranges option for appendMediaToTimeline built from the marks of each id. */
export function rangesFor(ids) {
  const ranges = {};
  for (const id of ids) {
    const m = media(id);
    const k = mediaMarks(m);
    const r = markedRange(m, k.in, k.out);
    if (r) ranges[id] = r;
  }
  return ranges;
}

// ---------------------------------------------------------------------------------------------------------
// Source monitor
// ---------------------------------------------------------------------------------------------------------

/** Opens a media item in the source monitor (with its marks); select: also make it the bin selection. */
export function openInSource(id, { select = false } = {}) {
  const m = media(id);
  if (!m) return;
  const marks = mediaMarks(m);
  uiStore.set((s) => ({
    ...s,
    sourceMediaId: id,
    sourceIn: marks.in,
    sourceOut: marks.out,
    ...(select ? { binSelection: [id] } : {}),
  }));
}

export const closeSource = () => uiStore.set((s) => (s.sourceMediaId ? { ...s, sourceMediaId: null } : s));

/** Opens an item in the Clips tab source monitor from anywhere (the shell switches to the Clips tab). */
export const requestSourceOpen = (id) => id && appEvents.emit('source.open', { mediaId: id });

// Other panels (BinCompact in the Edit tab, prompts…) open items here; the shell switches to the Clips tab.
// Registered at module load so the request works even before the Clips view has been mounted.
appEvents.on('source.open', ({ mediaId } = {}) => mediaId && openInSource(mediaId, { select: true }));

// ---------------------------------------------------------------------------------------------------------
// Flags & ratings
// ---------------------------------------------------------------------------------------------------------

export function flagMedia(ids, flag) {
  const list = ids.filter((id) => media(id));
  if (!list.length) return;
  projectStore.update((p) => setFlagOp(p, list, flag), { label: flagLabel(flag, list.length) });
}

/** Pick / reject toggle: clears the flag when every target already has it. */
export function toggleFlag(ids, flag) {
  flagMedia(ids, toggledFlag(projectStore.get(), ids, flag));
}

export function rateMedia(ids, rating) {
  const list = ids.filter((id) => media(id));
  if (!list.length) return;
  projectStore.update((p) => setRatingOp(p, list, rating), { label: rating ? `Rate ${rating}★` : 'Clear rating' });
}

// ---------------------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------------------

// Clips placed before their media was probed have a stand-in length; core widens them (autoOut) when the probe
// finishes. An undo / redo that restores a snapshot from before that brings the stand-in back with nothing left to
// widen it: repair such clips as a background update ({history: false}), however they got on the timeline.
let placeholderFixQueued = false;
projectStore.subscribe((p) => {
  if (!p || placeholderFixQueued || !placeholderFixes(p).length) return;
  placeholderFixQueued = true;
  queueMicrotask(() => {
    placeholderFixQueued = false;
    projectStore.update(
      (q) => {
        let r = q;
        for (const f of placeholderFixes(q)) r = M.updateClip(r, f.id, { out: f.out }); // also clears autoOut
        return r;
      },
      { history: false },
    );
  });
});

const revealAction = (clipId) => (clipId ? { label: 'Show', run: () => appEvents.emit('timeline.reveal', { clipId }) } : null);
const isPending = (m) => m.status !== 'ready' && m.kind !== 'image';

function addedMessage({ list, p, ranges, index, skipped }) {
  const pending = list.filter((id) => isPending(p.media[id]));
  const trimmed = list.filter((id) => ranges[id]);
  let msg;
  if (list.length === 1) {
    const id = list[0];
    const r = ranges[id];
    msg = `${index != null ? 'Inserted' : 'Added'} "${snippet(displayTitle(p.media[id]), 40)}" ${index != null ? 'at the playhead' : 'to the timeline'}`;
    if (r) msg += ` · marked range ${formatDuration((r.out ?? p.media[id].duration) - r.in)}`;
    if (pending.length) msg += ' · still downloading, its length updates when it finishes';
  } else {
    msg = `${index != null ? 'Inserted' : 'Added'} ${pluralize(list.length, 'item')} ${index != null ? 'at the playhead' : 'to the timeline'}`;
    if (trimmed.length) msg += ` · ${trimmed.length} trimmed to their IN/OUT marks`;
    if (pending.length) msg += ` · ${pending.length} still downloading`;
  }
  if (skipped.length) msg += ` · skipped ${pluralize(skipped.length, 'item')} that failed to download`;
  return msg;
}

/**
 * Adds media to the timeline in the given order: videos/images onto the main track (at `index`, default end),
 * audio onto a free audio lane at the playhead. ranges: {[id]: {in, out}} (defaults to each item's marks).
 * Items that failed to download are skipped (with a warning). Returns the new clip ids.
 */
export function addToTimeline(ids, { ranges = rangesFor(ids), index, label = 'Add to timeline', quiet = false } = {}) {
  const p = projectStore.get();
  const known = ids.filter((id) => p?.media[id]);
  const skipped = known.filter((id) => failed(p.media[id]));
  const list = known.filter((id) => !failed(p.media[id]));
  if (!list.length) {
    if (skipped.length) {
      toast(skipped.length === 1 ? "Can't add it: this item failed to download. Retry it first." : `Can't add: ${pluralize(skipped.length, 'item')} failed to download. Retry them first.`, {
        kind: 'warn',
      });
    }
    return [];
  }
  const visual = list.filter((id) => p.media[id].kind !== 'audio');
  const audio = list.filter((id) => p.media[id].kind === 'audio');
  const playhead = uiStore.get().playhead || 0;
  let clipIds = [];
  projectStore.update(
    (q) => {
      let r = q;
      if (visual.length) {
        const res = M.appendMediaToTimeline(r, visual, { index, ranges });
        r = res.project;
        clipIds = [...res.ids];
      }
      for (const id of audio) {
        const res = M.addAudioClip(r, id, { start: playhead, ...(ranges[id] || {}) });
        r = res.project;
        if (res.id) clipIds.push(res.id);
      }
      return r;
    },
    { label },
  );
  if (!quiet || skipped.length) {
    toast(addedMessage({ list, p, ranges, index, skipped }), { kind: skipped.length ? 'warn' : 'success', duration: skipped.length ? 5000 : 3200, action: revealAction(clipIds[0]) });
  }
  return clipIds;
}

/** Inserts media at the main-track boundary nearest to the timeline playhead. */
export function insertAtPlayhead(ids, { ranges = rangesFor(ids) } = {}) {
  const p = projectStore.get();
  if (!p) return [];
  const index = M.insertionIndexAt(M.layoutVideo(p.tracks.video), uiStore.get().playhead || 0);
  return addToTimeline(ids, { ranges, index, label: 'Insert at playhead' });
}

/** True when the media can feed an audio clip (audio files, videos with sound or not probed yet; not failed ones). */
export const canBeAudio = (m) => !!m && !failed(m) && (m.kind === 'audio' || (m.kind === 'video' && (m.status !== 'ready' || m.hasAudio)));

/** Adds a video's sound (or an audio file) as an audio clip at the timeline playhead. */
export function addAsAudio(id, range = rangesFor([id])[id]) {
  const m = media(id);
  if (!m) return null;
  if (!canBeAudio(m)) {
    toast(failed(m) ? 'This item failed to download. Retry it first.' : m.kind === 'image' ? 'Images have no sound' : 'This clip has no sound', { kind: 'warn' });
    return null;
  }
  const start = uiStore.get().playhead || 0;
  let clipId = null;
  projectStore.update(
    (p) => {
      const res = M.addAudioClip(p, id, { start, ...(range || {}) });
      clipId = res.id;
      return res.project;
    },
    { label: 'Add audio clip' },
  );
  toast(`Sound added to the audio track at ${formatTime(start)}${isPending(m) ? ' · still downloading' : ''}`, { kind: 'success', action: revealAction(clipId) });
  return clipId;
}

// ---------------------------------------------------------------------------------------------------------
// grok.com bridge
// ---------------------------------------------------------------------------------------------------------

/** Switches auto-add of new Grok videos ('autoCollect') or images ('autoCollectImages') and says what it does. */
export function setAutoCollect(key, on) {
  uiStore.set((s) => (s[key] === on ? s : { ...s, [key]: on }));
  if (on) toast(key === 'autoCollect' ? 'New Grok videos will be added to the bin automatically' : 'New Grok images will be added to the bin automatically', { kind: 'info' });
}

/** True when grok.com is connected; otherwise shows how to connect (one toast) and returns false. */
function requireGrok() {
  if (bridge.connected) return true;
  toast('Open grok.com in a tab first: the studio talks to your latest Grok tab.', { kind: 'warn', duration: 5000, action: { label: 'Open Grok', run: openGrokTab } });
  return false;
}

export async function copyPrompt(text) {
  if (!text) return toast('This item has no prompt', { kind: 'warn' });
  if (await copyText(text)) toast('Prompt copied', { kind: 'success' });
  else toast('Could not copy to the clipboard', { kind: 'error' });
}

/** Places a prompt in the grok.com composer (replacing what's there). */
export async function sendPromptToGrok(text, { submit = false } = {}) {
  if (!text) return toast('This item has no prompt', { kind: 'warn' });
  if (!requireGrok()) return;
  try {
    const res = await bridge.request(REQ.COMPOSER_INSERT, { text, mode: 'replace', submit });
    if (res && res.ok === false) throw new Error(res.error || 'composer not found');
    toast(submit ? 'Prompt sent to Grok' : "Prompt inserted in Grok's prompt box", { kind: 'success' });
  } catch (e) {
    toast(`Could not reach the Grok composer: ${e.message || e}`, { kind: 'error', duration: 6000, action: { label: 'Copy instead', run: () => copyPrompt(text) } });
  }
}

/**
 * Scrolls grok.com to a detected media element and flashes it. key: PageMedia key; url: the media URL (lets the
 * page find the element by its src when the key is unknown there); pageUrl: offered when it isn't on the page.
 */
export async function revealKeyOnGrok(key, { url = null, pageUrl = null } = {}) {
  if (!key) return toast('This item was not collected from grok.com', { kind: 'warn' });
  if (!requireGrok()) return;
  try {
    const res = await bridge.request(REQ.PAGE_REVEAL, { key, url });
    if (res && res.ok === false) throw new Error('not on the current page');
  } catch {
    toast("It's not on the current grok.com page.", {
      kind: 'warn',
      action: pageUrl && /^https:\/\/grok\.com\//.test(pageUrl) ? { label: 'Open its page', run: () => window.open(pageUrl, '_blank', 'noopener') } : null,
    });
  }
}

export const revealOnGrok = (id) => {
  const m = media(id);
  return m && revealKeyOnGrok(m.pageKey, { url: m.sourceUrl, pageUrl: m.pageUrl });
};

/** Uploads an image blob into the grok.com composer. Throws when the page refuses it. */
async function attachToComposer(blob, name) {
  const res = await bridge.request(REQ.COMPOSER_ATTACH, { blob: new File([blob], name, { type: blob.type }), name }, { timeout: 30000 });
  if (res && res.ok === false) throw new Error(res.error || 'the composer did not accept the image');
}

/** Grabs the last frame (or the OUT frame) of a clip and attaches it to the grok.com composer. */
export async function lastFrameToGrok(id, { time = null } = {}) {
  const m = media(id);
  if (!m) return;
  if (m.status !== 'ready') return toast('Wait until the clip has downloaded', { kind: 'warn' });
  if (!requireGrok()) return;
  try {
    const fps = m.fps || 30;
    const t = time ?? (m.kind === 'video' ? Math.max(0, (m.duration || 0) - 0.5 / fps) : 0);
    const blob = await grabFrame(id, t, { type: 'image/png' });
    await attachToComposer(blob, `${slugify(m.prompt || m.name, 40)}-last-frame.png`);
    toast('Frame attached to the Grok composer. Describe how the shot continues, then generate.', { kind: 'success', duration: 5000 });
  } catch (e) {
    toast(`Could not attach the frame to Grok: ${e.message || e}`, { kind: 'error', duration: 6000 });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Frames → bin / Ingredients / clipboard / file
// ---------------------------------------------------------------------------------------------------------

/** Name for a still taken from an item: images keep their title; video frames get the time they were taken at. */
export const frameName = (m, t) => (m?.kind === 'image' ? snippet(displayTitle(m), 60) : `${snippet(displayTitle(m), 40)} · frame ${formatTime(t)}`);

/**
 * Sends an image blob to the Ingredients library. The Ingredients tab handles 'ingredient.add': it confirms with a
 * toast (with "Show") once the image is stored, or says why it could not be added — so no toast here.
 */
export function saveAsIngredient(blob, { name, sourceUrl = null, prompt = null } = {}) {
  appEvents.emit('ingredient.add', { blob, name, origin: 'frame', sourceUrl, prompt });
}

/** Grabs a frame (or takes the image itself) and saves it straight to Ingredients (bin context menu). */
export async function grabFrameToIngredients(id, time) {
  const m = media(id);
  if (!m) return;
  try {
    const blob = await grabFrame(id, time, { type: 'image/png' });
    saveAsIngredient(blob, { name: frameName(m, time), sourceUrl: m.sourceUrl, prompt: m.prompt });
  } catch (e) {
    toast(`Could not grab the frame: ${e.message || e}`, { kind: 'error' });
  }
}

const frameOfferStore = createStore(null); // {mediaId, time, blob, url, name, prompt, sourceUrl}

/** Grabs a frame and opens the "what to do with it" dialog (bin / Ingredients / clipboard / download / Grok). */
export async function grabFrameFlow(id, time) {
  const m = media(id);
  if (!m) return;
  if (m.status !== 'ready') return toast('Wait until the media has downloaded', { kind: 'warn' });
  try {
    const blob = await grabFrame(id, time, { type: 'image/png' });
    const prev = frameOfferStore.get();
    if (prev) URL.revokeObjectURL(prev.url);
    frameOfferStore.set(() => ({ mediaId: id, time, blob, url: URL.createObjectURL(blob), name: frameName(m, time), prompt: m.prompt, sourceUrl: m.sourceUrl }));
  } catch (e) {
    toast(`Could not grab the frame: ${e.message || e}`, { kind: 'error' });
  }
}

export function closeFrameOffer() {
  const cur = frameOfferStore.get();
  if (cur) URL.revokeObjectURL(cur.url);
  frameOfferStore.set(() => null);
}

/** Dialog shown after "Grab frame"; mount once (ClipsView does). */
export function FrameOfferHost() {
  const offer = useStore(frameOfferStore, (s) => s, Object.is);
  useEffect(() => () => closeFrameOffer(), []);
  // Keyed by the grab so per-frame state (done marks, size) starts fresh without a racy reset effect.
  return offer ? html`<${FrameOffer} key=${offer.url} offer=${offer} />` : null;
}

function FrameOffer({ offer }) {
  const [done, setDone] = useState({});
  const [dims, setDims] = useState(null);
  // An action returns false when it didn't happen (it already told the user why): no check mark then.
  const run = async (k, fn) => {
    try {
      if ((await fn()) === false) return;
      setDone((d) => ({ ...d, [k]: true }));
    } catch (e) {
      toast(e.message || String(e), { kind: 'error' });
    }
  };
  const actions = [
    {
      k: 'bin',
      icon: 'film',
      label: 'Add to bin',
      hint: 'As an image clip',
      fn: async () => {
        const id = await addBlobAsMedia(offer.blob, { name: offer.name, origin: 'frame', kind: 'image', prompt: offer.prompt });
        toast('Frame added to the bin', { kind: 'success', action: { label: 'Show', run: () => revealInBin(id) } });
      },
    },
    { k: 'ing', icon: 'images', label: 'Save as ingredient', hint: 'Reference image library', fn: () => saveAsIngredient(offer.blob, { name: offer.name, sourceUrl: offer.sourceUrl, prompt: offer.prompt }) },
    {
      k: 'grok',
      icon: 'send',
      label: 'Attach to Grok',
      hint: 'Upload into the composer',
      fn: async () => {
        if (!requireGrok()) return false;
        try {
          await attachToComposer(offer.blob, `${slugify(offer.name, 40)}.png`);
        } catch (e) {
          throw new Error(`Could not attach the frame to Grok: ${e.message || e}`);
        }
        toast('Frame attached to the Grok composer', { kind: 'success' });
      },
    },
    {
      k: 'copy',
      icon: 'copy',
      label: 'Copy image',
      hint: 'PNG to the clipboard',
      fn: async () => {
        await copyImage(offer.blob);
        toast('Image copied', { kind: 'success' });
      },
    },
    { k: 'dl', icon: 'download', label: 'Download PNG', hint: 'Save to your computer', fn: () => downloadBlob(offer.blob, `${slugify(offer.name, 60)}.png`) },
  ];
  return html`<${Modal}
    title="Frame grabbed"
    width=${600}
    class="clips-frame-modal"
    onClose=${closeFrameOffer}
    footer=${html`<span class="muted small">${dims ? `${dims.w}×${dims.h} · ` : ''}at ${formatTime(offer.time)}</span><span class="spacer"></span><${Button} kind="primary" onClick=${closeFrameOffer}>Done<//>`}
  >
    <div class="clips-frame-body">
      <div class="clips-frame-preview checker">
        <img src=${offer.url} alt="Grabbed frame" onLoad=${(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      </div>
      <div class="clips-frame-actions">
        ${actions.map(
          (a) => html`<button type="button" key=${a.k} class=${cx('clips-frame-action', done[a.k] && 'is-done')} onClick=${() => run(a.k, a.fn)} data-action=${a.k}>
            <span class="clips-frame-action-icon"><${Icon} name=${done[a.k] ? 'check' : a.icon} size=${16} /></span>
            <span class="clips-frame-action-text"><span class="clips-frame-action-label">${a.label}</span><span class="clips-frame-action-hint">${a.hint}</span></span>
          </button>`,
        )}
      </div>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------------
// Files: download, rename, remove, import
// ---------------------------------------------------------------------------------------------------------

export async function downloadMedia(ids) {
  let ok = 0;
  let missing = 0;
  for (const id of ids) {
    const m = media(id);
    if (!m) continue;
    const blob = await getMediaBlob(id);
    if (!blob) {
      missing++;
      continue;
    }
    try {
      await downloadBlob(blob, mediaFilename(m));
      ok++;
    } catch (e) {
      console.warn('[gis] download failed', id, e);
      missing++;
    }
    if (ids.length > 1) await sleep(150); // let the browser keep up with several downloads
  }
  if (missing) toast(`${pluralize(missing, 'file')} could not be downloaded${ok ? ` (${ok} saved)` : ''}: not downloaded into the studio yet.`, { kind: 'error' });
  else if (ok > 1) toast(`Downloading ${ok} files`, { kind: 'success' });
}

/**
 * Renames an item. A name becomes the card title (the prompt moves to the second line); an empty name on an item
 * with a prompt goes back to showing the prompt.
 */
export async function renameMedia(id) {
  const m = media(id);
  if (!m) return;
  const custom = !isPromptName(m);
  const name = await promptDialog({
    title: 'Rename',
    label: m.prompt ? 'Name (leave empty to show the prompt as the title)' : 'Name',
    value: custom ? m.name : '',
    placeholder: snippet(displayTitle(m), 60),
    confirmLabel: 'Rename',
  });
  if (name == null) return;
  let clean = name.trim();
  if (!clean) {
    if (!m.prompt || !custom) return;
    clean = snippet(m.prompt, 48); // a prompt-derived name, like the ones grok imports get
  }
  if (clean === m.name) return;
  projectStore.update((p) => M.updateMedia(p, id, { name: clean }), { label: 'Rename' });
}

/**
 * Removes media from the bin (and their timeline clips) in one step — no confirmation: the toast offers Undo and
 * Ctrl+Z restores everything. opts.confirm asks first (bulk clean-ups). Returns true if removed.
 */
export async function removeFromBin(ids, { confirm = false } = {}) {
  const p = projectStore.get();
  const list = ids.filter((id) => p?.media[id]);
  if (!list.length) return false;
  const uses = list.reduce((n, id) => n + M.mediaUsage(p, id).length, 0);
  const what = list.length === 1 ? `"${snippet(displayTitle(p.media[list[0]]), 60)}"` : `These ${list.length} items`;
  if (confirm) {
    const ok = await confirmDialog({
      title: list.length === 1 ? 'Delete from bin?' : `Delete ${list.length} items from the bin?`,
      message: `${what} will be removed from the bin${uses ? `, together with ${pluralize(uses, 'clip')} using ${list.length === 1 ? 'it' : 'them'} on the timeline` : ''}.\nYou can undo this with Ctrl+Z.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return false;
  }
  const label = list.length === 1 ? 'Delete from bin' : `Delete ${list.length} items`;
  projectStore.update((q) => M.removeMedia(q, list), { label });
  const gone = new Set(list);
  uiStore.set((s) => ({ ...s, binSelection: s.binSelection.filter((id) => !gone.has(id)), ...(gone.has(s.sourceMediaId) ? { sourceMediaId: null } : {}) }));
  toast(`Deleted ${list.length === 1 ? snippet(displayTitle(p.media[list[0]]), 40) : pluralize(list.length, 'item')}${uses ? ` and ${pluralize(uses, 'timeline clip')}` : ''}`, {
    duration: 7000,
    action: { label: 'Undo', run: () => projectStore.undoLabel() === label && projectStore.undo() },
  });
  return true;
}

/** Bin clean-ups: ids of rejected items, of items on no timeline track, and of failed downloads. */
export function cleanupCandidates(p = projectStore.get()) {
  const ids = p?.mediaOrder || [];
  const used = new Set();
  for (const track of Object.values(p?.tracks || {})) for (const c of track || []) if (c.mediaId) used.add(c.mediaId);
  return {
    rejected: ids.filter((id) => p.media[id]?.flag === 'reject'),
    unused: ids.filter((id) => !used.has(id)),
    failed: ids.filter((id) => p.media[id]?.status === 'error'),
  };
}

const SUPPORTED_FILE = /\.(mp4|m4v|webm|mov|mkv|jpe?g|png|webp|gif|avif|mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;

/** Imports local files (picker when none given). Returns the new media ids. */
export async function importFilesFlow(files = null) {
  const picked = files || (await pickFiles({ accept: 'video/*,image/*,audio/*', multiple: true }));
  if (!picked.length) return [];
  const supported = picked.filter((f) => /^(video|image|audio)\//.test(f.type) || SUPPORTED_FILE.test(f.name));
  if (!supported.length) {
    toast('Those files are not videos, images or audio', { kind: 'error' });
    return [];
  }
  if (supported.length < picked.length) toast(`Skipped ${pluralize(picked.length - supported.length, 'unsupported file')}`, { kind: 'warn' });
  try {
    const ids = await importFiles(supported);
    const bad = ids.filter((id) => failed(media(id)));
    if (bad.length) toast(`${pluralize(bad.length, 'file')} could not be read: ${media(bad[0])?.error || 'unsupported media'}`, { kind: 'error', duration: 6000 });
    else if (ids.length) toast(`Imported ${pluralize(ids.length, 'file')}`, { kind: 'success', action: { label: 'Show', run: () => revealInBin(ids[0]) } });
    return ids;
  } catch (e) {
    toast(`Import failed: ${e.message || e}`, { kind: 'error' });
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Import from a URL. The dialog checks the link before it closes, so a typo never loses what was typed; a download
// that fails takes its broken item out of the bin again and offers "Try again", which reopens the dialog with the
// link and the reason. The import starts in the dialog's submit handler: the host-permission prompt needs that
// user gesture.
// ---------------------------------------------------------------------------------------------------------

const urlDialogStore = createStore(null); // {value, error, resolve, n}
let urlDialogSeq = 0;

/**
 * Asks for a link and imports it into the bin. Resolves with the new media id, or null when cancelled or failed.
 * url / error pre-fill the dialog ("Try again"). UrlImportHost must be mounted (ClipsView does it).
 */
export function importUrlFlow({ url = '', error = null } = {}) {
  closeUrlImport();
  return new Promise((resolve) => urlDialogStore.set(() => ({ value: String(url || ''), error: error || null, resolve, n: ++urlDialogSeq })));
}

/** Closes the URL dialog (its promise resolves with null). */
export function closeUrlImport() {
  const cur = urlDialogStore.get();
  if (!cur) return;
  urlDialogStore.set(() => null);
  cur.resolve(null);
}

/** importUrl() adds the item before downloading it: a failed import is taken out again (no undo step). */
function discardFailedImport(before, url) {
  const p = projectStore.get();
  if (!p) return;
  const broken = p.mediaOrder.filter((id) => !before.has(id) && p.media[id]?.sourceUrl === url && failed(p.media[id]));
  if (!broken.length) return;
  projectStore.update((q) => M.removeMedia(q, broken), { history: false });
  uiStore.set((s) => (broken.includes(s.sourceMediaId) ? { ...s, sourceMediaId: null } : s));
}

async function runUrlImport(url) {
  const before = new Set(projectStore.get()?.mediaOrder || []);
  try {
    const id = await importUrl(url);
    toast('Imported into the bin', { kind: 'success', action: { label: 'Show', run: () => revealInBin(id) } });
    return id;
  } catch (e) {
    discardFailedImport(before, url);
    const reason = e?.message || String(e);
    toast(`Could not import that link: ${reason}`, { kind: 'error', duration: 9000, action: { label: 'Try again', run: () => importUrlFlow({ url, error: reason }) } });
    return null;
  }
}

function UrlImportDialog({ dialog }) {
  const [value, setValue] = useState(dialog.value);
  const [error, setError] = useState(dialog.error);
  const inputRef = useRef(null);
  // Reopened by "Try again": the link is selected, ready to be fixed or re-sent.
  useEffect(() => {
    if (dialog.value) inputRef.current?.select();
  }, []);
  const submit = (e) => {
    e.preventDefault();
    const clean = value.trim();
    const problem = urlProblem(clean);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    urlDialogStore.set(() => null);
    runUrlImport(clean).then(dialog.resolve);
  };
  return html`<${Modal} title="Import from a URL" width=${460} class="clips-url-modal" onClose=${closeUrlImport}>
    <form class="clips-url-form" onSubmit=${submit} novalidate>
      <label class="field-label" for="clips-url-input">Link to a video, image or audio file (mp4, webm, jpg, png, mp3, wav…)</label>
      <input
        id="clips-url-input"
        ref=${inputRef}
        type="url"
        class=${cx('text-field', 'clips-url-input', error && 'is-invalid')}
        value=${value}
        placeholder="https://…"
        spellcheck="false"
        autocomplete="off"
        data-autofocus="true"
        aria-invalid=${error ? 'true' : 'false'}
        aria-describedby=${error ? 'clips-url-error' : undefined}
        onInput=${(e) => {
          setValue(e.currentTarget.value);
          if (error) setError(null);
        }}
      />
      ${error && html`<div class="clips-url-error" id="clips-url-error" role="alert"><${Icon} name="alert" size=${13} /><span>${error}</span></div>`}
      <div class="modal-footer modal-footer-inline">
        <${Button} kind="ghost" onClick=${closeUrlImport}>Cancel<//>
        <button type="submit" class="btn btn-primary btn-md"><span class="btn-label">Import</span></button>
      </div>
    </form>
  <//>`;
}

/** Host of the "Import from a URL" dialog; mount once (ClipsView does). */
export function UrlImportHost() {
  const d = useStore(urlDialogStore, (s) => s, Object.is);
  useEffect(() => () => closeUrlImport(), []);
  return d ? html`<${UrlImportDialog} key=${d.n} dialog=${d} />` : null;
}

// ---------------------------------------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------------------------------------

/**
 * Items for a bin item's context menu (kit showMenu format). ids: the items the menu acts on (the selection when
 * the clicked card is part of it). frameTime: time used by "Grab frame" (e.g. the hover-scrub position).
 * extra: items inserted after the opening ones (e.g. ClipsView's "Review from here").
 */
export function mediaMenuItems(id, { ids = [id], frameTime = 0, extra = [] } = {}) {
  const m = media(id);
  if (!m) return [];
  const multi = ids.length > 1;
  const n = ids.length;
  const p = projectStore.get();
  const flagOf = (f) => ids.every((x) => p.media[x]?.flag === f);
  const allFailed = ids.every((x) => failed(p.media[x]));
  const marked = ids.filter((x) => hasMarks(p.media[x]));
  return [
    { header: multi ? `${n} items` : snippet(displayTitle(m), 30) },
    // Through the app event: from the Edit tab this also switches to the Clips tab.
    !multi && { label: 'Open in source monitor', icon: 'maximize', shortcut: 'enter', onClick: () => requestSourceOpen(id) },
    { label: multi ? `Add ${n} to timeline` : 'Add to timeline', icon: 'plus', shortcut: 'e', disabled: allFailed, onClick: () => addToTimeline(ids) },
    !multi && m.kind !== 'image' && { label: 'Add as audio clip', icon: 'music', disabled: !canBeAudio(m), onClick: () => addAsAudio(id) },
    m.kind !== 'audio' && {
      label: multi ? `Add ${n} as overlays at the playhead` : 'Add as overlay (picture in picture)',
      icon: 'layers',
      disabled: allFailed,
      // Loaded on demand: the Edit tab's actions module is not needed for the bin.
      onClick: () => import('../edit/actions.js').then((A) => A.placeAsOverlay(ids, uiStore.get().playhead || 0)),
    },
    !multi &&
      m.kind !== 'audio' && {
        label: m.kind === 'image' ? 'Copy to Ingredients' : 'Grab frame → Ingredients',
        icon: m.kind === 'image' ? 'images' : 'camera',
        disabled: m.status !== 'ready',
        onClick: () => grabFrameToIngredients(id, frameTime),
      },
    ...extra,
    marked.length > 0 && { label: marked.length > 1 ? `Clear IN/OUT marks (${marked.length})` : 'Clear IN/OUT marks', icon: 'scissors', onClick: () => clearMarksOf(marked) },
    '-',
    // A checked item shows the check mark in place of its icon.
    { label: 'Pick', icon: flagOf('pick') ? null : 'flag', shortcut: 'p', checked: flagOf('pick'), onClick: () => flagMedia(ids, 'pick') },
    { label: 'Reject', icon: flagOf('reject') ? null : 'x', shortcut: 'x', checked: flagOf('reject'), onClick: () => flagMedia(ids, 'reject') },
    { label: 'Unflag', icon: 'minus', shortcut: 'u', onClick: () => flagMedia(ids, null) },
    '-',
    !multi && { label: 'Copy prompt', icon: 'copy', disabled: !m.prompt, onClick: () => copyPrompt(m.prompt) },
    !multi && { label: SEND_PROMPT_LABEL, icon: 'send', disabled: !m.prompt, onClick: () => sendPromptToGrok(m.prompt) },
    !multi && { label: 'Reveal on grok.com', icon: 'target', disabled: !m.pageKey, onClick: () => revealOnGrok(id) },
    !multi && '-',
    { label: multi ? `Download ${n} originals` : 'Download original', icon: 'download', onClick: () => downloadMedia(ids) },
    !multi && { label: 'Rename…', icon: 'edit', onClick: () => renameMedia(id) },
    { label: multi ? `Delete ${n} from bin` : 'Delete from bin', icon: 'trash', danger: true, shortcut: 'delete', onClick: () => removeFromBin(ids) },
  ];
}

/** Clears the marks of several items in one undo step. */
function clearMarksOf(ids) {
  projectStore.update(
    (p) => {
      let q = p;
      for (const id of ids) if (hasMarks(q.media[id])) q = M.updateMedia(q, id, { marks: null });
      return q;
    },
    { label: ids.length > 1 ? `Clear IN/OUT of ${ids.length} items` : 'Clear IN/OUT' },
  );
}
