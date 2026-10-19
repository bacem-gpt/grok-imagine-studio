// IngredientPicker({value, onChange, multiple = true, max = 0, placeholder}): compact row of the chosen reference
// images (thumbnails, drag to reorder, × to remove) plus a picker dialog over the Ingredients library with search,
// tag filters and quick import (files, paste, URL). Used by the Prompts tab for shot references.
// `value` is an array of ingredient ids (order = attach order); ids missing from the library are ignored.
import { html, render, useState, useEffect, useMemo, useRef, useLayoutEffect } from '../../../vendor/preact-htm.mjs';
import { useLibrary } from '../hooks.js';
import { isTypingTarget } from '../hotkeys.js';
import { Icon, Button, IconButton, Modal, EmptyState, DropZone, cx } from '../kit.js';
import { filterIngredients, tagCounts, urlsFromText } from './logic.js';
import { importFiles, pickAndImportFiles, pasteFromClipboard, promptImportUrl, importFromDataTransfer, imageFilesFrom, showIngredients } from './actions.js';
import { IngredientThumb } from './thumb.js';

/** Renders children into a <div> on document.body (escapes overflow/containment of the host panel). */
function Portal({ children }) {
  const hostRef = useRef(null);
  if (!hostRef.current) {
    hostRef.current = document.createElement('div');
    hostRef.current.className = 'ing-portal';
  }
  useLayoutEffect(() => {
    const host = hostRef.current;
    document.body.appendChild(host);
    return () => {
      render(null, host);
      host.remove();
    };
  }, []);
  useLayoutEffect(() => {
    render(children, hostRef.current);
  });
  return null;
}

