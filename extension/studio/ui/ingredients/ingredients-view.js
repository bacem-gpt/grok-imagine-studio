// Ingredients tab: library of reference images ("ingredients") for Grok — responsive grid with search, tag filters,
// sorting and multi-select; imports from files, the clipboard, URLs, grok.com and the bin; inspector with details;
// image editor workspace; grid composer; actions (attach to Grok, use in shot, add to timeline/bin, copy, download,
// delete). App events 'ingredient.fromPage' / 'ingredient.add' are handled in actions.js at import time.
import { html, useEffect, useMemo, useRef } from '../../../vendor/preact-htm.mjs';
import { useLibrary, usePage, useStore, useElementSize } from '../hooks.js';
import { useHotkeys, isTypingTarget, modalOpen } from '../hotkeys.js';
import { Icon, Button, IconButton, Select, EmptyState, DropZone, Spinner, Kbd, showMenu, cx, MEDIA_DRAG_TYPE } from '../kit.js';
import { formatBytes, pluralize } from '../../core/utils.js';
import { ingStore, setIng } from './state.js';
import { filterIngredients, tagCounts, rangeSelect, moveFocusIndex, urlsFromText, SORTS } from './logic.js';
import {
  pickAndImportFiles,
  pasteFromClipboard,
  promptImportUrl,
  importFiles,
  importFromDataTransfer,
  imageFilesFrom,
  importFromBin,
  attachToGrok,
  addToProject,
  openShotMenu,
  copyIngredient,
  deleteIngredients,
  openEditor,
  openComposer,
  openIngredientMenu,
} from './actions.js';
import { IngredientThumb } from './thumb.js';
import { Inspector } from './details.js';
import { ImageEditor } from './image-editor.js';
import { GridComposer } from './grid-composer.js';
import { PageImportDialog, BinImportDialog } from './import-dialogs.js';
import { projectStore } from '../../core/store.js';

export { IngredientPicker } from './ingredient-picker.js';

const WIDE = 960;
const dialogOpen = () => !!document.querySelector('.modal-backdrop');
/** A dialog or context menu is open: library keys (Escape, Enter, Delete, arrows…) belong to it. */
const anyModalOpen = () => modalOpen() || dialogOpen() || !!document.querySelector('.menu');
const isButtonLike = (el) => !!el && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute?.('role') === 'button');
const hasTextSelection = () => !!String(window.getSelection?.() || '').trim();

/**
 * Paste (Ctrl/⌘+V) of images or image URLs anywhere in the view while `enabled` (library and image editor).
 * Text pastes into fields are left alone.
 */
function usePasteImport(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onPaste = (e) => {
      if (e.defaultPrevented || dialogOpen()) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const files = imageFilesFrom(dt);
      if (!files.length) {
        if (isTypingTarget(e.target)) return; // ordinary text paste
        const urls = urlsFromText(dt.getData('text/uri-list') || dt.getData('text/plain'), dt.getData('text/html'));
        if (!urls.length) return;
      }
      e.preventDefault();
      importFromDataTransfer(dt, { origin: 'paste' });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [enabled]);
}

function addMenu(target, { pageCount, connected }) {
  showMenu(target, [
    { header: 'Add images' },
    { label: 'From files…', icon: 'upload', onClick: () => pickAndImportFiles() },
    { label: 'Paste from clipboard', icon: 'copy', shortcut: 'mod+v', onClick: () => pasteFromClipboard() },
    { label: 'From URL…', icon: 'link', onClick: () => promptImportUrl() },
    { label: connected ? `From grok.com${pageCount ? ` (${pageCount})` : ''}…` : 'From grok.com…', icon: 'sparkles', onClick: () => setIng({ dialog: 'page' }) },
    { label: 'From bin (still or video frame)…', icon: 'film', onClick: () => setIng({ dialog: 'bin', dialogArg: null }) },
  ]);
}

function viewMenu(target, st) {
  showMenu(target, [
    { header: 'Sort' },
    ...SORTS.map((s) => ({ label: s.label, checked: st.sort === s.value, onClick: () => setIng({ sort: s.value }) })),
    '-',
    { header: 'Thumbnails' },
    { label: 'Small', checked: st.density === 's', onClick: () => setIng({ density: 's' }) },
    { label: 'Medium', checked: st.density === 'm', onClick: () => setIng({ density: 'm' }) },
    { label: 'Large', checked: st.density === 'l', onClick: () => setIng({ density: 'l' }) },
    '-',
    { label: 'Fill tiles', checked: st.fit === 'cover', onClick: () => setIng({ fit: 'cover' }) },
    { label: 'Show whole image', checked: st.fit === 'contain', onClick: () => setIng({ fit: 'contain' }) },
  ]);
}

