// Dialogue tab: paste a long dialogue, split it into parts that each fit one generated video (~15 s), turn every
// part into a shot, send the parts to Grok one by one, see which video belongs to which part, then assemble the
// takes in dialogue order (optionally with subtitles). Pure logic lives in prompts/dialogue.js.
import { html, useMemo, useState, useEffect, useRef } from '../../../vendor/preact-htm.mjs';
import { useProject, useLibrary, useStore, useElementSize, usePage } from '../hooks.js';
import { Icon, IconButton, Button, Segmented, Select, Toggle, NumberField, toast, showMenu, confirmDialog, cx } from '../kit.js';
import { projectStore, uiStore } from '../../core/store.js';
import { appEvents } from '../../core/app-state.js';
import { pluralize, formatDuration, copyText } from '../../core/utils.js';
import * as M from '../../core/model.js';
import * as S from '../../prompts/shots.js';
import * as D from '../../prompts/dialogue.js';
import { getBible, mentionFor } from '../../prompts/library.js';
import { ShotStatus, TakeThumb, AutoTextarea, useCommittedText } from '../prompts/common.js';
import { removeFromBin } from '../media/actions.js';
import { sendShot, selectShot, setUi as setPromptsUi, assembleFromShots, startQueue, flushPending, queueStore } from '../prompts/state.js';

const NARROW = 760;
const LENGTHS = [6, 10, 15];

const update = (fn, label, merge = null) => projectStore.update(fn, { label, merge });
const dialogueNow = () => D.getDialogue(projectStore.get());
const setTab = (tab) => uiStore.set((s) => (s.tab === tab ? s : { ...s, tab }));

/** The project's dialogue (defaults filled), recomputed only when it changes. */
function useDialogue() {
  const raw = useProject((p) => p.dialogue);
  return useMemo(() => D.getDialogue({ dialogue: raw }), [raw]);
}

// ---------------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------------

/** Creates the missing shots (all parts, or the given ones). Returns the number created. */
function createShots(partIds = null, { quiet = false } = {}) {
  flushPending();
  let created = [];
  update((p) => {
    const r = D.createShotsForParts(p, { partIds });
    created = r.created;
    return r.project;
  }, 'Create shots for dialogue parts');
  if (!quiet) {
    if (created.length) toast(`Created ${pluralize(created.length, 'shot')} — one per part`, { kind: 'success', action: { label: 'Open Prompts', run: () => setTab('prompts') } });
    else toast('Every part already has its shot', { duration: 1800 });
  }
  return created.length;
}

/** Rewrites linked shots' prompts from their parts (drafts only unless includeSent). */
function syncPrompts({ includeSent = false, partIds = null, quiet = false } = {}) {
  flushPending();
  let updated = [];
  update((p) => {
    const r = D.syncShotPrompts(p, { includeSent, partIds });
    updated = r.updated;
    return r.project;
  }, 'Update shot prompts from the dialogue');
  if (!quiet) toast(updated.length ? `Updated ${pluralize(updated.length, 'shot prompt')}` : 'The shot prompts are already up to date', { duration: 2000 });
  return updated.length;
}

/** Makes sure a part has a shot with its current prompt, then sends it to Grok. */
async function sendPart(partId, { submit = false } = {}) {
  createShots([partId], { quiet: true });
  syncPrompts({ includeSent: true, partIds: [partId], quiet: true });
  const part = dialogueNow().parts.find((x) => x.id === partId);
  if (part?.shotId) await sendShot(part.shotId, { submit });
}

function openShot(shotId) {
  selectShot(shotId, { reveal: true });
  setPromptsUi({ pane: 'editor' });
  setTab('prompts');
}

async function sendAllParts() {
  createShots(null, { quiet: true });
  syncPrompts({ quiet: true });
  const p = projectStore.get();
  const ids = D.partShotIds(p).filter((id) => S.findShot(p, id)?.status === 'draft');
  if (!ids.length) return toast('Every part was already sent — use a part’s Send button to send it again', { kind: 'info', duration: 4000 });
  startQueue(ids);
  if (queueStore.get().status !== 'idle') {
    setPromptsUi({ dialog: 'queue' });
    setTab('prompts');
  }
}

async function assemble(replace) {
  const order = D.partShotIds(projectStore.get());
  if (!order.length) return toast('Create the parts’ shots and generate their videos first', { kind: 'info' });
  await assembleFromShots({ replace, order });
}

