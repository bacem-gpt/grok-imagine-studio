// App shell: header (project menu, tabs, undo/redo, connection, export, dock controls) and the four views.
// Views stay mounted after first visit (hidden when inactive) so players and forms keep their state;
// each receives `active` to pause work while hidden.
import { html, useState, useEffect } from '../../vendor/preact-htm.mjs';
import { projectStore, uiStore, projectsListStore } from '../core/store.js';
import { bridge } from '../core/bridge.js';
import { REQ } from '../../shared/protocol.js';
import * as M from '../core/model.js';
import { formatDuration, downloadBlob, sanitizeFilename, formatBytes, pluralize } from '../core/utils.js';
import { db } from '../core/db.js';
import {
  appEvents,
  newProject,
  openProject,
  duplicateProject,
  deleteProject,
  renameCurrentProject,
  exportProjectJson,
  importProjectJson,
  runGarbageCollection,
  restoreProject,
} from '../core/app-state.js';
import { useProject, useUI, usePage, useHistoryState, useStore, useLibrary } from './hooks.js';
import { useHotkeys } from './hotkeys.js';
import { Icon, IconButton, Button, Tabs, Modal, ToastHost, DialogHost, MenuHost, showMenu, toast, dismissToast, confirmDialog, promptDialog, pickFiles, cx } from './kit.js';
import { ClipsView } from './media/clips-view.js';
import { EditView } from './edit/edit-view.js';
import { PromptsView } from './prompts/prompts-view.js';
import { IngredientsView } from './ingredients/ingredients-view.js';
import { ExportDialog } from './export/export-dialog.js';

export const setTab = (tab) => uiStore.set((s) => (s.tab === tab ? s : { ...s, tab }));
const openExport = () => appEvents.emit('export.open', {});

/** Runs an async UI action; a failure becomes an error toast instead of a click that silently does nothing. */
const attempt = (fn, what) => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    console.warn(`[gis] ${what} failed`, e);
    toast(`${what}: ${e?.message || e}`, { kind: 'error', duration: 6000 });
    return undefined;
  }
};

async function cleanUpStorage() {
  const tid = toast('Cleaning up unused files…', { duration: 0 });
  try {
    const { removed, bytes } = await runGarbageCollection({ graceMs: 0 });
    toast(removed ? `Removed ${pluralize(removed, 'unused file')} (${formatBytes(bytes)})` : 'Nothing to clean up: every stored file is in use', { kind: 'success' });
  } catch (e) {
    toast(`Storage was not cleaned up (${e?.message || e}). Try again in a moment.`, { kind: 'warn', duration: 6000 });
  } finally {
    dismissToast(tid);
  }
}

async function exportProjectFile() {
  const p = projectStore.get();
  await downloadBlob(exportProjectJson(p), sanitizeFilename(`${p.name}.gis.json`));
}

function ProjectsModal({ onClose }) {
  const list = useStore(projectsListStore);
  const currentId = useProject((p) => p.id);
  const [usage, setUsage] = useState(null);
  useEffect(() => {
    db.estimate().then(setUsage);
  }, []);
  return html`<${Modal} title="Sequences" width=${560} onClose=${onClose}
    footer=${html`
      <span class="muted small">${usage ? `Storage used: ${formatBytes(usage.usage || 0)}` : ''}</span>
      <span class="spacer"></span>
      <${Button} icon="upload" kind="ghost" onClick=${attempt(async () => {
        const [file] = await pickFiles({ accept: '.json,application/json', multiple: false });
        if (!file) return;
        await importProjectJson(file);
        toast('Project imported', { kind: 'success' });
        onClose();
      }, 'Import failed')}>Import…<//>
      <${Button} icon="plus" kind="primary" onClick=${attempt(async () => {
        const name = await promptDialog({ title: 'New sequence', value: 'Untitled sequence', confirmLabel: 'Create' });
        if (name == null) return;
        await newProject(name || 'Untitled sequence');
        onClose();
      }, 'Could not create the sequence')}>New sequence<//>`}
  >
    <div class="project-list">
      ${list.map(
        (p) => html`<div class=${cx('project-row', p.id === currentId && 'is-current')} key=${p.id}>
          <button class="project-open" onClick=${attempt(async () => {
            await openProject(p.id);
            onClose();
          }, 'Could not open the sequence')}>
            <${Icon} name="film" size=${16} />
            <span class="project-name">${p.name}</span>
            <span class="project-meta">${p.clipCount} clips · ${formatDuration(p.duration)} · ${new Date(p.updatedAt).toLocaleString()}</span>
          </button>
          <${IconButton} icon="copy" title="Duplicate" size="sm" onClick=${attempt(async () => {
            if (await duplicateProject(p.id)) toast('Sequence duplicated');
            else toast('That sequence no longer exists', { kind: 'warn' });
          }, 'Could not duplicate the sequence')} />
          <${IconButton} icon="trash" title="Delete" size="sm" kind="danger" onClick=${attempt(async () => {
            if (await confirmDialog({ title: 'Delete sequence?', message: `"${p.name}" and its timeline will be deleted. Media no other sequence uses is removed from storage later.`, confirmLabel: 'Delete', danger: true })) {
              await deleteProject(p.id);
            }
          }, 'Could not delete the sequence')} />
        </div>`,
      )}
    </div>
  <//>`;
}