function PickerDialog({ initial, multiple, max, onDone, onClose }) {
  const library = useLibrary((l) => l.ingredients);
  const [sel, setSel] = useState(initial);
  const [search, setSearch] = useState('');
  const [tags, setTags] = useState([]);
  const visible = useMemo(() => filterIngredients(library, { search, tags, sort: 'newest' }), [library, search, tags]);
  const allTags = useMemo(() => tagCounts(library).slice(0, 24), [library]);
  const limit = multiple ? max || Infinity : 1;
  const full = sel.length >= limit;

  const choose = (id) => {
    if (!multiple) return onDone([id]);
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= limit ? s : [...s, id]));
  };
  const addImported = (ids) => {
    if (!ids?.length) return;
    if (!multiple) return onDone([ids[0]]);
    setSel((s) => [...s, ...ids.filter((id) => !s.includes(id))].slice(0, limit === Infinity ? undefined : limit));
  };
  const quiet = { reveal: false, announce: false };
  const searchRef = useRef(null);
  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  // Ctrl/⌘+V while the dialog is open imports and selects the pasted image.
  useEffect(() => {
    const onPaste = (e) => {
      const dt = e.clipboardData;
      if (!dt || e.defaultPrevented) return;
      const files = imageFilesFrom(dt);
      if (!files.length && (isTypingTarget(e.target) || !urlsFromText(dt.getData('text/plain'), dt.getData('text/html')).length)) return;
      e.preventDefault();
      importFromDataTransfer(dt, { origin: 'paste', ...quiet }).then(addImported);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const footer = html`
    <span class="muted small">${multiple ? `${sel.length} selected${Number.isFinite(limit) ? ` of max ${limit}` : ''}` : 'Click an image to choose it'}</span>
    ${multiple && sel.length > 0 && html`<button type="button" class="ing-link-btn" onClick=${() => setSel([])}>Clear</button>`}
    <span class="spacer"></span>
    <${Button} kind="ghost" onClick=${onClose}>Cancel<//>
    ${multiple && html`<${Button} kind="primary" icon="check" onClick=${() => onDone(sel)} data-testid="picker-done">Done<//>`}
  `;

  return html`<${Modal} title=${multiple ? 'Choose reference images' : 'Choose a reference image'} width=${820} class="ing-dialog ing-picker-dialog" onClose=${onClose} footer=${footer}>
    <${DropZone} class="ing-picker-drop" onFiles=${(files) => importFiles(files, quiet).then(addImported)} label="Drop images to add them">
      <div class="ing-picker-tools">
        <label class="ing-search">
          <${Icon} name="search" size=${14} />
          <input ref=${searchRef} type="search" placeholder="Search names, tags, prompts…" value=${search} aria-label="Search ingredients" onInput=${(e) => setSearch(e.currentTarget.value)} />
        </label>
        <${IconButton} icon="upload" title="Import image files" onClick=${() => pickAndImportFiles(quiet).then(addImported)} />
        <${IconButton} icon="copy" title="Paste image (Ctrl+V)" onClick=${() => pasteFromClipboard(quiet).then(addImported)} />
        <${IconButton} icon="link" title="Add from URL" onClick=${() => promptImportUrl(quiet).then(addImported)} />
      </div>
      ${allTags.length > 0 &&
      html`<div class="ing-filterbar is-compact">
        ${allTags.map(({ tag }) => {
          const on = tags.includes(tag);
          return html`<button type="button" key=${tag} class=${cx('chip', on && 'is-active')} onClick=${() => setTags((t) => (on ? t.filter((x) => x !== tag) : [...t, tag]))}>${tag}</button>`;
        })}
      </div>`}
      ${!library.length
        ? html`<${EmptyState} icon="images" title="Your Ingredients library is empty" compact=${true}
            action=${html`<${Button} kind="primary" icon="upload" onClick=${() => pickAndImportFiles(quiet).then(addImported)}>Import images<//>
              <${Button} icon="link" onClick=${() => promptImportUrl(quiet).then(addImported)}>From URL<//>`}>
            Import reference images here (or paste one with Ctrl+V). The Ingredients tab has more sources and an editor.
          <//>`
        : !visible.length
          ? html`<${EmptyState} icon="search" title="No images match" compact=${true}>Try another search or tag.<//>`
          : html`<div class="ing-pick-grid" role="listbox" aria-multiselectable=${multiple ? 'true' : 'false'}>
              ${visible.map((ing) => {
                const n = sel.indexOf(ing.id);
                return html`<button
                  type="button"
                  key=${ing.id}
                  role="option"
                  aria-selected=${n >= 0 ? 'true' : 'false'}
                  class=${cx('ing-pick-card', n >= 0 && 'is-selected', n < 0 && full && multiple && 'is-disabled')}
                  title=${ing.name}
                  data-id=${ing.id}
                  onClick=${() => choose(ing.id)}
                  onDblClick=${() => multiple && onDone(sel.includes(ing.id) ? sel : [...sel, ing.id])}
                >
                  <span class="ing-pick-media">
                    <${IngredientThumb} ing=${ing} />
                    <span class="ing-pick-check">${n >= 0 && multiple ? n + 1 : html`<${Icon} name="check" size=${12} />`}</span>
                  </span>
                  <span class="ing-pick-name">${ing.name}</span>
                </button>`;
              })}
            </div>`}
    <//>
  <//>`;
}

/**
 * Compact chooser for ingredient ids.
 * @param {{value?: string[], onChange?: (ids: string[]) => void, multiple?: boolean, max?: number, placeholder?: string, disabled?: boolean}} props
 */
export function IngredientPicker({ value = [], onChange, multiple = true, max = 0, placeholder = 'Add reference images', disabled = false }) {
  const library = useLibrary((l) => l.ingredients);
  const byId = useMemo(() => new Map(library.map((i) => [i.id, i])), [library]);
  const ids = (value || []).filter((id) => byId.has(id));
  const [open, setOpen] = useState(false);
  const [dragFrom, setDragFrom] = useState(-1);
  const emit = (next) => onChange?.(multiple ? (max ? next.slice(0, max) : next) : next.slice(-1));
  const remove = (id) => emit(ids.filter((x) => x !== id));
  const reorder = (from, to) => {
    if (from === to || from < 0 || to < 0) return;
    const next = ids.slice();
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    emit(next);
  };
  const canAdd = !disabled && (multiple ? !max || ids.length < max : true);

  return html`<div class=${cx('ing-picker', disabled && 'is-disabled')}>
    <${DropZone}
      class="ing-picker-row"
      onFiles=${(files) => !disabled && importFiles(files, { reveal: false, announce: false }).then((newIds) => newIds.length && emit(multiple ? [...ids, ...newIds] : [newIds[0]]))}
      label="Drop to add"
    >
      ${ids.map(
        (id, i) => html`<div
          key=${id}
          class=${cx('ing-picker-chip', dragFrom === i && 'is-dragging')}
          title=${byId.get(id).name}
          draggable=${multiple && ids.length > 1 && !disabled ? 'true' : 'false'}
          onDragStart=${(e) => {
            setDragFrom(i);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/x-gis-ing-order', String(i));
          }}
          onDragEnd=${() => setDragFrom(-1)}
          onDragOver=${(e) => e.dataTransfer.types.includes('text/x-gis-ing-order') && e.preventDefault()}
          onDrop=${(e) => {
            const from = Number(e.dataTransfer.getData('text/x-gis-ing-order'));
            if (!Number.isFinite(from)) return;
            e.preventDefault();
            e.stopPropagation();
            reorder(from, i);
            setDragFrom(-1);
          }}
          onDblClick=${() => showIngredients([id])}
        >
          <${IngredientThumb} ing=${byId.get(id)} />
          ${multiple && ids.length > 1 && html`<span class="ing-picker-num">${i + 1}</span>`}
          ${!disabled &&
          html`<button type="button" class="ing-picker-x" title="Remove" aria-label=${`Remove ${byId.get(id).name}`} onClick=${() => remove(id)}>
            <${Icon} name="x" size=${10} />
          </button>`}
        </div>`,
      )}
      ${canAdd &&
      html`<button type="button" class=${cx('ing-picker-add', !ids.length && 'is-empty')} onClick=${() => setOpen(true)} title="Choose from Ingredients" data-testid="ing-picker-add">
        <${Icon} name=${ids.length ? 'plus' : 'images'} size=${ids.length ? 14 : 15} />
        ${!ids.length && html`<span>${placeholder}</span>`}
      </button>`}
    <//>
    ${open &&
    html`<${Portal}>
      <${PickerDialog}
        initial=${ids}
        multiple=${multiple}
        max=${max}
        onClose=${() => setOpen(false)}
        onDone=${(next) => {
          setOpen(false);
          emit(next);
        }}
      />
    <//>`}
  </div>`;
}
