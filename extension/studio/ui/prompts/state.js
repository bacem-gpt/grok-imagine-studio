// Prompts tab: view state, per-user preferences and actions (send to Grok, import, export, assemble, queue).
// Module-level on purpose: the 'prompts.importText' app event and grok.com "composer submitted" events must be handled
// even before the tab has been opened, and the batch queue keeps running while other tabs are shown.

import { createStore, projectStore, uiStore, pageStore, libraryStore } from '../../core/store.js';
import { bridge } from '../../core/bridge.js';
import { REQ, EVT } from '../../../shared/protocol.js';
import { appEvents } from '../../core/app-state.js';
import { attachIngredientsToGrok } from '../../core/ingredients.js';
import { onMediaEvent } from '../../core/media.js';
import { copyText, debounce, downloadBlob, pluralize } from '../../core/utils.js';
import { slugify } from '../../../shared/grok-urls.js';
import { toast, dismissToast, confirmDialog } from '../kit.js';
import * as S from '../../prompts/shots.js';
import { expandTokens } from '../../prompts/tokens.js';
import { exportPromptList } from '../../prompts/lists.js';
import { getBible } from '../../prompts/library.js';
import { promptSimilarity } from '../../prompts/match.js';
import { createQueueRunner } from '../../prompts/queue.js';
import { collapseSpaces, normalizeForMatch } from '../../prompts/text.js';
import { autoPhrasePrompt } from '../../prompts/phrases.js';

// ---------------------------------------------------------------------------------------------------------
// Preferences (per browser profile; conveniences only, never project data)
// ---------------------------------------------------------------------------------------------------------

const PREFS_KEY = 'gis:prompts:prefs';
const PREFS_VERSION = 2;
const DEFAULT_PREFS = {
  v: PREFS_VERSION,
  attachRefs: true, // attach a shot's reference images before inserting its prompt
  autoLink: true, // link matching new Grok videos to sent shots automatically
  order: 'scene', // builder composition order preset
  queueDelay: 8, // seconds between batch sends
  queueTimeout: 240, // seconds to wait for a generation
  queueWait: true, // wait for a new video before sending the next shot
  libraryTab: 'phrases',
  phraseJoin: 'sentence', // how quick phrases are added to a prompt: 'sentence' | 'comma'
  phraseCat: 'all', // phrase board category filter
  // Section open states the user chose. No `builder` entry = automatic: open for a shot without a prompt.
  sections: { refs: true, takes: true, details: false, variations: false },
  assembleReplace: false,
  assembleTransition: 'cut',
  assembleApproved: false,
};

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    const sections = { ...DEFAULT_PREFS.sections, ...(raw.sections || {}) };
    // Version 1 saved the old default (builder: true) whether or not the user chose it: back to automatic.
    if ((raw.v || 1) < 2 && sections.builder === true) delete sections.builder;
    return { ...DEFAULT_PREFS, ...raw, v: PREFS_VERSION, sections };
  } catch {
    return { ...DEFAULT_PREFS, sections: { ...DEFAULT_PREFS.sections } };
  }
}

export const prefsStore = createStore(loadPrefs());
const savePrefs = debounce((p) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: prefs stay in memory */
  }
}, 300);
prefsStore.subscribe(savePrefs);
export const setPrefs = (patch) => prefsStore.set((s) => ({ ...s, ...patch }));
export const setSectionOpen = (key, open) => prefsStore.set((s) => ({ ...s, sections: { ...s.sections, [key]: open } }));

// ---------------------------------------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------------------------------------

/**
 * selectedId  shot open in the editor
 * pane        narrow layout: which pane is visible ('list' | 'editor' | 'library')
 * libraryOpen medium layout: the left column shows the library instead of the shot list
 * paste       {text, source, n} while the import preview is open (n remounts it for new text)
 * dialog      'assemble' | 'queue' | {type: 'link', shotId} | null
 * focus       {target, n} focus requests for the editor ('prompt' | 'title')
 * sending     shot ids currently being sent
 * offers      {shotId: [candidate]} matching grok.com videos waiting for confirmation (auto-link off)
 * inBox       {shotId, text} the studio put this shot's prompt in grok.com's prompt box and it hasn't been submitted
 * bibleFocus  {id, n} request to expand a bible card and focus its description
 * bibleReturn {entryId, shotId, libraryOpen, pane} where the bible card's "Back to shot" button leads
 */
export const promptsUi = createStore({ selectedId: null, pane: 'list', libraryOpen: false, paste: null, dialog: null, focus: null, sending: [], offers: {}, inBox: null, bibleFocus: null, bibleReturn: null });
export const setUi = (patch) => promptsUi.set((s) => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));

let focusCounter = 0;
export const requestFocus = (target = 'prompt') => setUi({ focus: { target, n: ++focusCounter } });

