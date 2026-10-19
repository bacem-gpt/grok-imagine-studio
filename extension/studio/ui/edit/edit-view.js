// Edit tab: compact bin (left, collapsible) · program monitor (centre) · inspector (right, collapsible) · timeline
// (bottom, resizable). Below 760 px wide: monitor on top, timeline below; wide but short (bottom dock): monitor and
// timeline side by side. In those two layouts the bin is a drawer and the inspector opens on demand, never covering
// the monitor: as a column when there is room, else as a sheet over the timeline (rules in edit-layout.js).
// Owns the edit session (Player link, playhead sync), the keyboard shortcuts and 'timeline.reveal'.

import { html, useEffect, useMemo, useState } from '../../../vendor/preact-htm.mjs';
import { projectStore, uiStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { appEvents } from '../../core/app-state.js';
import { clamp } from '../../core/utils.js';
import { useUI, useProject, useElementSize } from '../hooks.js';
import { useHotkeys, isTypingTarget } from '../hotkeys.js';
import { Icon, IconButton, toast, cx } from '../kit.js';
import { BinCompact } from '../media/bin-compact.js';
import { createEditSession } from './session.js';
import { ProgramMonitor } from './monitor.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { editLayout, SHORT_INSP_W } from './edit-layout.js';
import * as A from './actions.js';

const SPLIT_KEY = 'gis:edit:timelineHeight';

// 'timeline.reveal' can fire before the Edit tab was ever opened (the shell then switches tabs and mounts it).
let pendingReveal = null;
const revealListeners = new Set();
appEvents.on('timeline.reveal', (e) => {
  pendingReveal = e?.clipId || null;
  revealListeners.forEach((fn) => fn());
});

function loadSplit() {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function saveSplit(v) {
  try {
    localStorage.setItem(SPLIT_KEY, String(Math.round(v)));
  } catch {
    /* storage unavailable */
  }
}

const modalOpen = () => !!document.querySelector('.modal-backdrop');
const rangeFocused = () => {
  const el = document.activeElement;
  return !!el && el.tagName === 'INPUT' && el.type === 'range';
};

export function EditView({ active }) {
  const session = useMemo(() => createEditSession(), []);
  const [rootRef, size] = useElementSize();
  // Wide but short (e.g. docked at the bottom of grok.com): monitor and timeline side by side, panels on demand.
  // Three columns over a timeline don't fit in under 500 px of height at any width.
  const { narrow, short, drawers, mid, inspector: placement } = editLayout(size.width, size.height);
  const aspect = useProject((p) => (p.settings.width || 16) / (p.settings.height || 9));
  const binOpen = useUI((s) => s.binOpen);
  const inspectorOpen = useUI((s) => s.inspectorOpen);
  const exportOpen = useUI((s) => s.exportOpen);
  const selectionCount = useUI((s) => s.selection.length);
  const playing = useUI((s) => s.playing);
  const [drawer, setDrawer] = useState(null); // drawer layouts: 'bin' (modal drawer) | null
  const [inspOpen, setInspOpen] = useState(false); // drawer layouts: inspector shown (column or sheet, non-modal)
  const [split, setSplit] = useState(loadSplit);
  const [resizing, setResizing] = useState(false);
  const [drawerDrag, setDrawerDrag] = useState(false);

  useEffect(() => {
    if (window.__gis) window.__gis.edit = session; // debug / E2E hook (window.__gis is the studio's test hook)
    return () => {
      if (window.__gis?.edit === session) delete window.__gis.edit;
      session.dispose();
    };
  }, [session]);
  useEffect(() => {
    if (!active) session.pause();
  }, [active]);
  useEffect(() => {
    if (drawers) return;
    setDrawer(null);
    setInspOpen(false);
  }, [drawers]);
  useEffect(() => setDrawerDrag(false), [drawer]);

  // Someone else moved uiStore.playhead (project switch, another panel): follow it.
  useEffect(
    () =>
      uiStore.subscribe((s, prev) => {
        if (s.playhead !== prev.playhead && session.isExternalPlayhead(s.playhead)) session.player?.seek(s.playhead);
      }),
    [session],
  );
  // A new project resets the session's loop and selection-related state.
  useEffect(
    () =>
      appEvents.on('project.loaded', () => {
        session.player?.pause();
        session.player?.setLoop(null);
        session.player?.seek(0);
      }),
    [session],
  );

  useEffect(() => {
    const consume = () => {
      const id = pendingReveal;
      if (!id) return;
      pendingReveal = null;
      const p = projectStore.get();
      if (!p || !M.findClip(p, id)) return;
      A.setSelection([id]);
      const lay = M.layoutProject(p);
      const it = [...lay.video, ...lay.audio, ...lay.text].find((x) => x.clip.id === id);
      if (it) session.seek(it.start);
      session.emit('reveal', { clipId: id });
    };
    revealListeners.add(consume);
    consume();
    return () => revealListeners.delete(consume);
  }, [session]);

  // Undo can remove clips that are still selected: keep the selection to clips that exist (toolbar state, Delete…).
  useEffect(() => projectStore.subscribe((p) => A.pruneSelection(p)), []);

  /**
   * "Reveal in bin": select, scroll to and flash the item in the compact bin. BinCompact keeps its own selection
   * state, so the item is selected exactly as a click on it would.
   */
  const revealBinItem = (mediaId, tries = 0) => {
    const el = rootRef.current?.querySelector(`.edit-bin .bin-compact-item[data-media-id="${CSS.escape(mediaId)}"]`);
    if (!el) {
      if (tries < 6) {
        requestAnimationFrame(() => revealBinItem(mediaId, tries + 1)); // the panel / drawer is still mounting
        return;
      }
      const m = projectStore.get()?.media[mediaId];
      if (m) toast(`“${m.name}” is hidden by the bin’s search or “picked only” filter`, { kind: 'info' });
      return;
    }
    el.click();
    el.scrollIntoView({ block: 'nearest' });
    // A Web Animation rather than a class: the click makes BinCompact re-render the item, which would wipe a class.
    const ring = `inset 0 0 0 2px ${getComputedStyle(el).getPropertyValue('--accent').trim() || '#8f7dff'}, 0 0 0 3px rgba(143, 125, 255, 0.3)`;
    const flash = el.animate([{ boxShadow: ring }, { boxShadow: ring, offset: 0.45 }, { boxShadow: 'inset 0 0 0 2px transparent, 0 0 0 3px transparent' }], {
      duration: 1500,
      easing: 'ease-out',
    });
    flash.id = 'gis-reveal';
  };

  useEffect(() => {
    const offs = [
      session.on('showBin', ({ mediaId } = {}) => {
        if (drawers) setDrawer('bin');
        else uiStore.set((s) => (s.binOpen ? s : { ...s, binOpen: true }));
        if (mediaId) requestAnimationFrame(() => revealBinItem(mediaId));
      }),
      session.on('showInspector', () => (drawers ? setInspOpen(true) : uiStore.set((s) => ({ ...s, inspectorOpen: true })))),
      // a new title is typed right away: in the drawer layouts that needs the inspector shown
      session.on('focusText', () => drawers && setInspOpen(true)),
    ];
    return () => offs.forEach((f) => f());
  }, [session, drawers]);

  // ------------------------------------------------------------------ shortcuts (only while the tab is active)
  const k = (fn) => (e) => (modalOpen() ? false : fn(e));
  const arrow = (fn) => (e) => (modalOpen() || rangeFocused() ? false : fn(e));
  const zoom = (dir) => k(() => session.emit('zoom', { dir }));
  useHotkeys(
    {
      space: k(() => session.toggle()),
      k: k(() => session.shuttle(0)),
      j: k(() => session.shuttle(-1)),
      l: k(() => session.shuttle(1)),
      arrowleft: arrow(() => session.step(-1)),
      arrowright: arrow(() => session.step(1)),
      'shift+arrowleft': arrow(() => session.seekBy(-1)),
      'shift+arrowright': arrow(() => session.seekBy(1)),
      arrowup: arrow(() => session.jumpEdit(-1)),
      arrowdown: arrow(() => session.jumpEdit(1)),
      home: k(() => session.toStart()),
      end: k(() => session.toEnd()),
      s: k(() => A.splitAtPlayhead(session)),
      q: k(() => A.trimToPlayhead(session, 'in')),
      w: k(() => A.trimToPlayhead(session, 'out')),
      delete: k(() => A.deleteSelection()),
      backspace: k(() => A.deleteSelection()),
      // always handled: with nothing selected the browser would otherwise open its bookmark dialog
      'mod+d': k(() => {
        if (!A.duplicateSelection()) toast('Nothing to duplicate — select clips first', { kind: 'info' });
      }),
      'mod+c': k(() => (A.copySelection() ? undefined : false)),
      'mod+x': k(() => (A.cutSelection() ? undefined : false)),
      'mod+v': k(() => A.pasteAt(session.time())),
      'mod+a': k(() => A.selectAll()),
      t: k(() => A.addTextAt(session, session.time())),
      m: k(() => A.addMarkerAt(session.time())),
      '+': zoom(1),
      '=': zoom(1),
      '-': zoom(-1),
      '\\': k(() => session.emit('fit')),
      escape: (e) => {
        if (isTypingTarget(e.target) || modalOpen() || document.querySelector('.menu, .tl-pop')) return false;
        if (drawer) return setDrawer(null);
        if (drawers && inspOpen) return setInspOpen(false);
        if (A.getSelection().length) return A.clearSelection();
        if (session.player?.loop) return session.player.setLoop(null);
        return false;
      },
    },
    { enabled: active && !exportOpen },
  );

  // ------------------------------------------------------------------ splitter
  const height = size.height || 600;
  const minTop = narrow ? 150 : 190;
  const tlHeight = clamp(split ?? Math.round(height * (narrow ? 0.5 : 0.42)), 150, Math.max(150, height - minTop));
  const onSplitDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const y0 = e.clientY;
    const h0 = tlHeight;
    el.setPointerCapture(e.pointerId);
    setResizing(true);
    let last = h0;
    const move = (ev) => {
      last = clamp(h0 - (ev.clientY - y0), 150, Math.max(150, height - minTop));
      setSplit(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setResizing(false);
      saveSplit(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const toggleBin = () => (drawers ? setDrawer(drawer === 'bin' ? null : 'bin') : uiStore.set((s) => ({ ...s, binOpen: !s.binOpen })));
  const toggleInspector = () => (drawers ? setInspOpen((o) => !o) : uiStore.set((s) => ({ ...s, inspectorOpen: !s.inspectorOpen })));
  const inspColumn = drawers && inspOpen && placement === 'column';
  const inspSheet = drawers && inspOpen && placement === 'sheet';
  // short layout: the monitor takes the height it can use, up to half of what the inspector column leaves
  const monWidth = short ? Math.round(clamp((height - 44) * aspect, 280, (size.width - (inspColumn ? SHORT_INSP_W : 0)) * 0.5)) : null;

  const binPanel = html`<div class="edit-bin panel">
    <div class="panel-header edit-panel-head">
      <${Icon} name="film" size=${14} />
      <span class="panel-title">Bin</span>
      <span class="spacer"></span>
      <${IconButton} icon=${drawers ? 'x' : 'chevron-left'} size="sm" title="Hide bin" onClick=${toggleBin} />
    </div>
    <div class="edit-bin-body"><${BinCompact} /></div>
  </div>`;
  const inspector = html`<${Inspector} session=${session} onClose=${toggleInspector} closable=${drawers} />`;

  return html`<div class=${cx('edit-view', narrow && 'is-narrow', short && 'is-short', drawers && 'has-drawers', mid && 'is-mid', resizing && 'is-resizing')} ref=${rootRef}>
    <div class="edit-top" style=${monWidth ? `width:${monWidth}px` : ''}>
      ${!drawers &&
      (binOpen
        ? binPanel
        : html`<button type="button" class="edit-rail edit-rail-left" title="Show bin" onClick=${toggleBin}>
            <${Icon} name="film" size=${15} /><span>Bin</span>
          </button>`)}
      <div class="edit-center">
        <${ProgramMonitor} session=${session} active=${active} />
        ${drawers &&
        html`<div class=${cx('edit-fabs', playing && 'is-playing')}>
          <button type="button" class=${cx('edit-fab', drawer === 'bin' && 'is-active')} title="Bin: clips, images and sounds" onClick=${toggleBin}>
            <${Icon} name="film" size=${14} /><span>Bin</span>
          </button>
          <button type="button" class=${cx('edit-fab', inspOpen && 'is-active')} title="Inspector" aria-pressed=${inspOpen ? 'true' : 'false'} onClick=${toggleInspector}>
            <${Icon} name="sliders" size=${14} /><span>${selectionCount ? 'Edit clip' : 'Settings'}</span>
          </button>
        </div>`}
      </div>
      ${!drawers &&
      (inspectorOpen
        ? html`<div class="edit-insp">${inspector}</div>`
        : html`<button type="button" class="edit-rail edit-rail-right" title="Show inspector" onClick=${toggleInspector}>
            <${Icon} name="sliders" size=${15} /><span>Inspector</span>
          </button>`)}
      ${inspColumn && narrow && html`<div class="edit-insp">${inspector}</div>`}
    </div>
    <div class="edit-split" role="separator" aria-orientation="horizontal" title="Drag to resize the timeline" onPointerDown=${onSplitDown} onDblClick=${() => (setSplit(null), saveSplit(0))}>
      <span></span>
    </div>
    <div class="edit-bottom" style=${short ? '' : `height:${tlHeight}px`}>
      <${Timeline} session=${session} active=${active} narrow=${narrow} />
      ${inspSheet && html`<div class=${cx('edit-insp-sheet', drawerDrag && 'is-dragging')}>${inspector}</div>`}
    </div>
    ${inspColumn && short && html`<div class="edit-insp">${inspector}</div>`}
    ${drawers &&
    drawer === 'bin' &&
    html`<div class=${cx('edit-drawer-backdrop', drawerDrag && 'is-dragging')} onPointerDown=${() => setDrawer(null)}></div>
      <aside
        class=${cx('edit-drawer', 'edit-drawer-left', drawerDrag && 'is-dragging')}
        onDragStart=${() => setTimeout(() => setDrawerDrag(true), 0)}
        onDragEnd=${() => {
          if (!drawerDrag) return;
          setDrawerDrag(false);
          setDrawer(null);
          // the drop landed on the timeline: show it rather than the sheet that stepped aside for the drag
          if (placement === 'sheet') setInspOpen(false);
        }}
      >
        ${binPanel}
      </aside>`}
  </div>`;
}
