// Bible tab: project characters and locations (name, description, reference images) used by @Name expansion, the
// style guide ({{style}}) and notes. Edits are undoable project changes (one undo step per field focus).
// A card opened from a shot's unknown @Name (describeBibleEntry) gets its description focused and "Back to shot N".
import { html, useState, useEffect, useRef } from '../../../vendor/preact-htm.mjs';
import { useProject, useStore } from '../hooks.js';
import { Icon, IconButton, Button, toast, cx } from '../kit.js';
import { comboLabel } from '../hotkeys.js';
import { projectStore } from '../../core/store.js';
import { IngredientPicker } from '../ingredients/ingredient-picker.js';
import { getBible, addBibleEntry, updateBibleEntry, removeBibleEntry, setBibleText, mentionFor, uniqueBibleName } from '../../prompts/library.js';
import { shotIndex } from '../../prompts/shots.js';
import { useCommittedText, AutoTextarea, Boundary, IngThumb } from './common.js';
import { insertIntoPrompt, promptsUi, setUi, returnFromBible } from './state.js';

const KIND_META = {
  characters: { label: 'Characters', one: 'character', icon: 'user', placeholder: 'Who they are, visually: age, face, hair, build, clothing, distinctive features…' },
  locations: { label: 'Locations', one: 'location', icon: 'map-pin', placeholder: 'What the place looks like: architecture or landscape, materials, time of day, weather, palette…' },
};

/** "Back to shot N" for the card describeBibleEntry opened from that shot (null when it doesn't apply). */
function useReturnShot(entryId) {
  const shotId = useStore(promptsUi, (s) => (s.bibleReturn?.entryId === entryId ? s.bibleReturn.shotId : null));
  const index = useProject((p) => (shotId ? shotIndex(p, shotId) : -1));
  return index >= 0 ? index : null;
}

