// Library side panel: Snippets ("prepared texts"), Bible, Templates and Import tabs.
import { html, useState, useMemo } from '../../../vendor/preact-htm.mjs';
import { useLibrary, useStore, usePage } from '../hooks.js';
import { Icon, IconButton, Button, Tabs, EmptyState, TextField, toast, pickFiles, cx } from '../kit.js';
import { libraryStore } from '../../core/store.js';
import { copyText } from '../../core/utils.js';
import { createSnippet, upsertSnippet, removeSnippet, filterSnippets, allTags, snippetToken, STARTER_SNIPPETS } from '../../prompts/library.js';
import { BibleTab } from './bible-tab.js';
import { TemplatesTab } from './templates-tab.js';
import { prefsStore, setPrefs, insertIntoPrompt, openPaste, importFromPage, exportShots, copyAllPrompts } from './state.js';

const setSnippets = (fn) => libraryStore.set((s) => ({ ...s, snippets: fn(s.snippets || []) }));

function SnippetEditor({ snippet, onDone }) {
  const [title, setTitle] = useState(snippet?.title || '');
  const [text, setText] = useState(snippet?.text || '');
  const [tags, setTags] = useState((snippet?.tags || []).join(', '));
  const save = () => {
    if (!text.trim()) return toast('A snippet needs some text', { kind: 'warn' });
    const next = snippet?.id ? { ...snippet, title: title.trim() || snippet.title, text: text.trim(), tags } : createSnippet({ title, text, tags });
    setSnippets((list) => upsertSnippet(list, next));
    onDone(next);
  };
  return html`<div class="pr-snip-editor" onKeyDown=${(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.stopPropagation(), e.preventDefault(), save())}>
    <${TextField} value=${title} onInput=${setTitle} placeholder="Name — also usable as a {{token}}" autoFocus=${true} />
    <${TextField} value=${text} onInput=${setText} multiline=${true} rows=${4} placeholder="The text to reuse, e.g. a character description, your house style, things to avoid…" />
    <${TextField} value=${tags} onInput=${setTags} placeholder="Tags, comma separated — e.g. style, film noir" />
    <div class="row">
      ${title.trim() && html`<span class="pr-token-chip mono">{{${snippetToken({ title })}}}</span>`}
      <span class="spacer"></span>
      <${Button} size="sm" kind="ghost" onClick=${() => onDone(null)}>Cancel<//>
      <${Button} size="sm" kind="primary" icon="check" onClick=${save} data-testid="pr-snip-save">Save<//>
    </div>
  </div>`;
}

function SnippetCard({ s, onEdit }) {
  const token = `{{${snippetToken(s)}}}`;
  const remove = () => {
    setSnippets((list) => removeSnippet(list, s.id));
    toast(`Deleted “${s.title}”`, { action: { label: 'Undo', run: () => setSnippets((list) => upsertSnippet(list, s)) } });
  };
  return html`<div class="pr-snip" data-snippet=${s.id}>
    <div class="pr-snip-top">
      <span class="pr-snip-title">${s.title}</span>
      <button type="button" class="pr-token-chip mono" title="Insert as a token (expanded when sent)" onClick=${() => insertIntoPrompt(token)}>${token}</button>
    </div>
    <div class="pr-snip-text">${s.text}</div>
    ${s.tags?.length > 0 && html`<div class="pr-snip-tags">${s.tags.map((t) => html`<span key=${t} class="pr-tag">#${t}</span>`)}</div>`}
    <div class="pr-snip-actions">
      <${Button} size="sm" icon="plus" onClick=${() => insertIntoPrompt(s.text)} title="Insert the text into the prompt at the cursor" data-testid="pr-snip-insert">Insert<//>
      <${IconButton} icon="copy" size="sm" title="Copy" onClick=${() => copyText(s.text).then((ok) => ok && toast('Copied', { kind: 'success', duration: 1200 }))} />
      <${IconButton} icon="edit" size="sm" title="Edit" onClick=${onEdit} />
      <${IconButton} icon="trash" size="sm" kind="danger" title="Delete" onClick=${remove} />
    </div>
  </div>`;
}