const CAPTION_STYLE = { size: 0.045, weight: 600, background: 'rgba(0,0,0,0.55)', y: 0.88, shadow: false, maxWidth: 0.86 };

/** Adds the dialogue as subtitles over the parts' clips (replacing subtitles added before). */
function addSubtitles({ withNames = true } = {}) {
  const plan = D.subtitlePlan(projectStore.get(), { withNames });
  if (!plan.length) return toast('Put the parts’ videos on the timeline first (Assemble), then add subtitles', { kind: 'info', duration: 4500 });
  update((p) => {
    let q = M.removeClips(p, p.tracks.text.filter((c) => c.dialogue).map((c) => c.id));
    const lane = Math.max(0, ...q.tracks.text.map((c) => (c.lane || 0) + 1));
    for (const s of plan) {
      const r = M.addTextClip(q, { text: s.text, start: s.start, duration: s.duration, style: CAPTION_STYLE, animation: 'fade', lane });
      q = { ...r.project, tracks: { ...r.project.tracks, text: r.project.tracks.text.map((c) => (c.id === r.id ? { ...c, dialogue: true } : c)) } };
    }
    return q;
  }, 'Add dialogue subtitles');
  toast(`Added ${pluralize(plan.length, 'subtitle')}`, { kind: 'success', action: { label: 'Open Edit', run: () => setTab('edit') } });
}

function removeSubtitles() {
  const ids = projectStore.get().tracks.text.filter((c) => c.dialogue).map((c) => c.id);
  if (!ids.length) return toast('No dialogue subtitles on the timeline', { duration: 1800 });
  update((p) => M.removeClips(p, ids), 'Remove dialogue subtitles');
  toast(`Removed ${pluralize(ids.length, 'subtitle')}`, { action: { label: 'Undo', run: () => projectStore.undo() } });
}

async function resplit() {
  const d = dialogueNow();
  const linked = d.parts.filter((x) => x.shotId).length;
  if (linked && !(await confirmDialog({ title: 'Split the dialogue again?', message: `The parts are recomputed to fit ${d.settings.clipSeconds}-second clips. Parts whose text doesn’t change keep their shot; ${pluralize(linked, 'part')} linked to shots may move to other text — check the shot prompts afterwards (⋯ → Update shot prompts).`, confirmLabel: 'Split again' }))) return;
  flushPending();
  update((p) => D.autoSplit(p), 'Split dialogue into parts');
  toast(`Split into ${pluralize(dialogueNow().parts.length, 'part')}`, { kind: 'success', duration: 2000 });
}

async function clearDialogue() {
  if (!(await confirmDialog({ title: 'Clear the dialogue?', message: 'The parts are removed. Shots already created stay in the Prompts tab.', confirmLabel: 'Clear', danger: true }))) return;
  update((p) => D.updateDialogue(p, (d) => ({ ...d, parts: [] })), 'Clear dialogue');
}

async function copyAllPrompts() {
  const d = dialogueNow();
  const text = d.parts.map((_, i) => `${D.partTitle(d.parts[i], i)}\n${D.buildPartPrompt(d, i)}`).join('\n\n');
  if (await copyText(text)) toast('Copied every part’s prompt', { kind: 'success', duration: 1600 });
}

// ---------------------------------------------------------------------------------------------------------
// Start: paste a dialogue
// ---------------------------------------------------------------------------------------------------------

const EXAMPLE = `ALICE: Did you see the light over the hill last night?
BOB: I did. I thought it was a plane at first.
ALICE: Planes don't stop in the middle of the sky and hover for ten minutes.
BOB (whispering): Then what was it?
(They both look up at the sky.)
ALICE: I don't know. But I think it's coming back tonight, and I want to be there when it does.`;