const project = () => projectStore.get();
export const shotsOf = (p = project()) => S.getShots(p);

/** Selects a shot; `reveal` switches the narrow layout to the editor pane. */
export function selectShot(id, { reveal = false } = {}) {
  setUi((s) => ({ selectedId: id, pane: reveal && s.pane === 'list' ? 'editor' : s.pane }));
}

/** The selected shot, or null (the view's selection guard re-selects the first shot when it goes stale). */
export function currentShot(p = project()) {
  const shots = shotsOf(p);
  return shots.find((s) => s.id === promptsUi.get().selectedId) || null;
}

/** Selects the previous / next shot. */
export function selectRelative(delta) {
  const shots = shotsOf();
  if (!shots.length) return;
  // A stale selection (e.g. the shot was just removed by undo) counts as the first shot, like the selection guard.
  const i = Math.max(0, shots.findIndex((s) => s.id === promptsUi.get().selectedId));
  const next = Math.max(0, Math.min(shots.length - 1, i + delta));
  selectShot(shots[next].id);
  requestAnimationFrame(() => document.querySelector(`[data-shot-id="${shots[next].id}"]`)?.scrollIntoView({ block: 'nearest' }));
}

// ---------------------------------------------------------------------------------------------------------
// Token expansion context
// ---------------------------------------------------------------------------------------------------------

/** Expansion context for the current project + library. */
export const expandContext = (p = project()) => ({ bible: getBible(p), snippets: libraryStore.get().snippets || [] });

/** Expanded prompt text (what is sent to Grok) and diagnostics. */
export const expandPrompt = (text, p = project()) => expandTokens(text || '', expandContext(p));

// ---------------------------------------------------------------------------------------------------------
// Shot CRUD
// ---------------------------------------------------------------------------------------------------------

/** Adds a shot after the selected one (or at the end) and opens it. Returns the new id. */
export function newShot(partial = {}, { focus = 'prompt', atEnd = false } = {}) {
  const p = project();
  // Phrases the user marked "start every new shot with it" (Library → Phrases).
  if (partial.prompt == null) {
    const auto = autoPhrasePrompt(libraryStore.get().phrases, { join: prefsStore.get().phraseJoin === 'comma' ? 'comma' : 'sentence' });
    if (auto) partial = { ...partial, prompt: auto };
  }
  const idx = S.shotIndex(p, promptsUi.get().selectedId);
  let id = null;
  projectStore.update(
    (q) => {
      const r = S.addShot(q, partial, !atEnd && idx >= 0 ? idx + 1 : undefined);
      id = r.id;
      return r.project;
    },
    { label: 'New shot' },
  );
  if (id) {
    selectShot(id, { reveal: true });
    if (focus) requestFocus(focus);
  }
  return id;
}

export function duplicateShot(id = promptsUi.get().selectedId) {
  if (!id) return null;
  flushPending();
  let newId = null;
  projectStore.update(
    (q) => {
      const r = S.duplicateShot(q, id);
      newId = r.id;
      return r.project;
    },
    { label: 'Duplicate shot' },
  );
  if (newId) {
    selectShot(newId);
    toast('Shot duplicated', { kind: 'success', duration: 1800 });
  }
  return newId;
}

/** Deletes shots (undo available from the toast and Ctrl+Z). */
export function deleteShots(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return;
  const before = shotsOf();
  const firstIdx = before.findIndex((s) => list.includes(s.id));
  projectStore.update((q) => S.removeShots(q, list), { label: list.length > 1 ? 'Delete shots' : 'Delete shot' });
  const after = shotsOf();
  if (list.includes(promptsUi.get().selectedId)) selectShot(after[Math.min(firstIdx, after.length - 1)]?.id || null);
  toast(list.length > 1 ? `Deleted ${list.length} shots` : `Deleted shot ${firstIdx + 1}`, { action: { label: 'Undo', run: () => projectStore.undo() } });
}

export function moveShotBy(id, delta) {
  const i = S.shotIndex(project(), id);
  if (i < 0) return;
  projectStore.update((q) => S.moveShot(q, id, i + delta), { label: 'Move shot' });
}

export function setShotStatus(id, status) {
  projectStore.update((q) => S.setShotStatus(q, id, status), { label: `Mark ${S.STATUS_LABELS[status] || status}` });
}

/** Patches a shot. `merge` collapses a typing session into one undo step. */
export function patchShot(id, patch, { label = 'Edit shot', merge = null } = {}) {
  projectStore.update((q) => S.updateShot(q, id, patch), { label, merge });
}

// ---------------------------------------------------------------------------------------------------------
// Editor bridge (library "Insert" -> the prompt textarea at its cursor)
// ---------------------------------------------------------------------------------------------------------

export const editorApi = { insert: null };

