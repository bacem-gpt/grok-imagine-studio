// Boot, persistence and cross-cutting wiring:
//  - loads UI prefs, library and the last project; autosaves them (debounced; flushed when the window goes away;
//    failures are reported and retried)
//  - connects the bridge and mirrors grok.com state into pageStore (every page payload is validated first)
//  - handles page events (add to bin / ingredient / import text) and auto-collect
//  - project management (new / open / duplicate / delete / import / export)
//  - storage cleanup that accounts for every open studio window
//  - appEvents: a tiny bus for cross-panel requests (see APP_EVENTS)

import { projectStore, uiStore, pageStore, libraryStore, projectsListStore, PERSISTED_UI_KEYS, SYNCED_UI_KEYS } from './store.js';
import { db } from './db.js';
import * as M from './model.js';
import { bridge } from './bridge.js';
import { EVT, REQ, STUDIO_REQ, STUDIO_EVT } from '../../shared/protocol.js';
import { createEmitter, debounce, uid } from './utils.js';
import { importPageItems, resumePendingMedia, releaseRuntime } from './media.js';
import { invalidateIngredientCache } from './ingredients.js';
import { sanitizePageMediaList, sanitizePageMedia, sanitizePageInfo, sanitizeText, sanitizeFlag, sanitizeDockMode, sanitizeMediaUrls } from './page-input.js';

/**
 * Cross-panel events. Emit with appEvents.emit(name, payload); listen with appEvents.on(name, fn).
 *  'source.open'        {mediaId}                 open a media item in the Clips tab source monitor
 *  'timeline.reveal'    {clipId}                  select + scroll to a clip in the Edit tab
 *  'ingredient.fromPage' {item: PageMedia}        a grok.com image was sent to Ingredients
 *  'ingredient.add'     {blob, name, origin, sourceUrl}   add an image blob to Ingredients
 *  'prompts.importText' {text}                    text sent to the prompt list
 *  'export.open'        {}                        open the export dialog (the header's Export button and Ctrl+E use it)
 *  'project.loaded'     {project}                 a project was opened (also fired at boot)
 *  'project.removed'    {project}                 the open sequence was deleted in another window; `project` is the
 *                                                 last state seen here (restoreProject(project) brings it back)
 *  'save.failed'        {what, error}             autosave of 'project' | 'library' started failing (it retries;
 *                                                 uiStore.saveIssue is set until a save succeeds)
 *  'save.recovered'     {}                        saving works again after a failure
 */
export const appEvents = createEmitter();

const LAST_PROJECT_KEY = 'meta:lastProject';
const LIBRARY_KEY = 'library';
const UI_PREFS_KEY = 'gis:ui';
const CHANNEL_NAME = 'grok-imagine-studio';
const WINDOW_LOCK_PREFIX = 'gis-window:'; // held by every studio window while it is open (see storage cleanup)
const GC_GRACE_MS = 15 * 60 * 1000; // automatic cleanups only delete files unreferenced for this long
const RESTORE_KEEP_MS = 10 * 60 * 1000; // files of a sequence deleted elsewhere stay restorable this long
const SAVE_RETRY_MS = [2000, 5000, 15000, 30000];
let channel = null;
let autoCollectSince = 0;

// Several studio windows can be open at once (the overlay in more than one grok.com tab, standalone tabs).
// Saves never overwrite blindly: each save is a three-way merge (base = the version this window last loaded/saved,
// mine = current state, theirs = what is stored now) done atomically in one IndexedDB transaction, and every window
// merges the others' saves as soon as they are broadcast. Nothing added in one window is lost in another.
const INSTANCE_ID = uid('win');
let projectBase = null; // snapshot of the stored project version this window last loaded/saved (merge base)
let libraryBase = null; // same for the library document
const snapshot = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stripSaveMeta = (p) => {
  if (!p) return p;
  const { saveId, savedBy, ...rest } = p;
  return rest;
};
const LIBRARY_LISTS = ['snippets', 'presets', 'ingredients', 'templates'];
const libraryDoc = (lib) => {
  const { loaded, ...rest } = lib;
  return rest;
};
function mergeLibrary(base, mine, theirs) {
  const out = { ...stripSaveMeta(theirs), ...mine };
  for (const k of LIBRARY_LISTS) out[k] = M.mergeById(base?.[k] || [], mine?.[k] || [], theirs?.[k] || []);
  return out;
}

/** Brings a merged version into this window (no-op when nothing differs). Clears undo: undoing past another
 *  window's change would silently revert it on the next save. */