function StartPanel({ settings }) {
  const [text, setText] = useState('');
  const taRef = useRef(null);
  const preview = useMemo(() => D.splitDialogue(text, settings), [text, settings]);
  const start = () => {
    if (!text.trim()) return taRef.current?.focus();
    update((p) => D.autoSplit(D.updateDialogue(p, (d) => ({ ...d, parts: [] })), text), 'Split dialogue into parts');
  };
  return html`<div class="dlg-start">
    <div class="dlg-start-head">
      <div class="dlg-title"><${Icon} name="quote" size=${18} /> Dialogue planner</div>
      <p class="muted small">Paste the whole dialogue. It is cut into parts that each fit one ${settings.clipSeconds}-second video, every part becomes a shot, and each generated video stays linked to its part — so you always know which video says which lines, and the takes assemble in order.</p>
    </div>
    <${AutoTextarea}
      inputRef=${taRef}
      class="dlg-start-text"
      value=${text}
      minRows=${10}
      maxRows=${24}
      placeholder=${`One line per speaker turn, e.g.\n\n${EXAMPLE}`}
      onInput=${setText}
      data-testid="dlg-start-text"
    />
    <div class="row wrap dlg-start-actions">
      <${Button} kind="primary" icon="split-v" disabled=${!text.trim()} onClick=${start} data-testid="dlg-start-split">${text.trim() ? `Split into ${pluralize(preview.length, 'part')}` : 'Split into parts'}<//>
      <${Button} kind="ghost" icon="quote" onClick=${() => setText(EXAMPLE)}>Use an example<//>
      <span class="spacer"></span>
      <span class="muted tiny">${text.trim() ? `≈ ${formatDuration(D.estimateSeconds(text, settings))} of speech` : '“NAME: line” per line · (directions) in brackets · “---” forces a new part'}</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Setup panel (scene, speakers, prompt format, phrases)
// ---------------------------------------------------------------------------------------------------------

function SceneField({ scene }) {
  const { text, setText, flush, bumpSession } = useCommittedText('scene', scene, (_k, t, session) => update((p) => D.setScene(p, t), 'Edit scene', `dlg-scene:${session}`), { delay: 300 });
  return html`<${AutoTextarea}
    value=${text}
    minRows=${2}
    maxRows=${8}
    placeholder="Who is where, doing what — e.g. “Two friends sit at a café terrace at night, cinematic, medium shot.” Added before every part."
    onInput=${setText}
    onFocus=${bumpSession}
    onBlur=${flush}
    data-testid="dlg-scene"
  />`;
}

function SpeakerRow({ name, info, bible }) {
  const [voice, setVoice] = useState(info?.voice || '');
  useEffect(() => setVoice(info?.voice || ''), [info?.voice]);
  const commit = () => voice !== (info?.voice || '') && update((p) => D.setSpeaker(p, name, { voice: voice.trim() }), 'Speaker voice');
  const chars = bible.characters.filter((c) => c.name);
  return html`<div class="dlg-speaker">
    <span class="dlg-speaker-name" title=${name}>${name}</span>
    <input class="text-field dlg-speaker-voice" type="text" value=${voice} placeholder="voice — e.g. deep, calm" onInput=${(e) => setVoice(e.currentTarget.value)} onBlur=${commit} onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()} aria-label=${`${name}’s voice`} />
    ${chars.length > 0 &&
    html`<${Select}
      class="dlg-speaker-mention"
      value=${info?.mention || ''}
      title="Use a bible character (its @mention expands to the character’s description)"
      options=${[{ value: '', label: 'Name as written' }, ...chars.map((c) => ({ value: mentionFor(c), label: mentionFor(c) }))]}
      onChange=${(v) => update((p) => D.setSpeaker(p, name, { mention: v }), 'Speaker character')}
    />`}
  </div>`;
}

function SetupPanel({ d }) {
  const bible = useProject((p) => getBible(p));
  const phrases = useLibrary((l) => l.phrases || []);
  const speakers = useMemo(() => D.speakersOf(d.parts.map((x) => x.text).join('\n')), [d.parts]);
  const setSettings = (patch, label) => update((p) => D.setDialogueSettings(p, patch), label);
  const togglePhrase = (text) => {
    const has = d.settings.phrases.some((x) => x.toLowerCase() === text.toLowerCase());
    setSettings({ phrases: has ? d.settings.phrases.filter((x) => x.toLowerCase() !== text.toLowerCase()) : [...d.settings.phrases, text] }, 'Dialogue phrases');
  };
  const suggestions = phrases.length ? phrases.map((x) => x.text) : ['clear lip-synced speech', 'natural facial expressions', 'no music', 'no subtitles', 'no text on screen'];
  const extra = d.settings.phrases.filter((t) => !suggestions.some((x) => x.toLowerCase() === t.toLowerCase()));
  return html`<div class="dlg-setup">
    <section class="dlg-card">
      <div class="dlg-card-title">Scene <span class="muted tiny">added before every part</span></div>
      <${SceneField} scene=${d.scene} />
    </section>
    ${speakers.length > 0 &&
    html`<section class="dlg-card">
      <div class="dlg-card-title">Speakers</div>
      ${speakers.map((n) => html`<${SpeakerRow} key=${n} name=${n} info=${d.speakers[D.speakerKey(n)]} bible=${bible} />`)}
    </section>`}
    <section class="dlg-card">
      <div class="dlg-card-title">Prompt</div>
      <div class="field-label">Lines written as</div>
      <${Select} value=${d.settings.format} options=${D.DIALOGUE_FORMATS.map((f) => ({ value: f.id, label: f.label }))} onChange=${(v) => setSettings({ format: v }, 'Dialogue format')} />
      <${Toggle} checked=${d.settings.continuity} label="“Continues from the previous video” from part 2 on" onChange=${(v) => setSettings({ continuity: v }, 'Dialogue continuity')} />
      <div class="field-label">Phrases added to every part</div>
      <div class="pr-chips">
        ${[...suggestions, ...extra].map((t) => {
          const on = d.settings.phrases.some((x) => x.toLowerCase() === t.toLowerCase());
          return html`<button type="button" key=${t} class=${cx('chip', 'pr-chip', on && 'is-active')} aria-pressed=${on ? 'true' : 'false'} onClick=${() => togglePhrase(t)}>${on && html`<${Icon} name="check" size=${11} />`}${t}</button>`;
        })}
      </div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------------------------------------