/** Flush callbacks of text fields with a pending (debounced) edit; see useCommittedText in common.js. */
export const pendingFlushers = new Set();
/** Commits every pending text edit right away (before sending / copying / duplicating from the keyboard). */
export const flushPending = () => [...pendingFlushers].forEach((fn) => fn());

// Closing or reloading the window (the grok.com tab or the studio tab) must not drop text typed in the last few
// hundred ms: commit it, and the debounced prefs, before app-state saves the project on beforeunload. Capturing
// listeners on window run before its bubbling ones, so this goes first whatever the registration order.
function flushOnExit() {
  flushPending();
  savePrefs.flush(prefsStore.get());
}
window.addEventListener('beforeunload', flushOnExit, { capture: true });
window.addEventListener('pagehide', flushOnExit, { capture: true });

/** Inserts text into the selected shot's prompt at the cursor (creates a shot when none is selected). */
export function insertIntoPrompt(text) {
  if (!text) return false;
  if (editorApi.insert && currentShot()) {
    editorApi.insert(text);
    if (promptsUi.get().pane === 'library') setUi({ pane: 'editor' });
    return true;
  }
  newShot({ prompt: text });
  toast('Started a new shot with that text', { duration: 2000 });
  return true;
}

/**
 * Shows a bible entry ready to be described: the library on the Bible tab (the library pane when narrow, the left
 * column at medium widths) with the entry's card expanded and its description focused. `fromShot`: the card then
 * offers "Back to shot N", which restores the previous layout.
 */
export function describeBibleEntry(entryId, { fromShot = null } = {}) {
  const ui = promptsUi.get();
  setPrefs({ libraryTab: 'bible' });
  setUi({
    libraryOpen: true,
    pane: 'library',
    bibleFocus: { id: entryId, n: ++focusCounter },
    bibleReturn: fromShot ? { entryId, shotId: fromShot, libraryOpen: ui.libraryOpen, pane: ui.pane } : null,
  });
}

/** "Back to shot N" from a bible card opened by describeBibleEntry: commits the description, focuses the prompt. */
export function returnFromBible() {
  const r = promptsUi.get().bibleReturn;
  if (!r) return;
  flushPending();
  setUi({ bibleReturn: null, libraryOpen: r.libraryOpen, pane: r.pane === 'library' ? 'editor' : r.pane });
  if (S.findShot(project(), r.shotId)) selectShot(r.shotId);
  requestFocus('prompt');
}

// ---------------------------------------------------------------------------------------------------------
// Send to Grok
// ---------------------------------------------------------------------------------------------------------

const setSending = (id, on) => setUi((s) => ({ sending: on ? [...new Set([...s.sending, id])] : s.sending.filter((x) => x !== id) }));
const indexLabel = (id) => `Shot ${S.shotIndex(project(), id) + 1}`;

// Our own submits come back from grok.com as composer.submitted events — during the COMPOSER_INSERT request when
// embedded, possibly a moment after it in tab mode. Texts being sent (and for a few seconds after) are ignored there.
const SEND_ECHO_MS = 8000;
const recentSends = new Map(); // normalised text -> expiry (Infinity while the request runs)

function beginSend(text) {
  const key = normalizeForMatch(text);
  let cancelled = false;
  recentSends.set(key, Infinity);
  return {
    done: () => {
      if (!cancelled) recentSends.set(key, Date.now() + SEND_ECHO_MS);
    },
    /** Nothing was submitted: a submission that follows is the user's own. */
    cancel: () => {
      cancelled = true;
      recentSends.delete(key);
    },
  };
}

function isOwnSend(text) {
  const now = Date.now();
  for (const [k, until] of recentSends) if (until < now) recentSends.delete(k);
  const key = normalizeForMatch(text);
  for (const k of recentSends.keys()) if (k === key || promptSimilarity(k, key) >= 0.95) return true;
  return false;
}

// Reference images the studio attached to grok.com's composer that have not been submitted yet ({ids, text}: the
// composer text right after). Re-sending a shot doesn't upload them again while the composer still shows that text.
let composerRefs = null;
let composerUrl = null;
const sameText = (a, b) => collapseSpaces(a) === collapseSpaces(b);

async function composerStillHolds(text) {
  try {
    const res = await bridge.request(REQ.COMPOSER_READ, {}, { timeout: 5000 });
    return !!res?.found && sameText(res.text || '', text);
  } catch {
    return false;
  }
}

/**
 * Attaches the reference images that aren't in grok.com's composer yet. Returns {errors, extra, ids}: extra = images
 * from an earlier, unsubmitted send that are still in the composer (they can't be removed from here); ids = every
 * image the composer now holds.
 */
async function attachRefs(refs) {
  let have = [];
  if (composerRefs && (await composerStillHolds(composerRefs.text))) have = composerRefs.ids;
  else composerRefs = null;
  const missing = refs.filter((r) => !have.includes(r));
  const extra = have.filter((r) => !refs.includes(r));
  const res = missing.length ? await attachIngredientsToGrok(missing) : { errors: [] };
  return { errors: res.errors, extra, ids: [...new Set([...have, ...missing])] };
}

