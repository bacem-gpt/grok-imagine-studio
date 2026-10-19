// Shot editor: title, prompt (live expanded preview, unknown-token warnings, counts, insert menu), reference images,
// Prompt Builder, takes, generation hints (duration / mode / notes), variations, and the Send / Copy action bar
// (whose main button becomes "Generate" while the shot's prompt waits in Grok's prompt box).
import { html, useRef, useEffect, useMemo, useState } from '../../../vendor/preact-htm.mjs';
import { useProject, useStore, usePage, useUI } from '../hooks.js';
import { Icon, IconButton, Button, Segmented, NumberField, EmptyState, Kbd, showMenu, toast, promptDialog, cx } from '../kit.js';
import { projectStore, uiStore, libraryStore } from '../../core/store.js';
import { pluralize } from '../../core/utils.js';
import * as S from '../../prompts/shots.js';
import { expandTokens } from '../../prompts/tokens.js';
import { textStats } from '../../prompts/text.js';
import { mentionFor, insertAt, createSnippet, upsertSnippet, addBibleEntry, snippetToken } from '../../prompts/library.js';
import { DURATION_OPTIONS, SHOT_MODES } from '../../prompts/presets.js';
import { PrSection, ShotStatus, useCommittedText, AutoTextarea, useExpandCtx, useShotInBox } from './common.js';
import { PromptBuilder } from './prompt-builder.js';
import { ReferencesSection } from './refs.js';
import { TakesSection } from './takes.js';
import { VariationsSection } from './variations-panel.js';
import { shotMenuItems } from './shot-list.js';
import {
  promptsUi,
  setUi,
  prefsStore,
  setPrefs,
  patchShot,
  setShotStatus,
  selectRelative,
  sendShot,
  generateNow,
  copyShotPrompt,
  editorApi,
  newShot,
  openPaste,
  describeBibleEntry,
} from './state.js';

const LONG_PROMPT = 1000;

function insertMenu(e, { ctx, onInsert }) {
  const { bible, snippets } = ctx;
  const entries = [...bible.characters.map((c) => ({ ...c, kind: 'Character' })), ...bible.locations.map((c) => ({ ...c, kind: 'Location' }))].filter((x) => x.name);
  const items = [{ header: 'Bible' }];
  if (entries.length) for (const x of entries.slice(0, 14)) items.push({ label: `${mentionFor(x)}`, icon: x.kind === 'Character' ? 'user' : 'map-pin', onClick: () => onInsert(mentionFor(x)) });
  else items.push({ label: 'No characters or locations yet', disabled: true });
  items.push({ label: bible.style.trim() ? '{{style}} — style guide' : '{{style}} — style guide (empty)', icon: 'palette', onClick: () => onInsert('{{style}}') });
  items.push('-', { header: 'Snippets (as tokens)' });
  if (snippets.length) for (const s of snippets.slice(0, 14)) items.push({ label: `{{${snippetToken(s)}}}`, icon: 'quote', onClick: () => onInsert(`{{${snippetToken(s)}}}`) });
  else items.push({ label: 'No snippets yet — Library → Snippets', disabled: true });
  items.push('-', { label: 'Open the library', icon: 'book', onClick: () => setUi((s) => ({ libraryOpen: true, pane: s.pane === 'editor' ? 'library' : s.pane })) });
  showMenu(e, items);
}

function TokenWarnings({ exp, shotId, onFixed }) {
  if (!exp.unknown.length && !exp.empty.length) return null;
  const fix = async (tok) => {
    if (tok.startsWith('@')) {
      // Add the character, then straight to its description (the card offers "Back to shot N").
      const name = tok.slice(1).replace(/[_-]+/g, ' ');
      let id = null;
      projectStore.update(
        (q) => {
          const r = addBibleEntry(q, 'characters', { name });
          id = r.id;
          return r.project;
        },
        { label: 'Add character' },
      );
      if (id) describeBibleEntry(id, { fromShot: shotId });
    } else {
      const name = tok.replace(/^\{\{|\}\}$/g, '').split('|')[0].trim();
      const text = await promptDialog({ title: `Create snippet “${name}”`, label: `Text inserted wherever {{${name}}} appears`, multiline: true, confirmLabel: 'Create snippet' });
      if (text == null) return;
      libraryStore.set((s) => ({ ...s, snippets: upsertSnippet(s.snippets, createSnippet({ title: name, text })) }));
      toast(`Snippet {{${name}}} created`, { kind: 'success' });
    }
    onFixed?.();
  };
  return html`<div class="pr-warn-row" role="status">
    <${Icon} name="alert" size=${13} />
    ${exp.unknown.length > 0 && html`<span>Unknown:</span>`}
    ${exp.unknown.map((t) => html`<button type="button" key=${t} class="pr-warn-tok" title=${t.startsWith('@') ? 'Add to the bible' : 'Create a snippet with this name'} onClick=${() => fix(t)}>${t}<${Icon} name="plus" size=${10} /></button>`)}
    ${exp.empty.length > 0 && html`<span class="pr-warn-empty">Empty: ${exp.empty.map((t) => `{{${t}}}`).join(' ')}</span>`}
  </div>`;
}

