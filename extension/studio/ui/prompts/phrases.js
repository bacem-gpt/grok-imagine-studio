// Quick phrases: the phrase board under a shot's prompt (one click adds / removes "nobody speaks", "camera angle from
// top"… in the prompt), phrase sets, the prepared phrase library browser and the Library → Phrases manager.
// The user's phrases live in libraryStore.phrases (shared by every project); see prompts/phrases.js.
import { html, useState, useMemo } from '../../../vendor/preact-htm.mjs';
import { useLibrary, useStore, useProject } from '../hooks.js';
import { Icon, IconButton, Button, Modal, Select, EmptyState, toast, showMenu, promptDialog, confirmDialog, pickFiles, cx } from '../kit.js';
import { projectStore, libraryStore } from '../../core/store.js';
import { downloadBlob, pluralize } from '../../core/utils.js';
import * as S from '../../prompts/shots.js';
import * as P from '../../prompts/phrases.js';
import { PrSection } from './common.js';
import { prefsStore, setPrefs, flushPending, currentShot, editorApi, setUi, promptsUi } from './state.js';

const phrasesOf = () => libraryStore.get().phrases || [];
const setPhrases = (fn) => libraryStore.set((s) => ({ ...s, phrases: fn(s.phrases || []) }));
const setSets = (fn) => libraryStore.set((s) => ({ ...s, phraseSets: fn(s.phraseSets || []) }));
const joinOpts = () => ({ join: prefsStore.get().phraseJoin === 'comma' ? 'comma' : 'sentence' });

/** Rewrites a shot's prompt with fn(prompt) as one undo step (pending typing is committed first). */
export function editShotPrompt(shotId, fn, label) {
  flushPending();
  const shot = S.findShot(projectStore.get(), shotId);
  if (!shot) return false;
  const next = fn(shot.prompt || '');
  if (next === (shot.prompt || '')) return false;
  projectStore.update((q) => S.updateShot(q, shotId, { prompt: next }), { label });
  return true;
}

/** Adds the phrase to the shot's prompt, or removes it when it is there. */
export const togglePhraseOnShot = (shotId, text) => editShotPrompt(shotId, (pr) => P.togglePhraseInPrompt(pr, text, joinOpts()), P.promptHasPhrase(S.findShot(projectStore.get(), shotId)?.prompt, text) ? 'Remove phrase' : 'Add phrase');

/** Adds (or removes) a phrase on every shot. */
function phraseOnAllShots(text, add) {
  flushPending();
  const shots = S.getShots(projectStore.get());
  const touched = shots.filter((s) => P.promptHasPhrase(s.prompt, text) !== add).length;
  if (!touched) return toast(add ? 'Every shot already has that phrase' : 'No shot has that phrase', { duration: 1800 });
  projectStore.update(
    (q) => {
      let p = q;
      for (const s of S.getShots(q)) {
        const next = add ? P.addPhraseToPrompt(s.prompt, text, joinOpts()) : P.removePhraseFromPrompt(s.prompt, text);
        if (next !== s.prompt) p = S.updateShot(p, s.id, { prompt: next });
      }
      return p;
    },
    { label: add ? 'Add phrase to all shots' : 'Remove phrase from all shots' },
  );
  toast(`${add ? 'Added to' : 'Removed from'} ${pluralize(touched, 'shot')}`, { action: { label: 'Undo', run: () => projectStore.undo() } });
}

/** Adds phrases to the user's list. Returns how many were new. */
export function addToMyPhrases(partials, { quiet = false } = {}) {
  const before = phrasesOf().length;
  setPhrases((list) => P.addPhrases(list, partials));
  const added = phrasesOf().length - before;
  if (!quiet) toast(added ? `Added ${pluralize(added, 'phrase')} to your list` : 'Those phrases are already in your list', { kind: added ? 'success' : 'info', duration: 1800 });
  return added;
}