/** Error for "the text is in Grok's prompt box but the generation didn't start". */
const notSubmitted = (res) =>
  Object.assign(new Error(res?.error ? `Grok didn't start the generation (${res.error})` : "Grok didn't start the generation"), { inserted: true });

// The toast offering "Generate now" for the prompt in Grok's box: it goes away with that state, so a stale offer
// can't insert and generate the shot a second time.
let generateOffer = null;

/** Records which shot's prompt grok.com's prompt box holds unsubmitted (null: none / unknown). */
function setInBox(shotId = null, text = '') {
  const cur = promptsUi.get().inBox;
  if (cur ? cur.shotId === shotId && cur.text === text : !shotId) return;
  if (generateOffer) dismissToast(generateOffer);
  generateOffer = null;
  setUi({ inBox: shotId ? { shotId, text } : null });
}

/** Toast with a "Generate now" action for the shot whose prompt is in Grok's box (one at a time). */
function offerGenerate(id, message, opts) {
  if (generateOffer) dismissToast(generateOffer);
  generateOffer = toast(message, { duration: 8000, ...opts, action: { label: 'Generate now', run: () => generateNow(id) } });
}

/**
 * Sends a shot to the grok.com composer. Throws on failure (used by the queue); UI callers use sendShot().
 * A requested submit that doesn't happen throws an error with `inserted: true` (the shot stays unsent).
 * @param {string} id
 * @param {{submit?: boolean, attach?: boolean, interactive?: boolean}} opts
 */
export async function deliverShot(id, { submit = false, attach = prefsStore.get().attachRefs, interactive = false } = {}) {
  flushPending();
  const p = project();
  const shot = S.findShot(p, id);
  if (!shot) throw new Error('Shot not found');
  const { text, unknown } = expandPrompt(shot.prompt, p);
  if (!text.trim()) throw new Error(`${indexLabel(id)} has no prompt yet`);
  if (!bridge.connected) throw Object.assign(new Error('Not connected to grok.com — open Grok Imagine in a tab'), { text });
  if (interactive && unknown.length) {
    const ok = await confirmDialog({
      title: 'Send with unknown tokens?',
      message: `These tokens aren't defined in the bible or snippets and will be sent exactly as typed:\n\n${unknown.join('   ')}`,
      confirmLabel: 'Send anyway',
    });
    if (!ok) return false;
  }
  setSending(id, true);
  const echo = beginSend(text);
  let requested = false; // the insert (+ submit) request went out: its outcome may be unknown on a timeout
  try {
    const refs = attach && Array.isArray(shot.ingredientIds) ? shot.ingredientIds : [];
    let refIds = composerRefs?.ids || [];
    if (refs.length) {
      const r = await attachRefs(refs);
      refIds = r.ids;
      if (r.errors.length) {
        if (!interactive) throw new Error(`Reference images: ${r.errors[0]}`);
        toast(`${pluralize(r.errors.length, 'reference image')} could not be attached: ${r.errors[0]}`, { kind: 'warn', duration: 6000 });
      }
      if (r.extra.length && interactive) {
        toast(`Grok’s prompt box still holds ${pluralize(r.extra.length, 'reference image')} from an earlier send — remove ${r.extra.length > 1 ? 'them' : 'it'} on grok.com if ${r.extra.length > 1 ? 'they don’t' : 'it doesn’t'} belong to this shot.`, { kind: 'warn', duration: 7000 });
      }
    }
    requested = true;
    const res = await bridge.request(REQ.COMPOSER_INSERT, { text, mode: 'replace', submit: !!submit }, { timeout: 25000 });
    if (res && res.ok === false) throw Object.assign(new Error(res.error || "Grok's prompt box was not found on the page"), { nothingSent: true });
    if (submit && res?.submitted === false) {
      composerRefs = refIds.length ? { ids: refIds, text } : null;
      setInBox(id, text);
      throw notSubmitted(res);
    }
    composerRefs = submit || !refIds.length ? null : { ids: refIds, text };
    if (submit) setInBox(null);
    else setInBox(id, text);
    projectStore.update((q) => S.markShotSent(q, id, { text }), { label: `Send ${indexLabel(id).toLowerCase()} to Grok` });
    return true;
  } catch (e) {
    if (!requested || e.inserted || e.nothingSent) echo.cancel();
    e.text = text;
    throw e;
  } finally {
    echo.done();
    setSending(id, false);
  }
}

/**
 * UI send: confirms unknown tokens, toasts the result, offers "Copy" when Grok can't be reached. An insert-only send
 * offers "Generate now" (grok.com's own button is often under the docked studio).
 */