function ProjectMenuButton() {
  const name = useProject((p) => p.name);
  const [showProjects, setShowProjects] = useState(false);
  const open = (e) =>
    showMenu(e, [
      { header: 'Sequence' },
      { label: 'New sequence…', icon: 'plus', onClick: attempt(async () => {
        const n = await promptDialog({ title: 'New sequence', value: 'Untitled sequence', confirmLabel: 'Create' });
        if (n != null) await newProject(n || 'Untitled sequence');
      }, 'Could not create the sequence') },
      { label: 'Open / manage…', icon: 'folder', onClick: () => setShowProjects(true) },
      { label: 'Rename…', icon: 'edit', onClick: async () => {
        const n = await promptDialog({ title: 'Rename sequence', value: name, confirmLabel: 'Rename' });
        if (n != null) renameCurrentProject(n);
      } },
      { label: 'Duplicate', icon: 'copy', onClick: attempt(async () => {
        const c = await duplicateProject();
        if (c) toast(`Created "${c.name}"`, { kind: 'success', action: { label: 'Open', run: attempt(() => openProject(c.id), 'Could not open the sequence') } });
      }, 'Could not duplicate the sequence') },
      '-',
      { label: 'Export project file (.json)', icon: 'download', onClick: attempt(exportProjectFile, 'Could not export the project file') },
      { label: 'Import project file…', icon: 'upload', onClick: attempt(async () => {
        const [file] = await pickFiles({ accept: '.json,application/json', multiple: false });
        if (!file) return;
        await importProjectJson(file);
        toast('Project imported', { kind: 'success' });
      }, 'Import failed') },
      '-',
      { label: 'Clean up unused storage', icon: 'trash', onClick: cleanUpStorage },
    ]);
  return html`
    <button class="project-btn" onClick=${open} title="Sequence menu">
      <span class="project-btn-name">${name}</span>
      <${Icon} name="chevron-down" size=${14} />
    </button>
    ${showProjects && html`<${ProjectsModal} onClose=${() => setShowProjects(false)} />`}
  `;
}

function ConnectionPill() {
  const { connected, mode, route } = usePage((s) => ({ connected: s.connected, mode: s.mode, route: s.info?.route || null }));
  if (connected) {
    // Inside grok.com the pill only repeats what the Clips tab shows: narrow headers drop it (see base.css).
    return html`<span class=${cx('conn-pill is-on', mode === 'embedded' && 'is-embedded')} title=${mode === 'tab' ? 'Connected to your latest grok.com tab' : 'Running inside grok.com'}>
      <span class="conn-dot"></span><span class="conn-label">grok.com${route && route !== 'other' ? ` · ${route}` : ''}</span><span class="conn-label-short">Grok</span>
    </span>`;
  }
  return html`<a class="conn-pill is-off" href="https://grok.com/imagine" target="_blank" rel="noopener" title="Not connected to grok.com — open Grok Imagine to collect clips and send prompts">
    <${Icon} name="link" size=${13} /><span class="conn-label">Open Grok Imagine</span><span class="conn-label-short">Grok</span>
  </a>`;
}

