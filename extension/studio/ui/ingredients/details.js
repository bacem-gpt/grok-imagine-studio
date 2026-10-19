// Ingredient details: metadata form (name, tags, prompt/description, note), info table, action buttons and the
// right-hand inspector shown next to the library grid on wide layouts.
import { html, useState, useEffect, useMemo } from '../../../vendor/preact-htm.mjs';
import { updateIngredient } from '../../core/ingredients.js';
import { formatBytes, copyText, uid } from '../../core/utils.js';
import { useLibrary } from '../hooks.js';
import { Icon, Button, IconButton, Field, TextField, toast, cx } from '../kit.js';
import { useIngredientImage, IngredientThumb, imageVersion } from './thumb.js';
import { parseTags, mergeTags, tagCounts, ORIGIN_LABELS } from './logic.js';
import {
  renameIngredient,
  attachToGrok,
  addToProject,
  openShotMenu,
  copyIngredient,
  downloadIngredients,
  deleteIngredients,
  openEditor,
  openComposer,
  tagIngredients,
  openIngredientMenu,
} from './actions.js';
import { setIng } from './state.js';

/** Chip-style tag input. Enter or comma adds, Backspace on an empty field removes the last tag. */
export function TagEditor({ tags = [], onChange, suggestions = [], placeholder = 'Add tags…' }) {
  const [text, setText] = useState('');
  const [listId] = useState(() => uid('ingtags'));
  const add = (raw) => {
    const next = parseTags(raw);
    if (next.length) onChange(mergeTags(tags, next));
    setText('');
  };
  const lower = new Set(tags.map((t) => t.toLowerCase()));
  return html`<div class="ing-tag-editor">
    ${tags.map(
      (t) => html`<span class="ing-tag" key=${t}>
        <span class="ing-tag-text">${t}</span>
        <button type="button" class="ing-tag-x" title=${`Remove “${t}”`} aria-label=${`Remove tag ${t}`} onClick=${() => onChange(tags.filter((x) => x !== t))}>
          <${Icon} name="x" size=${11} />
        </button>
      </span>`,
    )}
    <input
      class="ing-tag-input"
      list=${listId}
      value=${text}
      placeholder=${tags.length ? 'Add tag' : placeholder}
      aria-label="Add tag"
      onInput=${(e) => {
        const v = e.currentTarget.value;
        if (/[,;]/.test(v)) add(v);
        else setText(v);
      }}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          add(text);
        } else if (e.key === 'Backspace' && !text && tags.length) {
          onChange(tags.slice(0, -1));
        }
      }}
      onBlur=${() => text.trim() && add(text)}
    />
    <datalist id=${listId}>${suggestions.filter((s) => !lower.has(s.toLowerCase())).slice(0, 40).map((s) => html`<option value=${s}></option>`)}</datalist>
  </div>`;
}

/** Text field bound to an ingredient field, committed on blur / Enter (single line). */
function BoundText({ value, onCommit, multiline = false, rows = 3, placeholder = '', ariaLabel }) {
  const [v, setV] = useState(value || '');
  useEffect(() => setV(value || ''), [value]);
  return html`<${TextField}
    value=${v}
    multiline=${multiline}
    rows=${rows}
    placeholder=${placeholder}
    aria-label=${ariaLabel}
    onInput=${setV}
    onCommit=${(x) => x !== (value || '') && onCommit(x)}
    onKeyDown=${(e) => {
      if (!multiline && e.key === 'Enter') e.currentTarget.blur();
    }}
  />`;
}

function InfoRow({ label, children }) {
  return html`<div class="ing-info-row"><span class="ing-info-k">${label}</span><span class="ing-info-v">${children}</span></div>`;
}