function adoptProject(merged) {
  const cur = projectStore.get();
  const clean = stripSaveMeta(merged);
  if (!cur || clean.id !== cur.id || sameJson(clean, cur)) return;
  projectStore.load(clean);
}

// ---------------------------------------------------------------------------------------------------------
// Save failures: reported once per streak, retried with backoff, shown in the header meanwhile
// ---------------------------------------------------------------------------------------------------------

const saveTrouble = { project: 0, library: 0 }; // consecutive failures
const retryTimers = {};

function saveFailed(what, e, retry) {
  const n = ++saveTrouble[what];
  const message = String(e?.message || e || 'unknown error');
  console.error(`[gis] failed to save the ${what}`, e);
  uiStore.set((s) => ({ ...s, saveIssue: { what, message, at: Date.now() } }));
  if (n === 1) appEvents.emit('save.failed', { what, error: message });
  clearTimeout(retryTimers[what]);
  retryTimers[what] = setTimeout(retry, SAVE_RETRY_MS[Math.min(n - 1, SAVE_RETRY_MS.length - 1)]);
}

function saveSucceeded(what) {
  if (!saveTrouble[what]) return;
  saveTrouble[what] = 0;
  clearTimeout(retryTimers[what]);
  if (saveTrouble.project || saveTrouble.library) return;
  uiStore.set((s) => ({ ...s, saveIssue: null }));
  appEvents.emit('save.recovered', {});
}

// ---------------------------------------------------------------------------------------------------------
// Project / library saves (serialized per document; the exit flush starts its write right away)
// ---------------------------------------------------------------------------------------------------------

const deletedHere = new Set(); // projects this window deleted (their late saves are dropped, not reported)

