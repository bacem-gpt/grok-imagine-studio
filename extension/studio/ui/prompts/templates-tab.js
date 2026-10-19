// Templates tab: meta-prompts to send to Grok *chat* so Grok writes material for you (shot lists, storyboards,
// character sheets, continuations, improvements). Fill the variables, preview, then send / copy, and import Grok's
// reply as shots. Users can save their own templates (libraryStore.templates).
import { html, useState, useMemo, useEffect } from '../../../vendor/preact-htm.mjs';
import { useLibrary, useProject, usePage, useStore } from '../hooks.js';
import { Icon, IconButton, Button, TextField, Toggle, toast, promptDialog, confirmDialog, showMenu } from '../kit.js';
import { libraryStore } from '../../core/store.js';
import { copyText } from '../../core/utils.js';
import * as S from '../../prompts/shots.js';
import { BUILTIN_TEMPLATES, templateFields, fillTemplate, createTemplate } from '../../prompts/templates.js';
import { getBible, mentionFor } from '../../prompts/library.js';
import { expandTokens } from '../../prompts/tokens.js';
import { promptsUi, sendTextToGrok, importFromPage } from './state.js';

const CHAT_ROUTES = new Set(['chat', 'other']);
const CATEGORY_ORDER = ['Plan', 'Shot', 'Reference', 'Refine', 'Mine'];

function useAllTemplates() {
  const mine = useLibrary((l) => l.templates || []);
  return useMemo(() => [...BUILTIN_TEMPLATES, ...mine.map((t) => ({ ...t, category: 'Mine', custom: true, description: t.description || 'Your template' }))], [mine]);
}

