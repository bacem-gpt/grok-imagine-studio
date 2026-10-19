// BinCompact: the dense bin used inside the Edit tab. List or grid of bin items (thumb, name, duration, flags) with
// search and a "picked only" filter; items drag onto the timeline (dataTransfer 'application/x-gis-media' = JSON
// array of ids), "+" appends to the timeline, double-click opens the source monitor (appEvents 'source.open').
// Files dropped on it (or picked with the import button) are imported into the bin.
// "Reveal in bin": appEvents 'bin.reveal' {mediaId} (see actions.js useBinReveal) makes a BinCompact that is on screen
// show the item — the search or "picked only" filter hiding it is cleared — select it, scroll to it and flash it.
// Rows are memoized and read their own item, so an update of one item re-renders one row.
import { html, useState, useMemo, useRef, useEffect } from '../../../vendor/preact-htm.mjs';
import { projectStore } from '../../core/store.js';
import { appEvents } from '../../core/app-state.js';
import { formatDuration, pluralize } from '../../core/utils.js';
import { useProject } from '../hooks.js';
import { Icon, IconButton, DropZone, EmptyState, showMenu, cx } from '../kit.js';
import { filterAndSort, filterShowing, nextSelection, displayTitle, trimLabel } from './bin-logic.js';
import { MediaThumb } from './media-thumb.js';
import { memo } from './memo.js';
import { usePref } from './prefs.js';
import { revealIn } from './keys.js';
import { startMediaDrag, cardAction } from './bin-grid.js';
import { addToTimeline, importFilesFlow, mediaMenuItems, useBinReveal } from './actions.js';

const KIND_ICON = { video: 'film', image: 'image', audio: 'music' };
const FLASH_MS = 1600;

const CompactItem = memo(function CompactItem({ id, selected, view, flash, api }) {
  const m = useProject((p) => p.media[id] || null);
  if (!m) return null;
  const meta = [m.kind === 'image' ? 'Image' : m.duration > 0 ? formatDuration(m.duration) : m.status === 'error' ? 'Error' : '…', m.width ? `${m.width}×${m.height}` : null]
    .filter(Boolean)
    .join(' · ');
  // Marks set in the Clips tab trim what "+" and drags add: say so here too.
  const trim = trimLabel(m);
  const trimBadge = trim && html`<span class="bin-compact-trim" title=${trim}><${Icon} name="scissors" size=${10} /></span>`;
  return html`<div
    class=${cx('bin-compact-item', selected && 'is-selected', m.flag && `is-${m.flag}`)}
    data-media-id=${id}
    draggable="true"
    role="option"
    aria-selected=${selected ? 'true' : 'false'}
    title=${`${displayTitle(m)}${trim ? `\n${trim}` : ''}\n\nDrag to the timeline · double-click to open in the source monitor`}
    onClick=${(e) => api.onSelect(id, e)}
    onDblClick=${() => appEvents.emit('source.open', { mediaId: id })}
    onDragStart=${(e) => api.onDragStart(e, id)}
    onContextMenu=${(e) => api.onContext(e, id)}
  >
    <div class="bin-compact-thumb">
      <${MediaThumb} mediaId=${id} showFlag=${view === 'grid'} showDuration=${view === 'grid'} showKind=${view === 'grid'} badges=${view === 'grid' && trimBadge} />
    </div>
    ${view === 'list' &&
    html`<div class="bin-compact-info">
      <div class="bin-compact-name">${displayTitle(m)}</div>
      <div class="bin-compact-meta">
        <${Icon} name=${KIND_ICON[m.kind] || 'film'} size=${11} />
        <span>${meta}</span>
        ${trimBadge}
        ${m.rating > 0 && html`<span class="bin-compact-stars">${'★'.repeat(m.rating)}</span>`}
        ${m.flag === 'pick' && html`<span class="bin-compact-flag is-pick" title="Picked"><${Icon} name="flag" size=${10} /></span>`}
        ${m.flag === 'reject' && html`<span class="bin-compact-flag is-reject" title="Rejected"><${Icon} name="x" size=${10} /></span>`}
      </div>
    </div>`}
    <button
      type="button"
      class="bin-compact-add"
      title=${m.kind === 'audio' ? 'Add to an audio track at the playhead' : trim ? 'Append the marked range to the timeline' : 'Append to the timeline'}
      onClick=${cardAction(() => addToTimeline([id]))}
      onDblClick=${(e) => e.stopPropagation()}
    >
      <${Icon} name="plus" size=${13} />
    </button>
    ${flash > 0 && html`<span class="bin-compact-flash" key=${flash} aria-hidden="true"></span>`}
  </div>`;
});