async function editPhraseText(ph) {
  const v = await promptDialog({ title: 'Edit phrase', label: 'Phrase', value: ph.text, confirmLabel: 'Save' });
  if (v == null) return;
  const before = phrasesOf();
  setPhrases((list) => P.updatePhrase(list, ph.id, { text: v }));
  if (phrasesOf() === before && P.cleanPhraseText(v) !== ph.text) toast('That phrase is already in your list', { kind: 'info' });
}

function deletePhrase(ph) {
  const before = phrasesOf();
  setPhrases((list) => P.removePhrase(list, ph.id));
  toast(`Deleted “${ph.text}”`, { action: { label: 'Undo', run: () => setPhrases(() => before) } });
}

/** Context menu of a phrase chip / row. */
function phraseMenu(e, ph, { shotId = null } = {}) {
  const items = [];
  if (shotId) {
    items.push({ label: 'Insert at the cursor', icon: 'type', onClick: () => editorApi.insert?.(ph.text) });
    items.push('-');
  }
  items.push(
    { label: 'Add to every shot', icon: 'plus', onClick: () => phraseOnAllShots(ph.text, true) },
    { label: 'Remove from every shot', icon: 'minus', onClick: () => phraseOnAllShots(ph.text, false) },
    { label: 'Start every new shot with it', checked: !!ph.auto, onClick: () => setPhrases((list) => P.updatePhrase(list, ph.id, { auto: !ph.auto })) },
    '-',
    { label: 'Edit…', icon: 'edit', onClick: () => editPhraseText(ph) },
    { header: 'Category' },
    ...P.PHRASE_CATEGORIES.map((c) => ({ label: c.label, checked: ph.category === c.id, onClick: () => setPhrases((list) => P.updatePhrase(list, ph.id, { category: c.id })) })),
    '-',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => deletePhrase(ph) },
  );
  showMenu(e, items);
}

async function saveSetFrom(texts) {
  if (!texts.length) return toast('Click a few phrases into the prompt first — the set remembers the ones that are on', { kind: 'info' });
  const name = await promptDialog({ title: 'Save phrase set', label: `Name for these ${texts.length} phrases`, placeholder: 'e.g. Dialogue scene', confirmLabel: 'Save set' });
  if (name == null) return;
  setSets((list) => [...list, P.createPhraseSet({ name, texts })]);
  toast('Phrase set saved', { kind: 'success', duration: 1600 });
}

function setMenu(e, set) {
  showMenu(e, [
    { header: set.texts.join(' · ').slice(0, 80) },
    {
      label: 'Rename…',
      icon: 'edit',
      onClick: async () => {
        const v = await promptDialog({ title: 'Rename set', value: set.name, confirmLabel: 'Rename' });
        if (v != null && v.trim()) setSets((list) => list.map((x) => (x.id === set.id ? { ...x, name: v.trim() } : x)));
      },
    },
    {
      label: 'Replace with the phrases now in the prompt',
      icon: 'refresh',
      onClick: () => {
        const shot = currentShot();
        const texts = P.activePhrases(shot?.prompt, phrasesOf());
        if (!texts.length) return toast('No phrase of your list is in this prompt', { kind: 'info' });
        setSets((list) => list.map((x) => (x.id === set.id ? { ...x, texts: P.createPhraseSet({ texts }).texts } : x)));
      },
    },
    '-',
    {
      label: 'Delete set',
      icon: 'trash',
      danger: true,
      onClick: () => {
        const before = libraryStore.get().phraseSets || [];
        setSets((list) => list.filter((x) => x.id !== set.id));
        toast(`Deleted set “${set.name}”`, { action: { label: 'Undo', run: () => setSets(() => before) } });
      },
    },
  ]);
}

const openPhrasesLibrary = () => (setPrefs({ libraryTab: 'phrases' }), setUi((s) => ({ libraryOpen: true, pane: s.pane === 'editor' ? 'library' : s.pane })));