function TemplateDetail({ tpl, onBack }) {
  const bible = useProject((p) => getBible(p));
  const snippets = useLibrary((l) => l.snippets || []);
  const selectedId = useStore(promptsUi, (s) => s.selectedId);
  const shot = useProject((p) => S.findShot(p, selectedId));
  const route = usePage((s) => s.info?.route || null);
  const connected = usePage((s) => s.connected);
  const fields = useMemo(() => templateFields(tpl), [tpl]);
  const [values, setValues] = useState({});
  const [attachRefs, setAttachRefs] = useState(tpl.attach === 'reference');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tpl.template);
  useEffect(() => {
    setValues({});
    setDraft(tpl.template);
    setEditing(false);
    setAttachRefs(tpl.attach === 'reference');
  }, [tpl.id]);

  // Context defaults: the selected shot's prompt, the first bible character, the style guide.
  const ctxDefaults = useMemo(() => {
    const d = {};
    if (shot?.prompt) d.prompt = expandTokens(shot.prompt, { bible, snippets }).text;
    const firstChar = bible.characters.find((c) => c.name);
    if (firstChar) d.character = mentionFor(firstChar);
    const firstLoc = bible.locations.find((c) => c.name);
    if (firstLoc) d.location = mentionFor(firstLoc);
    if (bible.style.trim()) d.style = bible.style.trim();
    return d;
  }, [shot?.prompt, bible, snippets]);
  // Context (selected shot, bible) beats a template's generic default; the user's own value beats both.
  const effective = useMemo(() => {
    const out = {};
    for (const f of fields) {
      const v = values[f.key];
      if (v != null && String(v).trim()) out[f.key] = v;
      else if (ctxDefaults[f.key]) out[f.key] = ctxDefaults[f.key];
    }
    return out;
  }, [fields, values, ctxDefaults]);
  const filled = useMemo(() => fillTemplate(editing ? draft : tpl.template, effective, { bible, snippets }), [tpl, editing, draft, effective, bible, snippets]);
  const refs = Array.isArray(shot?.ingredientIds) ? shot.ingredientIds : [];
  const onImagine = route && !CHAT_ROUTES.has(route);
  const blocked = filled.missing.length > 0;

  const send = (submit) => sendTextToGrok(filled.text, { submit, ingredientIds: attachRefs ? refs : [] });
  const saveAs = async () => {
    const name = await promptDialog({ title: 'Save as my template', value: tpl.custom ? tpl.name : `${tpl.name} (mine)`, confirmLabel: 'Save' });
    if (name == null) return;
    const rec = createTemplate({ name, template: editing ? draft : tpl.template, fields: tpl.fields || [] });
    libraryStore.set((s) => ({ ...s, templates: [...(s.templates || []), rec] }));
    toast(`Saved “${rec.name}”`, { kind: 'success' });
  };
  const saveEdit = () => {
    libraryStore.set((s) => ({ ...s, templates: (s.templates || []).map((t) => (t.id === tpl.id ? { ...t, template: draft } : t)) }));
    setEditing(false);
    toast('Template saved', { kind: 'success', duration: 1500 });
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Delete template?', message: `“${tpl.name}” will be removed from your templates.`, confirmLabel: 'Delete', danger: true }))) return;
    libraryStore.set((s) => ({ ...s, templates: (s.templates || []).filter((t) => t.id !== tpl.id) }));
    onBack();
  };

  return html`<div class="pr-tpl-detail">
    <div class="pr-tpl-head">
      <${IconButton} icon="chevron-left" size="sm" title="All templates" onClick=${onBack} />
      <div class="pr-tpl-name">${tpl.name}</div>
      ${tpl.custom && html`<${IconButton} icon="more" size="sm" title="Template actions" onClick=${(e) => showMenu(e.currentTarget, [{ label: 'Edit text', icon: 'edit', onClick: () => setEditing(true) }, { label: 'Delete', icon: 'trash', danger: true, onClick: remove }])} />`}
    </div>
    <div class="pr-tpl-desc muted small">${tpl.description}</div>
    ${editing &&
    html`<div class="pr-tpl-edit">
      <${TextField} value=${draft} onInput=${setDraft} multiline=${true} rows=${7} />
      <div class="muted tiny">Use {{variable}} or {{variable|default}}; @Name and {{style}} come from the bible.</div>
      <div class="row"><span class="spacer"></span><${Button} size="sm" kind="ghost" onClick=${() => (setDraft(tpl.template), setEditing(false))}>Cancel<//>${tpl.custom && html`<${Button} size="sm" kind="primary" onClick=${saveEdit}>Save<//>`}</div>
    </div>`}
    <div class="pr-tpl-form">
      ${fields.map((f) => {
        const auto = !values[f.key] && !!ctxDefaults[f.key];
        return html`<label class="pr-tpl-field" key=${f.key}>
          <span class="field-label">${f.label}${filled.missing.includes(f.key) || filled.missing.some((m) => m.toLowerCase() === f.key) ? html` <span class="pr-req">required</span>` : auto ? html` <span class="pr-auto">from ${f.key === 'prompt' ? 'selected shot' : 'bible'}</span>` : ''}</span>
          <${TextField}
            value=${values[f.key] ?? ''}
            onInput=${(v) => setValues((s) => ({ ...s, [f.key]: v }))}
            multiline=${!!f.multiline}
            rows=${f.multiline ? 3 : undefined}
            placeholder=${auto ? String(ctxDefaults[f.key]).slice(0, 120) : f.default != null ? `${f.default} (default)` : f.placeholder || ''}
          />
        </label>`;
      })}
    </div>
    <div class="pr-tpl-preview">
      <div class="pr-preview-head"><${Icon} name="eye" size=${12} /> Message to Grok<span class="spacer"></span><span class="mono tiny">${filled.text.length} chars</span></div>
      <div class="pr-preview-text">${filled.text.split(/(\{\{[^{}]+\}\})/).map((part, i) => (i % 2 ? html`<mark key=${i} class="pr-tok is-unknown" title="Fill in this field">${part}</mark>` : part))}</div>
    </div>
    ${tpl.attach === 'reference' &&
    html`<div class="pr-tpl-attach">
      <${Toggle} checked=${attachRefs && refs.length > 0} disabled=${!refs.length} onChange=${setAttachRefs} label=${refs.length ? `Attach the selected shot’s ${refs.length} reference image${refs.length > 1 ? 's' : ''}` : 'Select a shot with reference images to attach them'} />
    </div>`}
    ${onImagine &&
    html`<div class="pr-hint is-warn">
      <${Icon} name="alert" size=${13} />
      <span>grok.com is showing Imagine: this message would be used as a <b>generation prompt</b>. Send it from a Grok chat instead.</span>
      <a class="pr-link-btn" href="https://grok.com/" target="_blank" rel="noopener">Open chat</a>
    </div>`}
    <div class="pr-tpl-actions">
      <${IconButton} icon="copy" size="sm" disabled=${blocked} title="Copy the message" onClick=${() => copyText(filled.text).then((ok) => toast(ok ? 'Copied' : 'Copy failed', { kind: ok ? 'success' : 'error', duration: 1400 }))} />
      <${IconButton} icon="save" size="sm" title="Save as my template (editable copy)" onClick=${saveAs} />
      <span class="spacer"></span>
      <${Button} size="sm" icon="send" disabled=${blocked || !connected} onClick=${() => send(false)} title="Insert into the Grok prompt box">Insert<//>
      <${Button} size="sm" kind="primary" icon="sparkles" disabled=${blocked || !connected} onClick=${() => send(true)} title="Insert and send to Grok" data-testid="pr-tpl-send">Ask Grok<//>
    </div>
    ${blocked && html`<div class="muted tiny pr-tpl-missing">Fill in: ${filled.missing.join(', ')}</div>`}
    <div class="pr-tpl-next">
      <${Icon} name="inbox" size=${14} />
      <span>When Grok has answered, import its reply as shots.</span>
      <span class="spacer"></span>
      <${Button} size="sm" kind="ghost" disabled=${!connected} onClick=${() => importFromPage('reply')} data-testid="pr-tpl-import">Import reply<//>
    </div>
  </div>`;
}

export function TemplatesTab() {
  const all = useAllTemplates();
  const [openId, setOpenId] = useState(null);
  const tpl = all.find((t) => t.id === openId);
  if (tpl) return html`<div class="pr-lib-pane"><div class="pr-lib-scroll"><${TemplateDetail} tpl=${tpl} onBack=${() => setOpenId(null)} /></div></div>`;
  const groups = CATEGORY_ORDER.map((c) => ({ c, items: all.filter((t) => (t.category || 'Mine') === c) })).filter((g) => g.items.length);
  return html`<div class="pr-lib-pane">
    <div class="pr-lib-scroll">
      <div class="pr-lib-intro">Messages for <b>Grok chat</b> that make Grok write material for you — shot lists, storyboards, character sheets. Send one, then import the reply as shots.</div>
      ${groups.map(
        (g) => html`<div class="pr-tpl-group" key=${g.c}>
          <div class="pr-lib-heading">${g.c === 'Mine' ? 'My templates' : g.c}</div>
          ${g.items.map(
            (t) => html`<button type="button" key=${t.id} class="pr-tpl-row" onClick=${() => setOpenId(t.id)} data-template=${t.id}>
              <span class="pr-tpl-row-text"><b>${t.name}</b><span>${t.description}</span></span>
              <${Icon} name="chevron-right" size=${14} />
            </button>`,
          )}
        </div>`,
      )}
    </div>
  </div>`;
}

