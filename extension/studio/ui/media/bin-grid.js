// The bin: toolbar (search, filters, sort, card size, import, review), a responsive grid of cards (MediaThumb,
// title, rating, pick/reject), multi-selection with a bulk-action bar, per-card context menu and dragging to the
// timeline (dataTransfer 'application/x-gis-media' = JSON array of ids). Selection / keyboard logic lives in
// ClipsView so the shortcuts work wherever the focus is. The grid is one Tab stop (roving tabindex: the current
// card); the buttons inside a card stay out of the Tab order, the keys (Enter, E, P, X, 1–5…) and the context menu
// reach them. Cards are memoized and read their own item, so an update of one item re-renders one card.
import { html, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { uiStore } from '../../core/store.js';
import { pluralize } from '../../core/utils.js';
import { useProject, useStore, usePage, useUI, useElementSize } from '../hooks.js';
import { Icon, IconButton, Button, Select, EmptyState, showMenu, cx } from '../kit.js';
import {
  KIND_OPTIONS,
  FLAG_OPTIONS,
  RATING_OPTIONS,
  SORT_OPTIONS,
  DEFAULT_FILTER,
  MEDIA_DRAG_TYPE,
  normalizeFilter,
  isFilterActive,
  orderedSelection,
  flagStats,
  displayTitle,
  displaySubtitle,
  trimLabel,
  posterTime,
  parseMediaDrag,
} from './bin-logic.js';
import { MediaThumb } from './media-thumb.js';
import { memo } from './memo.js';
import { usePref } from './prefs.js';
import {
  addToTimeline,
  flagMedia,
  toggleFlag,
  rateMedia,
  downloadMedia,
  removeFromBin,
  importFilesFlow,
  importUrlFlow,
  mediaMenuItems,
  openGrokTab,
  setAutoCollect,
} from './actions.js';

export const setBinFilter = (patch) => uiStore.set((s) => ({ ...s, binFilter: { ...normalizeFilter(s.binFilter), ...patch } }));

/** Drag image showing how many items are being dragged. */
function setDragGhost(e, count) {
  const ghost = document.createElement('div');
  ghost.className = 'bin-drag-ghost';
  ghost.textContent = `${count} items`;
  document.body.appendChild(ghost);
  try {
    e.dataTransfer.setDragImage(ghost, 16, 16);
  } catch {
    /* ignore */
  }
  setTimeout(() => ghost.remove(), 0);
}

/** dragstart handler shared by the bin grid and BinCompact. */
export function startMediaDrag(e, id, selection, orderedIds) {
  const ids = selection.includes(id) ? orderedSelection(selection, orderedIds) : [id];
  e.dataTransfer.setData(MEDIA_DRAG_TYPE, JSON.stringify(ids));
  e.dataTransfer.effectAllowed = 'copy';
  if (ids.length > 1) setDragGhost(e, ids.length);
  return ids;
}

const SPRING_DELAY = 450;
let stopSpring = null;
const isEditTab = (el) => el.querySelector('.tab-label')?.textContent.trim() === 'Edit' || /^Timeline/i.test(el.getAttribute('title') || '');

/**
 * Spring-loaded Edit tab while bin cards are dragged out of the Clips tab: holding the drag over the Edit tab opens
 * it, so the cards can be dropped anywhere on the timeline. Listens only for the duration of the drag; onEnd runs
 * when it finishes (dropped or cancelled).
 */
function springLoadEditTab(onEnd) {
  stopSpring?.();
  let timer = 0;
  let over = null;
  const leaveTab = () => {
    clearTimeout(timer);
    over?.classList.remove('clips-spring');
    over = null;
  };
  const onOver = (e) => {
    const tab = e.target?.closest?.('.app-tabs [role="tab"]') || null;
    if (tab === over) return;
    leaveTab();
    if (!tab || !isEditTab(tab) || uiStore.get().tab === 'edit') return;
    over = tab;
    tab.classList.add('clips-spring');
    timer = setTimeout(() => {
      leaveTab();
      uiStore.set((s) => (s.tab === 'edit' ? s : { ...s, tab: 'edit' }));
    }, SPRING_DELAY);
  };
  const stop = () => {
    leaveTab();
    document.removeEventListener('dragover', onOver, true);
    window.removeEventListener('dragend', stop, true);
    window.removeEventListener('drop', stop, true);
    if (stopSpring === stop) stopSpring = null;
    onEnd?.();
  };
  document.addEventListener('dragover', onOver, true);
  window.addEventListener('dragend', stop, true);
  window.addEventListener('drop', stop, true);
  stopSpring = stop;
}

const hasMediaDrag = (e) => [...(e.dataTransfer?.types || [])].includes(MEDIA_DRAG_TYPE);

/** Shown at the bottom of the bin while cards are dragged: drop to append them, or hold over the Edit tab. */
function DropBar({ count }) {
  const [over, setOver] = useState(false);
  return html`<div
    class=${cx('bin-dropbar', over && 'is-over')}
    onDragEnter=${(e) => hasMediaDrag(e) && setOver(true)}
    onDragOver=${(e) => {
      if (!hasMediaDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!over) setOver(true);
    }}
    onDragLeave=${(e) => !e.currentTarget.contains(e.relatedTarget) && setOver(false)}
    onDrop=${(e) => {
      e.preventDefault();
      setOver(false);
      const ids = parseMediaDrag(e.dataTransfer.getData(MEDIA_DRAG_TYPE));
      if (ids.length) addToTimeline(ids);
    }}
  >
    <${Icon} name="plus" size=${15} />
    <span class="bin-dropbar-main">Drop to add ${count > 1 ? `${count} items` : 'it'} to the end of the timeline</span>
    <span class="bin-dropbar-hint">or hold over the <b>Edit</b> tab to place ${count > 1 ? 'them' : 'it'} exactly</span>
  </div>`;
}

/** Click handler for buttons inside a card: no bubbling to the card, and a double-click doesn't run it twice. */
export const cardAction = (fn) => (e) => {
  e.stopPropagation();
  if (e.detail > 1) return;
  fn(e);
};
const stopDbl = (e) => e.stopPropagation();

/** The kit Rating, with its stars out of the Tab order (the card is one Tab stop; 1–5 rate it from the keyboard). */
function CardStars({ value, onChange }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return html`<span class="rating" onMouseLeave=${() => setHover(0)}>
    ${[1, 2, 3, 4, 5].map(
      (n) => html`<button
        type="button"
        tabindex="-1"
        class=${cx('rating-star', n <= shown && 'is-on')}
        title=${`${n} star${n > 1 ? 's' : ''} (${n})`}
        onMouseEnter=${() => setHover(n)}
        onClick=${(e) => {
          e.stopPropagation();
          onChange(n === value ? 0 : n);
        }}
      ><${Icon} name=${n <= shown ? 'star-filled' : 'star'} size=${12} /></button>`,
    )}
  </span>`;
}

/**
 * One bin card. Reads its own item (so only the card whose item changed re-renders) and calls the bin's handlers
 * through `api`, a stable object. tabbable: the grid's single Tab stop. flash: a counter that replays the reveal
 * highlight when it changes (0 = none).
 */
const BinCard = memo(function BinCard({ id, api, selected, current, tabbable, flash }) {
  const m = useProject((p) => p.media[id] || null);
  const scrub = useRef(null);
  if (!m) return null;
  const trim = trimLabel(m);
  const title = displayTitle(m);
  const sub = displaySubtitle(m);
  const context = (e) => {
    // The context-menu key (or Shift+F10) has no pointer position: open the menu under the card instead.
    if (!e.clientX && !e.clientY) {
      e.preventDefault();
      api.onContext(e.currentTarget, id, scrub.current);
    } else api.onContext(e, id, scrub.current);
  };
  return html`<div
    class=${cx('bin-card', selected && 'is-selected', current && 'is-current', m.flag && `is-${m.flag}`)}
    data-media-id=${id}
    draggable="true"
    role="option"
    tabindex=${tabbable ? '0' : '-1'}
    aria-selected=${selected ? 'true' : 'false'}
    aria-label=${[title, m.flag === 'pick' ? 'picked' : m.flag === 'reject' ? 'rejected' : null, m.rating ? `${m.rating} of 5 stars` : null, trim ? 'IN/OUT marks set' : null].filter(Boolean).join(', ')}
    onClick=${(e) => api.onSelect(id, e)}
    onDblClick=${() => api.onOpen(id)}
    onContextMenu=${context}
    onDragStart=${(e) => api.onDragStart(e, id)}
  >
    <div class="bin-card-media">
      <${MediaThumb}
        mediaId=${id}
        showFlag=${true}
        onScrub=${(f) => (scrub.current = f)}
        badges=${trim && html`<span class="bin-card-trim" title=${trim}><${Icon} name="scissors" size=${11} /></span>`}
      />
      <div class="bin-card-hover" onDblClick=${stopDbl}>
        <${IconButton} icon="plus" size="sm" kind="solid" tabindex="-1" title="Add to timeline (E)" onClick=${cardAction(() => addToTimeline([id]))} />
        <${IconButton} icon="maximize" size="sm" kind="solid" tabindex="-1" title="Open in source monitor (Enter)" onClick=${cardAction(() => api.onOpen(id))} />
        <${IconButton} icon="more" size="sm" kind="solid" tabindex="-1" title="More actions" onClick=${cardAction((e) => api.onContext(e, id, scrub.current))} />
      </div>
    </div>
    <div class="bin-card-body">
      <div class=${cx('bin-card-text', sub && 'has-sub')} title=${sub ? `${m.name}\n\n${m.prompt}` : m.prompt || title}>
        <div class="bin-card-title">${title}</div>
        ${sub && html`<div class="bin-card-sub">${sub}</div>`}
      </div>
      <div class="bin-card-foot" onClick=${(e) => e.stopPropagation()} onDblClick=${stopDbl}>
        <${CardStars} value=${m.rating || 0} onChange=${(n) => rateMedia([id], n)} />
        <span class="spacer"></span>
        <button type="button" tabindex="-1" class=${cx('bin-flag', 'is-pick', m.flag === 'pick' && 'is-on')} title=${m.flag === 'pick' ? 'Picked (P) — click to unflag' : 'Pick (P)'} aria-pressed=${m.flag === 'pick' ? 'true' : 'false'} onClick=${() => toggleFlag([id], 'pick')}>
          <${Icon} name="flag" size=${13} />
        </button>
        <button type="button" tabindex="-1" class=${cx('bin-flag', 'is-reject', m.flag === 'reject' && 'is-on')} title=${m.flag === 'reject' ? 'Rejected (X) — click to unflag' : 'Reject (X)'} aria-pressed=${m.flag === 'reject' ? 'true' : 'false'} onClick=${() => toggleFlag([id], 'reject')}>
          <${Icon} name="x" size=${13} />
        </button>
      </div>
    </div>
    ${flash > 0 && html`<span class="bin-card-flash" key=${flash} aria-hidden="true"></span>`}
  </div>`;
});

function BinToolbar({ narrow, cardSize, onCardSize, onReview, reviewCount, onShowKeys }) {
  const filter = normalizeFilter(useStore(uiStore, (s) => s.binFilter));
  const searchRef = useRef(null);
  const [filtersOpen, setFiltersOpen] = usePref('filtersOpen', false);
  const activeFilters = (filter.kind !== 'all') + (filter.flag !== 'all') + (filter.minRating > 0);
  const filters = html`
    <${Select} class="bin-select" value=${filter.kind} options=${KIND_OPTIONS} title="Kind" onChange=${(v) => setBinFilter({ kind: v })} />
    <${Select} class="bin-select" value=${filter.flag} options=${FLAG_OPTIONS} title="Flags" onChange=${(v) => setBinFilter({ flag: v })} />
    <${Select} class="bin-select" value=${String(filter.minRating)} options=${RATING_OPTIONS} title="Minimum rating" onChange=${(v) => setBinFilter({ minRating: Number(v) })} />
    <${Select} class="bin-select" value=${filter.sort} options=${SORT_OPTIONS} title="Sort" onChange=${(v) => setBinFilter({ sort: v })} />
    <label class="bin-size" title="Card size">
      <${Icon} name="grid" size=${13} />
      <input type="range" min="120" max="320" step="10" value=${cardSize} style=${`--pct:${((cardSize - 120) / 200) * 100}%`} aria-label="Card size" onInput=${(e) => onCardSize(Number(e.currentTarget.value))} />
    </label>`;
  return html`<div class=${cx('bin-toolbar', narrow && 'is-narrow')}>
    <div class="bin-toolbar-row">
      <label class="bin-search">
        <${Icon} name="search" size=${14} />
        <input
          ref=${searchRef}
          type="text"
          value=${filter.search}
          placeholder="Search prompts, names, tags"
          aria-label="Search the bin"
          onInput=${(e) => setBinFilter({ search: e.currentTarget.value })}
          onKeyDown=${(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              if (filter.search) setBinFilter({ search: '' });
              else e.currentTarget.blur();
            } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        ${filter.search && html`<button type="button" class="bin-search-clear" title="Clear search" onClick=${() => setBinFilter({ search: '' })}><${Icon} name="x" size=${12} /></button>`}
      </label>
      ${!narrow && filters}
      <div class="bin-toolbar-end">
        ${narrow &&
        html`<${IconButton}
          icon="filter"
          size="sm"
          active=${filtersOpen}
          badge=${activeFilters || null}
          title=${filtersOpen ? 'Hide filters & sort' : 'Filters & sort'}
          onClick=${() => setFiltersOpen(!filtersOpen)}
        />`}
        <${Button}
          size="sm"
          kind="ghost"
          icon="upload"
          title="Import videos, images or audio (you can also drop files here)"
          onClick=${(e) =>
            showMenu(e.currentTarget, [
              { header: 'Import into the bin' },
              { label: 'Files…', icon: 'upload', onClick: () => importFilesFlow() },
              { label: 'From a URL…', icon: 'link', onClick: () => importUrlFlow() },
            ])}
          >${narrow ? '' : 'Import'}<//
        >
        <${IconButton} icon="keyboard" size="sm" title="Keyboard shortcuts (?)" onClick=${onShowKeys} />
        <${Button} size="sm" kind="primary" icon="play2" disabled=${!reviewCount} onClick=${() => onReview()} title="Review the filtered bin one clip at a time with the keyboard, from the first item (R)">Review<//>
      </div>
    </div>
    ${narrow && filtersOpen && html`<div class="bin-toolbar-row is-filters">${filters}</div>`}
  </div>`;
}

function SelectionBar({ ids, orderedIds, narrow, onOpen }) {
  const ordered = orderedSelection(ids, orderedIds);
  const n = ids.length;
  const firstKind = useProject((p) => p.media[ids[0]]?.kind || null);
  const one = n === 1 ? firstKind : null; // kind of the single selected item: Trim (or Open for an image)
  const rateMenu = (e) =>
    showMenu(e, [
      { header: `Rate ${pluralize(n, 'item')}` },
      ...[5, 4, 3, 2, 1].map((r) => ({ label: '★'.repeat(r) + '☆'.repeat(5 - r), shortcut: String(r), onClick: () => rateMedia(ids, r) })),
      '-',
      { label: 'Clear rating', shortcut: '0', onClick: () => rateMedia(ids, 0) },
    ]);
  const addTitle = n > 1 ? `Append the ${n} items to the end of the timeline, in the order the bin shows them (E)` : 'Append to the end of the timeline (E)';
  return html`<div class="bin-selbar" role="toolbar" aria-label="Selection actions">
    <span class="bin-selbar-count">${n} selected</span>
    <${Button} size="sm" kind="primary" icon="plus" onClick=${() => addToTimeline(ordered)} title=${addTitle}>${narrow ? 'Add' : 'Add to timeline'}<//>
    ${one &&
    html`<${Button} size="sm" icon=${one === 'image' ? 'maximize' : 'scissors'} class="bin-selbar-open" onClick=${() => onOpen(ids[0])} title=${one === 'image' ? 'Open in the source monitor (Enter)' : 'Open in the source monitor to set IN/OUT marks: what you add is trimmed to them (Enter)'}>
      ${one === 'image' ? 'Open' : 'Trim'}
    <//>`}
    <${IconButton} icon="flag" size="sm" title="Pick (P)" onClick=${() => flagMedia(ids, 'pick')} />
    <${IconButton} icon="x" size="sm" title="Reject (X)" onClick=${() => flagMedia(ids, 'reject')} />
    <${IconButton} icon="minus" size="sm" title="Unflag (U)" onClick=${() => flagMedia(ids, null)} />
    <${IconButton} icon="star" size="sm" title="Rate (1–5)" onClick=${rateMenu} />
    <${IconButton} icon="download" size="sm" title="Download originals" onClick=${() => downloadMedia(ordered)} />
    <${IconButton} icon="trash" size="sm" kind="danger" title="Remove from bin (Del)" onClick=${() => removeFromBin(ordered)} />
    <span class="spacer"></span>
    <${Button} size="sm" kind="ghost" onClick=${() => uiStore.set((s) => ({ ...s, binSelection: [] }))} title="Clear selection (Esc)">Clear<//>
  </div>`;
}

/** Empty bin: how to collect clips (what is on screen above it decides the wording). */
function EmptyBin({ connected }) {
  const autoCollect = useUI((s) => s.autoCollect);
  const turnOnAuto = () => setAutoCollect('autoCollect', true);
  return html`<${EmptyState}
    icon="film"
    title="Your bin is empty"
    action=${html`<${Button} kind="primary" icon="upload" onClick=${() => importFilesFlow()}>Import files<//>
      <${Button} icon="link" onClick=${() => importUrlFlow()}>From a URL<//>
      ${!connected && html`<${Button} kind="ghost" icon="external" onClick=${openGrokTab}>Open Grok Imagine<//>`}`}
  >
    ${connected
      ? html`Collect the generations you like from grok.com: click <b>+</b> on a clip above (or select several and press <b>Add</b>), hover a video on Grok and click <b>+ Bin</b>, ${autoCollect
            ? 'or let auto-add (on) bring in each new one.'
            : html`or <button type="button" class="bin-link" data-testid="bin-auto-on" onClick=${turnOnAuto}>turn on auto-add</button> to collect each new one.`} You can also import files or a link, or drop files anywhere on this tab.`
      : 'Open Grok Imagine in a tab: the clips Grok shows there are listed above, ready to add. You can also import files or a link, or drop files anywhere on this tab.'}
  <//>`;
}

export function BinPanel({ narrow: narrowView, orderedIds, selection, sourceId, focusId, flash, cardSize, onCardSize, onSelect, onOpen, onReview, onShowKeys, gridRef }) {
  const [panelRef, panelSize] = useElementSize();
  // The bin shares its width with the docked monitor: lay the toolbar out by the panel's own width.
  const narrow = narrowView || (panelSize.width > 0 && panelSize.width < 860);
  const { media, total } = useProject((p) => ({ media: p.media, total: p.mediaOrder.length }));
  const allStats = useProject((p) => {
    const s = flagStats(p, p.mediaOrder);
    return { picked: s.picked, rejected: s.rejected };
  });
  const filter = useStore(uiStore, (s) => s.binFilter);
  const connected = usePage((s) => s.connected);
  const filtered = isFilterActive(filter);
  const sel = selection.filter((id) => media[id]);
  const selSet = new Set(sel);
  const [dragCount, setDragCount] = useState(0);
  const dragToken = useRef(0);

  const onCardDragStart = (e, id) => {
    const ids = startMediaDrag(e, id, sel, orderedIds);
    const token = ++dragToken.current;
    // The drop bar appears after dragstart (changing the page during dragstart can abort the drag).
    setTimeout(() => dragToken.current === token && setDragCount(ids.length), 0);
    springLoadEditTab(() => {
      dragToken.current++;
      setDragCount(0);
    });
  };

  const onContext = (e, id, scrubFrac) => {
    let targets = [id];
    if (sel.includes(id) && sel.length > 1) targets = orderedSelection(sel, orderedIds);
    else if (!sel.includes(id)) onSelect(id, null);
    const m = media[id];
    const frameTime = scrubFrac != null && m?.duration > 0 ? scrubFrac * m.duration : posterTime(m?.duration || 0);
    const extra = targets.length === 1 ? [{ label: 'Review from here', icon: 'play2', onClick: () => onReview(id) }] : [];
    showMenu(e, mediaMenuItems(id, { ids: targets, frameTime, extra }));
  };

  // One stable object for the memoized cards; its handlers are refreshed on every render.
  const api = useRef({}).current;
  Object.assign(api, { onSelect, onOpen, onContext, onDragStart: onCardDragStart });

  let content;
  if (!total) {
    content = html`<${EmptyBin} connected=${connected} />`;
  } else if (!orderedIds.length) {
    content = html`<${EmptyState} icon="filter" title="Nothing matches" action=${html`<${Button} icon="x" onClick=${() => setBinFilter({ ...DEFAULT_FILTER, sort: normalizeFilter(filter).sort })}>Reset filters<//>`}>
      No items match the current search and filters.
    <//>`;
  } else {
    content = html`<div
      class="bin-grid"
      ref=${gridRef}
      role="listbox"
      aria-multiselectable="true"
      aria-label="Bin"
      style=${`--bin-card-w:${cardSize}px`}
      onClick=${(e) => e.target === e.currentTarget && sel.length && uiStore.set((s) => ({ ...s, binSelection: [] }))}
    >
      ${orderedIds.map(
        (id) => html`<${BinCard}
          key=${id}
          id=${id}
          api=${api}
          selected=${selSet.has(id)}
          current=${sourceId === id}
          tabbable=${focusId === id}
          flash=${flash?.id === id ? flash.n : 0}
        />`,
      )}
    </div>`;
  }

  return html`<div class=${cx('bin-panel', narrow && 'is-narrow')} ref=${panelRef}>
    <${BinToolbar} narrow=${narrow} cardSize=${cardSize} onCardSize=${onCardSize} onReview=${onReview} reviewCount=${orderedIds.length} onShowKeys=${onShowKeys} />
    ${total > 0 &&
    html`<div class="bin-status">
      <span class="bin-status-counts">
        ${pluralize(total, 'item')}${allStats.picked ? html` · <span class="bin-status-pick">${allStats.picked} picked</span>` : ''}${allStats.rejected
          ? html` · <span class="bin-status-reject">${allStats.rejected} rejected</span>`
          : ''}
      </span>
      ${filtered &&
      html`<span class="bin-status-filter">· showing ${orderedIds.length}
        <button type="button" class="bin-link" onClick=${() => setBinFilter({ ...DEFAULT_FILTER, sort: normalizeFilter(filter).sort })}>Reset filters</button></span>`}
      <span class="spacer"></span>
      ${orderedIds.length > 0 &&
      html`<button type="button" class="bin-link" onClick=${() => uiStore.set((s) => ({ ...s, binSelection: orderedIds.slice() }))} title="Select all (Ctrl+A)">Select all</button>`}
    </div>`}
    <div class="bin-scroll">${content}</div>
    ${dragCount > 0 ? html`<${DropBar} count=${dragCount} />` : sel.length > 0 && html`<${SelectionBar} ids=${sel} orderedIds=${orderedIds} narrow=${narrow} onOpen=${onOpen} />`}
  </div>`;
}