async function saveProject(project) {
  try {
    const base = projectBase && projectBase.id === project.id ? projectBase : null;
    let gone = false;
    const saved = await db.updateProject(project.id, (stored) => {
      // Deleted since this window loaded it (here or elsewhere): never bring it back behind the user's back.
      if (!stored && base) {
        gone = true;
        return undefined;
      }
      let next = project;
      if (stored && base && stored.saveId !== base.saveId) next = M.mergeProjects(base, project, stripSaveMeta(stored));
      return { ...stripSaveMeta(next), saveId: uid('sv'), savedBy: INSTANCE_ID };
    });
    if (gone) {
      saveSucceeded('project');
      projectRemovedElsewhere(project.id);
      return;
    }
    // (a save that finishes after this window switched to another sequence must not become that one's merge base)
    if (saved.id === projectStore.get()?.id) projectBase = snapshot(saved);
    if (!sameJson(stripSaveMeta(saved), project)) {
      // Another window saved meanwhile: adopt the merge, re-merging edits made here while saving.
      const now = projectStore.get();
      adoptProject(now === project ? saved : M.mergeProjects(snapshot(project), now, stripSaveMeta(saved)));
    }
    projectsListStore.set((list) => {
      const summary = M.projectSummary(saved);
      const rest = list.filter((p) => p.id !== saved.id);
      return [summary, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
    });
    channel?.postMessage({ type: 'project-saved', id: saved.id, saveId: saved.saveId, by: INSTANCE_ID });
    if (!saveProjectSoon.pending) clearJournal();
    saveSucceeded('project');
  } catch (e) {
    saveFailed('project', e, () => {
      const cur = projectStore.get();
      if (cur) saveProjectSoon(cur);
    });
  }
}

let projectSaving = Promise.resolve();
const saveProjectNow = (project) => (projectSaving = projectSaving.then(() => saveProject(project)));
const saveProjectSoon = debounce((project) => saveProjectNow(project), 400);

async function saveLibrary(lib) {
  try {
    const mine = libraryDoc(lib);
    const base = libraryBase;
    const saved = await db.kvUpdate(LIBRARY_KEY, (stored) => {
      let next = mine;
      if (stored && base && stored.saveId !== base.saveId) next = mergeLibrary(base, mine, stored);
      return { ...stripSaveMeta(next), saveId: uid('lib'), savedBy: INSTANCE_ID };
    });
    libraryBase = snapshot(saved);
    if (!sameJson(stripSaveMeta(saved), mine)) adoptLibrary(stripSaveMeta(saved));
    channel?.postMessage({ type: 'library-saved', saveId: saved.saveId, by: INSTANCE_ID });
    if (!saveLibrarySoon.pending) clearLibraryJournal();
    saveSucceeded('library');
  } catch (e) {
    saveFailed('library', e, () => saveLibrarySoon(libraryStore.get()));
  }
}

let librarySaving = Promise.resolve();
const saveLibraryNow = (lib) => (librarySaving = librarySaving.then(() => saveLibrary(lib)));
const saveLibrarySoon = debounce((lib) => saveLibraryNow(lib), 400);

function adoptLibrary(doc) {
  const cur = libraryStore.get();
  // Images edited or removed in the other window: drop this window's cached thumbnails/URLs for them.
  const fresh = new Map((doc.ingredients || []).map((i) => [i.id, i.updatedAt]));
  const stale = (cur.ingredients || []).filter((i) => fresh.get(i.id) !== i.updatedAt).map((i) => i.id);
  if (stale.length) invalidateIngredientCache(stale);
  if (!sameJson(libraryDoc(cur), doc)) libraryStore.set((s) => ({ ...s, ...doc, loaded: true }));
}

/**
 * True when an ingredient was added or removed, or its image replaced: its binary is already stored (or deleted), so
 * the metadata is saved right away instead of debounced — a tab closed a moment later must not orphan the file.
 */
function ingredientFilesChanged(prev = [], next = []) {
  if (prev === next) return false;
  if (prev.length !== next.length) return true;
  const before = new Map(prev.map((i) => [i.id, i]));
  return next.some((i) => {
    const b = before.get(i.id);
    return !b || b.size !== i.size || b.mime !== i.mime || b.width !== i.width || b.height !== i.height;
  });
}

// ---------------------------------------------------------------------------------------------------------
// UI prefs: each window writes only the keys it changed; settings changed elsewhere apply here too
// ---------------------------------------------------------------------------------------------------------

let storedPrefs = {}; // what `gis:ui` holds, as far as this window knows
const uiDirty = new Set();
let applyingStoredPrefs = false;

function writeUiPrefs() {
  if (!uiDirty.size) return;
  const ui = uiStore.get();
  const next = { ...storedPrefs };
  for (const k of uiDirty) next[k] = ui[k];
  uiDirty.clear();
  storedPrefs = next;
  try {
    chrome?.storage?.local?.set({ [UI_PREFS_KEY]: next })?.catch?.(() => {});
  } catch {
    /* not in extension context */
  }
}
const saveUiSoon = debounce(writeUiPrefs, 500);

async function loadUiPrefs() {
  try {
    const got = await chrome.storage.local.get(UI_PREFS_KEY);
    const prefs = got?.[UI_PREFS_KEY];
    if (prefs && typeof prefs === 'object') {
      storedPrefs = { ...prefs };
      uiStore.set((s) => ({ ...s, ...prefs, binFilter: { ...s.binFilter, ...(prefs.binFilter || {}) } }));
    }
  } catch {
    /* ignore */
  }
}

/** Another window (or the content script) changed `gis:ui`: settings follow, per-window view state does not. */
function watchUiPrefs() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[UI_PREFS_KEY]) return;
      const next = changes[UI_PREFS_KEY].newValue || {};
      storedPrefs = { ...next };
      const ui = uiStore.get();
      const patch = {};
      for (const k of SYNCED_UI_KEYS) if (k in next && !uiDirty.has(k) && !sameJson(next[k], ui[k])) patch[k] = next[k];
      if (!Object.keys(patch).length) return;
      applyingStoredPrefs = true;
      try {
        uiStore.set((s) => ({ ...s, ...patch }));
      } finally {
        applyingStoredPrefs = false;
      }
    });
  } catch {
    /* not in extension context */
  }
}

async function loadLibrary() {
  const lib = (await db.kvGet(LIBRARY_KEY)) || {};
  libraryBase = snapshot(lib);
  libraryStore.set((s) => ({ ...s, ...stripSaveMeta(lib), loaded: true }));
}

export async function refreshProjectsList() {
  const all = await db.listProjects();
  projectsListStore.set(() => all.map((p) => M.projectSummary(M.normalizeProject(p))));
  return all;
}

function setProject(project) {
  releaseRuntime(project.mediaOrder);
  projectBase = snapshot(project);
  projectStore.load(stripSaveMeta(project));
  uiStore.set((s) => ({ ...s, selection: [], binSelection: [], playhead: 0, playing: false, sourceMediaId: null, sourceIn: null, sourceOut: null }));
  db.kvSet(LAST_PROJECT_KEY, project.id).catch(() => {});
  appEvents.emit('project.loaded', { project });
  resumePendingMedia();
}

/** Merges what another window stored for the open project into this one (no-op when nothing new is stored). */
async function pullStoredProject() {
  const cur = projectStore.get();
  if (!cur) return;
  const stored = await db.getProject(cur.id);
  if (!stored || stored.saveId === projectBase?.saveId || projectStore.get()?.id !== cur.id) return;
  const merged = projectBase ? M.mergeProjects(projectBase, projectStore.get(), stripSaveMeta(stored)) : stored;
  projectBase = snapshot(stored);
  adoptProject(merged);
}