/** Editable metadata + info for one ingredient. */
export function IngredientDetails({ ing }) {
  const all = useLibrary((l) => l.ingredients);
  const suggestions = useMemo(() => tagCounts(all).map((t) => t.tag), [all]);
  if (!ing) return null;
  const date = new Date(ing.createdAt || Date.now());
  return html`<div class="ing-details">
    <${Field} label="Name">
      <${BoundText} value=${ing.name} ariaLabel="Name" onCommit=${(x) => renameIngredient(ing.id, x)} />
    <//>
    <${Field} label="Tags" hint="Characters, locations, styles… Filter the library by tag.">
      <${TagEditor} tags=${ing.tags || []} suggestions=${suggestions} onChange=${(tags) => updateIngredient(ing.id, { tags })} />
    <//>
    <div class="field">
      <div class="field-label ing-field-label-row">
        <span>Prompt / description</span>
        ${ing.prompt && html`<button type="button" class="ing-link-btn" onClick=${async () => (await copyText(ing.prompt)) && toast('Prompt copied', { kind: 'success' })}><${Icon} name="copy" size=${12} />Copy</button>`}
      </div>
      <${BoundText}
        value=${ing.prompt || ''}
        multiline=${true}
        rows=${3}
        ariaLabel="Prompt or description"
        placeholder="The prompt that generated it, or how to describe it to Grok"
        onCommit=${(x) => updateIngredient(ing.id, { prompt: x.trim() || null })}
      />
    </div>
    <${Field} label="Note">
      <${BoundText} value=${ing.note || ''} multiline=${true} rows=${2} ariaLabel="Note" placeholder="Private note" onCommit=${(x) => updateIngredient(ing.id, { note: x })} />
    <//>
    <div class="ing-info">
      <${InfoRow} label="Size">${ing.width} × ${ing.height} px · ${formatBytes(ing.size)}<//>
      <${InfoRow} label="Format">${(ing.mime || '').replace('image/', '').toUpperCase() || '—'}<//>
      <${InfoRow} label="Source">${ORIGIN_LABELS[ing.origin] || ing.origin || '—'}<//>
      <${InfoRow} label="Added">${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<//>
      ${/^https?:\/\//i.test(ing.sourceUrl || '') && html`<${InfoRow} label="URL"><a class="ing-url" href=${ing.sourceUrl} target="_blank" rel="noopener noreferrer" title=${ing.sourceUrl}>${ing.sourceUrl}</a><//>`}
    </div>
  </div>`;
}

/** Action buttons for the given ingredient ids. */
export function IngredientActions({ ids, layout = 'panel' }) {
  const one = ids.length === 1;
  return html`<div class=${cx('ing-actions', `is-${layout}`)}>
    <div class="ing-actions-main">
      ${one
        ? html`<${Button} icon="crop" onClick=${() => openEditor(ids[0])} title="Crop, rotate, resize and adjust (Enter)">Edit image<//>`
        : html`<${Button} icon="grid" onClick=${() => openComposer(ids)} title="Combine into one reference sheet (G, up to 9 images)">Make sheet<//>`}
      <${Button} kind="primary" icon="send" onClick=${() => attachToGrok(ids)} title="Upload into the grok.com composer">Attach to Grok<//>
    </div>
    <div class="ing-actions-row">
      <${IconButton} icon="clapper" title="Use in shot…" onClick=${(e) => openShotMenu(e.currentTarget, ids)} />
      <${IconButton} icon="film" title="Add to timeline as still" onClick=${() => addToProject(ids, { toTimeline: true })} />
      <${IconButton} icon="inbox" title="Add to bin" onClick=${() => addToProject(ids, { toTimeline: false })} />
      ${one && html`<${IconButton} icon="copy" title="Copy image (Ctrl+C)" onClick=${() => copyIngredient(ids[0])} />`}
      <${IconButton} icon="download" title="Download" onClick=${() => downloadIngredients(ids)} />
      ${!one && html`<${IconButton} icon="tag" title="Add tags…" onClick=${() => tagIngredients(ids)} />`}
      <span class="spacer"></span>
      <${IconButton} icon="trash" kind="danger" title="Delete (Del)" onClick=${() => deleteIngredients(ids)} />
      <${IconButton} icon="more" title="More" onClick=${(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openIngredientMenu({ x: r.left, y: r.bottom + 4 }, ids);
      }} />
    </div>
  </div>`;
}

/** Large preview of one ingredient (full resolution, contain). Click opens the editor. */
function Preview({ ing }) {
  const url = useIngredientImage(ing.id, imageVersion(ing));
  return html`<button type="button" class="ing-insp-preview checker" title="Open in the editor (Enter)" onClick=${() => openEditor(ing.id)}>
    ${url ? html`<img src=${url} alt=${ing.name} draggable=${false} />` : html`<${IngredientThumb} ing=${ing} fit="contain" />`}
    <span class="ing-insp-preview-hint"><${Icon} name="crop" size=${14} />Edit</span>
  </button>`;
}

/** Right-hand inspector (wide layouts): one item -> preview + details; several -> summary + bulk actions. */
export function Inspector({ selected, focused }) {
  if (focused && selected.length <= 1) {
    return html`<aside class="ing-inspector" aria-label="Image details">
      <div class="ing-insp-scroll">
        <${Preview} ing=${focused} />
        <${IngredientActions} ids=${[focused.id]} />
        <${IngredientDetails} ing=${focused} key=${focused.id} />
      </div>
    </aside>`;
  }
  if (selected.length > 1) {
    return html`<aside class="ing-inspector" aria-label="Selection">
      <div class="ing-insp-scroll">
        <div class="ing-insp-stack">
          ${selected.slice(0, 4).map((ing, i) => html`<${IngredientThumb} key=${ing.id} ing=${ing} class=${`ing-stack-${i}`} />`)}
        </div>
        <div class="ing-insp-multi-title">${selected.length} images selected</div>
        <div class="muted small ing-insp-multi-hint">
          ${selected.length <= 9 ? 'Combine them into one reference sheet, attach them to Grok in this order, or use them in a shot.' : 'A reference sheet holds up to 9 images; attach or tag them in bulk.'}
        </div>
        <${IngredientActions} ids=${selected.map((i) => i.id)} />
        <button type="button" class="ing-link-btn ing-insp-clear" onClick=${() => setIng({ selection: [], focusId: null })}>Clear selection</button>
      </div>
    </aside>`;
  }
  return html`<aside class="ing-inspector is-empty" aria-label="Image details">
    <div class="ing-insp-empty">
      <${Icon} name="image" size=${26} />
      <div class="ing-insp-empty-title">No image selected</div>
      <div class="muted small">Click an image to see its details. Double-click (or Enter) opens the editor; Ctrl/⌘-click or Shift-click selects several.</div>
    </div>
  </aside>`;
}