/** Inline "add a phrase" field: Enter saves it to the list (and, on the board, puts it in the prompt). */
function AddPhraseField({ category, onAdded, placeholder = 'Add a phrase…' }) {
  const [v, setV] = useState('');
  const submit = () => {
    const text = P.cleanPhraseText(v);
    if (!text) return;
    const existing = phrasesOf()[P.findPhraseIndex(phrasesOf(), text)];
    if (!existing) setPhrases((list) => P.addPhrases(list, { text, category: category && category !== 'all' ? category : 'other' }));
    setV('');
    onAdded?.(existing?.text || text);
  };
  return html`<form class="pr-phrase-add" onSubmit=${(e) => (e.preventDefault(), submit())}>
    <${Icon} name="plus" size=${12} />
    <input type="text" value=${v} placeholder=${placeholder} aria-label="New phrase" onInput=${(e) => setV(e.currentTarget.value)} data-testid="pr-phrase-input" />
  </form>`;
}

/** Phrase board in the shot editor. */
export function PhraseBoard({ shot }) {
  const phrases = useLibrary((l) => l.phrases || []);
  const sets = useLibrary((l) => l.phraseSets || []);
  const cat = useStore(prefsStore, (p) => p.phraseCat || 'all');
  const join = useStore(prefsStore, (p) => p.phraseJoin || 'sentence');
  const [browse, setBrowse] = useState(false);
  const prompt = shot.prompt || '';
  const active = useMemo(() => new Set(P.activePhrases(prompt, phrases).map((t) => t.toLowerCase())), [prompt, phrases]);
  const groups = useMemo(() => P.groupPhrases(phrases), [phrases]);
  const shown = cat === 'all' ? phrases : phrases.filter((x) => x.category === cat);
  const validCat = cat === 'all' || groups.some((g) => g.id === cat);

  const menu = (e) =>
    showMenu(e.currentTarget, [
      { label: 'Browse the phrase library…', icon: 'book', onClick: () => setBrowse(true) },
      { label: 'Manage my phrases', icon: 'list', onClick: openPhrasesLibrary },
      { label: 'Save the phrases now on as a set…', icon: 'layers', onClick: () => saveSetFrom(P.activePhrases(prompt, phrases)) },
      '-',
      { header: 'Add phrases as' },
      { label: 'Sentences — “… Nobody speaks.”', checked: join !== 'comma', onClick: () => setPrefs({ phraseJoin: 'sentence' }) },
      { label: 'A comma list — “…, nobody speaks”', checked: join === 'comma', onClick: () => setPrefs({ phraseJoin: 'comma' }) },
    ]);
  const actions = html`<${IconButton} icon="more" size="sm" title="Phrase options" onClick=${menu} />`;

  return html`<${PrSection} id="phrases" title="Quick phrases" icon="quote" count=${active.size || null} actions=${actions}>
    <div class="pr-phrases" data-testid="pr-phrases">
      ${!phrases.length
        ? html`<div class="pr-phrases-empty">
            <span class="muted small">Keep the phrases you write in every prompt — “nobody speaks”, “camera angle from top” — and click them in and out.</span>
            <div class="row wrap">
              <${Button} size="sm" kind="primary" icon="plus" onClick=${() => addToMyPhrases(P.STARTER_PHRASES)} data-testid="pr-phrases-starters">Add starter phrases<//>
              <${Button} size="sm" icon="book" onClick=${() => setBrowse(true)}>Browse the library<//>
            </div>
          </div>`
        : html`
            ${groups.length > 1 &&
            html`<div class="pr-phrase-cats" role="tablist" aria-label="Phrase categories">
              ${[{ id: 'all', label: 'All', items: phrases }, ...groups].map(
                (g) => html`<button type="button" key=${g.id} role="tab" aria-selected=${(validCat ? cat : 'all') === g.id ? 'true' : 'false'} class=${cx('pr-phrase-cat', (validCat ? cat : 'all') === g.id && 'is-active')} onClick=${() => setPrefs({ phraseCat: g.id })}>
                  ${g.label}<span class="pr-phrase-cat-n">${g.items.length}</span>
                </button>`,
              )}
            </div>`}
            ${sets.length > 0 &&
            html`<div class="pr-phrase-sets">
              ${sets.map((set) => {
                const on = P.setIsApplied(prompt, set);
                return html`<button
                  type="button"
                  key=${set.id}
                  class=${cx('chip', 'pr-chip', 'pr-set-chip', on && 'is-active')}
                  title=${`${on ? 'Remove' : 'Add'}: ${set.texts.join(' · ')} — right-click for options`}
                  onClick=${() => editShotPrompt(shot.id, (pr) => P.togglePhraseSet(pr, set, joinOpts()), on ? 'Remove phrase set' : 'Add phrase set')}
                  onContextMenu=${(e) => setMenu(e, set)}
                >
                  <${Icon} name="layers" size=${11} />${set.name}
                </button>`;
              })}
            </div>`}
            <div class="pr-chips pr-phrase-chips">
              ${(validCat ? shown : phrases).map((ph) => {
                const on = active.has(ph.text.toLowerCase());
                return html`<button
                  type="button"
                  key=${ph.id}
                  class=${cx('chip', 'pr-chip', 'pr-phrase', on && 'is-active', ph.auto && 'is-auto')}
                  title=${`${on ? 'Remove from' : 'Add to'} the prompt${ph.auto ? ' · added to every new shot' : ''} — right-click for more`}
                  aria-pressed=${on ? 'true' : 'false'}
                  onClick=${() => togglePhraseOnShot(shot.id, ph.text)}
                  onContextMenu=${(e) => phraseMenu(e, ph, { shotId: shot.id })}
                  data-phrase=${ph.text}
                >
                  ${on && html`<${Icon} name="check" size=${11} />`}${ph.text}
                </button>`;
              })}
              <${AddPhraseField} category=${validCat ? cat : 'all'} onAdded=${(text) => editShotPrompt(shot.id, (pr) => P.addPhraseToPrompt(pr, text, joinOpts()), 'Add phrase')} />
            </div>
          `}
    </div>
    ${browse && html`<${PhraseLibraryModal} onClose=${() => setBrowse(false)} />`}
  <//>`;
}