/** Shown while autosave keeps failing (it retries in the background). */
function SaveIssue() {
  const issue = useUI((s) => s.saveIssue);
  if (!issue) return null;
  return html`<span class="save-issue" role="status" title=${`Your latest changes are not saved yet (${issue.message}). Retrying…`}>
    <${Icon} name="alert" size=${14} /><span class="save-issue-label">Not saved</span>
  </span>`;
}

const DOCK_MODES = [
  { mode: 'right', icon: 'dock-right', label: 'Dock right' },
  { mode: 'bottom', icon: 'dock-bottom', label: 'Dock bottom' },
  { mode: 'float', icon: 'dock-float', label: 'Floating window' },
  { mode: 'max', icon: 'maximize', label: 'Full window' },
];

function DockControls() {
  const mode = usePage((s) => s.mode);
  const dock = useUI((s) => s.dock);
  if (mode !== 'embedded') return null;
  const setDock = async (m) => {
    try {
      const res = await bridge.request(REQ.UI_SET_DOCK, { mode: m });
      uiStore.set((s) => ({ ...s, dock: res?.mode || m }));
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  };
  const popOut = attempt(() => chrome.runtime.sendMessage({ gis: 'open-tab' }), 'Could not open the studio in a tab');
  const current = DOCK_MODES.find((d) => d.mode === dock) || DOCK_MODES[0];
  // Wide: one button per mode. Narrow: a single menu button (see .dock-full / .dock-compact in base.css).
  return html`<div class="dock-controls">
    <div class="dock-full">
      <${IconButton} icon="dock-right" title="Dock right" size="sm" active=${dock === 'right'} onClick=${() => setDock('right')} />
      <${IconButton} icon="dock-bottom" title="Dock bottom" size="sm" active=${dock === 'bottom'} onClick=${() => setDock('bottom')} />
      <${IconButton} icon="dock-float" title="Floating window (drag the top bar to move)" size="sm" active=${dock === 'float'} onClick=${() => setDock('float')} />
      <${IconButton} icon="maximize" title="Full window" size="sm" active=${dock === 'max'} onClick=${() => setDock(dock === 'max' ? 'right' : 'max')} />
      <${IconButton} icon="external" title="Open in a separate tab" size="sm" onClick=${popOut} />
    </div>
    <div class="dock-compact">
      <${IconButton}
        icon=${current.icon}
        title="Panel layout"
        size="sm"
        onClick=${(e) =>
          showMenu(e, [
            { header: 'Panel layout' },
            ...DOCK_MODES.map((d) => ({ label: d.label, icon: d.icon, checked: d.mode === dock, onClick: () => setDock(d.mode) })),
            '-',
            { label: 'Open in a separate tab', icon: 'external', onClick: popOut },
          ])}
      />
    </div>
    <${IconButton} icon="x" title="Hide studio (Alt+Shift+S)" size="sm" onClick=${() => bridge.request(REQ.UI_CLOSE).catch(() => {})} />
  </div>`;
}

function Header() {
  const tab = useUI((s) => s.tab);
  const counts = useProject((p) => ({
    bin: p.mediaOrder.length,
    duration: M.sequenceDuration(p),
    shots: p.shots?.length || 0,
  }));
  const ingredients = useLibrary((l) => l.ingredients.length);
  const hist = useHistoryState();
  const tabs = [
    { id: 'clips', label: 'Clips', icon: 'film', badge: counts.bin || null, title: 'Collect and pick generated clips (Alt+1)' },
    { id: 'edit', label: 'Edit', icon: 'scissors', badge: counts.duration > 0 ? formatDuration(counts.duration) : null, title: 'Timeline editor (Alt+2)' },
    { id: 'prompts', label: 'Prompts', icon: 'sparkles', badge: counts.shots || null, title: 'Shot list and prompt builder (Alt+3)' },
    { id: 'ingredients', label: 'Ingredients', icon: 'images', badge: ingredients || null, title: 'Reference images (Alt+4)' },
  ];
  return html`<header class="app-header">
    <div class="brand" title="Grok Imagine Studio"><${Icon} name="logo" size=${18} /></div>
    <${ProjectMenuButton} />
    <${SaveIssue} />
    <${Tabs} tabs=${tabs} value=${tab} onChange=${setTab} class="app-tabs" />
    <div class="header-spacer"></div>
    <div class="header-actions">
      <${IconButton} icon="undo" class="undo-btn" title=${`Undo${hist.undoLabel ? ' ' + hist.undoLabel : ''} (Ctrl+Z)`} disabled=${!hist.canUndo} onClick=${() => projectStore.undo()} />
      <${IconButton} icon="redo" class="redo-btn" title=${`Redo${hist.redoLabel ? ' ' + hist.redoLabel : ''} (Ctrl+Shift+Z)`} disabled=${!hist.canRedo} onClick=${() => projectStore.redo()} />
      <${ConnectionPill} />
      <${Button} kind="primary" icon="download" class="export-btn" onClick=${openExport} title="Export video (Ctrl+E)">Export<//>
      <${DockControls} />
    </div>
  </header>`;
}

function View({ id, active, children }) {
  const [mounted, setMounted] = useState(active);
  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);
  if (!mounted) return null;
  return html`<section class=${cx('view', `view-${id}`, active && 'is-active')} hidden=${!active}>${children}</section>`;
}