function FitMeter({ text, settings }) {
  const est = D.estimateSeconds(text, settings);
  const cap = D.partCapacity(settings);
  const level = D.fitLevel(text, settings);
  return html`<span class=${cx('dlg-fit', `is-${level}`)} title=${`About ${est.toFixed(1)} s of speech; a ${settings.clipSeconds} s clip leaves ${cap.toFixed(0)} s for it${level === 'over' ? ' — too long: move a line to the next part or split it' : ''}`}>
    <span class="dlg-fit-bar"><span style=${`width:${Math.min(100, (est / cap) * 100)}%`}></span></span>
    <span class="dlg-fit-text">${est.toFixed(1)} / ${cap.toFixed(0)} s</span>
  </span>`;
}

function PartTakes({ shot }) {
  const takes = useProject((p) => (shot ? S.validTakes(p, shot) : []));
  if (!shot) return null;
  if (!takes.length) return html`<span class="dlg-takes-none muted tiny">${shot.status === 'draft' ? 'Not sent yet' : 'Waiting for the video…'}</span>`;
  const menu = (e, id) =>
    showMenu(e, [
      { label: 'Preview', icon: 'play', onClick: () => appEvents.emit('source.open', { mediaId: id }) },
      { label: shot.chosenTake === id ? 'Chosen take' : 'Use this take', icon: 'star', disabled: shot.chosenTake === id, onClick: () => update((p) => S.chooseTake(p, shot.id, id), 'Choose take') },
      { label: 'Unlink from this part', icon: 'x', onClick: () => update((p) => S.unlinkTake(p, shot.id, id), 'Unlink take') },
      '-',
      { label: 'Delete this video', icon: 'trash', danger: true, onClick: () => removeFromBin([id]) },
    ]);
  const chosen = S.effectiveTake(projectStore.get(), shot);
  return html`<div class="dlg-takes">
    ${takes.slice(0, 8).map(
      (id, i) => html`<button type="button" key=${id} class=${cx('dlg-take', id === chosen && 'is-chosen')} title=${`Take ${i + 1}${id === chosen ? ' · used in the sequence' : ''} — click for options`} onClick=${(e) => menu(e, id)} data-take=${id}>
        <${TakeThumb} mediaId=${id} />
        ${id === chosen && html`<span class="dlg-take-star"><${Icon} name="star-filled" size=${10} /></span>`}
      </button>`,
    )}
    ${takes.length > 8 && html`<span class="muted tiny">+${takes.length - 8}</span>`}
  </div>`;
}