/** The prepared phrase library: click a phrase to add it to (or remove it from) the user's list. */
function PreparedBrowser({ compact = false }) {
  const mine = useLibrary((l) => l.phrases || []);
  const [search, setSearch] = useState('');
  const have = useMemo(() => new Map(mine.map((x) => [x.text.toLowerCase(), x])), [mine]);
  const q = search.trim().toLowerCase();
  const groups = P.PHRASE_CATEGORIES.map((c) => ({ ...c, items: P.PREPARED_PHRASES.filter((x) => x.category === c.id && (!q || x.text.includes(q))) })).filter((g) => g.items.length);
  const toggle = (x) => {
    const cur = have.get(x.text.toLowerCase());
    if (cur) setPhrases((list) => P.removePhrase(list, cur.id));
    else setPhrases((list) => P.addPhrases(list, x));
  };
  return html`<div class=${cx('pr-prepared', compact && 'is-compact')}>
    <label class="pr-search"><${Icon} name="search" size=${14} /><input type="search" placeholder="Search the phrase library" value=${search} onInput=${(e) => setSearch(e.currentTarget.value)} /></label>
    ${groups.map(
      (g) => html`<div class="pr-chip-group" key=${g.id}>
        <div class="row pr-prepared-head">
          <div class="pr-chip-group-label">${g.label}</div>
          <span class="spacer"></span>
          <button type="button" class="pr-link-btn" onClick=${() => addToMyPhrases(g.items)}>Add all</button>
        </div>
        <div class="pr-chips">
          ${g.items.map((x) => {
            const on = have.has(x.text.toLowerCase());
            return html`<button type="button" key=${x.text} class=${cx('chip', 'pr-chip', on && 'is-active')} aria-pressed=${on ? 'true' : 'false'} title=${on ? 'In your list — click to remove' : 'Add to your list'} onClick=${() => toggle(x)} data-prepared=${x.text}>
              ${on ? html`<${Icon} name="check" size=${11} />` : html`<${Icon} name="plus" size=${11} />`}${x.text}
            </button>`;
          })}
        </div>
      </div>`,
    )}
    ${!groups.length && html`<div class="muted small">No phrase matches “${search}”.</div>`}
  </div>`;
}

