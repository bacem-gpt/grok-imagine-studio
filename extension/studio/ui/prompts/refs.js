// Shot reference images: the Ingredients tab's IngredientPicker (with a minimal built-in fallback picker if it is
// unavailable), the "attach when sending" preference, and a shortcut to add the references of bible characters
// mentioned in the prompt.
import { html, useState, useMemo } from '../../../vendor/preact-htm.mjs';
import { useLibrary, useProject, useStore } from '../hooks.js';
import { Icon, Button, Modal, EmptyState, Toggle, cx } from '../kit.js';
import { uiStore } from '../../core/store.js';
import { IngredientPicker } from '../ingredients/ingredient-picker.js';
import { mentionedEntries } from '../../prompts/library.js';
import { PrSection, Boundary, IngThumb } from './common.js';
import { prefsStore, setPrefs, patchShot } from './state.js';

/** Fallback chooser over libraryStore.ingredients (used only if the Ingredients picker fails to render). */
function SimpleRefPicker({ value = [], onChange }) {
  const library = useLibrary((l) => l.ingredients);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(value);
  const ids = value.filter((id) => library.some((i) => i.id === id));
  return html`<div class="pr-simple-picker">
    ${ids.map(
      (id) => html`<span class="pr-simple-chip" key=${id}>
        <${IngThumb} id=${id} title=${library.find((i) => i.id === id)?.name || ''} />
        <button type="button" title="Remove" onClick=${() => onChange(ids.filter((x) => x !== id))}><${Icon} name="x" size=${10} /></button>
      </span>`,
    )}
    <${Button} size="sm" icon="plus" onClick=${() => (setSel(ids), setOpen(true))}>${ids.length ? 'Add' : 'Add reference images'}<//>
    ${open &&
    html`<${Modal} title="Choose reference images" width=${640} onClose=${() => setOpen(false)}
      footer=${html`<${Button} kind="ghost" onClick=${() => setOpen(false)}>Cancel<//><${Button} kind="primary" onClick=${() => (onChange(sel), setOpen(false))}>Done<//>`}
    >
      ${!library.length
        ? html`<${EmptyState} icon="images" title="No ingredients yet" compact=${true}>Add reference images in the Ingredients tab first.<//>`
        : html`<div class="pr-simple-grid">
            ${library.map(
              (ing) => html`<button type="button" key=${ing.id} class=${cx('pr-simple-card', sel.includes(ing.id) && 'is-selected')} onClick=${() => setSel((s) => (s.includes(ing.id) ? s.filter((x) => x !== ing.id) : [...s, ing.id]))}>
                <${IngThumb} id=${ing.id} /><span>${ing.name}</span>
              </button>`,
            )}
          </div>`}
    <//>`}
  </div>`;
}

export function ReferencesSection({ shot }) {
  const attach = useStore(prefsStore, (p) => p.attachRefs);
  const ids = Array.isArray(shot.ingredientIds) ? shot.ingredientIds : [];
  const library = useLibrary((l) => l.ingredients);
  const bible = useProject((p) => p.bible);
  // References of bible entries mentioned in the prompt that the shot doesn't use yet.
  const suggested = useMemo(() => {
    const known = new Set(library.map((i) => i.id));
    const out = [];
    for (const e of mentionedEntries({ bible }, shot.prompt)) {
      const missing = (e.ingredientIds || []).filter((id) => known.has(id) && !ids.includes(id));
      if (missing.length) out.push({ name: e.name, ids: missing });
    }
    return out;
  }, [bible, shot.prompt, ids.join(','), library]);
  const setIds = (next) => patchShot(shot.id, { ingredientIds: next }, { label: 'Shot references' });
  const mode = shot.mode;

  // The Ingredients tab is where these images are prepared: name it here so the two words meet.
  return html`<${PrSection} id="refs" title="Reference images (Ingredients)" icon="images" count=${ids.length || null}>
    <div class="pr-refs">
      <${Boundary} fallback=${html`<${SimpleRefPicker} value=${ids} onChange=${setIds} />`}>
        <${IngredientPicker} value=${ids} onChange=${setIds} multiple=${true} placeholder="Add reference images (characters, products, keyframes)" />
      <//>
    </div>
    ${suggested.map(
      (s) => html`<div class="pr-ref-suggest" key=${s.name}>
        <${Icon} name="user" size=${13} />
        <span>@${s.name} has ${s.ids.length} reference image${s.ids.length > 1 ? 's' : ''} in the bible</span>
        <span class="spacer"></span>
        <button type="button" class="pr-link-btn" onClick=${() => setIds([...ids, ...s.ids])}>Add</button>
      </div>`,
    )}
    <div class="pr-refs-foot">
      <${Toggle} checked=${attach} onChange=${(v) => setPrefs({ attachRefs: v })} label="Attach to Grok when sending" />
      <span class="spacer"></span>
      <button type="button" class="pr-link-btn" title="Prepare reference images: import, crop, compose grids" onClick=${() => uiStore.set((s) => ({ ...s, tab: 'ingredients' }))} data-testid="pr-open-ingredients">
        ${library.length ? 'Ingredients tab' : 'Open Ingredients'}<${Icon} name="chevron-right" size=${12} />
      </button>
    </div>
    ${mode === 'animate' && !ids.length && html`<div class="pr-hint is-warn"><${Icon} name="info" size=${13} /> Image → video shots need a reference image: Grok animates it with your prompt.</div>`}
  <//>`;
}