// ---------------------------------------------------------------------------------------------------------
// Project management
// ---------------------------------------------------------------------------------------------------------

export async function newProject(name = 'Untitled sequence') {
  const cur = projectStore.get();
  if (cur) await saveProjectSoon.flush(cur);
  const p = M.createProject(name);
  await db.putProject(p);
  setProject(p);
  await refreshProjectsList();
  return p;
}

export async function openProject(id) {
  const cur = projectStore.get();
  if (cur?.id === id) return cur;
  if (cur) await saveProjectSoon.flush(cur); // merging save, never a blind overwrite
  const raw = await db.getProject(id);
  if (!raw) {
    refreshProjectsList().catch(() => {});
    throw new Error('That sequence no longer exists (it was deleted in another window)');
  }
  const p = M.normalizeProject(raw);
  setProject(p);
  return p;
}

export async function duplicateProject(id = projectStore.get()?.id) {
  const raw = id === projectStore.get()?.id ? projectStore.get() : await db.getProject(id);
  if (!raw) return null;
  const now = Date.now();
  const copy = { ...structuredClone(stripSaveMeta(raw)), id: M.createProject().id, name: `${raw.name} (copy)`, createdAt: now, updatedAt: now };
  await db.putProject(copy);
  await refreshProjectsList();
  return copy;
}

export async function deleteProject(id) {
  deletedHere.add(id);
  if (projectStore.get()?.id === id) saveProjectSoon.cancel();
  await db.deleteProject(id);
  channel?.postMessage({ type: 'project-deleted', id, by: INSTANCE_ID });
  const list = await refreshProjectsList();
  if (projectStore.get()?.id === id) {
    if (list.length) setProject(M.normalizeProject(list[0]));
    else await newProject();
  }
  scheduleGarbageCollection();
}

let restoreRefs = new Set(); // media of a sequence deleted elsewhere that can still be restored from here
let restoreTimer = null;

/**
 * The open sequence no longer exists in storage (deleted in another window): switch to another one and offer the
 * last state seen here back ('project.removed'); its files stay protected from storage cleanup meanwhile.
 */
async function projectRemovedElsewhere(id) {
  const cur = projectStore.get();
  if (deletedHere.has(id) || cur?.id !== id) return;
  deletedHere.add(id); // handled once; later saves of it are dropped (restoreProject clears this)
  const copy = snapshot(stripSaveMeta(cur));
  saveProjectSoon.cancel();
  restoreRefs = new Set(Object.keys(copy.media || {}));
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => (restoreRefs = new Set()), RESTORE_KEEP_MS);
  const list = await refreshProjectsList();
  if (projectStore.get()?.id !== id) return;
  if (list.length) setProject(M.normalizeProject(list[0]));
  else await newProject();
  appEvents.emit('project.removed', { project: copy });
}

/** Saves a sequence offered by 'project.removed' again and opens it. */
export async function restoreProject(project) {
  const p = M.normalizeProject({ ...stripSaveMeta(project), updatedAt: Date.now() });
  deletedHere.delete(p.id);
  await db.putProject(p);
  clearTimeout(restoreTimer);
  restoreRefs = new Set();
  await refreshProjectsList();
  return openProject(p.id);
}

export function renameCurrentProject(name) {
  projectStore.update((p) => M.renameProject(p, name), { label: 'Rename project' });
}

/** Project JSON (media binaries are referenced by source URL only). */
export function exportProjectJson(project = projectStore.get()) {
  return new Blob([JSON.stringify({ format: 'grok-imagine-studio-project', version: 1, project: stripSaveMeta(project) }, null, 2)], { type: 'application/json' });
}

export async function importProjectJson(file) {
  const data = JSON.parse(await file.text());
  const raw = data?.project || data;
  if (!raw || typeof raw !== 'object' || !raw.tracks) throw new Error('Not a Grok Imagine Studio project file');
  // Only http(s) links survive as source / page URLs: a project file is foreign input like a web page.
  const media = Object.fromEntries(Object.entries(raw.media && typeof raw.media === 'object' ? raw.media : {}).map(([id, m]) => [id, m && typeof m === 'object' ? sanitizeMediaUrls(m) : m]));
  const p = M.normalizeProject({ ...stripSaveMeta(raw), media, id: M.createProject().id, name: raw.name || file.name.replace(/\.json$/i, '') });
  await db.putProject(p);
  setProject(p);
  await refreshProjectsList();
  return p;
}