export function BinCompact() {
  const { media, order } = useProject((p) => ({ media: p.media, order: p.mediaOrder }));
  const [search, setSearch] = useState('');
  const [pickedOnly, setPickedOnly] = usePref('compactPicked', false);
  const [view, setView] = usePref('compactView', 'list');
  const [sel, setSel] = useState({ selection: [], anchor: null });
  const [flash, setFlash] = useState(null); // {id, n}: the row highlighted by "reveal in bin"
  const flashTimer = useRef(0);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const ids = useMemo(
    () => filterAndSort({ media, mediaOrder: order }, { search, flag: pickedOnly ? 'pick' : 'all', sort: 'newest' }),
    [media, order, search, pickedOnly],
  );
  const selection = sel.selection.filter((id) => media[id]);
  const selSet = new Set(selection);
  useEffect(() => {
    const visible = new Set(ids);
    if (sel.selection.some((id) => !visible.has(id))) setSel((s) => ({ ...s, selection: s.selection.filter((id) => visible.has(id)) }));
  }, [ids]);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // Reveal in bin (only while this bin is on screen: the Edit tab stays mounted when another tab is shown).
  useBinReveal(
    (id) => {
      const m = projectStore.get()?.media[id];
      if (!m) return;
      const showing = filterShowing({ search, flag: pickedOnly ? 'pick' : 'all' }, m);
      if (showing.search !== search) setSearch(showing.search);
      if (pickedOnly && showing.flag !== 'pick') setPickedOnly(false);
      setSel({ selection: [id], anchor: id });
      setFlash((f) => ({ id, n: (f?.n || 0) + 1 }));
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
      // After the re-render that shows it (a cleared search can bring the list back first).
      requestAnimationFrame(() => {
        const list = listRef.current;
        revealIn(list, list?.querySelector(`[data-media-id="${CSS.escape(id)}"]`), { center: true });
      });
    },
    { shown: () => !!rootRef.current && rootRef.current.getClientRects().length > 0 },
  );

  const onSelect = (id, e) => setSel(nextSelection({ selection, anchor: sel.anchor, orderedIds: ids, id, shift: e.shiftKey, mod: e.ctrlKey || e.metaKey }));
  const onContext = (e, id) => {
    const targets = selection.includes(id) && selection.length > 1 ? ids.filter((x) => selection.includes(x)) : [id];
    if (!selection.includes(id)) setSel({ selection: [id], anchor: id });
    showMenu(e, mediaMenuItems(id, { ids: targets }));
  };
  // One stable object for the memoized rows; its handlers are refreshed on every render.
  const api = useRef({}).current;
  Object.assign(api, { onSelect, onContext, onDragStart: (e, mid) => startMediaDrag(e, mid, selection, ids) });
  const total = order.length;

  let content;
  if (!total) {
    content = html`<${EmptyState} icon="film" title="No clips yet" compact=${true}>
      Collect clips in the <b>Clips</b> tab or import files here, then drag them onto the timeline.
    <//>`;
  } else if (!ids.length) {
    content = html`<${EmptyState} icon="filter" title=${pickedOnly ? 'No picked clips' : 'Nothing matches'} compact=${true}>
      ${pickedOnly ? html`Pick clips with <b>P</b> in the Clips tab, or show everything.` : 'Try another search.'}
      ${pickedOnly && html`<div><button type="button" class="bin-link" onClick=${() => setPickedOnly(false)}>Show all clips</button></div>`}
    <//>`;
  } else {
    content = html`<div class=${cx('bin-compact-list', `is-${view}`)} ref=${listRef} role="listbox" aria-multiselectable="true" aria-label="Bin">
      ${ids.map(
        (id) => html`<${CompactItem} key=${id} id=${id} selected=${selSet.has(id)} view=${view} flash=${flash?.id === id ? flash.n : 0} api=${api} />`,
      )}
    </div>`;
  }

  return html`<div class="bin-compact" ref=${rootRef}>
    <div class="bin-compact-head">
      <label class="bin-compact-search">
        <${Icon} name="search" size=${13} />
        <input
          type="text"
          value=${search}
          placeholder="Search bin"
          aria-label="Search the bin"
          onInput=${(e) => setSearch(e.currentTarget.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              if (search) setSearch('');
              else e.currentTarget.blur();
            }
          }}
        />
      </label>
      <${IconButton} icon="flag" size="sm" active=${pickedOnly} title=${pickedOnly ? 'Showing picked clips only' : 'Show picked clips only'} onClick=${() => setPickedOnly(!pickedOnly)} />
      <${IconButton} icon=${view === 'list' ? 'grid' : 'list'} size="sm" title=${view === 'list' ? 'Grid view' : 'List view'} onClick=${() => setView(view === 'list' ? 'grid' : 'list')} />
      <${IconButton} icon="upload" size="sm" title="Import files" onClick=${() => importFilesFlow()} />
    </div>
    <${DropZone} class="bin-compact-drop" onFiles=${(files) => importFilesFlow(files)} label="Drop to import">
      ${content}
    <//>
    ${selection.length > 1 &&
    html`<div class="bin-compact-sel">
      <span>${pluralize(selection.length, 'item')} selected · drag them, or</span>
      <button type="button" class="bin-link" title="Append them to the end of the timeline, in the order listed here" onClick=${() => addToTimeline(ids.filter((x) => selection.includes(x)))}>append all</button>
    </div>`}
  </div>`;
}