export async function sendShot(id = promptsUi.get().selectedId, { submit = false } = {}) {
  if (!id) return false;
  try {
    const ok = await deliverShot(id, { submit, interactive: true });
    if (ok && submit) toast(`${indexLabel(id)} sent to Grok — generating…`, { kind: 'success' });
    else if (ok) offerGenerate(id, `${indexLabel(id)} is in Grok's prompt box`, { kind: 'success' });
    return ok;
  } catch (e) {
    console.warn('[gis] send shot failed', e);
    if (e.inserted) {
      offerGenerate(id, `${indexLabel(id)} is in Grok's prompt box, but ${e.message} — press Grok's button to generate it.`, { kind: 'warn' });
      return false;
    }
    const text = e.text || '';
    toast(`Couldn't send: ${e.message || e}`, { kind: 'error', duration: 6000, action: text ? { label: 'Copy prompt', run: () => copyText(text).then(() => toast('Prompt copied', { kind: 'success' })) } : null });
    return false;
  }
}

/**
 * Starts the generation of a shot whose prompt the studio already put in grok.com's prompt box: presses Grok's
 * button (REQ.COMPOSER_SUBMIT), so whatever else the box holds (reference images) goes along. When the box no
 * longer holds the shot's current prompt (edited since, cleared or replaced on grok.com) the shot is inserted
 * again and generated.
 */
export async function generateNow(id = promptsUi.get().selectedId) {
  if (!id) return false;
  flushPending();
  const shot = S.findShot(project(), id);
  if (!shot) return false;
  const { text } = expandPrompt(shot.prompt);
  const box = promptsUi.get().inBox;
  const inBox = box?.shotId === id && box.text === text && bridge.connected;
  if (!inBox || !(await composerStillHolds(text))) {
    if (inBox) setInBox(null);
    return sendShot(id, { submit: true });
  }
  setSending(id, true);
  const echo = beginSend(text); // our own click comes back as composer.submitted: handled here, not there
  try {
    const res = await bridge.request(REQ.COMPOSER_SUBMIT, {}, { timeout: 10000 });
    if (!res?.ok) {
      echo.cancel();
      offerGenerate(id, `${indexLabel(id)} is in Grok's prompt box, but Grok didn't start the generation${res?.error ? ` (${res.error})` : ''} — press Grok's button to generate it.`, { kind: 'warn' });
      return false;
    }
    composerRefs = null;
    setInBox(null);
    if (S.findShot(project(), id)?.status === 'draft') projectStore.update((q) => S.markShotSent(q, id, { text }), { label: `Generate ${indexLabel(id).toLowerCase()}` });
    else projectStore.update((q) => S.updateShot(q, id, { sentAt: Date.now() }), { history: false }); // takes match from now
    toast(`${indexLabel(id)} sent to Grok — generating…`, { kind: 'success' });
    return true;
  } catch (e) {
    console.warn('[gis] generate failed', e);
    toast(`Couldn't start the generation: ${e.message || e}`, { kind: 'error', duration: 6000 });
    return false;
  } finally {
    echo.done();
    setSending(id, false);
  }
}

/** Copies the expanded prompt of a shot. */
export async function copyShotPrompt(id = promptsUi.get().selectedId) {
  flushPending();
  const shot = S.findShot(project(), id);
  if (!shot) return;
  const { text } = expandPrompt(shot.prompt);
  if (!text.trim()) return toast('This shot has no prompt yet', { kind: 'warn' });
  if (await copyText(text)) toast('Prompt copied', { kind: 'success', duration: 1600 });
  else toast('Could not copy to the clipboard', { kind: 'error' });
}

/** Sends free text (templates) to the Grok composer. */
export async function sendTextToGrok(text, { submit = false, ingredientIds = [] } = {}) {
  if (!text.trim()) return false;
  if (!bridge.connected) {
    toast('Not connected to grok.com', { kind: 'error', action: { label: 'Copy', run: () => copyText(text) } });
    return false;
  }
  const echo = beginSend(text);
  let requested = false;
  try {
    let refIds = composerRefs?.ids || [];
    if (ingredientIds.length) {
      const r = await attachRefs(ingredientIds);
      refIds = r.ids;
      if (r.errors.length) toast(`Some images could not be attached: ${r.errors[0]}`, { kind: 'warn' });
    }
    requested = true;
    const res = await bridge.request(REQ.COMPOSER_INSERT, { text, mode: 'replace', submit: !!submit }, { timeout: 25000 });
    if (res && res.ok === false) throw Object.assign(new Error(res.error || "Grok's prompt box was not found"), { nothingSent: true });
    setInBox(null); // the box now holds this text, not a shot's prompt
    if (submit && res?.submitted === false) {
      composerRefs = refIds.length ? { ids: refIds, text } : null;
      echo.cancel();
      toast(`The message is in Grok's prompt box, but ${notSubmitted(res).message} — press Grok's button to send it.`, { kind: 'warn', duration: 8000 });
      return false;
    }
    composerRefs = submit || !refIds.length ? null : { ids: refIds, text };
    toast(submit ? 'Sent to Grok' : "Inserted in Grok's prompt box", { kind: 'success' });
    return true;
  } catch (e) {
    if (!requested || e.nothingSent) echo.cancel();
    toast(`Couldn't send: ${e.message || e}`, { kind: 'error', action: { label: 'Copy', run: () => copyText(text) } });
    return false;
  } finally {
    echo.done();
  }
}

