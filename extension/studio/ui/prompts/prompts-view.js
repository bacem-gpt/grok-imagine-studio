// Prompts tab: shot list / storyboard, shot editor (prompt, builder, references, takes, variations) and the library
// (snippets, bible, templates, import). Responsive: three columns when wide; at medium widths the left column
// switches between the shot list and the library (the editor stays visible); one pane with a switcher when docked
// narrow (~480 px).
import { html, useEffect, useMemo } from '../../../vendor/preact-htm.mjs';
import { useStore, useElementSize, useProject } from '../hooks.js';
import { useHotkeys, isTypingTarget, comboFromEvent, modalOpen } from '../hotkeys.js';
import { Segmented, cx } from '../kit.js';
import { projectStore } from '../../core/store.js';
import * as S from '../../prompts/shots.js';
import { ShotList } from './shot-list.js';
import { ShotEditor } from './shot-editor.js';
import { LibraryPanel } from './library-panel.js';
import { PasteListModal, AssembleDialog, QueueDialog } from './dialogs.js';
import { LinkTakesDialog } from './takes.js';
import { promptsUi, setUi, selectShot, selectRelative, sendShot, duplicateShot, newShot } from './state.js';
import './take-watcher.js'; // starts linking generated videos to sent shots (from boot, whichever tab is open)

const WIDE = 1080;
const MEDIUM = 700;

const anyModalOpen = () => !!document.querySelector('.modal-backdrop');

/** Shots created by other tabs (or older versions) may be partial: complete them quietly. */
function useShotRepair() {
  useEffect(() => {
    const fix = () => {
      const p = projectStore.get();
      if (p && S.repairShots(p) !== p) projectStore.update((q) => S.repairShots(q), { history: false });
    };
    fix();
    return projectStore.subscribe(fix);
  }, []);
}

/** Keeps a valid shot selected (first shot when the selection disappears). */
function useSelectionGuard() {
  const ids = useProject((p) => S.getShots(p).map((s) => s.id).join('|'));
  const selectedId = useStore(promptsUi, (s) => s.selectedId);
  useEffect(() => {
    const list = ids ? ids.split('|') : [];
    if (!list.length) {
      if (selectedId) selectShot(null);
    } else if (!selectedId || !list.includes(selectedId)) selectShot(list[0]);
  }, [ids, selectedId]);
}

/** Shortcuts while typing in a field of this view (hotkeys.js lets only a few combos through while typing). */
const TYPING_COMBOS = {
  'mod+shift+enter': () => sendShot(undefined, { submit: true }),
  'alt+arrowup': () => selectRelative(-1),
  'alt+arrowdown': () => selectRelative(1),
  'mod+d': () => duplicateShot(),
  'mod+n': () => newShot(),
};

/**
 * Alt+N = new shot (Chrome keeps Ctrl/⌘+N for a new window). Matched on the key, or on the physical N key when the
 * key is a dead key / symbol: macOS Option+N types "˜", so e.key is never 'n' there.
 */
const isNewShotKey = (e) =>
  e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && ((e.key || '').toLowerCase() === 'n' || (e.code === 'KeyN' && !/^[a-z0-9]$/i.test(e.key || '')));

export function PromptsView({ active }) {
  const [ref, size] = useElementSize();
  const width = size.width || window.innerWidth;
  const layout = width >= WIDE ? 'wide' : width >= MEDIUM ? 'medium' : 'narrow';
  const ui = useStore(promptsUi, (s) => ({ pane: s.pane, libraryOpen: s.libraryOpen, paste: s.paste, dialog: s.dialog }));
  const shotCount = useProject((p) => S.getShots(p).length);

  useShotRepair();
  useSelectionGuard();

  // Shot shortcuts don't fire from dialogs or while typing in the library (snippet / template forms).
  const guard = (fn) => (e) => {
    if (anyModalOpen() || (isTypingTarget(e.target) && e.target.closest?.('.pr-lib'))) return false;
    fn(e);
  };
  useHotkeys(
    {
      'mod+enter': guard(() => sendShot(undefined, { submit: false })),
      'mod+shift+enter': guard(() => sendShot(undefined, { submit: true })),
      'alt+arrowup': guard(() => selectRelative(-1)),
      'alt+arrowdown': guard(() => selectRelative(1)),
      'mod+d': guard(() => duplicateShot()),
      'mod+n': guard(() => newShot()),
    },
    { enabled: active },
  );

  // Alt+N, also while typing in the editor or the shot list (see isNewShotKey).
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.isComposing || e.repeat || !isNewShotKey(e)) return;
      if (anyModalOpen() || modalOpen()) return;
      if (isTypingTarget(e.target) && !e.target.closest?.('.pr-editor, .pr-list')) return;
      e.preventDefault();
      newShot();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const onKeyDown = (e) => {
    if (!active || e.defaultPrevented || e.isComposing || !isTypingTarget(e.target)) return;
    if (!e.target.closest('.pr-editor, .pr-list') || e.target.closest('.modal-backdrop')) return;
    const fn = TYPING_COMBOS[comboFromEvent(e)];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  const paneOptions = useMemo(
    () => [
      { value: 'list', label: shotCount ? `Shots · ${shotCount}` : 'Shots', icon: 'list' },
      { value: 'editor', label: 'Editor', icon: 'edit' },
      { value: 'library', label: 'Library', icon: 'book' },
    ],
    [shotCount],
  );

  // Medium widths: the left column shows either the shot list or the library; the editor stays fully visible.
  const sideLibrary = layout === 'medium' && ui.libraryOpen;
  const sideSwitch =
    layout === 'medium' &&
    html`<div class="pr-side-switch">
      <${Segmented}
        value=${sideLibrary ? 'library' : 'list'}
        options=${[paneOptions[0], paneOptions[2]]}
        onChange=${(v) => setUi({ libraryOpen: v === 'library' })}
      />
    </div>`;
  const showLibrary = layout !== 'medium' || sideLibrary;
  const dialog = ui.dialog;
  return html`<div class=${cx('pr-root', `is-${layout}`, layout === 'narrow' && `pane-${ui.pane}`)} ref=${ref} onKeyDown=${onKeyDown}>
    ${layout === 'narrow' && html`<div class="pr-nav"><${Segmented} value=${ui.pane} options=${paneOptions} onChange=${(v) => setUi({ pane: v })} /></div>`}
    <div class="pr-cols">
      <div class="pr-col pr-col-list" hidden=${sideLibrary}>${sideSwitch}<${ShotList} layout=${layout} /></div>
      <div class="pr-col pr-col-editor"><${ShotEditor} layout=${layout} /></div>
      ${showLibrary && html`<div class="pr-col pr-col-lib">${sideSwitch}<${LibraryPanel} layout=${layout} /></div>`}
    </div>
    ${ui.paste && html`<${PasteListModal} key=${ui.paste.n} initial=${ui.paste} onClose=${() => setUi({ paste: null })} />`}
    ${dialog === 'assemble' && html`<${AssembleDialog} onClose=${() => setUi({ dialog: null })} />`}
    ${dialog === 'queue' && html`<${QueueDialog} onClose=${() => setUi({ dialog: null })} />`}
    ${dialog?.type === 'link' && html`<${LinkTakesDialog} shotId=${dialog.shotId} onClose=${() => setUi({ dialog: null })} />`}
  </div>`;
}