export function PhraseLibraryModal({ onClose }) {
  const count = useLibrary((l) => (l.phrases || []).length);
  return html`<${Modal}
    title="Phrase library"
    width=${640}
    onClose=${onClose}
    class="pr-phrase-modal"
    footer=${html`<span class="muted small">${pluralize(count, 'phrase')} in your list</span><span class="spacer"></span><${Button} kind="primary" onClick=${onClose}>Done<//>`}
  >
    <p class="muted small pr-modal-lead">Pick the phrases you use often. They appear as one-click chips under every shot’s prompt.</p>
    <${PreparedBrowser} />
  <//>`;
}

/** The shot selected in the Prompts tab (re-renders on selection and prompt changes). */
function useSelectedShot() {
  const selectedId = useStore(promptsUi, (s) => s.selectedId);
  return useProject((p) => S.findShot(p, selectedId));
}

function PhraseRow({ ph, index, total }) {
  const shot = useSelectedShot();
  const on = !!shot && P.promptHasPhrase(shot.prompt, ph.text);
  return html`<div class=${cx('pr-phrase-row', ph.auto && 'is-auto')} data-phrase-row=${ph.text}>
    <button type="button" class=${cx('pr-phrase-row-text', on && 'is-on')} title=${shot ? (on ? 'In the selected shot’s prompt — click to remove' : 'Click to add to the selected shot’s prompt') : 'Select a shot to use it'} disabled=${!shot} onClick=${() => togglePhraseOnShot(shot.id, ph.text)}>
      ${on && html`<${Icon} name="check" size=${12} />`}<span>${ph.text}</span>
    </button>
    <${IconButton} icon=${ph.auto ? 'star-filled' : 'star'} size="sm" active=${ph.auto} title=${ph.auto ? 'Added to every new shot — click to stop' : 'Add to every new shot'} onClick=${() => setPhrases((list) => P.updatePhrase(list, ph.id, { auto: !ph.auto }))} />
    <${IconButton} icon="arrow-up" size="sm" title="Move up" disabled=${index === 0} onClick=${() => setPhrases((list) => P.movePhrase(list, ph.id, list.findIndex((x) => x.id === ph.id) - 1))} />
    <${IconButton} icon="arrow-down" size="sm" title="Move down" disabled=${index >= total - 1} onClick=${() => setPhrases((list) => P.movePhrase(list, ph.id, list.findIndex((x) => x.id === ph.id) + 1))} />
    <${IconButton} icon="more" size="sm" title="More" onClick=${(e) => phraseMenu(e.currentTarget, ph)} />
  </div>`;
}