// grok.com reports every submitted prompt: a submission that matches a shot marks it as sent (even when the user
// pasted it by hand), so its videos can be linked as takes. Echoes of the studio's own sends are ignored.
bridge.on(EVT.COMPOSER_SUBMITTED, ({ text } = {}) => {
  composerRefs = null; // whatever was attached went out with this submission
  setInBox(null); // and the prompt the box held
  const p = project();
  if (!p || !text || !text.trim() || isOwnSend(text)) return;
  let best = null;
  for (const shot of S.getShots(p)) {
    if (!shot.prompt?.trim()) continue;
    const expanded = expandPrompt(shot.prompt, p).text;
    const score = Math.max(promptSimilarity(text, expanded), shot.sentText ? promptSimilarity(text, shot.sentText) : 0);
    if (score >= 0.8 && (!best || score > best.score)) best = { shot, score };
  }
  if (!best) return;
  const { shot } = best;
  if (shot.status !== 'draft' && shot.sentText && promptSimilarity(text, shot.sentText) >= 0.95) {
    // Already marked sent with this text (e.g. inserted from the studio, submitted on grok.com): only refresh the
    // send time used for take matching — not a new undo step.
    projectStore.update((q) => S.updateShot(q, shot.id, { sentAt: Date.now() }), { history: false });
    return;
  }
  projectStore.update((q) => S.markShotSent(q, shot.id, { text }), { label: 'Prompt submitted on grok.com' });
});

// Navigating grok.com drops whatever the composer held.
bridge.on(EVT.PAGE_NAVIGATED, (info = {}) => {
  if (info.url && info.url !== composerUrl) {
    composerRefs = null;
    setInBox(null);
  }
  composerUrl = info.url || composerUrl;
});
// So does losing the grok.com tab, or (standalone studio) switching to another one.
bridge.onStatus(() => setInBox(null));

// ---------------------------------------------------------------------------------------------------------
// Take decisions: grok.com items and bin media the take watcher already linked or offered, and media the user
// linked or unlinked by hand, are never linked automatically again — not after an Unlink, an undo or a reload.
// Kept per project in localStorage (bookkeeping, not project data: undo must not bring a decision back).
// ---------------------------------------------------------------------------------------------------------

const HANDLED_MAX = 2000;
const handledKey = (projectId) => `gis:prompts:handled:${projectId}`;
let handled = { projectId: undefined, keys: new Set() };

function handledSet() {
  const id = project()?.id || null;
  if (handled.projectId !== id) {
    let keys = [];
    try {
      keys = id ? JSON.parse(localStorage.getItem(handledKey(id)) || '[]') : [];
    } catch {
      keys = [];
    }
    handled = { projectId: id, keys: new Set(Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : []) };
  }
  return handled.keys;
}

/** True when the take watcher must leave this candidate key alone (`page:<key>` / `media:<id>`). */
export const isHandled = (key) => !!key && handledSet().has(key);

/** Records take decisions (see above). */
export function markHandled(keys) {
  const set = handledSet();
  let changed = false;
  for (const k of keys) {
    if (k && !set.has(k)) {
      set.add(k);
      changed = true;
    }
  }
  if (!changed || !handled.projectId) return;
  for (const k of set) {
    if (set.size <= HANDLED_MAX) break;
    set.delete(k); // oldest first
  }
  try {
    localStorage.setItem(handledKey(handled.projectId), JSON.stringify([...set]));
  } catch {
    /* storage unavailable: decisions last for this session */
  }
}

/** Decision keys of a media item: `media:<id>` plus `page:<pageKey>` for grok.com media. */
export const mediaKeys = (media) => (media ? [`media:${media.id}`, media.pageKey ? `page:${media.pageKey}` : null].filter(Boolean) : []);

/** Links media to a shot by hand (bin picker, drop on a card): one undo step; the watcher won't move them later. */
export function linkTakesByHand(shotId, mediaIds, { label = 'Link takes' } = {}) {
  const p = project();
  const ids = mediaIds.filter((id) => p.media[id]);
  if (!ids.length) return 0;
  markHandled(ids.flatMap((id) => mediaKeys(p.media[id])));
  projectStore.update((q) => S.linkTakes(q, ids.map((mediaId) => ({ shotId, mediaId }))), { label });
  return ids.length;
}