export function App() {
  const tab = useUI((s) => s.tab);
  const exportOpen = useUI((s) => s.exportOpen);
  const hasProject = useProject((p) => !!p.id);

  useEffect(() => {
    const offs = [
      appEvents.on('source.open', () => setTab('clips')),
      appEvents.on('timeline.reveal', () => setTab('edit')),
      appEvents.on('export.open', () => uiStore.set((s) => ({ ...s, exportOpen: true }))),
      appEvents.on('save.failed', ({ what, error }) =>
        toast(`Couldn't save ${what === 'library' ? 'the library' : 'your changes'} (${error}). Retrying — keep this window open.`, { kind: 'error', duration: 9000 }),
      ),
      appEvents.on('save.recovered', () => toast('All changes saved', { kind: 'success' })),
      appEvents.on('project.removed', ({ project }) =>
        toast(`"${project.name}" was deleted in another window.`, {
          kind: 'warn',
          duration: 15000,
          action: { label: 'Restore', run: attempt(() => restoreProject(project), 'Could not restore the sequence') },
        }),
      ),
    ];
    // Safety net: an async failure nobody handled is shown instead of silently doing nothing.
    let lastShown = 0;
    const onRejection = (e) => {
      const err = e.reason;
      if (err?.name === 'AbortError' || /play\(\) request|interrupted by a (new load|call to pause)/i.test(String(err?.message || ''))) return;
      console.warn('[gis] unhandled error', err);
      if (Date.now() - lastShown < 5000) return;
      lastShown = Date.now();
      toast(`Something went wrong: ${err?.message || err}`, { kind: 'error', duration: 6000 });
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      offs.forEach((f) => f());
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  useHotkeys({
    'mod+z': () => projectStore.undo(),
    'mod+shift+z': () => projectStore.redo(),
    'mod+y': () => projectStore.redo(),
    'mod+e': openExport,
    'alt+1': () => setTab('clips'),
    'alt+2': () => setTab('edit'),
    'alt+3': () => setTab('prompts'),
    'alt+4': () => setTab('ingredients'),
  });

  if (!hasProject) return html`<div class="boot">Loading…</div>`;
  return html`<div class="app">
    <${Header} />
    <main class="app-main">
      <${View} id="clips" active=${tab === 'clips'}><${ClipsView} active=${tab === 'clips'} /><//>
      <${View} id="edit" active=${tab === 'edit'}><${EditView} active=${tab === 'edit'} /><//>
      <${View} id="prompts" active=${tab === 'prompts'}><${PromptsView} active=${tab === 'prompts'} /><//>
      <${View} id="ingredients" active=${tab === 'ingredients'}><${IngredientsView} active=${tab === 'ingredients'} /><//>
    </main>
    ${exportOpen && html`<${ExportDialog} onClose=${() => uiStore.set((s) => ({ ...s, exportOpen: false }))} />`}
    <${MenuHost} />
    <${DialogHost} />
    <${ToastHost} />
  </div>`;
}