function Card({ ing, selected, focused, flash, fit, onPointer, onToggle }) {
  const tags = ing.tags || [];
  return html`<div
    class=${cx('ing-card', selected && 'is-selected', focused && 'is-focused', flash && 'is-flash')}
    role="option"
    aria-selected=${selected ? 'true' : 'false'}
    data-id=${ing.id}
    title=${ing.prompt ? `${ing.name}\n\n${ing.prompt}` : ing.name}
    onClick=${(e) => onPointer(e, ing.id)}
    onDblClick=${() => openEditor(ing.id)}
    onContextMenu=${(e) => onPointer(e, ing.id, true)}
  >
    <div class="ing-card-media">
      <${IngredientThumb} ing=${ing} fit=${fit} />
      <button
        type="button"
        class="ing-card-check"
        title=${selected ? 'Deselect' : 'Select'}
        aria-label=${selected ? `Deselect ${ing.name}` : `Select ${ing.name}`}
        onClick=${(e) => {
          e.stopPropagation();
          onToggle(ing.id);
        }}
      ><${Icon} name="check" size=${12} /></button>
      <button
        type="button"
        class="ing-card-more"
        title="Actions"
        aria-label=${`Actions for ${ing.name}`}
        onClick=${(e) => {
          e.stopPropagation();
          onPointer(e, ing.id, true);
        }}
      ><${Icon} name="more" size=${14} /></button>
      ${ing.origin === 'page' && html`<span class="ing-card-origin" title="From grok.com">Grok</span>`}
      ${ing.origin === 'grid' && html`<span class="ing-card-origin" title="Reference sheet">Sheet</span>`}
    </div>
    <div class="ing-card-body">
      <div class="ing-card-name">${ing.name}</div>
      <div class="ing-card-meta mono">${ing.width}×${ing.height} · ${formatBytes(ing.size)}</div>
      ${tags.length > 0 &&
      html`<div class="ing-card-tags">
        ${tags.slice(0, 2).map((t) => html`<span class="ing-mini-tag" key=${t}>${t}</span>`)}
        ${tags.length > 2 && html`<span class="ing-mini-tag is-more">+${tags.length - 2}</span>`}
      </div>`}
    </div>
  </div>`;
}

function LibraryEmpty({ connected, pageCount }) {
  return html`<div class="ing-empty">
    <${EmptyState}
      icon="images"
      title="Build your reference library"
      action=${html`
        <${Button} kind="primary" icon="upload" onClick=${() => pickAndImportFiles()}>Import images<//>
        <${Button} icon="copy" onClick=${() => pasteFromClipboard()}>Paste<//>
        <${Button} icon="link" onClick=${() => promptImportUrl()}>From URL<//>
        <${Button} icon="sparkles" onClick=${() => setIng({ dialog: 'page' })}>From grok.com${connected && pageCount ? ` (${pageCount})` : ''}<//>
        <${Button} icon="film" onClick=${() => setIng({ dialog: 'bin', dialogArg: null })}>Frame from bin<//>
      `}
    >
      Collect the images you want Grok to work from: characters, products, locations, styles. Crop and adjust them, combine
      several into one reference sheet, then attach them to Grok or to a shot in one click.
    <//>
    <ul class="ing-tips">
      <li><${Icon} name="upload" size=${14} /><span>Drop image files anywhere in this panel</span></li>
      <li><${Icon} name="copy" size=${14} /><span><${Kbd} combo="mod+v" /> pastes a copied image or image URL</span></li>
      <li><${Icon} name="sparkles" size=${14} /><span>On grok.com, hover an image and choose <b>Ingredient</b></span></li>
    </ul>
  </div>`;
}