/** Library → Phrases: the user's phrases by category, phrase sets, import / export and the prepared library. */
export function PhrasesTab() {
  const phrases = useLibrary((l) => l.phrases || []);
  const sets = useLibrary((l) => l.phraseSets || []);
  const [search, setSearch] = useState('');
  const [newCat, setNewCat] = useState('other');
  const [showPrepared, setShowPrepared] = useState(false);
  const shot = useSelectedShot();
  const q = search.trim().toLowerCase();
  const groups = useMemo(() => P.groupPhrases(q ? phrases.filter((x) => x.text.toLowerCase().includes(q)) : phrases), [phrases, q]);

  const importText = (text, source = 'the text') => {
    const items = P.parsePhrasesText(text);
    if (!items.length) return toast(`No phrases found in ${source}`, { kind: 'warn' });
    addToMyPhrases(items);
  };
  const tools = (e) =>
    showMenu(e.currentTarget, [
      {
        label: 'Paste phrases…',
        icon: 'list',
        onClick: async () => {
          const v = await promptDialog({ title: 'Paste phrases', label: 'One phrase per line. “# Camera angle” lines set the category.', multiline: true, confirmLabel: 'Add phrases' });
          if (v != null) importText(v);
        },
      },
      {
        label: 'Import a file (.txt, .json)…',
        icon: 'upload',
        onClick: async () => {
          const [file] = await pickFiles({ accept: '.txt,.md,.json,text/plain,application/json', multiple: false });
          if (file) importText(await file.text(), file.name);
        },
      },
      { label: 'Export my phrases (.txt)', icon: 'download', disabled: !phrases.length, onClick: () => downloadBlob(new Blob([P.exportPhrasesText(phrases)], { type: 'text/plain' }), 'grok-phrases.txt') },
      '-',
      { label: 'Add the starter phrases', icon: 'sparkles', onClick: () => addToMyPhrases(P.STARTER_PHRASES) },
      {
        label: 'Delete all my phrases',
        icon: 'trash',
        danger: true,
        disabled: !phrases.length,
        onClick: async () => {
          if (!(await confirmDialog({ title: 'Delete all phrases?', message: `Your ${pluralize(phrases.length, 'phrase')} will be removed from the list (prompts keep their text).`, confirmLabel: 'Delete all', danger: true }))) return;
          const before = phrases;
          setPhrases(() => []);
          toast('Phrases deleted', { action: { label: 'Undo', run: () => setPhrases(() => before) } });
        },
      },
    ]);

  return html`<div class="pr-lib-pane">
    <div class="pr-lib-tools">
      <label class="pr-search"><${Icon} name="search" size=${14} /><input type="search" placeholder="Search my phrases" value=${search} onInput=${(e) => setSearch(e.currentTarget.value)} /></label>
      <${IconButton} icon="more" size="sm" title="Import, export…" onClick=${tools} />
    </div>
    <div class="pr-lib-scroll">
      <div class="pr-phrase-newrow">
        <${AddPhraseField} category=${newCat} placeholder="New phrase, then Enter" />
        <${Select} value=${newCat} title="Category of new phrases" options=${P.PHRASE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))} onChange=${setNewCat} />
      </div>
      ${sets.length > 0 &&
      html`<div class="pr-lib-heading">Phrase sets</div>
        <div class="pr-phrase-setlist">
          ${sets.map(
            (set) => html`<div class="pr-phrase-setrow" key=${set.id}>
              <${Icon} name="layers" size=${13} />
              <span class="pr-phrase-setname" title=${set.texts.join(' · ')}>${set.name}</span>
              <span class="muted tiny">${set.texts.length}</span>
              <span class="spacer"></span>
              <${IconButton} icon="plus" size="sm" title="Add / remove in the selected shot’s prompt" disabled=${!shot} onClick=${() => {
                if (shot) editShotPrompt(shot.id, (pr) => P.togglePhraseSet(pr, set, joinOpts()), 'Phrase set');
              }} />
              <${IconButton} icon="more" size="sm" title="Set options" onClick=${(e) => setMenu(e.currentTarget, set)} />
            </div>`,
          )}
        </div>`}
      ${!phrases.length
        ? html`<${EmptyState} icon="quote" title="Your phrases" compact=${true} action=${html`<${Button} size="sm" kind="primary" icon="sparkles" onClick=${() => addToMyPhrases(P.STARTER_PHRASES)}>Add starter phrases<//>`}>
            Short texts you repeat in prompts. They show as one-click chips under each shot’s prompt — click to add, click again to remove.
          <//>`
        : groups.map(
            (g) => html`<div class="pr-phrase-group" key=${g.id}>
              <div class="pr-lib-heading">${g.label} <span class="muted">${g.items.length}</span></div>
              ${g.items.map((ph) => html`<${PhraseRow} key=${ph.id} ph=${ph} index=${phrases.indexOf(ph)} total=${phrases.length} />`)}
            </div>`,
          )}
      ${q && phrases.length > 0 && !groups.length && html`<div class="pr-lib-none muted small">No phrase matches “${search}”.</div>`}
      <div class="pr-lib-heading pr-prepared-toggle">
        <button type="button" class="pr-link-btn" aria-expanded=${showPrepared ? 'true' : 'false'} onClick=${() => setShowPrepared(!showPrepared)} data-testid="pr-prepared-toggle">
          <${Icon} name=${showPrepared ? 'chevron-down' : 'chevron-right'} size=${12} /> Prepared phrase library (${P.PREPARED_PHRASES.length})
        </button>
      </div>
      ${showPrepared && html`<${PreparedBrowser} compact=${true} />`}
    </div>
  </div>`;
}
