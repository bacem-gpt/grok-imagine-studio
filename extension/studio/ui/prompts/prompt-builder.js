// Prompt Builder: structured fields (subject, action, setting, shot type, camera, lens, motion, timing, lighting,
// style, mood, palette, sound, extra) with chip pickers from presets.js (plus the user's own chips saved in
// libraryStore.presets and bible @mentions), one-click looks, a live preview and "Compose" into the prompt.
import { html, useState, useMemo } from '../../../vendor/preact-htm.mjs';
import { useLibrary, useProject, useStore } from '../hooks.js';
import { Icon, IconButton, Button, Select, showMenu, toast, cx } from '../kit.js';
import { projectStore, libraryStore } from '../../core/store.js';
import * as S from '../../prompts/shots.js';
import { BUILDER_FIELDS, ORDER_PRESETS, composePrompt, orderFor, hasFields } from '../../prompts/compose.js';
import { presetGroupsFor, RECIPES } from '../../prompts/presets.js';
import { hasPhrase, togglePhrase } from '../../prompts/text.js';
import { getBible, mentionFor, createCustomPreset, addCustomPreset, removeCustomPreset } from '../../prompts/library.js';
import { PrSection, useCommittedText } from './common.js';
import { prefsStore, setPrefs, patchShot } from './state.js';

const SECTIONS = ['Scene', 'Camera', 'Look', 'Sound & extras'];

function setFieldValue(shotId, key, value, { label = 'Edit builder field', merge = null } = {}) {
  projectStore.update((q) => S.updateShotFields(q, shotId, { [key]: value }), { label, merge });
}

/** Chip groups for a field, including bible mentions for subject / setting and {{style}}. */
function useChipGroups(key) {
  const custom = useLibrary((l) => l.presets);
  const bible = useProject((p) => getBible(p));
  return useMemo(() => {
    const groups = presetGroupsFor(key, custom);
    const extra = [];
    if (key === 'subject' && bible.characters.length) extra.push({ group: 'Bible characters', items: bible.characters.filter((c) => c.name).map((c) => ({ label: mentionFor(c), text: mentionFor(c) })) });
    if (key === 'setting' && bible.locations.length) extra.push({ group: 'Bible locations', items: bible.locations.filter((c) => c.name).map((c) => ({ label: mentionFor(c), text: mentionFor(c) })) });
    if (key === 'style' && bible.style.trim()) extra.push({ group: 'Bible', items: [{ label: '{{style}} (style guide)', text: '{{style}}' }] });
    return [...extra, ...groups];
  }, [key, custom, bible]);
}

/** Latest stored value (a blur may have committed typed text after the last render). */
const liveValue = (shotId, key) => S.findShot(projectStore.get(), shotId)?.fields?.[key] || '';

function ChipPanel({ shotId, field, value }) {
  const groups = useChipGroups(field.key);
  const toggle = (text) => setFieldValue(shotId, field.key, togglePhrase(liveValue(shotId, field.key), text), { label: `Builder: ${field.label}` });
  const saveCustom = () => {
    const text = String(liveValue(shotId, field.key) || '')
      .split(/[,;]/)
      .pop()
      .trim();
    if (!text) return toast(`Type a ${field.label.toLowerCase()} first, then save it as a chip`, { kind: 'info' });
    libraryStore.set((s) => ({ ...s, presets: addCustomPreset(s.presets, createCustomPreset(field.key, text)) }));
    toast(`Saved “${text}” as a ${field.label.toLowerCase()} chip`, { kind: 'success', duration: 2000 });
  };
  return html`<div class="pr-chip-panel" data-field=${field.key}>
    ${groups.map(
      (g) => html`<div class="pr-chip-group" key=${g.group}>
        <div class="pr-chip-group-label">${g.group}</div>
        <div class="pr-chips">
          ${g.items.map((it) => {
            const on = hasPhrase(value, it.text);
            return html`<button
              type="button"
              key=${it.id || it.text}
              class=${cx('chip', 'pr-chip', on && 'is-active', it.custom && 'is-custom')}
              title=${it.text === it.label ? (it.custom ? 'Your chip — right-click to remove' : '') : it.text}
              onClick=${() => toggle(it.text)}
              onContextMenu=${(e) =>
                it.custom &&
                showMenu(e, [{ label: `Remove “${it.label}”`, icon: 'trash', danger: true, onClick: () => libraryStore.set((s) => ({ ...s, presets: removeCustomPreset(s.presets, it.id) })) }])}
            >
              ${on && html`<${Icon} name="check" size=${11} />`}${it.label}
            </button>`;
          })}
        </div>
      </div>`,
    )}
    <div class="pr-chip-panel-foot">
      <button type="button" class="pr-link-btn" onClick=${saveCustom}><${Icon} name="plus" size=${12} /> Save current text as my chip</button>
    </div>
  </div>`;
}