function SelectionBar({ ids, onClear, compact }) {
  const n = ids.length;
  // Compact: secondary actions become icons; the primary one (Attach) keeps its label, like the Clips selection bar.
  const act = (icon, label, title, onClick, extra = {}) =>
    compact && extra.kind !== 'primary'
      ? html`<${IconButton} icon=${icon} size="sm" title=${title} onClick=${onClick} disabled=${extra.disabled} />`
      : html`<${Button} size="sm" kind=${extra.kind || 'ghost'} icon=${icon} title=${title} onClick=${onClick} disabled=${extra.disabled}>${label}<//>`;
  return html`<div class=${cx('ing-selbar', compact && 'is-compact')} role="toolbar" aria-label="Selection actions">
    <${IconButton} icon="x" size="sm" title="Clear selection (Esc)" onClick=${onClear} />
    <span class="ing-selbar-count">${n} selected</span>
    <span class="ing-selbar-sep"></span>
    ${n === 1 && act('crop', 'Edit', 'Edit image (Enter)', () => openEditor(ids[0]))}
    ${n === 1 && act('info', 'Details', 'Name, tags, prompt and notes', () => openEditor(ids[0], 'details'))}
    ${n >= 2 && act('grid', 'Sheet', 'Make a reference sheet (G)', () => openComposer(ids))}
    ${act('clapper', 'Shot', 'Use in shot', (e) => openShotMenu(e.currentTarget, ids))}
    ${act('film', 'Timeline', 'Add to timeline as still', () => addToProject(ids, { toTimeline: true }))}
    ${act('send', 'Attach', 'Attach to the Grok composer', () => attachToGrok(ids), { kind: 'primary' })}
    <${IconButton} icon="more" size="sm" title="More actions" onClick=${(e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openIngredientMenu({ x: r.left, y: r.top - 8 }, ids);
    }} />
  </div>`;
}