function PartCard({ part, index, total, d }) {
  const shot = useProject((p) => (part.shotId ? S.findShot(p, part.shotId) : null));
  const connected = usePage((s) => s.connected);
  const [showPrompt, setShowPrompt] = useState(false);
  const { text, setText, flush, bumpSession } = useCommittedText(part.id, part.text, (id, t, session) => update((p) => D.setPartText(p, id, t), 'Edit dialogue part', `dlg-part:${id}:${session}`));
  const prompt = useMemo(() => D.buildPartPrompt({ ...d, parts: d.parts.map((x) => (x.id === part.id ? { ...x, text } : x)) }, index), [d, text, index, part.id]);
  const stale = shot && shot.prompt !== prompt;
  const speakers = D.speakersOf(text);
  const lines = D.splitLines(text).length;
  const menu = (e) =>
    showMenu(e.currentTarget, [
      shot ? { label: 'Open the shot in Prompts', icon: 'edit', onClick: () => openShot(shot.id) } : { label: 'Create its shot', icon: 'plus', onClick: () => createShots([part.id]) },
      shot && stale && { label: 'Update the shot’s prompt', icon: 'refresh', onClick: () => syncPrompts({ includeSent: true, partIds: [part.id] }) },
      { label: 'Copy the prompt', icon: 'copy', onClick: () => copyText(prompt).then((ok) => ok && toast('Copied', { kind: 'success', duration: 1200 })) },
      { label: 'Insert & generate', icon: 'sparkles', disabled: !text.trim(), onClick: () => sendPart(part.id, { submit: true }) },
      '-',
      { label: 'Move first line to the previous part', icon: 'arrow-up', disabled: index === 0 || !lines, onClick: () => (flush(), update((p) => D.moveLine(p, part.id, 'first-up'), 'Move line')) },
      { label: 'Move last line to the next part', icon: 'arrow-down', disabled: index >= total - 1 || !lines, onClick: () => (flush(), update((p) => D.moveLine(p, part.id, 'last-down'), 'Move line')) },
      { label: 'Split in two', icon: 'scissors', disabled: lines < 2, onClick: () => (flush(), update((p) => D.splitPartAt(p, part.id, Math.ceil(lines / 2)).project, 'Split part')) },
      { label: 'Merge with the next part', icon: 'layers', disabled: index >= total - 1, onClick: () => (flush(), update((p) => D.mergeWithNext(p, part.id), 'Merge parts')) },
      { label: 'Insert an empty part after', icon: 'plus', onClick: () => update((p) => D.insertPart(p, part.id).project, 'Insert part') },
      '-',
      {
        label: 'Delete part',
        icon: 'trash',
        danger: true,
        onClick: () => {
          update((p) => D.removeParts(p, part.id), 'Delete part');
          toast(`Deleted part ${index + 1}${shot ? ' (its shot stays in Prompts)' : ''}`, { action: { label: 'Undo', run: () => projectStore.undo() } });
        },
      },
    ]);
  return html`<article class=${cx('dlg-part', `is-${D.fitLevel(text, d.settings)}`)} data-part=${part.id} data-testid="dlg-part">
    <header class="dlg-part-head">
      <span class="dlg-part-num" title=${`Part ${index + 1} of ${total}`}>${String(index + 1).padStart(2, '0')}</span>
      <span class="dlg-part-who">${speakers.join(' & ') || 'Narration'}</span>
      <${FitMeter} text=${text} settings=${d.settings} />
      <span class="spacer"></span>
      ${shot ? html`<button type="button" class="dlg-shot-link" title="Open its shot in the Prompts tab" onClick=${() => openShot(shot.id)}><${ShotStatus} shot=${shot} compact=${true} /><span>Shot ${S.shotIndex(projectStore.get(), shot.id) + 1}</span></button>` : html`<span class="dlg-noshot muted tiny">no shot yet</span>`}
      <${Button}
        size="sm"
        kind=${shot && shot.status !== 'draft' ? 'ghost' : 'default'}
        icon="send"
        disabled=${!text.trim()}
        title=${connected ? 'Put this part’s prompt in Grok’s prompt box (creates its shot if needed)' : 'Open grok.com to send'}
        onClick=${() => (flush(), sendPart(part.id))}
        data-testid="dlg-send"
        >${shot && shot.status !== 'draft' ? 'Resend' : 'Send'}<//
      >
      <${IconButton} icon="more" size="sm" title="Part actions" onClick=${menu} />
    </header>
    <${AutoTextarea} class="dlg-part-text" value=${text} minRows=${2} maxRows=${14} placeholder="ALICE: …" onInput=${setText} onFocus=${bumpSession} onBlur=${flush} aria-label=${`Part ${index + 1} lines`} />
    <footer class="dlg-part-foot">
      <${PartTakes} shot=${shot} />
      <span class="spacer"></span>
      ${stale && html`<button type="button" class="dlg-stale" title="The part changed since its shot was written — click to update the shot’s prompt" onClick=${() => (flush(), syncPrompts({ includeSent: true, partIds: [part.id] }))}><${Icon} name="refresh" size=${11} /> Update shot</button>`}
      <button type="button" class="pr-link-btn" aria-expanded=${showPrompt ? 'true' : 'false'} onClick=${() => setShowPrompt(!showPrompt)}>${showPrompt ? 'Hide prompt' : 'Prompt'}</button>
    </footer>
    ${showPrompt && html`<div class="dlg-prompt mono" data-testid="dlg-prompt">${prompt}</div>`}
  </article>`;
}