function ExpandedPreview({ exp }) {
  const hasTokens = exp.segments.some((s) => s.token);
  if (!hasTokens) return null;
  return html`<div class="pr-preview" data-testid="pr-preview">
    <div class="pr-preview-head"><${Icon} name="eye" size=${12} /> Sent to Grok as <span class="spacer"></span><span class="mono tiny">${exp.text.length} chars</span></div>
    <div class="pr-preview-text">
      ${exp.segments.map((s, i) => (s.token ? html`<mark key=${i} class=${cx('pr-tok', `is-${s.status}`)} title=${s.token}>${s.text || '∅'}</mark>` : s.text))}
    </div>
  </div>`;
}

function PromptField({ shot, index }) {
  const ctx = useExpandCtx();
  const taRef = useRef(null);
  const selRef = useRef({ start: null, end: null });
  const textRef = useRef('');
  const { text, setText, flush, bumpSession } = useCommittedText(shot.id, shot.prompt, (id, t, session) => patchShot(id, { prompt: t }, { label: 'Edit prompt', merge: `prompt:${id}:${session}` }));
  textRef.current = text;
  const exp = useMemo(() => expandTokens(text, ctx), [text, ctx]);
  const stats = textStats(exp.text);
  const focus = useStore(promptsUi, (s) => s.focus);

  const insert = (ins) => {
    const el = taRef.current;
    const cur = textRef.current;
    const focused = el && document.activeElement === el;
    const start = focused ? el.selectionStart : selRef.current.start;
    const end = focused ? el.selectionEnd : selRef.current.end;
    const r = insertAt(cur, ins, start, end);
    setText(r.text);
    flush();
    requestAnimationFrame(() => {
      if (!taRef.current) return;
      taRef.current.focus();
      taRef.current.setSelectionRange(r.cursor, r.cursor);
      selRef.current = { start: r.cursor, end: r.cursor };
    });
  };
  useEffect(() => {
    editorApi.insert = insert;
    return () => {
      if (editorApi.insert === insert) editorApi.insert = null;
    };
  });
  useEffect(() => {
    selRef.current = { start: null, end: null };
  }, [shot.id]);
  useEffect(() => {
    if (focus?.target !== 'prompt' || !taRef.current) return;
    const el = taRef.current;
    requestAnimationFrame(() => {
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    });
  }, [focus?.n]);

  const remember = () => {
    const el = taRef.current;
    if (el) selRef.current = { start: el.selectionStart, end: el.selectionEnd };
  };
  const saveAsSnippet = async () => {
    const el = taRef.current;
    const sel = el && el.selectionEnd > el.selectionStart ? el.value.slice(el.selectionStart, el.selectionEnd) : text;
    if (!sel.trim()) return toast('Write or select some text first', { kind: 'info' });
    const title = await promptDialog({ title: 'Save as snippet', label: 'Name (used as a {{token}} too)', value: '', placeholder: 'e.g. Hero look', confirmLabel: 'Save snippet' });
    if (title == null) return;
    const snip = createSnippet({ title, text: sel });
    libraryStore.set((s) => ({ ...s, snippets: upsertSnippet(s.snippets, snip) }));
    toast(`Saved snippet {{${snippetToken(snip)}}}`, { kind: 'success' });
  };

  return html`<div class="pr-prompt-block">
    <div class="pr-prompt-head">
      <label class="pr-block-label" for="pr-prompt-input">Prompt</label>
      <span class="spacer"></span>
      <span class=${cx('pr-count-text', stats.chars > LONG_PROMPT && 'is-long')} title=${stats.chars > LONG_PROMPT ? 'Long prompts are often truncated or partly ignored by video models' : 'Length of the text sent to Grok'} data-testid="pr-char-count">
        ${stats.chars} chars · ${pluralize(stats.words, 'word')}
      </span>
    </div>
    <${AutoTextarea}
      id="pr-prompt-input"
      class="pr-prompt"
      inputRef=${taRef}
      value=${text}
      minRows=${4}
      maxRows=${18}
      placeholder=${`Describe shot ${index + 1}: subject, action, setting, camera, light, sound…\nUse @Name for bible characters and {{name}} for snippets.`}
      onInput=${(v) => setText(v)}
      onFocus=${bumpSession}
      onBlur=${() => (remember(), flush())}
      onSelect=${remember}
      onKeyUp=${remember}
      onMouseUp=${remember}
      spellcheck=${true}
    />
    <div class="pr-prompt-tools">
      <${Button} size="sm" kind="ghost" icon="hash" onMouseDown=${(e) => e.preventDefault()} onClick=${(e) => insertMenu(e.currentTarget, { ctx, onInsert: insert })} title="Insert a @character, {{style}} or a snippet token">Insert<//>
      <${Button} size="sm" kind="ghost" icon="save" onMouseDown=${(e) => e.preventDefault()} onClick=${saveAsSnippet} title="Save the selection (or the whole prompt) as a reusable snippet">Save as snippet<//>
      <span class="spacer"></span>
      ${text && html`<${IconButton} icon="trash" size="sm" title="Clear the prompt" onClick=${() => (setText(''), flush())} />`}
    </div>
    <${TokenWarnings} exp=${exp} shotId=${shot.id} />
    <${ExpandedPreview} exp=${exp} />
  </div>`;
}

