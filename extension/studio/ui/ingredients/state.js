// View state of the Ingredients tab (module-level so app events can select freshly added images even while the
// tab is hidden). Small per-viewer preferences (sort, density, thumbnail fit) persist in localStorage.
import { createStore, libraryStore } from '../../core/store.js';
import { filterIngredients } from './logic.js';

const PREFS_KEY = 'gis:ingredients:prefs';
const PREF_KEYS = ['sort', 'density', 'fit'];

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    const out = {};
    for (const k of PREF_KEYS) if (typeof raw[k] === 'string') out[k] = raw[k];
    return out;
  } catch {
    return {};
  }
}

export const ingStore = createStore({
  search: '',
  tags: [], // active tag filters (AND)
  sort: 'newest',
  density: 'm', // 's' | 'm' | 'l'
  fit: 'cover', // thumbnail fit: 'cover' | 'contain'
  selection: [], // selected ingredient ids
  focusId: null, // keyboard cursor / inspector subject
  anchorId: null, // shift-click range anchor
  editorId: null, // ingredient open in the editor workspace
  editorTab: 'edit', // 'edit' | 'details'
  composerIds: null, // ids when the grid composer is open
  dialog: null, // 'page' | 'bin' | null
  dialogArg: null, // e.g. preselected bin media id
  busy: 0, // pending imports
  flash: [], // recently added ids (highlight animation)
  ...loadPrefs(),
});

let lastPrefs = '';
ingStore.subscribe((s) => {
  const prefs = JSON.stringify(Object.fromEntries(PREF_KEYS.map((k) => [k, s[k]])));
  if (prefs === lastPrefs) return;
  lastPrefs = prefs;
  try {
    localStorage.setItem(PREFS_KEY, prefs);
  } catch {
    /* storage unavailable (private window, blocked site data) */
  }
});

/** Shallow-merge a patch into the view state. */
export const setIng = (patch) => ingStore.set((s) => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));

/** Selects ids (and focuses the first one). */
export function selectIds(ids, { focus = true } = {}) {
  setIng({ selection: [...ids], ...(focus ? { focusId: ids[0] ?? null, anchorId: ids[0] ?? null } : {}) });
}

let flashTimer = null;
/**
 * Selects ids (clearing a search/tag filter that would hide them) and, with flash, highlights them briefly
 * (freshly added images).
 */
export function revealIds(ids, { flash = true } = {}) {
  if (!ids.length) return;
  const s = ingStore.get();
  let unfilter = null;
  if (s.search.trim() || s.tags.length) {
    const visible = new Set(filterIngredients(libraryStore.get().ingredients, { search: s.search, tags: s.tags }).map((i) => i.id));
    if (ids.some((id) => !visible.has(id))) unfilter = { search: '', tags: [] };
  }
  setIng({ ...unfilter, selection: [...ids], focusId: ids[0], anchorId: ids[0], ...(flash ? { flash: [...ids] } : null) });
  if (!flash) return;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setIng({ flash: [] }), 1600);
}

// The open image editor registers a guard that resolves true when it may be left (it asks about unsaved edits),
// so switching to another image never drops edits silently.
let editorGuard = null;
export const setEditorGuard = (fn) => {
  editorGuard = fn;
};
export const clearEditorGuard = (fn) => {
  if (editorGuard === fn) editorGuard = null;
};
/** Resolves true when the open editor (if any) may be left. */
export const canLeaveEditor = async () => (editorGuard ? !!(await editorGuard()) : true);

/** Wraps an async job so the toolbar shows a busy indicator while it runs. */
export async function withBusy(fn) {
  setIng((s) => ({ busy: s.busy + 1 }));
  try {
    return await fn();
  } finally {
    setIng((s) => ({ busy: Math.max(0, s.busy - 1) }));
  }
}
