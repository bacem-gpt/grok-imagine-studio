// Clips tab: collect what Grok generated (page strip), triage it (bin grid, review mode) and trim it (source
// monitor) before it goes to the timeline. Layout: wide = page strip on top, bin grid, source monitor docked to the
// right (or below, resizable); narrow (< 760 px) = stacked, with the source monitor as an overlay sheet; short
// (< 600 px, e.g. docked at the bottom of grok.com) = the page strip folds to its header so the bin keeps room.
// All Clips shortcuts live in one hotkey map gated by `active` (review mode registers its own while open).
import { html, useState, useEffect, useMemo, useRef } from '../../../vendor/preact-htm.mjs';
import { projectStore, uiStore } from '../../core/store.js';
import { clamp } from '../../core/utils.js';
import { useProject, useUI, useElementSize, useDrag } from '../hooks.js';
import { useHotkeys, isTypingTarget } from '../hotkeys.js';
import { DropZone, Modal, Kbd, toast, cx } from '../kit.js';
import { filterAndSort, filterShowing, normalizeFilter, nextSelection, gridMove, orderedSelection } from './bin-logic.js';
import { usePref, loadPref, savePref } from './prefs.js';
import { guardKeys, revealIn } from './keys.js';
import { PageStrip } from './page-strip.js';
import { BinPanel } from './bin-grid.js';
import { SourceMonitor } from './source-monitor.js';
import { ReviewMode } from './review-mode.js';
import {
  FrameOfferHost,
  closeFrameOffer,
  UrlImportHost,
  closeUrlImport,
  useBinReveal,
  openInSource,
  closeSource,
  addToTimeline,
  insertAtPlayhead,
  flagMedia,
  rateMedia,
  removeFromBin,
  importFilesFlow,
} from './actions.js';

const FLASH_MS = 1600;
const sameFilter = (a, b) => ['kind', 'flag', 'minRating', 'search', 'sort'].every((k) => a[k] === b[k]);

const NARROW_PX = 760;
const SHORT_PX = 600;
const MIN_MONITOR = { right: 340, bottom: 240 };

const SHORTCUTS = [
  {
    title: 'Bin',
    keys: [
      ['← → ↑ ↓', 'Move the selection (Shift extends it)'],
      ['Ctrl/⌘+A', 'Select all'],
      ['Enter', 'Open in the source monitor'],
      ['P · X · U', 'Pick · reject · unflag'],
      ['1–5 · 0', 'Rate · clear rating'],
      ['E', 'Add to timeline (uses IN/OUT marks)'],
      ['W', 'Insert at the timeline playhead'],
      ['Del', 'Remove from bin'],
      ['R', 'Review the filtered bin from the start'],
      ['Esc', 'Close the monitor · clear the selection'],
    ],
  },
  {
    title: 'Source monitor',
    keys: [
      ['Space', 'Play / pause'],
      ['J · K · L', 'Shuttle back · stop · forward (again for 2×, 4×, 8×)'],
      [', · .', 'Previous · next frame'],
      ['I · O', 'Mark IN · OUT at the current frame'],
      ['Shift+I · Shift+O', 'Go to IN · OUT'],
      ['Ctrl/⌘+Shift+X', 'Clear the marks'],
      ['← →', 'Previous · next clip'],
    ],
  },
  {
    title: 'Review mode',
    keys: [
      ['← →', 'Previous · next item'],
      ['Space', 'Play / pause'],
      ['P · X · U', 'Pick · reject · unflag'],
      ['1–5 · 0', 'Rate · clear rating'],
      ['I · O', 'Mark IN · OUT'],
      ['Enter', 'Add to timeline and go to the next item'],
      ['M', 'Mute'],
      ['Esc', 'Exit'],
    ],
  },
];

function ShortcutsModal({ onClose }) {
  return html`<${Modal} title="Clips shortcuts" width=${620} onClose=${onClose}>
    <div class="clips-keys">
      ${SHORTCUTS.map(
        (g) => html`<div class="clips-keys-group" key=${g.title}>
          <div class="clips-keys-title">${g.title}</div>
          ${g.keys.map(
            ([k, label]) => html`<div class="clips-keys-row" key=${k}>
              <span class="clips-keys-combo">${k.split(' · ').map((part, i) => html`${i > 0 && html`<span class="clips-keys-sep">·</span>`}<${Kbd}>${part}<//>`)}</span>
              <span class="clips-keys-label">${label}</span>
            </div>`,
          )}
        </div>`,
      )}
    </div>
  <//>`;
}