// ---------------------------------------------------------------------------------------------------------
// Storage cleanup: binaries nothing references — in storage or in any open studio window
// ---------------------------------------------------------------------------------------------------------

/** Ids this window still needs: its sequence, undo/redo history, library, a restorable sequence, fresh writes. */
function localReferences() {
  const ids = new Set(db.recentKeys());
  const cur = projectStore.get();
  if (cur) for (const id of Object.keys(cur.media)) ids.add(id);
  for (const id of projectStore.historyMediaIds()) ids.add(id);
  for (const ing of libraryStore.get().ingredients || []) ids.add(ing.id);
  for (const id of restoreRefs) ids.add(id);
  return [...ids];
}

const gcWaiters = new Map(); // request id -> handler of the other windows' answers

/**
 * The references of every other open studio window (each holds a 'gis-window:<id>' Web Lock while open and answers
 * on the BroadcastChannel). Rejects when one of them does not answer in time: nothing may be deleted then.
 */
async function otherWindowsReferences(timeoutMs = 8000) {
  if (!channel || !navigator.locks?.query) throw new Error('cannot reach the other studio windows');
  const { held = [] } = await navigator.locks.query();
  const others = new Set(held.map((l) => l.name || '').filter((n) => n.startsWith(WINDOW_LOCK_PREFIX)).map((n) => n.slice(WINDOW_LOCK_PREFIX.length)));
  others.delete(INSTANCE_ID);
  if (!others.size) return [];
  const reqId = uid('gc');
  return new Promise((resolve, reject) => {
    const ids = new Set();
    const timer = setTimeout(() => {
      gcWaiters.delete(reqId);
      reject(new Error('another studio window did not answer'));
    }, timeoutMs);
    gcWaiters.set(reqId, (msg) => {
      for (const id of Array.isArray(msg.ids) ? msg.ids : []) ids.add(id);
      others.delete(msg.by);
      if (others.size) return;
      clearTimeout(timer);
      gcWaiters.delete(reqId);
      resolve([...ids]);
    });
    channel.postMessage({ type: 'gc-refs?', reqId, by: INSTANCE_ID });
  });
}

/**
 * Deletes stored binaries and previews that nothing references: no saved sequence or library, and no open studio
 * window (its sequence, undo history, library, imports not saved yet). graceMs: delete only files unreferenced for
 * at least that long (automatic runs); 0 deletes them now (the menu's "Clean up unused storage"). Rejects — deleting
 * nothing — when another studio window does not report its references. Resolves {removed, bytes, waiting}.
 */
export async function runGarbageCollection({ graceMs = 0 } = {}) {
  const run = async () => {
    const [projects, others, lib] = await Promise.all([db.listProjects(), otherWindowsReferences(), db.kvGet(LIBRARY_KEY).catch(() => null)]);
    const keep = new Set([...others, ...localReferences()]);
    for (const p of projects) for (const id of Object.keys(p.media || {})) keep.add(id);
    for (const ing of lib?.ingredients || []) keep.add(ing.id);
    const res = await db.collectGarbage([...keep], { graceMs });
    if (res.removed) console.info(`[gis] storage cleanup removed ${res.removed} unused files`);
    return res;
  };
  return navigator.locks?.request ? navigator.locks.request('gis-gc', run) : run(); // one cleanup at a time
}

let gcTimer = null;
/** Automatic cleanup after `delay` ms (files must have stayed unreferenced for GC_GRACE_MS). */
export function scheduleGarbageCollection(delay = 15000) {
  clearTimeout(gcTimer);
  gcTimer = setTimeout(() => {
    runGarbageCollection({ graceMs: GC_GRACE_MS }).catch((e) => console.info('[gis] storage cleanup skipped:', e?.message || e));
  }, delay);
}

// ---------------------------------------------------------------------------------------------------------
// Other studio windows (overlay in another grok.com tab, standalone tabs)
// ---------------------------------------------------------------------------------------------------------