function DetailsSection({ shot }) {
  const { text, setText, flush, bumpSession } = useCommittedText(shot.id, shot.notes, (id, t, session) => patchShot(id, { notes: t }, { label: 'Edit notes', merge: `notes:${id}:${session}` }));
  // "Other" opens a number field for any length (it stays open for a non-preset length).
  const [otherOpen, setOtherOpen] = useState(false);
  const otherRef = useRef(null);
  useEffect(() => setOtherOpen(false), [shot.id]);
  const custom = otherOpen || !DURATION_OPTIONS.includes(shot.duration);
  const pickLength = (v) => {
    if (v === 'custom') {
      setOtherOpen(true);
      requestAnimationFrame(() => otherRef.current?.querySelector('input')?.select());
      return;
    }
    setOtherOpen(false);
    patchShot(shot.id, { duration: v }, { label: 'Shot length' });
  };
  return html`<${PrSection} id="details" title="Generation hints & notes" icon="sliders">
    <div class="pr-details">
      <div class="pr-detail">
        <div class="field-label">Length</div>
        <div class="row wrap">
          <${Segmented} size="sm" value=${custom ? 'custom' : shot.duration} options=${[...DURATION_OPTIONS.map((d) => ({ value: d, label: `${d}s` })), { value: 'custom', label: 'Other' }]} onChange=${pickLength} />
          ${custom && html`<span ref=${otherRef} class="pr-other-len"><${NumberField} value=${shot.duration} min=${1} max=${S.MAX_SHOT_DURATION} step=${0.5} suffix="s" width=${74} title="Length in seconds" onChange=${(v) => patchShot(shot.id, { duration: v }, { label: 'Shot length' })} /></span>`}
        </div>
      </div>
      <div class="pr-detail">
        <div class="field-label">Mode</div>
        <${Segmented} size="sm" value=${shot.mode} options=${SHOT_MODES.map((m) => ({ value: m.id, label: m.label, title: m.hint }))} onChange=${(v) => patchShot(shot.id, { mode: v }, { label: 'Shot mode' })} />
      </div>
    </div>
    <div class="pr-detail">
      <div class="field-label">Notes</div>
      <${AutoTextarea} value=${text} minRows=${2} maxRows=${8} placeholder="Private notes — continuity, what to fix in the next take… (not sent to Grok)" onInput=${(v) => setText(v)} onFocus=${bumpSession} onBlur=${flush} />
    </div>
  <//>`;
}

function StatusButton({ shot }) {
  const open = (e) =>
    showMenu(e.currentTarget, [
      { header: 'Status' },
      ...S.SHOT_STATUSES.map((st) => ({ label: S.STATUS_LABELS[st], checked: shot.status === st, onClick: () => setShotStatus(shot.id, st) })),
    ]);
  return html`<button type="button" class="pr-status-btn" title="Change status" onClick=${open} data-testid="pr-status-btn">
    <${ShotStatus} shot=${shot} /><${Icon} name="chevron-down" size=${12} />
  </button>`;
}