function SnippetsTab() {
  const snippets = useLibrary((l) => l.snippets || []);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [editing, setEditing] = useState(null); // snippet id | 'new' | null
  const tags = useMemo(() => allTags(snippets), [snippets]);
  const list = useMemo(() => filterSnippets(snippets, { search, tag }), [snippets, search, tag]);
  const addStarters = () => {
    setSnippets((cur) => STARTER_SNIPPETS.reduce((acc, s) => (acc.some((x) => x.title === s.title) ? acc : upsertSnippet(acc, createSnippet(s))), cur));
    toast(`Added ${STARTER_SNIPPETS.length} starter snippets`, { kind: 'success' });
  };
  return html`<div class="pr-lib-pane">
    <div class="pr-lib-tools">
      <label class="pr-search"><${Icon} name="search" size=${14} /><input type="search" placeholder="Search snippets" value=${search} onInput=${(e) => setSearch(e.currentTarget.value)} /></label>
      <${Button} size="sm" kind="primary" icon="plus" onClick=${() => setEditing('new')} data-testid="pr-snip-new">New<//>
    </div>
    ${tags.length > 0 &&
    html`<div class="pr-tag-filter">
      ${tags.slice(0, 16).map(({ tag: t, count }) => html`<button type="button" key=${t} class=${cx('chip', 'pr-chip', tag === t && 'is-active')} onClick=${() => setTag(tag === t ? '' : t)}>#${t} <span class="muted">${count}</span></button>`)}
    </div>`}
    <div class="pr-lib-scroll">
      ${editing === 'new' && html`<${SnippetEditor} onDone=${() => setEditing(null)} />`}
      ${!snippets.length && editing !== 'new'
        ? html`<${EmptyState} icon="quote" title="Snippets" compact=${true}
            action=${html`<${Button} size="sm" kind="primary" icon="plus" onClick=${() => setEditing('new')}>New snippet<//><${Button} size="sm" onClick=${addStarters}>Add starter snippets<//>`}
          >
            Prepared texts you reuse in every prompt — a character description, your house style, “no text, no watermarks”.
            Insert them at the cursor, or reference them as <span class="mono">{{name}}</span> so editing the snippet updates every shot.
          <//>`
        : !list.length && snippets.length
          ? html`<div class="pr-lib-none muted small">No snippet matches “${search || '#' + tag}”.</div>`
          : list.map((s) => (editing === s.id ? html`<${SnippetEditor} key=${s.id} snippet=${s} onDone=${() => setEditing(null)} />` : html`<${SnippetCard} key=${s.id} s=${s} onEdit=${() => setEditing(s.id)} />`))}
    </div>
  </div>`;
}

function ImportTab() {
  const connected = usePage((s) => s.connected);
  const fromFile = async () => {
    const [file] = await pickFiles({ accept: '.txt,.md,.markdown,.csv,.tsv,.json,text/plain,text/markdown,text/csv,application/json', multiple: false });
    if (!file) return;
    try {
      openPaste(await file.text(), file.name);
    } catch (e) {
      toast(`Couldn't read ${file.name}: ${e.message || e}`, { kind: 'error' });
    }
  };
  const Card = ({ icon, title, text, onClick, disabled, testid }) => html`<button type="button" class="pr-import-card" disabled=${disabled} onClick=${onClick} data-testid=${testid}>
    <span class="pr-import-icon"><${Icon} name=${icon} size=${18} /></span>
    <span class="pr-import-text"><b>${title}</b><span>${text}</span></span>
    <${Icon} name="chevron-right" size=${14} />
  </button>`;
  return html`<div class="pr-lib-pane">
    <div class="pr-lib-scroll">
      <div class="pr-lib-heading">Import shots</div>
      <${Card} icon="sparkles" title="Grok’s latest reply" text=${connected ? 'Turn the list Grok just wrote into shots' : 'Open a Grok chat first'} disabled=${!connected} onClick=${() => importFromPage('reply')} testid="pr-import-reply" />
      <${Card} icon="quote" title="Selected text on grok.com" text="Select prompts on the page, then import them" disabled=${!connected} onClick=${() => importFromPage('selection')} testid="pr-import-selection" />
      <${Card} icon="list" title="Paste a list" text="Numbered, bullets, “Shot 3:”, paragraphs, JSON, CSV, Markdown tables" onClick=${() => openPaste('')} testid="pr-import-paste" />
      <${Card} icon="upload" title="From a file" text=".txt .md .csv .json" onClick=${fromFile} />
      <div class="pr-lib-tip"><${Icon} name="info" size=${13} /><span>On grok.com you can also right-click selected text → <b>Send selected text to Studio prompt list</b>.</span></div>
      <div class="pr-lib-heading">Export</div>
      <div class="pr-export-row">
        <${Button} size="sm" icon="copy" onClick=${copyAllPrompts}>Copy all<//>
        ${['txt', 'md', 'json', 'csv'].map((f) => html`<${Button} key=${f} size="sm" kind="ghost" icon="download" onClick=${() => exportShots(f)}>.${f}<//>`)}
      </div>
    </div>
  </div>`;
}

const TABS = [
  { id: 'snippets', label: 'Snippets', icon: 'quote', title: 'Snippets: prepared texts you reuse in prompts' },
  { id: 'bible', label: 'Bible', icon: 'book', title: 'Characters, locations, style guide' },
  { id: 'templates', label: 'Templates', icon: 'wand', title: 'Meta-prompts that ask Grok to write material' },
  { id: 'import', label: 'Import', icon: 'inbox', title: 'Import / export prompt lists' },
];

export function LibraryPanel({ layout }) {
  const tab = useStore(prefsStore, (p) => p.libraryTab);
  const snippetCount = useLibrary((l) => (l.snippets || []).length);
  const tabs = TABS.map((t) => ({ ...t, badge: t.id === 'snippets' ? snippetCount || null : null }));
  return html`<aside class=${cx('pr-lib', 'panel', layout && `is-${layout}`)} aria-label="Prompt library">
    <div class="panel-header pr-lib-head">
      <${Tabs} tabs=${tabs} value=${tab} onChange=${(v) => setPrefs({ libraryTab: v })} class="pr-lib-tabs" />
    </div>
    <div class="pr-lib-body">
      ${tab === 'snippets' && html`<${SnippetsTab} />`}
      ${tab === 'bible' && html`<${BibleTab} />`}
      ${tab === 'templates' && html`<${TemplatesTab} />`}
      ${tab === 'import' && html`<${ImportTab} />`}
    </div>
  </aside>`;
}