function ScriptEditor({ d }) {
  const script = useMemo(() => D.scriptFromParts(d.parts), [d.parts]);
  const { text, setText, flush, bumpSession } = useCommittedText('script', script, (_k, t, session) => update((p) => D.setScript(p, t), 'Edit dialogue', `dlg-script:${session}`), { delay: 500 });
  const parts = useMemo(() => D.setScript({}, text), [text]);
  const texts = D.getDialogue(parts).parts.map((x) => x.text);
  const over = texts.filter((t) => D.fitLevel(t, d.settings) === 'over').length;
  return html`<div class="dlg-script">
    <div class="dlg-script-info muted small">
      <span><b>${pluralize(texts.length, 'part')}</b> · a line with <span class="mono">---</span> starts a new part</span>
      ${over > 0 && html`<span class="dlg-warn"><${Icon} name="alert" size=${12} /> ${pluralize(over, 'part')} too long for ${d.settings.clipSeconds} s</span>`}
    </div>
    <${AutoTextarea} class="dlg-script-text" value=${text} minRows=${14} maxRows=${60} onInput=${setText} onFocus=${bumpSession} onBlur=${flush} aria-label="Dialogue script" data-testid="dlg-script" />
  </div>`;
}

function Summary({ d }) {
  const stats = useProject((p) => {
    let shots = 0;
    let withTakes = 0;
    for (const part of d.parts) {
      const shot = part.shotId && S.findShot(p, part.shotId);
      if (!shot) continue;
      shots++;
      if (S.effectiveTake(p, shot)) withTakes++;
    }
    return { shots, withTakes };
  });
  const total = d.parts.reduce((s, x) => s + D.estimateSeconds(x.text, d.settings), 0);
  return html`<span class="dlg-summary muted small" data-testid="dlg-summary">
    ${pluralize(d.parts.length, 'part')} · ≈${formatDuration(total)} speech · ${stats.shots}/${d.parts.length} shots · ${stats.withTakes}/${d.parts.length} videos
  </span>`;
}