function EditorHeader({ shot, index, total, layout }) {
  const { text, setText, flush, bumpSession } = useCommittedText(shot.id, shot.title, (id, t, session) => patchShot(id, { title: t }, { label: 'Rename shot', merge: `title:${id}:${session}` }));
  const focus = useStore(promptsUi, (s) => s.focus);
  const inputRef = useRef(null);
  useEffect(() => {
    if (focus?.target === 'title') inputRef.current?.focus();
  }, [focus?.n]);
  return html`<div class="pr-ed-head">
    <div class="pr-ed-nav">
      ${layout === 'narrow' && html`<${IconButton} icon="chevron-left" size="sm" title="Back to the shot list" onClick=${() => setUi({ pane: 'list' })} />`}
      <span class="pr-ed-num" title=${`Shot ${index + 1} of ${total}`}>${String(index + 1).padStart(2, '0')}</span>
      <input
        ref=${inputRef}
        class="pr-ed-title"
        type="text"
        value=${text}
        placeholder="Untitled shot"
        aria-label="Shot title"
        onInput=${(e) => setText(e.currentTarget.value)}
        onFocus=${bumpSession}
        onBlur=${flush}
        onKeyDown=${(e) => e.key === 'Enter' && (flush(), e.currentTarget.blur())}
        data-testid="pr-title"
      />
      <${StatusButton} shot=${shot} />
      <div class="pr-ed-arrows">
        <${IconButton} icon="chevron-up" size="sm" title="Previous shot (Alt+↑)" disabled=${index <= 0} onClick=${() => selectRelative(-1)} />
        <${IconButton} icon="chevron-down" size="sm" title="Next shot (Alt+↓)" disabled=${index >= total - 1} onClick=${() => selectRelative(1)} />
      </div>
      <${IconButton} icon="more" size="sm" title="Shot actions" onClick=${(e) => showMenu(e.currentTarget, shotMenuItems(shot, index, total))} />
    </div>
  </div>`;
}