/** Unlinks a take; the watcher won't link that media again automatically. */
export function unlinkTakeByHand(shotId, mediaId) {
  markHandled(mediaKeys(project()?.media[mediaId]));
  projectStore.update((q) => S.unlinkTake(q, shotId, mediaId), { label: 'Unlink take' });
}

// ---------------------------------------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------------------------------------

/** Opens the import preview with some text (source: where it came from, for the dialog subtitle). */
export function openPaste(text = '', source = '') {
  setUi({ paste: { text: String(text || ''), source, n: ++focusCounter } });
}

/** Creates shots from parsed items. position: 'after' (selected shot) | 'end' | 'replace'. Returns new ids. */
export function importItems(items, { position = 'end' } = {}) {
  const list = (items || []).filter((it) => it && it.prompt);
  if (!list.length) return [];
  const p = project();
  const idx = S.shotIndex(p, promptsUi.get().selectedId);
  let ids = [];
  projectStore.update(
    (q) => {
      let r = q;
      if (position === 'replace') r = S.removeShots(r, S.getShots(r).map((s) => s.id));
      const at = position === 'after' && idx >= 0 ? idx + 1 : undefined;
      const res = S.addShots(
        r,
        list.map((it) => ({ title: it.title || '', prompt: it.prompt, duration: it.duration, notes: it.notes || '' })),
        at,
      );
      ids = res.ids;
      return res.project;
    },
    { label: position === 'replace' ? 'Replace shots from list' : `Import ${pluralize(list.length, 'shot')}` },
  );
  if (ids[0]) selectShot(ids[0]);
  return ids;
}

/** Fetches text from grok.com (latest reply or selection) and opens the import preview. */
export async function importFromPage(kind = 'reply') {
  if (!bridge.connected) {
    toast('Not connected to grok.com', { kind: 'error' });
    return;
  }
  try {
    const res = await bridge.request(kind === 'selection' ? REQ.PAGE_SELECTION : REQ.PAGE_LAST_REPLY, {}, { timeout: 10000 });
    const text = (res?.text || '').trim();
    if (!text) {
      toast(kind === 'selection' ? 'Nothing is selected on grok.com — select some text first' : 'No Grok reply found on the page — open the chat with the reply', { kind: 'warn', duration: 5000 });
      return;
    }
    openPaste(text, kind === 'selection' ? 'Selection on grok.com' : 'Grok’s latest reply');
  } catch (e) {
    toast(`Couldn't read grok.com: ${e.message || e}`, { kind: 'error' });
  }
}

/** Expanded prompt text per shot (exports and "copy all" use what would be sent). */
const resolver = (p = project()) => {
  const ctx = expandContext(p);
  return (shot) => expandTokens(shot.prompt || '', ctx).text;
};

export function exportShots(format = 'txt') {
  flushPending();
  const p = project();
  const shots = shotsOf(p);
  if (!shots.length) return toast('No shots to export yet', { kind: 'warn' });
  const text = exportPromptList(shots, format, { resolve: resolver(p), title: p.name });
  const mime = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv' }[format] || 'text/plain';
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), `${slugify(p.name, 40)}-shots.${format}`).catch((e) => toast(`Export failed: ${e.message || e}`, { kind: 'error' }));
}

export async function copyAllPrompts() {
  flushPending();
  const p = project();
  const shots = shotsOf(p);
  if (!shots.length) return toast('No shots yet', { kind: 'warn' });
  const ok = await copyText(exportPromptList(shots, 'txt', { resolve: resolver(p) }));
  toast(ok ? `Copied ${pluralize(shots.length, 'prompt')}` : 'Could not copy to the clipboard', { kind: ok ? 'success' : 'error' });
}

// ---------------------------------------------------------------------------------------------------------
// Assemble timeline
// ---------------------------------------------------------------------------------------------------------

/** Resolves when the given media are ready (or failed), or after timeoutMs. */
function waitForMedia(ids, timeoutMs = 90000) {
  const pending = () => ids.filter((id) => {
    const m = project()?.media[id];
    return m && (m.status === 'pending' || m.status === 'loading');
  });
  if (!pending().length) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    const off = onMediaEvent(() => {
      if (!pending().length) done(true);
    });
    function done(ok) {
      clearTimeout(timer);
      off();
      resolve(ok);
    }
  });
}

/**
 * Builds the main track from the shots' chosen (or first) takes, in shot order. Waits for takes that are still
 * downloading so clips get their real duration.
 */
