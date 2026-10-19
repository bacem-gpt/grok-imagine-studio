// Minimal observable stores. Pure (no DOM / Preact) so the history logic is unit-testable.
// UI components read them with useStore() from ui/hooks.js.

/** Generic store: get(), set(partial | updater), subscribe(listener) -> unsubscribe. */
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();
  return {
    get: () => state,
    set(updater) {
      const next = typeof updater === 'function' ? updater(state) : { ...state, ...updater };
      if (next === state || next === undefined) return;
      const prev = state;
      state = next;
      for (const l of [...listeners]) l(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * Store for the current project with undo/redo.
 *   update(fn, {label, merge})  fn(project) -> new project (return the same object for a no-op).
 *     merge: a string key; consecutive updates with the same key collapse into ONE undo step
 *            (use one key per drag gesture, e.g. `trim-${pointerId}-${startTime}`).
 *     history: false to apply without recording (e.g. background media status updates).
 *   undo(), redo(), canUndo(), canRedo(), load(project) (clears history), get(), subscribe().
 */
export function createProjectStore({ limit = 150 } = {}) {
  const store = createStore(null);
  let past = []; // [{project, label}]
  let future = [];
  let lastMerge = null;
  let lastMergeAt = 0;
  const historyListeners = new Set();
  const notifyHistory = () => historyListeners.forEach((l) => l());

  function apply(next) {
    store.set(() => next);
  }

  return {
    get: store.get,
    subscribe: store.subscribe,
    load(project) {
      past = [];
      future = [];
      lastMerge = null;
      apply(project);
      notifyHistory();
    },
    update(fn, { label = '', merge = null, history = true } = {}) {
      const cur = store.get();
      if (!cur) return cur;
      const next = fn(cur);
      if (!next || next === cur) return cur;
      if (history) {
        const now = Date.now();
        const mergeable = merge && merge === lastMerge && now - lastMergeAt < 60_000;
        if (!mergeable) {
          past.push({ project: cur, label });
          if (past.length > limit) past.shift();
        }
        lastMerge = merge;
        lastMergeAt = now;
        future = [];
        notifyHistory();
      } else if (past.length || future.length) {
        // Non-history updates (media download status, remembered export settings) must survive undo/redo:
        // patch them into the stored snapshots.
        const patchSnap = (snap) => {
          if (!snap.project) return snap;
          let project = snap.project;
          if (project.media && next.media !== cur.media) {
            const media = { ...project.media };
            let changed = false;
            for (const [id, m] of Object.entries(next.media)) {
              if (media[id] && media[id] !== m) {
                media[id] = { ...media[id], ...pickVolatile(m) };
                changed = true;
              }
            }
            if (changed) project = { ...project, media };
          }
          for (const key of VOLATILE_PROJECT_KEYS) if (next[key] !== cur[key]) project = { ...project, [key]: next[key] };
          return project === snap.project ? snap : { ...snap, project };
        };
        past = past.map(patchSnap);
        future = future.map(patchSnap);
      }
      apply(next);
      return next;
    },
    /**
     * Background media updates (download status, probe results): applied to the current state AND to every
     * undo/redo snapshot containing the item — so undoing "Add to bin" mid-download and redoing it later shows the
     * finished item instead of one stuck on 'loading'. Never creates an undo step.
     */
    patchMedia(id, patch) {
      const withPatch = (p) => (p?.media?.[id] ? { ...p, media: { ...p.media, [id]: { ...p.media[id], ...patch } } } : p);
      const patchSnap = (snap) => {
        const project = withPatch(snap.project);
        return project === snap.project ? snap : { ...snap, project };
      };
      past = past.map(patchSnap);
      future = future.map(patchSnap);
      const cur = store.get();
      const next = withPatch(cur);
      if (next !== cur) apply(next);
      return next;
    },
    /** Ends the current merge group so the next update starts a fresh undo step. */
    breakMerge() {
      lastMerge = null;
    },
    undo() {
      const prev = past.pop();
      if (!prev) return false;
      future.push({ project: store.get(), label: prev.label });
      lastMerge = null;
      apply(prev.project);
      notifyHistory();
      return true;
    },
    redo() {
      const nxt = future.pop();
      if (!nxt) return false;
      past.push({ project: store.get(), label: nxt.label });
      lastMerge = null;
      apply(nxt.project);
      notifyHistory();
      return true;
    },
    /** Media ids referenced by any undo/redo snapshot (so storage cleanup never deletes restorable media). */
    historyMediaIds() {
      const ids = new Set();
      for (const snap of [...past, ...future]) for (const id of Object.keys(snap.project?.media || {})) ids.add(id);
      return [...ids];
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undoLabel: () => past[past.length - 1]?.label || '',
    redoLabel: () => future[future.length - 1]?.label || '',
    onHistory(fn) {
      historyListeners.add(fn);
      return () => historyListeners.delete(fn);
    },
  };
}

/** Top-level project keys that are preferences rather than edits (kept across undo/redo when set with history:false). */
const VOLATILE_PROJECT_KEYS = ['exportSettings'];

/** Media fields that reflect background loading rather than user edits (kept across undo/redo). */
function pickVolatile(m) {
  const { status, error, errorStage, size, mime, duration, width, height, hasAudio, fps } = m;
  return { status, error, errorStage, size, mime, duration, width, height, hasAudio, fps };
}

// ---------------------------------------------------------------------------------------------------------
// Application stores (singletons)
// ---------------------------------------------------------------------------------------------------------

/** The open project (undoable). */
export const projectStore = createProjectStore();

/**
 * Transient UI state (not undoable). Persisted keys are listed in PERSISTED_UI_KEYS (saved by app-state.js).
 */
export const uiStore = createStore({
  tab: 'clips', // 'clips' | 'edit' | 'prompts' | 'ingredients'
  dock: 'right', // overlay dock mode reported by the content script
  selection: [], // selected clip ids (timeline)
  binSelection: [], // selected media ids (bin)
  playhead: 0, // timeline seconds
  playing: false,
  zoom: 80, // timeline pixels per second
  snapping: true,
  sourceMediaId: null, // media open in the source monitor
  sourceIn: null, // source monitor marks (seconds)
  sourceOut: null,
  binFilter: { kind: 'all', flag: 'all', minRating: 0, search: '', sort: 'newest' },
  autoCollect: false, // automatically add new grok videos to the bin
  autoCollectImages: false,
  exportOpen: false,
  inspectorOpen: true,
  binOpen: true, // compact bin in the Edit tab
  promptSendMode: 'insert', // 'insert' | 'insert-submit'
  saveIssue: null, // {what: 'project'|'library', message, at} while autosave keeps failing (it retries)
});

/** UI state remembered for the next start (each window writes only the keys it changed). */
export const PERSISTED_UI_KEYS = ['tab', 'zoom', 'snapping', 'binFilter', 'autoCollect', 'autoCollectImages', 'inspectorOpen', 'binOpen', 'promptSendMode'];
/** Settings that take effect in every open studio window as soon as one changes them (the rest is per-window view state). */
export const SYNCED_UI_KEYS = ['autoCollect', 'autoCollectImages', 'promptSendMode', 'snapping'];

/** Connection to grok.com and media detected there. */
export const pageStore = createStore({
  connected: false,
  mode: 'none', // 'embedded' | 'tab' | 'none'
  info: null, // PageInfo
  items: [], // PageMedia[] currently detected on grok.com
});

/**
 * Global library shared by all projects: prepared prompt snippets, custom presets, image ingredients.
 * Shapes are owned by the Prompts / Ingredients tabs; see their modules for details.
 */
export const libraryStore = createStore({
  loaded: false,
  snippets: [], // [{id, title, text, tags, createdAt}]
  presets: [], // custom prompt-builder presets [{id, group, label, text}]
  ingredients: [], // [{id, name, kind:'image', mime, width, height, size, tags, note, origin, sourceUrl, createdAt}]
  templates: [], // saved prompt templates [{id, name, template, fields}]
});

/** Projects list for the picker [{id, name, updatedAt, duration, clipCount, mediaCount}]. */
export const projectsListStore = createStore([]);