function Toolbar({ d, view, setView, narrow }) {
  const missing = d.parts.filter((x) => !x.shotId && x.text.trim()).length;
  const [otherOpen, setOtherOpen] = useState(!LENGTHS.includes(d.settings.clipSeconds));
  const speed = D.SPEEDS.find((s) => Math.abs(s.wps - d.settings.wps) < 0.01)?.id || 'custom';
  const setSettings = (patch, label) => update((p) => D.setDialogueSettings(p, patch), label);
  const more = (e) =>
    showMenu(e.currentTarget, [
      { label: `Split again to fit ${d.settings.clipSeconds} s clips`, icon: 'split-v', onClick: resplit },
      { label: 'Update the shots’ prompts (drafts)', icon: 'refresh', onClick: () => syncPrompts() },
      { label: 'Update every shot’s prompt, sent ones too', icon: 'refresh', onClick: () => syncPrompts({ includeSent: true }) },
      { label: 'Send every unsent part (batch)…', icon: 'sparkles', onClick: sendAllParts },
      { label: 'Copy every part’s prompt', icon: 'copy', onClick: copyAllPrompts },
      '-',
      { header: 'Timeline' },
      { label: 'Assemble the videos in dialogue order', icon: 'film', onClick: () => assemble(false) },
      { label: 'Replace the timeline with them', icon: 'film', onClick: () => assemble(true) },
      { label: 'Add the dialogue as subtitles', icon: 'type', onClick: () => addSubtitles() },
      { label: 'Add subtitles without names', icon: 'type', onClick: () => addSubtitles({ withNames: false }) },
      { label: 'Remove dialogue subtitles', icon: 'x', onClick: removeSubtitles },
      '-',
      { label: 'Clear the dialogue', icon: 'trash', danger: true, onClick: clearDialogue },
    ]);
  return html`<div class="dlg-toolbar">
    <${Segmented} size="sm" value=${view} onChange=${setView} options=${[{ value: 'parts', label: 'Parts', icon: 'list' }, { value: 'script', label: 'Script', icon: 'type' }, ...(narrow ? [{ value: 'setup', label: 'Setup', icon: 'sliders' }] : [])]} />
    <div class="dlg-tool" title="Length of one generated video: the parts are cut to fit it">
      <span class="dlg-tool-label">Clip</span>
      <${Segmented}
        size="sm"
        value=${otherOpen ? 'other' : d.settings.clipSeconds}
        options=${[...LENGTHS.map((s) => ({ value: s, label: `${s}s` })), { value: 'other', label: '…', title: 'Other length' }]}
        onChange=${(v) => (v === 'other' ? setOtherOpen(true) : (setOtherOpen(false), setSettings({ clipSeconds: v }, 'Clip length')))}
      />
      ${otherOpen && html`<${NumberField} value=${d.settings.clipSeconds} min=${2} max=${60} step=${1} suffix="s" width=${62} title="Clip length" onChange=${(v) => setSettings({ clipSeconds: v }, 'Clip length')} />`}
    </div>
    <div class="dlg-tool" title="How fast the characters speak — sets how many lines fit in a clip">
      <span class="dlg-tool-label">Speech</span>
      <${Select}
        value=${speed}
        options=${[...D.SPEEDS.map((s) => ({ value: s.id, label: `${s.label} (${s.wps} words/s)` })), ...(speed === 'custom' ? [{ value: 'custom', label: `${d.settings.wps} words/s` }] : [])]}
        onChange=${(v) => v !== 'custom' && setSettings({ wps: D.SPEEDS.find((s) => s.id === v).wps }, 'Speaking speed')}
      />
    </div>
    <span class="spacer"></span>
    <${Summary} d=${d} />
    ${missing > 0
      ? html`<${Button} size="sm" kind="primary" icon="plus" onClick=${() => createShots()} title="One shot per part, titled “Part N”, with the part’s prompt" data-testid="dlg-create-shots">Create ${pluralize(missing, 'shot')}<//>`
      : html`<${Button} size="sm" icon="film" onClick=${() => assemble(false)} title="Put each part’s chosen video on the timeline, in dialogue order" data-testid="dlg-assemble">Assemble<//>`}
    <${IconButton} icon="more" size="sm" title="More dialogue actions" onClick=${more} data-testid="dlg-more" />
  </div>`;
}

export function DialogueView() {
  const d = useDialogue();
  const [ref, size] = useElementSize();
  const narrow = (size.width || window.innerWidth) < NARROW;
  const [view, setView] = useState('parts');
  const shown = !narrow && view === 'setup' ? 'parts' : view;
  // Shot links of deleted shots are dropped quietly.
  const dangling = useProject((p) => (p.dialogue?.parts || []).some((x) => x?.shotId && !S.findShot(p, x.shotId)));
  useEffect(() => {
    if (dangling) projectStore.update((p) => D.repairDialogue(p), { history: false });
  }, [dangling]);

  if (!d.parts.length)
    return html`<div class="dlg-root is-empty" ref=${ref}>
      <div class="dlg-scroll"><${StartPanel} settings=${d.settings} /></div>
    </div>`;
  return html`<div class=${cx('dlg-root', narrow && 'is-narrow')} ref=${ref}>
    <${Toolbar} d=${d} view=${view} setView=${setView} narrow=${narrow} />
    <div class="dlg-cols">
      <div class="dlg-main dlg-scroll">
        ${shown === 'parts' &&
        html`<div class="dlg-parts">
          ${d.parts.map((part, i) => html`<${PartCard} key=${part.id} part=${part} index=${i} total=${d.parts.length} d=${d} />`)}
          <button type="button" class="dlg-add-part" onClick=${() => update((p) => D.insertPart(p, null).project, 'Add part')}><${Icon} name="plus" size=${13} /> Add a part</button>
        </div>`}
        ${shown === 'script' && html`<${ScriptEditor} d=${d} />`}
        ${shown === 'setup' && html`<${SetupPanel} d=${d} />`}
      </div>
      ${!narrow && html`<aside class="dlg-side dlg-scroll"><${SetupPanel} d=${d} /></aside>`}
    </div>
  </div>`;
}