async function onChannelMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.by === INSTANCE_ID) return;
  if (msg.type === 'project-saved') {
    const cur = projectStore.get();
    if (cur && msg.id === cur.id && msg.saveId !== projectBase?.saveId) await pullStoredProject();
    refreshProjectsList();
  } else if (msg.type === 'project-deleted') {
    await refreshProjectsList();
    if (projectStore.get()?.id === msg.id) await projectRemovedElsewhere(msg.id);
  } else if (msg.type === 'library-saved') {
    if (msg.saveId && msg.saveId === libraryBase?.saveId) return;
    const stored = (await db.kvGet(LIBRARY_KEY)) || {};
    if (stored.saveId === libraryBase?.saveId) return;
    const merged = libraryBase ? mergeLibrary(libraryBase, libraryDoc(libraryStore.get()), stored) : stripSaveMeta(stored);
    libraryBase = snapshot(stored);
    adoptLibrary(merged);
  } else if (msg.type === 'gc-refs?') {
    channel?.postMessage({ type: 'gc-refs', reqId: msg.reqId, by: INSTANCE_ID, ids: localReferences() });
  } else if (msg.type === 'gc-refs') {
    gcWaiters.get(msg.reqId)?.(msg);
  }
}

function connectWindows() {
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e) => {
      onChannelMessage(e.data).catch((err) => console.warn('[gis] message from another studio window failed', err));
    };
  } catch {
    channel = null; // BroadcastChannel unavailable
  }
  // Held until this window closes: storage cleanups elsewhere wait for this window's answer (registered above).
  try {
    navigator.locks?.request(WINDOW_LOCK_PREFIX + INSTANCE_ID, () => new Promise(() => {})).catch(() => {});
  } catch {
    /* Web Locks unavailable */
  }
}

// ---------------------------------------------------------------------------------------------------------
// Collecting grok.com media
// ---------------------------------------------------------------------------------------------------------

/**
 * Adds grok.com items to the bin like importPageItems(), coordinated across studio windows: one window at a time
 * (Web Lock per project) merges what the others stored, imports only what is still missing and stores it before
 * letting the next one look — so two windows watching the same grok.com tab never import a generation twice.
 * Use it for automatic imports (auto-collect, take linking). Resolves the media ids like importPageItems().
 */
export async function collectPageItems(items, opts = {}) {
  const project = projectStore.get();
  if (!project || !items.length) return [];
  const run = async () => {
    await pullStoredProject().catch(() => {});
    if (projectStore.get()?.id !== project.id) return [];
    const missing = items.filter((it) => !M.findMediaForPageItem(projectStore.get(), it));
    const ids = await importPageItems(items, opts);
    if (missing.length && projectStore.get()?.id === project.id) await saveProjectSoon.flush(projectStore.get());
    return ids;
  };
  return navigator.locks?.request ? navigator.locks.request(`gis-collect:${project.id}`, run) : run();
}

// ---------------------------------------------------------------------------------------------------------
// Bridge wiring
// ---------------------------------------------------------------------------------------------------------

function binKeys() {
  const p = projectStore.get();
  if (!p) return [];
  return p.mediaOrder.map((id) => p.media[id]?.pageKey).filter(Boolean);
}

const pushBinKeys = debounce(() => bridge.emit(STUDIO_EVT.BIN_KEYS, { keys: binKeys() }), 300);

/** Pulls the page state (info, detected media, dock) — on boot and after every (re)connection. */
async function syncFromPage() {
  if (!bridge.connected) return;
  try {
    const [info, scan, dock] = await Promise.all([
      bridge.request(REQ.PAGE_INFO).catch(() => null),
      bridge.request(REQ.PAGE_SCAN).catch(() => null),
      bridge.mode === 'embedded' ? bridge.request(REQ.UI_GET_DOCK).catch(() => null) : null,
    ]);
    const cleanInfo = sanitizePageInfo(info);
    const items = scan && Array.isArray(scan.items) ? sanitizePageMediaList(scan.items) : null;
    pageStore.set((s) => ({ ...s, info: cleanInfo || s.info, items: items || s.items }));
    const mode = sanitizeDockMode(dock?.mode);
    if (mode) uiStore.set((s) => ({ ...s, dock: mode }));
    pushBinKeys();
  } catch (e) {
    console.warn('[gis] page sync failed', e);
  }
}

const failedImport = (e) => console.warn('[gis] import from grok.com failed', e);