function ActionBar({ shot }) {
  const connected = usePage((s) => s.connected);
  const sendMode = useUI((s) => s.promptSendMode);
  const attach = useStore(prefsStore, (p) => p.attachRefs);
  const sending = useStore(promptsUi, (s) => s.sending.includes(shot.id));
  // The shot's prompt waits, unchanged, in Grok's prompt box: the main button starts the generation from here
  // (Grok's own button is often under the docked studio).
  const inBox = useShotInBox(shot);
  const refs = Array.isArray(shot.ingredientIds) ? shot.ingredientIds.length : 0;
  const submitDefault = sendMode === 'insert-submit';
  const sendMenu = (e) =>
    showMenu(e.currentTarget, [
      { header: 'Send to Grok' },
      { label: 'Insert into Grok', icon: 'send', shortcut: 'mod+enter', onClick: () => sendShot(shot.id, { submit: false }) },
      { label: 'Insert & generate', icon: 'sparkles', shortcut: 'mod+shift+enter', onClick: () => sendShot(shot.id, { submit: true }) },
      '-',
      { header: 'Send button' },
      { label: 'Inserts only', checked: !submitDefault, onClick: () => uiStore.set((s) => ({ ...s, promptSendMode: 'insert' })) },
      { label: 'Inserts & generates', checked: submitDefault, onClick: () => uiStore.set((s) => ({ ...s, promptSendMode: 'insert-submit' })) },
      '-',
      { label: `Attach reference images first${refs ? ` (${refs})` : ''}`, checked: attach, onClick: () => setPrefs({ attachRefs: !attach }) },
    ]);
  const main = inBox
    ? { icon: 'sparkles', label: 'Generate', title: 'The prompt is in Grok’s prompt box — start the generation (presses Grok’s button)', run: () => generateNow(shot.id), testid: 'pr-generate' }
    : submitDefault
      ? { icon: 'sparkles', label: 'Send & generate', title: 'Insert into Grok and generate (Ctrl+Shift+Enter)', run: () => sendShot(shot.id, { submit: true }), testid: 'pr-send' }
      : { icon: 'send', label: 'Send to Grok', title: 'Insert into Grok’s prompt box (Ctrl+Enter)', run: () => sendShot(shot.id), testid: 'pr-send' };
  return html`<div class="pr-actionbar">
    <div class="pr-actionbar-left">
      <${Button} size="sm" kind="ghost" icon="copy" onClick=${() => copyShotPrompt(shot.id)} title="Copy the prompt as sent (tokens expanded)" data-testid="pr-copy">Copy<//>
      ${shot.status !== 'approved'
        ? html`<${Button} size="sm" kind="ghost" icon="check" onClick=${() => setShotStatus(shot.id, 'approved')} title="Mark this shot as approved">Approve<//>`
        : html`<span class="pr-approved-note"><${Icon} name="check" size=${13} /> Approved</span>`}
    </div>
    <span class="spacer"></span>
    ${!connected &&
    html`<span class="pr-offline" role="status" title="The studio isn't connected to a grok.com tab — open grok.com/imagine to send prompts">
      <${Icon} name="alert" size=${13} /><span class="pr-offline-text">Not connected to grok.com</span>
    </span>`}
    <div class="btn-group pr-send">
      <${Button} kind="primary" icon=${sending ? null : main.icon} disabled=${sending} onClick=${main.run} title=${main.title} data-testid=${main.testid}>
        ${sending ? 'Sending…' : main.label}
      <//>
      <${Button} kind="primary" icon="chevron-down" class="pr-send-caret" title="Send options" aria-label="Send options" onClick=${sendMenu} />
    </div>
  </div>`;
}

/** Shown in the editor area when no shot is selected / the list is empty. */
function EditorEmpty({ hasShots }) {
  if (hasShots) return html`<div class="pr-editor panel"><${EmptyState} icon="edit" title="Select a shot">Pick a shot in the list to edit its prompt, builder fields, references and takes.<//></div>`;
  return html`<div class="pr-editor panel pr-welcome">
    <div class="pr-welcome-inner">
      <div class="pr-welcome-title"><${Icon} name="sparkles" size=${18} /> Prompt workshop</div>
      <p class="pr-welcome-lead">Prepare everything you send to Grok Imagine, then pick the best takes and cut them together.</p>
      <ol class="pr-steps">
        <li><b>Plan</b> — write shots, paste a prompt list, or let a template ask Grok for one. The builder and chips turn ideas into strong prompts; the bible keeps characters consistent.</li>
        <li><b>Send</b> — <span class="mono">Ctrl+Enter</span> puts the shot’s prompt (and reference images) into Grok’s prompt box. Batch-send several shots if you like.</li>
        <li><b>Collect</b> — new videos whose prompt matches a sent shot are linked to it as takes. Choose the best take per shot.</li>
        <li><b>Assemble</b> — one click puts the chosen takes on the timeline in shot order.</li>
      </ol>
      <div class="row wrap pr-welcome-actions">
        <${Button} kind="primary" icon="plus" onClick=${() => newShot()}>New shot<//>
        <${Button} icon="list" onClick=${() => openPaste('')}>Paste a prompt list<//>
        <${Button} kind="ghost" icon="wand" onClick=${() => (setPrefs({ libraryTab: 'templates' }), setUi({ libraryOpen: true, pane: 'library' }))}>Ask Grok for a shot list<//>
      </div>
    </div>
  </div>`;
}

export function ShotEditor({ layout }) {
  const selectedId = useStore(promptsUi, (s) => s.selectedId);
  const shot = useProject((p) => S.findShot(p, selectedId));
  const index = useProject((p) => S.shotIndex(p, selectedId));
  const total = useProject((p) => S.getShots(p).length);
  if (!shot) return html`<${EditorEmpty} hasShots=${total > 0} />`;
  return html`<div class="pr-editor panel" data-shot=${shot.id}>
    <${EditorHeader} shot=${shot} index=${index} total=${total} layout=${layout} />
    <div class="panel-body pr-editor-body">
      <${PromptField} shot=${shot} index=${index} />
      <${ReferencesSection} shot=${shot} />
      <${PromptBuilder} shot=${shot} />
      <${TakesSection} shot=${shot} />
      <${DetailsSection} shot=${shot} />
      <${VariationsSection} shot=${shot} />
      <div class="pr-kbd-help muted tiny">
        <span><${Kbd} combo="mod+enter" /> send</span>
        <span><${Kbd} combo="mod+shift+enter" /> send & generate</span>
        <span><${Kbd} combo="alt+arrowup" /><${Kbd} combo="alt+arrowdown" /> previous / next</span>
        <span><${Kbd} combo="mod+d" /> duplicate</span>
        <span><${Kbd} combo="alt+n" /> new shot</span>
      </div>
    </div>
    <${ActionBar} shot=${shot} />
  </div>`;
}