function FieldRow({ shot, field, open, onToggle }) {
  const stored = shot.fields?.[field.key] || '';
  const { text, setText, flush, bumpSession } = useCommittedText(`${shot.id}:${field.key}`, stored, (key, t, session) => {
    const [shotId, fieldKey] = key.split(':');
    setFieldValue(shotId, fieldKey, t, { merge: `field:${key}:${session}` });
  });
  const filled = !!String(text || '').trim();
  return html`<div class=${cx('pr-field', open && 'is-open', filled && 'is-filled')} data-field=${field.key}>
    <label class="pr-field-label" for=${`pr-f-${field.key}`}>${field.label}</label>
    <div class="pr-field-input">
      <input
        id=${`pr-f-${field.key}`}
        type="text"
        class="text-field"
        value=${text}
        placeholder=${field.placeholder}
        onInput=${(e) => setText(e.currentTarget.value)}
        onFocus=${bumpSession}
        onBlur=${flush}
        onKeyDown=${(e) => e.key === 'Enter' && (flush(), e.currentTarget.blur())}
      />
      <button type="button" class=${cx('pr-field-chips-btn', open && 'is-active')} title=${open ? 'Hide suggestions' : `${field.label} suggestions`} aria-expanded=${open ? 'true' : 'false'} onClick=${onToggle}>
        <${Icon} name=${open ? 'chevron-up' : 'sparkles'} size=${13} />
      </button>
    </div>
    ${open && html`<${ChipPanel} shotId=${shot.id} field=${field} value=${stored} />`}
  </div>`;
}

export function PromptBuilder({ shot }) {
  const order = useStore(prefsStore, (p) => p.order);
  const [openKey, setOpenKey] = useState(null);
  // Until the user opens or closes the builder (then their choice sticks): open for a shot without a prompt, closed
  // once it has one, so its references and takes are right under the prompt. Decided when the shot is opened —
  // typing the first words doesn't fold it away.
  const autoOpen = useMemo(() => !String(shot.prompt || '').trim(), [shot.id]);
  const fields = shot.fields || {};
  const composed = useMemo(() => composePrompt(fields, orderFor(order)), [fields, order]);
  const filled = BUILDER_FIELDS.filter((f) => String(fields[f.key] || '').trim()).length;

  const compose = (mode = 'replace') => {
    if (!composed) return toast('Fill in a few builder fields first (or click chips)', { kind: 'info' });
    const cur = (shot.prompt || '').trim();
    const next = mode === 'append' && cur ? `${cur} ${composed}` : composed;
    if (next === cur) return;
    patchShot(shot.id, { prompt: next }, { label: mode === 'append' ? 'Append composed prompt' : 'Compose prompt' });
    if (cur && mode === 'replace') toast('Prompt replaced with the composed text', { action: { label: 'Undo', run: () => projectStore.undo() } });
  };
  const applyRecipe = (r) => {
    projectStore.update((q) => S.updateShotFields(q, shot.id, r.fields), { label: `Look: ${r.label}` });
    toast(`Applied the “${r.label}” look`, { duration: 1800 });
  };
  const clearAll = () => {
    const empty = Object.fromEntries(Object.keys(fields).map((k) => [k, '']));
    projectStore.update((q) => S.updateShotFields(q, shot.id, empty), { label: 'Clear builder' });
  };

  const actions = html`
    <${Select} class="pr-order-select" value=${order} title="Sentence order" options=${ORDER_PRESETS.map((o) => ({ value: o.id, label: o.label }))} onChange=${(v) => setPrefs({ order: v })} />
  `;

  return html`<${PrSection} id="builder" title="Prompt builder" icon="wand" count=${filled || null} actions=${actions} defaultOpen=${autoOpen}>
    <div class="pr-recipes">
      <span class="pr-recipes-label">Quick looks</span>
      <div class="pr-recipes-chips">
        ${RECIPES.map((r) => html`<button type="button" key=${r.id} class="chip pr-recipe" title=${composePrompt(r.fields)} onClick=${() => applyRecipe(r)}>${r.label}</button>`)}
      </div>
    </div>
    ${SECTIONS.map(
      (sec) => html`<div class="pr-field-group" key=${sec}>
        <div class="pr-field-group-label">${sec}</div>
        <div class="pr-field-grid">
          ${BUILDER_FIELDS.filter((f) => f.section === sec).map(
            (f) => html`<${FieldRow} key=${f.key} shot=${shot} field=${f} open=${openKey === f.key} onToggle=${() => setOpenKey(openKey === f.key ? null : f.key)} />`,
          )}
        </div>
      </div>`,
    )}
    <div class=${cx('pr-compose', !composed && 'is-empty')}>
      <div class="pr-compose-preview" data-testid="pr-compose-preview">${composed || 'Pick chips or type in the fields above — the composed prompt appears here.'}</div>
      <div class="pr-compose-actions">
        ${hasFields(fields) && html`<button type="button" class="pr-link-btn" onClick=${clearAll}>Clear fields</button>`}
        <span class="spacer"></span>
        <${IconButton} icon="plus" size="sm" title="Append to the prompt" disabled=${!composed} onClick=${() => compose('append')} />
        <${Button} size="sm" kind="primary" icon="wand" disabled=${!composed} onClick=${() => compose('replace')} data-testid="pr-compose">Compose prompt<//>
      </div>
    </div>
  <//>`;
}