function wireBridge() {
  bridge.init();
  pageStore.set((s) => ({ ...s, connected: bridge.connected, mode: bridge.mode }));
  bridge.onStatus(({ connected, mode }) => {
    pageStore.set((s) => ({ ...s, connected, mode }));
    if (connected) syncFromPage();
  });
  bridge.handle(STUDIO_REQ.BIN_KEYS, () => ({ keys: binKeys() }));

  bridge.on(EVT.PAGE_MEDIA, ({ items = [] } = {}) => {
    const list = sanitizePageMediaList(items);
    pageStore.set((s) => ({ ...s, items: list }));
    const ui = uiStore.get();
    if (ui.autoCollect || ui.autoCollectImages) {
      // Only genuinely new generations: the content script flags them (it.fresh); older content scripts without the
      // flag fall back to "first seen after auto-collect was switched on".
      const isNew = (it) => (typeof it.fresh === 'boolean' ? it.fresh && it.seenAt >= autoCollectSince : it.seenAt >= autoCollectSince);
      const fresh = list.filter((it) => isNew(it) && ((ui.autoCollect && it.kind === 'video') || (ui.autoCollectImages && it.kind === 'image')));
      const p = projectStore.get();
      const missing = fresh.filter((it) => !M.findMediaForPageItem(p, it));
      if (missing.length) collectPageItems(missing).catch(failedImport);
    }
  });
  bridge.on(EVT.PAGE_ADD, ({ items = [], flag = null, target = 'bin' } = {}) => {
    // An explicit user action on grok.com: links to other sites are allowed (fetched through the page only).
    const list = sanitizePageMediaList(items, { userTarget: true }, 200);
    if (list.length) importPageItems(list, { flag: sanitizeFlag(flag), toTimeline: target === 'timeline' }).catch(failedImport);
  });
  bridge.on(EVT.PAGE_INGREDIENT, ({ item } = {}) => {
    const clean = sanitizePageMedia(item, { userTarget: true });
    if (clean) appEvents.emit('ingredient.fromPage', { item: clean });
  });
  bridge.on(EVT.PAGE_IMPORT_TEXT, ({ text } = {}) => {
    const clean = sanitizeText(text);
    if (clean.trim()) appEvents.emit('prompts.importText', { text: clean });
  });
  bridge.on(EVT.PAGE_NAVIGATED, (info) => {
    const clean = sanitizePageInfo(info);
    if (clean) pageStore.set((s) => ({ ...s, info: clean }));
  });
  bridge.on(EVT.UI_VISIBILITY, ({ mode } = {}) => {
    const m = sanitizeDockMode(mode);
    if (m) uiStore.set((s) => (s.dock === m ? s : { ...s, dock: m }));
  });

  bridge.appReady(); // all handlers registered: acknowledge the page connection
  syncFromPage();

  // Keep the page's "already in bin" badges current.
  let lastKeys = '';
  projectStore.subscribe((p) => {
    const keys = p ? p.mediaOrder.map((id) => p.media[id]?.pageKey).join('|') : '';
    if (keys !== lastKeys) {
      lastKeys = keys;
      pushBinKeys();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------------------

/** Writes whatever is still waiting for its debounce: the window is going away (tab closed, reloaded, hidden). */
// An IndexedDB write started while the page unloads may never land (the page can be torn down first), so unsaved
// project state is also journaled synchronously to localStorage and merged back in at the next start.
const JOURNAL_KEY = 'gis:journal:project';
const JOURNAL_MAX_CHARS = 3_000_000;
function writeJournal(project) {
  try {
    const json = JSON.stringify({ instance: INSTANCE_ID, base: projectBase, project });
    if (json.length <= JOURNAL_MAX_CHARS) localStorage.setItem(JOURNAL_KEY, json);
  } catch {
    /* storage full or unavailable: the IndexedDB save is still attempted */
  }
}
function clearJournal() {
  try {
    localStorage.removeItem(JOURNAL_KEY);
  } catch {
    /* ignore */
  }
}
const LIB_JOURNAL_KEY = 'gis:journal:library';
function writeLibraryJournal(lib) {
  try {
    const json = JSON.stringify({ base: libraryBase, doc: libraryDoc(lib) });
    if (json.length <= JOURNAL_MAX_CHARS) localStorage.setItem(LIB_JOURNAL_KEY, json);
  } catch {
    /* storage full or unavailable */
  }
}
function clearLibraryJournal() {
  try {
    localStorage.removeItem(LIB_JOURNAL_KEY);
  } catch {
    /* ignore */
  }
}
/** Library counterpart of recoverJournal(). */
async function recoverLibraryJournal() {
  let journal = null;
  try {
    journal = JSON.parse(localStorage.getItem(LIB_JOURNAL_KEY) || 'null');
  } catch {
    /* corrupt */
  }
  clearLibraryJournal();
  if (!journal?.doc) return;
  await db.kvUpdate(LIBRARY_KEY, (stored) => {
    const theirs = stored || {};
    const merged = journal.base ? mergeLibrary(stripSaveMeta(journal.base), journal.doc, theirs) : { ...stripSaveMeta(theirs), ...journal.doc };
    return { ...stripSaveMeta(merged), saveId: uid('lib'), savedBy: INSTANCE_ID };
  });
}

/** Merges a journal left by a window that closed before its last save landed. */
async function recoverJournal() {
  let journal = null;
  try {
    journal = JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null');
  } catch {
    /* corrupt: drop it */
  }
  clearJournal();
  if (!journal?.project?.id) return;
  const mine = stripSaveMeta(journal.project);
  await db.updateProject(mine.id, (stored) => {
    if (!stored) return undefined; // the sequence was deleted meanwhile
    const merged = journal.base ? M.mergeProjects(stripSaveMeta(journal.base), mine, stripSaveMeta(stored)) : mine;
    return { ...stripSaveMeta(merged), saveId: uid('sv'), savedBy: INSTANCE_ID };
  });
}

// Unsaved project state is journaled on every change (coalesced per task), not only on unload: a closing tab can
// tear down this frame before any unload handler runs. Cleared once the IndexedDB save has landed.
let journalQueued = false;
function scheduleJournal() {
  if (journalQueued) return;
  journalQueued = true;
  queueMicrotask(() => {
    journalQueued = false;
    const p = projectStore.get();
    if (p && saveProjectSoon.pending) writeJournal(p);
  });
}

function flushPendingSaves() {
  if (saveProjectSoon.pending) {
    saveProjectSoon.cancel();
    const p = projectStore.get();
    if (p) {
      writeJournal(p);
      // not queued behind an earlier save: the write must start before the page is gone
      Promise.resolve(saveProject(p)).then(clearJournal, () => {});
    }
  }
  if (saveLibrarySoon.pending) {
    saveLibrarySoon.cancel();
    saveLibrary(libraryStore.get());
  }
  if (saveUiSoon.pending) saveUiSoon.flush();
}

export async function initApp() {
  await db.open();
  await recoverJournal().catch((e) => console.warn('[gis] could not recover unsaved changes', e));
  await recoverLibraryJournal().catch((e) => console.warn('[gis] could not recover unsaved library changes', e));
  await loadUiPrefs();
  await loadLibrary();
  connectWindows();
  const all = await refreshProjectsList();
  const lastId = await db.kvGet(LAST_PROJECT_KEY);
  const raw = all.find((p) => p.id === lastId) || all[0];
  let project = raw ? M.normalizeProject(raw) : null;
  if (!project) {
    project = M.createProject('My first sequence');
    await db.putProject(project);
    await refreshProjectsList();
  }

  projectStore.subscribe((p) => {
    if (!p) return;
    saveProjectSoon(p);
    scheduleJournal();
  });
  // Placeholder clips (autoOut) whose media is now probed take the real duration — also after undo/redo or a
  // merge from another window brings back a pre-download snapshot.
  projectStore.subscribe((p) => {
    if (!p) return;
    const needs = (c) => c.autoOut && p.media[c.mediaId]?.status === 'ready' && p.media[c.mediaId].duration > 0;
    if (!p.tracks.video.some(needs) && !p.tracks.audio.some(needs)) return;
    queueMicrotask(() =>
      projectStore.update(
        (q) => {
          let r = q;
          for (const c of [...q.tracks.video, ...q.tracks.audio]) {
            const m = q.media[c.mediaId];
            if (c.autoOut && m?.status === 'ready' && m.duration > 0) r = M.updateClip(r, c.id, { out: m.duration });
          }
          return r;
        },
        { history: false },
      ),
    );
  });
  let prevLib = libraryStore.get();
  libraryStore.subscribe((lib) => {
    const before = prevLib;
    prevLib = lib;
    if (!lib.loaded) return;
    if (ingredientFilesChanged(before.ingredients, lib.ingredients)) saveLibrarySoon.flush(lib);
    else saveLibrarySoon(lib);
    writeLibraryJournal(lib); // cleared once the save lands (see saveLibrary)
  });
  let prevUi = uiStore.get();
  uiStore.subscribe((ui) => {
    const changed = PERSISTED_UI_KEYS.filter((k) => ui[k] !== prevUi[k]);
    if (changed.length && !applyingStoredPrefs) {
      for (const k of changed) uiDirty.add(k);
      saveUiSoon();
    }
    if ((ui.autoCollect && !prevUi.autoCollect) || (ui.autoCollectImages && !prevUi.autoCollectImages)) autoCollectSince = Date.now();
    prevUi = ui;
  });
  autoCollectSince = Date.now();
  watchUiPrefs();

  window.addEventListener('beforeunload', flushPendingSaves);
  window.addEventListener('pagehide', flushPendingSaves);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushPendingSaves());

  wireBridge();
  setProject(project);
  scheduleGarbageCollection(30000);
}