export async function assembleFromShots({ replace = false, transition = null, approvedOnly = false, onWait = null, order = null } = {}) {
  const p = project();
  const { mediaIds } = S.takesInShotOrder(p, { approvedOnly, order });
  if (!mediaIds.length) {
    toast(approvedOnly ? 'No approved shot has a take yet' : 'No shot has a take yet — send shots to Grok or link clips from the bin', { kind: 'warn', duration: 5000 });
    return null;
  }
  const busy = mediaIds.filter((id) => ['pending', 'loading'].includes(p.media[id]?.status));
  if (busy.length) {
    onWait?.(busy.length);
    await waitForMedia(busy);
  }
  let result = null;
  projectStore.update(
    (q) => {
      result = S.assembleTimeline(q, { replace, transition, approvedOnly, order });
      return result.project;
    },
    { label: 'Assemble timeline from shots' },
  );
  if (!result?.clipIds.length) {
    toast(result?.failed.length ? 'The takes failed to download — retry them in the Clips tab, or link other clips' : 'No shot has a usable take any more', { kind: 'error', duration: 6000 });
    return null;
  }
  const failed = result.failed.length;
  const missing = result.skipped.length - failed;
  const notes = [missing ? `${pluralize(missing, 'shot')} without a take skipped` : '', failed ? `${pluralize(failed, 'shot')} skipped: take failed to download` : ''].filter(Boolean);
  toast(`Placed ${pluralize(result.clipIds.length, 'clip')} on the timeline${notes.length ? ` · ${notes.join(' · ')}` : ''}`, {
    kind: failed ? 'warn' : 'success',
    duration: 6000,
    action: { label: 'Open Edit', run: () => uiStore.set((s) => ({ ...s, tab: 'edit' })) },
  });
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Batch queue
// ---------------------------------------------------------------------------------------------------------

/** Resolves 'done' when a new Grok video (seen after `since`) appears or the shot gets a new take, else 'timeout'. */
function waitForGeneration(shotId, { since, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const takesAtStart = S.findShot(project(), shotId)?.takes?.length || 0;
    const check = () => {
      const fresh = pageStore.get().items.some((it) => it.kind === 'video' && (it.seenAt || 0) >= since);
      const shot = S.findShot(project(), shotId);
      if (fresh || (shot?.takes?.length || 0) > takesAtStart) finish('done');
    };
    const offs = [pageStore.subscribe(check), projectStore.subscribe(check)];
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const onAbort = () => finish('stopped');
    signal?.addEventListener('abort', onAbort, { once: true });
    function finish(result) {
      clearTimeout(timer);
      offs.forEach((off) => off());
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }
    check();
  });
}

export const queueStore = createStore({ status: 'idle', index: 0, items: [], options: null });
export const queueRunner = createQueueRunner({
  send: (id) => deliverShot(id, { submit: true, interactive: false }),
  waitForResult: waitForGeneration,
  onChange: (state) => queueStore.set(() => state),
});

/** Starts the batch queue with the given shot ids (in order) using the saved preferences. */
export function startQueue(shotIds) {
  if (!bridge.connected) {
    toast('Open grok.com first — the queue sends prompts to the Grok page', { kind: 'error' });
    return;
  }
  const pr = prefsStore.get();
  queueRunner.start(shotIds, { delayMs: pr.queueDelay * 1000, waitForGeneration: pr.queueWait, timeoutMs: pr.queueTimeout * 1000 }).then(() => {
    const st = queueRunner.getState();
    if (st.status === 'done') {
      const errors = st.items.filter((i) => i.status === 'error').length;
      const timeouts = st.items.filter((i) => i.status === 'timeout').length;
      const notes = [timeouts ? `${timeouts} without a new video yet` : '', errors ? `${errors} failed` : ''].filter(Boolean);
      toast(`Batch finished: ${st.items.length - errors} of ${pluralize(st.items.length, 'shot')} sent${notes.length ? ` · ${notes.join(' · ')}` : ''}`, {
        kind: errors || timeouts ? 'warn' : 'success',
        duration: 6000,
      });
    } else if (st.error) toast(st.error, { kind: 'error', duration: 6000 });
  });
}

/** Manual queue: sends the first unsent (draft) shot in list order and selects it. */
export async function sendNextDraft({ submit = true } = {}) {
  const next = S.nextDraftShot(project());
  if (!next) {
    toast('Every shot with a prompt has been sent', { kind: 'info' });
    return false;
  }
  selectShot(next.id);
  return sendShot(next.id, { submit });
}

// ---------------------------------------------------------------------------------------------------------
// App events
// ---------------------------------------------------------------------------------------------------------

appEvents.on('prompts.importText', ({ text } = {}) => {
  if (!text || !String(text).trim()) return;
  openPaste(text, 'Sent from grok.com');
  uiStore.set((s) => (s.tab === 'prompts' ? s : { ...s, tab: 'prompts' }));
});

appEvents.on('project.loaded', () => {
  queueRunner.stop({ silent: true });
  queueRunner.reset();
  setUi({ selectedId: null, paste: null, dialog: null, offers: {}, sending: [], inBox: null, bibleFocus: null, bibleReturn: null });
});