function EntryCard({ kind, entry, open, onToggle, focusDesc = false, onFocused }) {
  const meta = KIND_META[kind];
  const commit = (field) => (id, t, session) => projectStore.update((q) => updateBibleEntry(q, kind, id, { [field]: t }), { label: `Edit ${meta.one}`, merge: `bible:${field}:${id}:${session}` });
  const name = useCommittedText(entry.id, entry.name, commit('name'));
  const desc = useCommittedText(entry.id, entry.description, commit('description'));
  const refs = Array.isArray(entry.ingredientIds) ? entry.ingredientIds : [];
  const descRef = useRef(null);
  const backTo = useReturnShot(entry.id);
  useEffect(() => {
    if (!open || !focusDesc || !descRef.current) return;
    const el = descRef.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    onFocused?.();
  }, [open, focusDesc]);
  const remove = () => {
    projectStore.update((q) => removeBibleEntry(q, kind, entry.id), { label: `Delete ${meta.one}` });
    toast(`Deleted ${entry.name || meta.one}`, { action: { label: 'Undo', run: () => projectStore.undo() } });
  };
  const onDescKey = (e) => {
    if (backTo == null || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    returnFromBible();
  };
  return html`<div class=${cx('pr-bible-card', open && 'is-open')} data-entry=${entry.id}>
    <div class="pr-bible-row">
      <button type="button" class="pr-bible-toggle" onClick=${onToggle} aria-expanded=${open ? 'true' : 'false'} title=${open ? 'Collapse' : 'Edit'}>
        <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} size=${13} />
      </button>
      ${open
        ? html`<input class="text-field pr-bible-name" type="text" value=${name.text} placeholder="Name" onInput=${(e) => name.setText(e.currentTarget.value)} onFocus=${name.bumpSession} onBlur=${name.flush} />`
        : html`<button type="button" class="pr-bible-summary" onClick=${onToggle}>
            <span class="pr-bible-title">${entry.name || 'Unnamed'}</span>
            <span class="pr-bible-desc">${entry.description || 'No description yet'}</span>
          </button>`}
      ${!open && refs.length > 0 && html`<span class="pr-bible-refs">${refs.slice(0, 2).map((id) => html`<${IngThumb} key=${id} id=${id} />`)}</span>`}
      <button type="button" class="pr-token-chip mono" title="Insert the mention into the prompt" disabled=${!entry.name} onClick=${() => insertIntoPrompt(mentionFor(entry))}>${mentionFor(entry) || '@'}</button>
    </div>
    ${open &&
    html`<div class="pr-bible-edit">
      <${AutoTextarea} inputRef=${descRef} value=${desc.text} minRows=${3} maxRows=${10} placeholder=${meta.placeholder} onInput=${(v) => desc.setText(v)} onFocus=${desc.bumpSession} onBlur=${desc.flush} onKeyDown=${onDescKey} aria-label=${`Description of ${entry.name || meta.one}`} />
      ${backTo != null &&
      html`<div class="pr-bible-return">
        <${Button} size="sm" kind="primary" icon="chevron-left" onClick=${returnFromBible} title=${`Back to the shot (${comboLabel('mod+enter')})`} data-testid="pr-bible-back">Back to shot ${backTo + 1}<//>
      </div>`}
      <div class="pr-bible-refs-edit">
        <div class="field-label">Reference images (Ingredients)</div>
        <${Boundary} fallback=${html`<span class="muted small">Reference picker unavailable</span>`}>
          <${IngredientPicker} value=${refs} onChange=${(ids) => projectStore.update((q) => updateBibleEntry(q, kind, entry.id, { ingredientIds: ids }), { label: `${meta.one} references` })} placeholder="Add reference images" />
        <//>
      </div>
      <div class="row">
        <span class="muted tiny">First mention expands to “${entry.name || 'Name'} (description)”.</span>
        <span class="spacer"></span>
        <${IconButton} icon="trash" size="sm" kind="danger" title=${`Delete ${meta.one}`} onClick=${remove} />
      </div>
    </div>`}
  </div>`;
}

function EntryList({ kind, list }) {
  const meta = KIND_META[kind];
  const [openId, setOpenId] = useState(null);
  const [focusId, setFocusId] = useState(null); // card whose description takes the focus once it is open
  const request = useStore(promptsUi, (s) => s.bibleFocus);
  useEffect(() => {
    if (!request || !list.some((e) => e.id === request.id)) return;
    setOpenId(request.id);
    setFocusId(request.id);
    setUi({ bibleFocus: null }); // handled once (not again when the tab is shown later)
  }, [request?.n, list]);
  const add = () => {
    let id = null;
    projectStore.update(
      (q) => {
        const r = addBibleEntry(q, kind, { name: uniqueBibleName(q, kind === 'characters' ? 'New character' : 'New location') });
        id = r.id;
        return r.project;
      },
      { label: `Add ${meta.one}` },
    );
    setOpenId(id);
  };
  return html`<div class="pr-bible-group">
    <div class="pr-lib-heading"><${Icon} name=${meta.icon} size=${13} /> ${meta.label} <span class="spacer"></span><${Button} size="sm" kind="ghost" icon="plus" onClick=${add} data-testid=${`pr-add-${kind}`}>Add<//></div>
    ${list.length
      ? list.map(
          (e) =>
            html`<${EntryCard} key=${e.id} kind=${kind} entry=${e} open=${openId === e.id} onToggle=${() => setOpenId(openId === e.id ? null : e.id)} focusDesc=${focusId === e.id} onFocused=${() => setFocusId(null)} />`,
        )
      : html`<div class="pr-lib-none muted small">No ${meta.label.toLowerCase()} yet.</div>`}
  </div>`;
}

function BibleText({ field, value, label, placeholder, token }) {
  const t = useCommittedText(field, value, (key, text, session) => projectStore.update((q) => setBibleText(q, key, text), { label: `Edit ${label.toLowerCase()}`, merge: `bible:${key}:${session}` }));
  return html`<div class="pr-bible-group">
    <div class="pr-lib-heading">${label}<span class="spacer"></span>${token && html`<button type="button" class="pr-token-chip mono" title="Insert the token into the prompt" onClick=${() => insertIntoPrompt(token)}>${token}</button>`}</div>
    <${AutoTextarea} value=${t.text} minRows=${field === 'style' ? 3 : 2} maxRows=${10} placeholder=${placeholder} onInput=${(v) => t.setText(v)} onFocus=${t.bumpSession} onBlur=${t.flush} data-testid=${`pr-bible-${field}`} />
  </div>`;
}

export function BibleTab() {
  const bible = useProject((p) => getBible(p));
  const empty = !bible.characters.length && !bible.locations.length && !bible.style.trim();
  return html`<div class="pr-lib-pane">
    <div class="pr-lib-scroll">
      ${empty &&
      html`<div class="pr-lib-intro">
        <b>Keep the sequence consistent.</b> Describe your characters and locations once, then write <span class="mono">@Name</span> in any prompt —
        the first mention expands to the full description when the shot is sent. <span class="mono">{{style}}</span> inserts the style guide.
      </div>`}
      <${EntryList} kind="characters" list=${bible.characters} />
      <${EntryList} kind="locations" list=${bible.locations} />
      <${BibleText} field="style" value=${bible.style} label="Style guide" token="{{style}}" placeholder="The look every shot shares — e.g. cinematic, 35mm film grain, teal and orange palette, soft natural light" />
      <${BibleText} field="notes" value=${bible.notes} label="Notes" placeholder="Story notes, continuity reminders… (inserted only where you write {{notes}})" />
    </div>
  </div>`;
}