export function IngredientsView({ active }) {
  const ingredients = useLibrary((l) => l.ingredients);
  const loaded = useLibrary((l) => l.loaded);
  const st = useStore(ingStore);
  const { connected, pageCount } = usePage((s) => ({ connected: s.connected, pageCount: s.items.filter((i) => i.kind === 'image').length }));
  const [rootRef, size] = useElementSize();
  const gridRef = useRef(null);
  const searchRef = useRef(null);

  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const visible = useMemo(() => filterIngredients(ingredients, { search: st.search, tags: st.tags, sort: st.sort }), [ingredients, st.search, st.tags, st.sort]);
  const visibleIds = useMemo(() => visible.map((i) => i.id), [visible]);
  const visibleSet = useMemo(() => new Set(visibleIds), [visibleIds]);
  const visibleKey = visibleIds.join('|');
  const tags = useMemo(() => tagCounts(ingredients), [ingredients]);
  // Only images you can see count as selected, so bulk actions and Delete never touch images hidden by the filter.
  const selection = st.selection.filter((id) => visibleSet.has(id));
  const selSet = new Set(selection);
  const flashSet = new Set(st.flash);
  const focused = st.focusId && visibleSet.has(st.focusId) ? byId.get(st.focusId) || null : null;
  const editorIng = st.editorId ? byId.get(st.editorId) || null : null;
  const composerIds = st.composerIds ? st.composerIds.filter((id) => byId.has(id)) : null;
  const wide = size.width >= WIDE;
  const filtered = !!st.search.trim() || st.tags.length > 0;
  const libraryActive = active && !editorIng && !composerIds && !st.dialog;

  // Close the editor if its ingredient disappears (deleted here or in another window).
  useEffect(() => {
    if (st.editorId && !editorIng && loaded) setIng({ editorId: null });
  }, [st.editorId, editorIng, loaded]);

  // Images the search / tag filter hides leave the selection (and the keyboard cursor).
  useEffect(() => {
    if (!loaded) return;
    const s = ingStore.get();
    const sel = s.selection.filter((id) => visibleSet.has(id));
    const keepFocus = !s.focusId || visibleSet.has(s.focusId);
    const keepAnchor = !s.anchorId || visibleSet.has(s.anchorId);
    if (sel.length !== s.selection.length || !keepFocus || !keepAnchor) {
      setIng({ selection: sel, focusId: keepFocus ? s.focusId : null, anchorId: keepAnchor ? s.anchorId : null });
    }
  }, [visibleKey, loaded]);

  // Keep the keyboard cursor visible.
  useEffect(() => {
    if (!st.focusId || !gridRef.current) return;
    const el = gridRef.current.querySelector(`[data-id="${CSS.escape(st.focusId)}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [st.focusId, visible.length]);

  // Paste works in the library and in the image editor (not under the composer or an import dialog).
  usePasteImport(active && !composerIds && !st.dialog);

  // ---------------------------------------------------------------- selection
  const select = (ids, focusId = ids[0] ?? null) => setIng({ selection: ids, focusId, anchorId: focusId });
  const toggle = (id) =>
    setIng((s) => {
      const has = s.selection.includes(id);
      return { selection: has ? s.selection.filter((x) => x !== id) : [...s.selection, id], focusId: id, anchorId: id };
    });
  const onPointer = (e, id, menu = false) => {
    if (menu) {
      const ids = selSet.has(id) ? selection : [id];
      if (!selSet.has(id)) select([id]);
      openIngredientMenu(e, ids);
      return;
    }
    if (e.metaKey || e.ctrlKey) toggle(id);
    else if (e.shiftKey && st.anchorId) setIng({ selection: [...new Set([...selection, ...rangeSelect(visibleIds, st.anchorId, id)])], focusId: id });
    else select([id]);
    gridRef.current?.focus({ preventScroll: true });
  };
  const clearSelection = () => setIng({ selection: [], focusId: null, anchorId: null });

  const gridCols = () => {
    const g = gridRef.current;
    if (!g) return 1;
    return Math.max(1, getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length);
  };
  const moveFocus = (key, extend = false) => {
    const idx = visibleIds.indexOf(st.focusId);
    const next = moveFocusIndex(idx, key, visibleIds.length, gridCols());
    if (next < 0) return false;
    const id = visibleIds[next];
    if (extend && st.anchorId) setIng({ selection: rangeSelect(visibleIds, st.anchorId, id), focusId: id });
    else select([id]);
    return true;
  };

  // ---------------------------------------------------------------- keyboard (library)
  const guard = () => libraryActive && !anyModalOpen();
  const target = () => (selection.length ? selection : focused ? [focused.id] : []);
  useHotkeys(
    {
      delete: () => (guard() && target().length ? (deleteIngredients(target()), true) : false),
      backspace: () => (guard() && target().length ? (deleteIngredients(target()), true) : false),
      'mod+a': () => (guard() && visibleIds.length ? (setIng({ selection: [...visibleIds], focusId: st.focusId || visibleIds[0] }), true) : false),
      enter: (e) => {
        if (!guard() || isButtonLike(e.target)) return false;
        const id = focused?.id || selection[0];
        if (!id) return false;
        openEditor(id);
      },
      escape: (e) => {
        if (!guard()) return false;
        if (isTypingTarget(e.target)) {
          e.target.blur();
          return true;
        }
        if (!selection.length && !st.focusId) return false;
        clearSelection();
      },
      // (selected text, e.g. a source URL in the inspector, copies as text)
      'mod+c': () => (guard() && !hasTextSelection() && target().length === 1 ? (copyIngredient(target()[0]), true) : false),
      g: () => (guard() && selection.length >= 2 ? (openComposer(selection), true) : false),
      '/': () => (guard() ? (searchRef.current?.focus(), true) : false),
      arrowleft: () => guard() && moveFocus('arrowleft'),
      arrowright: () => guard() && moveFocus('arrowright'),
      arrowup: () => guard() && moveFocus('arrowup'),
      arrowdown: () => guard() && moveFocus('arrowdown'),
      'shift+arrowleft': () => guard() && moveFocus('arrowleft', true),
      'shift+arrowright': () => guard() && moveFocus('arrowright', true),
      'shift+arrowup': () => guard() && moveFocus('arrowup', true),
      'shift+arrowdown': () => guard() && moveFocus('arrowdown', true),
      home: () => guard() && moveFocus('home'),
      end: () => guard() && moveFocus('end'),
    },
    { enabled: libraryActive },
  );

  // ---------------------------------------------------------------- drops
  const onDropData = (dt) => {
    const raw = dt.getData(MEDIA_DRAG_TYPE);
    if (raw) {
      let ids = [];
      try {
        ids = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const media = projectStore.get()?.media || {};
      for (const id of ids) {
        if (media[id]?.kind === 'image') importFromBin(id, 0);
        else if (media[id]?.kind === 'video') setIng({ dialog: 'bin', dialogArg: id });
      }
      return;
    }
    importFromDataTransfer(dt, { origin: 'url' });
  };

  const empty = loaded && !ingredients.length;
  const showInspector = wide && !empty;

  return html`<div class="ing-root" ref=${rootRef}>
    <div class=${cx('ing-view', `ing-density-${st.density}`, showInspector && 'has-inspector', !wide && selection.length > 0 && 'has-selbar')} data-active=${active ? 'true' : 'false'}>
      <${DropZone} class="ing-drop" onFiles=${(files) => importFiles(files)} onDropData=${onDropData} label="Drop images to add them to Ingredients">
        <div class="ing-toolbar">
          <label class="ing-search">
            <${Icon} name="search" size=${14} />
            <input
              ref=${searchRef}
              type="search"
              placeholder=${ingredients.length ? `Search ${pluralize(ingredients.length, 'image')}…` : 'Search…'}
              value=${st.search}
              aria-label="Search ingredients"
              onInput=${(e) => setIng({ search: e.currentTarget.value })}
            />
            ${st.search && html`<button type="button" class="ing-search-x" aria-label="Clear search" onClick=${() => setIng({ search: '' })}><${Icon} name="x" size=${12} /></button>`}
          </label>
          <span class="ing-sort">
            <${Select} value=${st.sort} options=${SORTS} onChange=${(sort) => setIng({ sort })} title="Sort" />
          </span>
          <${IconButton} icon="sliders" title="View options" onClick=${(e) => viewMenu(e.currentTarget, st)} />
          ${st.busy > 0 && html`<span class="ing-busy" title="Importing…"><${Spinner} size=${14} /></span>`}
          <span class="spacer"></span>
          ${selection.length >= 2 && html`<${Button} icon="grid" class="ing-toolbar-sheet" onClick=${() => openComposer(selection)} title="Combine the selection into one reference sheet (G)">Sheet<//>`}
          <${Button} kind="primary" icon="plus" iconRight="chevron-down" onClick=${(e) => addMenu(e.currentTarget, { pageCount, connected })} data-testid="ing-add">Add<//>
        </div>
        ${tags.length > 0 &&
        html`<div class="ing-filterbar" role="group" aria-label="Filter by tag">
          <button type="button" class=${cx('chip', !st.tags.length && 'is-active')} onClick=${() => setIng({ tags: [] })}>All</button>
          ${tags.map(({ tag, count }) => {
            const on = st.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
            return html`<button
              type="button"
              key=${tag}
              class=${cx('chip', on && 'is-active')}
              aria-pressed=${on ? 'true' : 'false'}
              onClick=${() => setIng((s) => ({ tags: on ? s.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...s.tags, tag] }))}
            >
              <${Icon} name="tag" size=${11} />${tag}<span class="ing-chip-count">${count}</span>
            </button>`;
          })}
        </div>`}
        <div class="ing-main">
          <div class="ing-library">
            ${!loaded
              ? html`<div class="ing-loading"><${Spinner} size=${20} /></div>`
              : empty
                ? html`<${LibraryEmpty} connected=${connected} pageCount=${pageCount} />`
                : !visible.length
                  ? html`<${EmptyState} icon="search" title="No images match" compact=${true} action=${html`<${Button} size="sm" onClick=${() => setIng({ search: '', tags: [] })}>Clear filters<//>`}>
                      Try another search or tag. Search looks at names, tags, notes and prompts.
                    <//>`
                  : html`<div
                      class=${cx('ing-grid', `is-fit-${st.fit}`)}
                      ref=${gridRef}
                      role="listbox"
                      aria-multiselectable="true"
                      aria-label="Ingredients"
                      tabindex="0"
                      onClick=${(e) => e.target === e.currentTarget && clearSelection()}
                    >
                      ${visible.map(
                        (ing) => html`<${Card}
                          key=${ing.id}
                          ing=${ing}
                          fit=${st.fit}
                          selected=${selSet.has(ing.id)}
                          focused=${st.focusId === ing.id}
                          flash=${flashSet.has(ing.id)}
                          onPointer=${onPointer}
                          onToggle=${toggle}
                        />`,
                      )}
                    </div>`}
            ${!empty && filtered && visible.length > 0 && html`<div class="ing-count muted tiny">${visible.length} of ${ingredients.length}</div>`}
          </div>
          ${showInspector && html`<${Inspector} selected=${selection.map((id) => byId.get(id))} focused=${focused} />`}
        </div>
        ${!wide && selection.length > 0 && !editorIng && html`<${SelectionBar} ids=${selection} onClear=${clearSelection} compact=${size.width < 560} />`}
      <//>
      ${editorIng &&
      html`<${DropZone} class="ing-ws-drop" onFiles=${(files) => importFiles(files)} onDropData=${onDropData} label="Drop images to add them to Ingredients">
        <${ImageEditor}
          key=${editorIng.id}
          ing=${editorIng}
          tab=${st.editorTab}
          active=${active && !composerIds && !st.dialog}
          onTab=${(t) => setIng({ editorTab: t })}
          onClose=${() => setIng({ editorId: null })}
        />
      <//>`}
    </div>
    ${composerIds && html`<${GridComposer} ids=${composerIds} onClose=${() => setIng({ composerIds: null })} />`}
    ${st.dialog === 'page' && html`<${PageImportDialog} onClose=${() => setIng({ dialog: null })} />`}
    ${st.dialog === 'bin' && html`<${BinImportDialog} initialMediaId=${st.dialogArg} onClose=${() => setIng({ dialog: null, dialogArg: null })} />`}
  </div>`;
}