export function ClipsView({ active }) {
  const [rootRef, size] = useElementSize();
  const narrow = size.width > 0 && size.width < NARROW_PX;
  const short = size.height > 0 && size.height < SHORT_PX;
  const filter = useUI((s) => s.binFilter);
  const selection = useUI((s) => s.binSelection);
  const sourceId = useUI((s) => s.sourceMediaId);
  const { media, order } = useProject((p) => ({ media: p.media, order: p.mediaOrder }));
  const orderedIds = useMemo(() => filterAndSort({ media, mediaOrder: order }, filter), [media, order, filter]);
  const [review, setReview] = useState(null); // {ids, startIndex, monitorWasOpen}
  const [pageCollapsed, setPageCollapsed] = usePref('pageCollapsed', false);
  const [shortOpen, setShortOpen] = useState(false); // page strip opened by hand while the view is short
  const stripCollapsed = pageCollapsed || (short && !shortOpen);
  const [dock, setDock] = usePref('monitorDock', 'right');
  const [cardSize, setCardSize] = usePref('cardSize', 180);
  const [monSizes, setMonSizes] = useState(() => loadPref('monitorSizes', {})); // {right: width, bottom: height}
  const [showKeys, setShowKeys] = useState(false);
  const monitorApi = useRef(null);
  const gridRef = useRef(null);
  const mainRef = useRef(null);
  const anchorRef = useRef(null);
  const cursorRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [flash, setFlash] = useState(null); // {id, n}: the card highlighted by "reveal in bin"
  const flashTimer = useRef(0);
  const monitorOpen = !!sourceId && !!media[sourceId];
  // The grid's single Tab stop (roving tabindex): the keyboard cursor, else the selection, the monitor's item, the first.
  const focusId = orderedIds.includes(cursorRef.current)
    ? cursorRef.current
    : selection.find((id) => orderedIds.includes(id)) || (orderedIds.includes(sourceId) ? sourceId : orderedIds[0] || null);

  /** Scrolls the bin to a card after the next render; focus: also move the keyboard focus to it. */
  const scrollToCard = (id, { center = false, focus = false } = {}) =>
    requestAnimationFrame(() => {
      const grid = gridRef.current;
      const el = grid?.querySelector(`[data-media-id="${CSS.escape(id)}"]`);
      if (focus && el && document.activeElement !== el) el.focus({ preventScroll: true });
      revealIn(grid?.parentElement, el, { center });
    });
  const gridHasFocus = () => !!gridRef.current?.contains(document.activeElement);
  /** The card that has the keyboard focus (Tab into the grid focuses one without selecting it), or null. */
  const focusedCard = () => {
    const el = gridHasFocus() ? document.activeElement.closest('.bin-card') : null;
    const id = el?.dataset.mediaId;
    return id && orderedIds.includes(id) ? id : null;
  };

  useEffect(() => () => clearTimeout(flashTimer.current), []);
  // 'bin.reveal' while this tab is on screen: show the item even if the search / filters hid it, select and flash it.
  useBinReveal(
    (id) => {
      const m = projectStore.get()?.media[id];
      if (!m) return;
      const cur = normalizeFilter(uiStore.get().binFilter);
      const next = filterShowing(cur, m);
      anchorRef.current = id;
      cursorRef.current = id;
      uiStore.set((s) => ({ ...s, binSelection: [id], ...(sameFilter(cur, next) ? {} : { binFilter: next }) }));
      if (uiStore.get().sourceMediaId && uiStore.get().sourceMediaId !== id) openInSource(id); // the monitor follows, as on a click
      setFlash((f) => ({ id, n: (f?.n || 0) + 1 }));
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
      scrollToCard(id, { center: true });
    },
    { shown: () => activeRef.current, pending: false },
  );

  // Selection only ever covers what's displayed: drop items the filter hides or that were removed.
  useEffect(() => {
    const visible = new Set(orderedIds);
    if (uiStore.get().binSelection.some((id) => !visible.has(id))) uiStore.set((s) => ({ ...s, binSelection: s.binSelection.filter((id) => visible.has(id)) }));
  }, [orderedIds]);

  // Leaving the tab closes this view's dialogs: a hidden kit Modal would still claim Escape in the other tabs.
  useEffect(() => {
    if (active) return;
    closeFrameOffer();
    closeUrlImport();
    setShowKeys(false);
  }, [active]);

  // Monitor changed item (prev/next, source.open from another tab…): keep the grid cursor and viewport on it.
  useEffect(() => {
    if (!sourceId) return;
    cursorRef.current = sourceId;
    scrollToCard(sourceId);
  }, [sourceId]);

  const select = (id, e) => {
    const mod = !!e && (e.ctrlKey || e.metaKey);
    const shift = !!e && e.shiftKey;
    const res = nextSelection({ selection: uiStore.get().binSelection, anchor: anchorRef.current, orderedIds, id, shift, mod });
    anchorRef.current = res.anchor;
    cursorRef.current = id;
    uiStore.set((s) => ({ ...s, binSelection: res.selection }));
    if (!mod && !shift && uiStore.get().sourceMediaId && uiStore.get().sourceMediaId !== id) openInSource(id); // the monitor follows
  };
  const open = (id) => {
    anchorRef.current = id;
    cursorRef.current = id;
    openInSource(id, { select: true });
  };
  const gridColumns = () => {
    const grid = gridRef.current;
    if (!grid) return 1;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  };
  const nav = (key, extend = false) => {
    const s = uiStore.get();
    const from =
      focusedCard() ||
      (orderedIds.includes(cursorRef.current) ? cursorRef.current : s.binSelection.find((id) => orderedIds.includes(id)) || (orderedIds.includes(s.sourceMediaId) ? s.sourceMediaId : null));
    const to = gridMove(orderedIds, from, key, gridColumns());
    if (!to) return;
    const focus = gridHasFocus(); // keyboard focus on a card moves with the cursor (roving tabindex)
    cursorRef.current = to;
    if (extend) {
      const res = nextSelection({ selection: s.binSelection, anchor: anchorRef.current || from || to, orderedIds, id: to, shift: true });
      anchorRef.current = res.anchor;
      uiStore.set((st) => ({ ...st, binSelection: res.selection }));
    } else {
      anchorRef.current = to;
      uiStore.set((st) => ({ ...st, binSelection: [to] }));
      if (s.sourceMediaId) openInSource(to);
    }
    scrollToCard(to, { focus });
  };
  /** Items P/X/U/ratings/E/W/Enter act on: the selection (display order), else the focused card, else the monitor's item. */
  const targets = () => {
    const s = uiStore.get();
    const p = projectStore.get();
    const sel = orderedSelection(s.binSelection.filter((id) => p.media[id]), orderedIds);
    if (sel.length) return sel;
    const focused = focusedCard();
    if (focused) return [focused];
    return s.sourceMediaId && p.media[s.sourceMediaId] ? [s.sourceMediaId] : [];
  };
  const firstTarget = () => targets()[0] || null;
  const withTargets = (fn) => () => {
    const ids = targets();
    if (!ids.length) return false;
    fn(ids);
  };
  const withMonitor = (fn) => () => {
    const api = monitorApi.current;
    if (!api || review) return false;
    fn(api);
  };
  /** Review walks the whole filtered bin; it starts at the first item unless `fromId` says where ("Review from here"). */
  const startReview = (fromId = null) => {
    if (!orderedIds.length) {
      toast('Nothing to review: the bin is empty with these filters', { kind: 'warn' });
      return;
    }
    const startIndex = typeof fromId === 'string' ? Math.max(0, orderedIds.indexOf(fromId)) : 0;
    setReview({ ids: orderedIds.slice(), startIndex, monitorWasOpen: !!uiStore.get().sourceMediaId });
  };
  const toggleStrip = () => {
    if (!short) return setPageCollapsed(!pageCollapsed);
    if (stripCollapsed) {
      setShortOpen(true);
      if (pageCollapsed) setPageCollapsed(false);
    } else setShortOpen(false);
  };
  const exitReview = (lastId) => {
    const r = review;
    setReview(null);
    if (lastId && projectStore.get()?.media[lastId]) {
      anchorRef.current = lastId;
      cursorRef.current = lastId;
      uiStore.set((s) => ({ ...s, binSelection: orderedIds.includes(lastId) ? [lastId] : [] }));
      if (r?.monitorWasOpen) openInSource(lastId);
      scrollToCard(lastId);
    }
  };

  const keys = {
    arrowleft: () => nav('arrowleft'),
    arrowright: () => nav('arrowright'),
    arrowup: () => nav('arrowup'),
    arrowdown: () => nav('arrowdown'),
    'shift+arrowleft': () => nav('arrowleft', true),
    'shift+arrowright': () => nav('arrowright', true),
    'shift+arrowup': () => nav('arrowup', true),
    'shift+arrowdown': () => nav('arrowdown', true),
    home: () => (monitorApi.current ? monitorApi.current.goTo('start') : nav('home')),
    end: () => (monitorApi.current ? monitorApi.current.goTo('end') : nav('end')),
    enter: () => {
      const id = firstTarget();
      if (!id) return false;
      open(id);
    },
    space: () => {
      if (monitorApi.current) return void monitorApi.current.toggle();
      const id = firstTarget();
      if (!id) return false;
      open(id);
    },
    j: withMonitor((a) => a.shuttle('j')),
    k: withMonitor((a) => a.shuttle('k')),
    l: withMonitor((a) => a.shuttle('l')),
    ',': withMonitor((a) => a.step(-1)),
    '.': withMonitor((a) => a.step(1)),
    i: withMonitor((a) => a.markIn()),
    o: withMonitor((a) => a.markOut()),
    'shift+i': withMonitor((a) => a.goTo('in')),
    'shift+o': withMonitor((a) => a.goTo('out')),
    'mod+shift+x': withMonitor((a) => a.clearMarks()),
    e: withTargets((ids) => addToTimeline(ids)),
    w: withTargets((ids) => insertAtPlayhead(ids)),
    p: withTargets((ids) => flagMedia(ids, 'pick')),
    x: withTargets((ids) => flagMedia(ids, 'reject')),
    u: withTargets((ids) => flagMedia(ids, null)),
    delete: withTargets((ids) => removeFromBin(ids)),
    backspace: withTargets((ids) => removeFromBin(ids)),
    // Always consumed (an empty bin included) so the browser never selects the page text.
    'mod+a': () => {
      if (orderedIds.length) uiStore.set((s) => ({ ...s, binSelection: orderedIds.slice() }));
    },
    escape: () => {
      // Escape fires inside text fields too: the first press only leaves the field.
      const el = document.activeElement;
      if (isTypingTarget(el) && rootRef.current?.contains(el)) return void el.blur();
      if (uiStore.get().sourceMediaId) return void closeSource();
      if (uiStore.get().binSelection.length) return void uiStore.set((s) => ({ ...s, binSelection: [] }));
      return false;
    },
    r: () => startReview(),
    '?': () => setShowKeys(true),
  };
  for (const n of [0, 1, 2, 3, 4, 5]) keys[String(n)] = withTargets((ids) => rateMedia(ids, n));
  useHotkeys(guardKeys(keys), { enabled: active && !review && !showKeys });

  // Resizable docked monitor. Below the bin needs height: a short view keeps it beside the bin.
  const variant = narrow ? 'sheet' : dock === 'bottom' && !short ? 'bottom' : 'right';
  const onSplitDown = useDrag({
    onStart: () => {
      const dockEl = mainRef.current?.querySelector('.clips-monitor-dock');
      const main = mainRef.current?.getBoundingClientRect();
      if (!dockEl || !main) return false;
      const r = dockEl.getBoundingClientRect();
      return { start: variant === 'right' ? r.width : r.height, max: variant === 'right' ? main.width - 300 : main.height - 160 };
    },
    onMove: ({ dx, dy, ctx }) => {
      if (!ctx) return;
      const v = variant === 'right' ? ctx.start - dx : ctx.start - dy;
      setMonSizes((s) => ({ ...s, [variant]: Math.round(clamp(v, MIN_MONITOR[variant], Math.max(MIN_MONITOR[variant], ctx.max))) }));
    },
    onEnd: () => setMonSizes((s) => (savePref('monitorSizes', s), s)),
  });
  const monSize = monSizes?.[variant];
  const dockStyle = monSize ? `--mon-size:${monSize}px` : '';

  return html`<${DropZone} class="clips-drop" onFiles=${(files) => importFilesFlow(files)} label="Drop videos, images or audio to add them to the bin">
    <div class=${cx('clips-view', narrow && 'is-narrow', monitorOpen && 'has-monitor', `clips-mon-${variant}`)} ref=${rootRef}>
      <div class="clips-main" ref=${mainRef}>
        <div class="clips-left">
          <${PageStrip} narrow=${narrow} collapsed=${stripCollapsed} onToggle=${toggleStrip} />
          <${BinPanel}
            narrow=${narrow}
            orderedIds=${orderedIds}
            selection=${selection}
            sourceId=${sourceId}
            focusId=${focusId}
            flash=${flash}
            cardSize=${cardSize}
            onCardSize=${setCardSize}
            onSelect=${select}
            onOpen=${open}
            onReview=${startReview}
            onShowKeys=${() => setShowKeys(true)}
            gridRef=${gridRef}
          />
        </div>
        ${monitorOpen &&
        !review &&
        !narrow &&
        html`<div class="clips-split" onPointerDown=${onSplitDown} title="Drag to resize the monitor" role="separator" aria-orientation=${variant === 'right' ? 'vertical' : 'horizontal'}></div>
          <div class="clips-monitor-dock" style=${dockStyle}>
            <${SourceMonitor} active=${active} orderedIds=${orderedIds} variant=${variant} onVariant=${short ? null : setDock} apiRef=${monitorApi} />
          </div>`}
      </div>
      ${monitorOpen &&
      !review &&
      narrow &&
      html`<div class="clips-sheet-backdrop" onClick=${closeSource}></div>
        <div class="clips-sheet">
          <${SourceMonitor} active=${active} orderedIds=${orderedIds} variant="sheet" apiRef=${monitorApi} />
        </div>`}
      ${review && html`<${ReviewMode} active=${active} ids=${review.ids} startIndex=${review.startIndex} onExit=${exitReview} />`}
      <${FrameOfferHost} />
      <${UrlImportHost} />
      ${showKeys && html`<${ShortcutsModal} onClose=${() => setShowKeys(false)} />`}
    </div>
  <//>`;
}
