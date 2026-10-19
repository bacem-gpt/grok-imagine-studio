// "On grok.com": the media Grok shows on the connected page (pageStore.items), as a horizontal strip with hover
// previews, "in bin" badges, an always visible "+" on clips not in the bin yet (Add & pick / Reveal on hover), bulk
// add, Load more and the auto-add switches (a compact one in the narrow header, both in the "…" menu; off-limits while
// grok.com is not connected). Bulk adds keep the strip's order, so the bin lists them as the strip does. Only the "+"
// is a Tab stop on a card (the hover actions would add three per clip before the bin).
import { html, useState, useEffect, useMemo, useRef } from '../../../vendor/preact-htm.mjs';
import { pageStore } from '../../core/store.js';
import { bridge } from '../../core/bridge.js';
import { REQ } from '../../../shared/protocol.js';
import { importPageItems } from '../../core/media.js';
import { formatDuration, pluralize } from '../../core/utils.js';
import { useProject, usePage, useUI, useElementSize } from '../hooks.js';
import { Icon, IconButton, Button, Segmented, Toggle, EmptyState, Spinner, showMenu, toast, cx } from '../kit.js';
import { binPageIndexString, parsePageIndex, pageItemsView, missingFromBin, nextSelection, snippet, PAGE_FILTERS } from './bin-logic.js';
import { MediaThumb } from './media-thumb.js';
import { usePref } from './prefs.js';
import { openInSource, revealKeyOnGrok, openGrokTab, setAutoCollect } from './actions.js';

const NEEDS_GROK = 'Connect to grok.com first: open Grok Imagine in a tab';

const ROUTE_LABEL = { imagine: 'Imagine feed', post: 'Post', favorites: 'Favorites', chat: 'Chat', other: 'Page' };

/** Adds page items to the bin; flag 'pick' marks them as picks (also for items already there). */
async function addItems(list, inBin, { flag = null, open = false } = {}) {
  if (!list.length) return [];
  const fresh = list.filter((it) => !inBin.has(it.key)).length;
  try {
    const ids = await importPageItems(list, { flag });
    if (open && ids[0]) openInSource(ids[0], { select: true });
    if (fresh) toast(`Adding ${pluralize(fresh, 'item')} to the bin${flag === 'pick' ? ' as picks' : ''}`, { kind: 'success' });
    else if (flag === 'pick') toast(list.length > 1 ? 'Marked as picks' : 'Marked as a pick', { kind: 'success' });
    else if (!open) toast('Already in the bin', { kind: 'info' });
    return ids;
  } catch (e) {
    toast(`Could not add: ${e.message || e}`, { kind: 'error' });
    return [];
  }
}

function PageCard({ item, binId, selected, onSelect, onAdd, onPick, onReveal, onOpen }) {
  const inBin = !!binId;
  const [preview, setPreview] = useState(false);
  const [failedThumb, setFailedThumb] = useState(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const enter = () => {
    if (item.kind !== 'video' || !item.url) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPreview(true), 350);
  };
  const leave = () => {
    clearTimeout(timer.current);
    setPreview(false);
  };
  // Buttons on the card: no bubbling to the card's click / double-click, and a double-click runs them once.
  const stop = (fn) => (e) => {
    e.stopPropagation();
    if (e.detail > 1) return;
    fn();
  };
  const label = item.prompt ? snippet(item.prompt, 120) : item.kind === 'video' ? 'Grok video' : 'Grok image';
  return html`<div
    class=${cx('clips-pcard', inBin && 'is-inbin', selected && 'is-selected')}
    data-key=${item.key}
    title=${item.prompt || label}
    onPointerEnter=${enter}
    onPointerLeave=${leave}
    onClick=${(e) => onSelect(item.key, e)}
    onDblClick=${() => (inBin ? onOpen(item) : onAdd(item, true))}
  >
    <div class="clips-pcard-media">
      ${item.thumbUrl && item.thumbUrl !== failedThumb
        ? html`<img src=${item.thumbUrl} alt="" loading="lazy" draggable="false" onError=${() => setFailedThumb(item.thumbUrl)} />`
        : binId
          ? html`<${MediaThumb} mediaId=${binId} scrub=${false} showKind=${false} showDuration=${false} showUsage=${false} />`
          : html`<div class="clips-pcard-ph"><${Icon} name=${item.kind === 'video' ? 'film' : 'image'} size=${20} /></div>`}
      ${preview && html`<video class="clips-pcard-video" src=${item.url} muted autoplay loop playsInline preload="auto" onError=${() => setPreview(false)}></video>`}
      <span class=${cx('clips-pcard-kind', `is-${item.kind}`)}><${Icon} name=${item.kind === 'video' ? 'film' : 'image'} size=${11} /></span>
      ${item.duration > 0 && html`<span class="clips-pcard-dur">${formatDuration(item.duration)}</span>`}
      ${inBin && html`<span class="clips-pcard-inbin"><${Icon} name="check" size=${11} />In bin</span>`}
      ${selected && html`<span class="clips-pcard-check"><${Icon} name="check" size=${12} /></span>`}
      <div class="clips-pcard-actions" onDblClick=${(e) => e.stopPropagation()}>
        ${inBin && html`<${IconButton} icon="maximize" size="sm" tabindex="-1" title="Open in the source monitor" onClick=${stop(() => onOpen(item))} />`}
        <${IconButton} icon="flag" size="sm" tabindex="-1" title=${inBin ? 'Mark as pick' : 'Add to bin & pick'} onClick=${stop(() => onPick(item))} />
        <${IconButton} icon="target" size="sm" tabindex="-1" title="Reveal on grok.com" onClick=${stop(() => onReveal(item))} />
      </div>
      ${!inBin &&
      html`<button type="button" class="clips-pcard-add" title="Add to bin" aria-label="Add to bin" onClick=${stop(() => onAdd(item))} onDblClick=${(e) => e.stopPropagation()}>
        <${Icon} name="plus" size=${14} />
      </button>`}
    </div>
    <div class="clips-pcard-prompt">${label}</div>
  </div>`;
}

export function PageStrip({ narrow: narrowView = false, collapsed = false, onToggle }) {
  const [rootRef, rootSize] = useElementSize();
  // Shares its width with the docked monitor: compact header when its own width is small.
  const narrow = narrowView || (rootSize.width > 0 && rootSize.width < 940);
  const { connected, mode, route } = usePage((s) => ({ connected: s.connected, mode: s.mode, route: s.info?.route || null }));
  const items = usePage((s) => s.items);
  const indexStr = useProject((p) => binPageIndexString(p));
  const binCount = useProject((p) => p.mediaOrder.length);
  const binIndex = useMemo(() => parsePageIndex(indexStr), [indexStr]); // pageKey -> media id
  const inBin = useMemo(() => new Set(binIndex.keys()), [binIndex]);
  const autoCollect = useUI((s) => s.autoCollect);
  const autoImages = useUI((s) => s.autoCollectImages);
  const [filter, setFilter] = usePref('pageFilter', 'all');
  const [sel, setSel] = useState({ selection: [], anchor: null });
  const [busy, setBusy] = useState(null); // 'more' | 'scan'

  const view = useMemo(() => pageItemsView(items, filter, inBin), [items, filter, inBin]);
  const viewKeys = useMemo(() => view.map((it) => it.key), [view]);
  // Bulk adds go in the strip's order (newest first): the bin then lists the batch exactly like the strip.
  const ordered = useMemo(() => pageItemsView(items), [items]);
  const newVideos = useMemo(() => missingFromBin(ordered, inBin, 'video'), [ordered, inBin]);
  const newAll = useMemo(() => missingFromBin(ordered, inBin), [ordered, inBin]);
  const selected = useMemo(() => {
    const set = new Set(sel.selection);
    return ordered.filter((it) => set.has(it.key));
  }, [ordered, sel]);

  // Forget selected keys that disappeared from the page.
  useEffect(() => {
    const present = new Set(items.map((it) => it.key));
    if (sel.selection.some((k) => !present.has(k))) setSel((s) => ({ ...s, selection: s.selection.filter((k) => present.has(k)) }));
  }, [items]);

  // Vertical wheel scrolls the strip sideways (element listeners aren't forced passive, so preventDefault works).
  const onStripWheel = (e) => {
    const el = e.currentTarget;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  };

  const select = (key, e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && !e.shiftKey && sel.selection.length === 1 && sel.selection[0] === key) return setSel({ selection: [], anchor: null });
    setSel(nextSelection({ selection: sel.selection, anchor: sel.anchor, orderedIds: viewKeys, id: key, shift: e.shiftKey, mod }));
  };
  const clearSel = () => setSel({ selection: [], anchor: null });
  const openItem = (item) => {
    const id = binIndex.get(item.key);
    if (id) openInSource(id, { select: true });
  };
  const loadMore = async () => {
    if (!bridge.connected) return toast('Not connected to grok.com', { kind: 'warn', action: { label: 'Open Grok', run: openGrokTab } });
    setBusy('more');
    try {
      const res = await bridge.request(REQ.PAGE_LOAD_MORE, { steps: 3 }, { timeout: 30000 });
      toast(res?.added ? `Found ${pluralize(res.added, 'more item')}` : 'No more media found on this page', { kind: res?.added ? 'success' : 'info' });
    } catch (e) {
      toast(`Load more failed: ${e.message || e}`, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const rescan = async () => {
    if (!bridge.connected) return toast('Not connected to grok.com', { kind: 'warn', action: { label: 'Open Grok', run: openGrokTab } });
    setBusy('scan');
    try {
      const res = await bridge.request(REQ.PAGE_SCAN);
      if (Array.isArray(res?.items)) pageStore.set((s) => ({ ...s, items: res.items }));
    } catch (e) {
      toast(`Scan failed: ${e.message || e}`, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const addSelected = async (flag = null) => {
    await addItems(selected, inBin, { flag });
    clearSel();
  };

  const moreMenu = (e) =>
    showMenu(e, [
      { header: 'On grok.com' },
      { label: 'Load more from the page', icon: 'arrow-down', disabled: !connected, onClick: loadMore },
      { label: 'Rescan the page', icon: 'refresh', disabled: !connected, onClick: rescan },
      '-',
      { label: `Add all new (${newAll.length})`, icon: 'plus', disabled: !newAll.length, onClick: () => addItems(newAll, inBin) },
      { label: 'Add selected & pick', icon: 'flag', disabled: !selected.length, onClick: () => addSelected('pick') },
      { label: 'Select all not in bin', icon: 'check', disabled: !newAll.length, onClick: () => setSel({ selection: view.filter((it) => !inBin.has(it.key)).map((it) => it.key), anchor: null }) },
      '-',
      !connected && { header: NEEDS_GROK },
      { label: 'Auto-add new videos', checked: autoCollect, disabled: !connected, onClick: () => setAutoCollect('autoCollect', !autoCollect) },
      { label: 'Auto-add new images', checked: autoImages, disabled: !connected, onClick: () => setAutoCollect('autoCollectImages', !autoImages) },
      '-',
      { label: 'Open Grok Imagine', icon: 'external', onClick: openGrokTab },
    ]);
  const autoTitle = (what) => (connected ? `Add new Grok ${what} to the bin automatically while the studio is open` : NEEDS_GROK);

  let body = null;
  if (!collapsed) {
    if (!connected && binCount > 0) {
      // The bin is in use: one line instead of the full explanation, so the bin keeps the room.
      body = html`<div class="clips-page-banner" role="status">
        <${Icon} name="link" size=${14} />
        <span class="clips-page-banner-text">Not connected: open Grok to list the clips it shows here.</span>
        <${Button} size="sm" kind="primary" icon="external" onClick=${openGrokTab}>Open Grok Imagine<//>
      </div>`;
    } else if (!connected) {
      body = html`<${EmptyState} icon="link" title="Not connected to grok.com" compact=${true}
        action=${html`<${Button} size="sm" kind="primary" icon="external" onClick=${openGrokTab}>Open Grok Imagine<//>`}>
        Open <b>grok.com/imagine</b> or a Grok chat where you generated videos: every clip Grok shows there is listed here so you can pick
        the good ones. ${mode === 'tab' ? 'This studio tab works with your most recently used grok.com tab.' : ''}
      <//>`;
    } else if (!items.length) {
      body = html`<${EmptyState} icon="search" title="No generated media detected on this page" compact=${true}
        action=${html`<${Button} size="sm" icon="arrow-down" onClick=${loadMore} disabled=${!!busy}>Load more<//><${Button} size="sm" kind="ghost" icon="refresh" onClick=${rescan} disabled=${!!busy}>Rescan<//>`}>
        Open grok.com/imagine, one of your posts or a chat with generated videos. New generations appear here as Grok shows them; scroll the
        feed or use Load more for older ones.
      <//>`;
    } else if (!view.length) {
      body = html`<div class="clips-page-none">
        <span>${filter === 'new' ? 'Everything on this page is already in your bin.' : 'Nothing of this kind on the page.'}</span>
        <button type="button" class="bin-link" onClick=${() => setFilter('all')}>Show all</button>
      </div>`;
    } else {
      body = html`<div class="clips-page-strip" onWheel=${onStripWheel}>
        ${view.map(
          (item) => html`<${PageCard}
            key=${item.key}
            item=${item}
            binId=${binIndex.get(item.key) || null}
            selected=${sel.selection.includes(item.key)}
            onSelect=${select}
            onAdd=${(it, open = false) => addItems([it], inBin, { open })}
            onPick=${(it) => addItems([it], inBin, { flag: 'pick' })}
            onReveal=${(it) => revealKeyOnGrok(it.key, { url: it.url, pageUrl: it.pageUrl })}
            onOpen=${openItem}
          />`,
        )}
        ${connected &&
        html`<button type="button" class="clips-page-more" onClick=${loadMore} disabled=${!!busy} title="Scroll grok.com to load older media">
          ${busy === 'more' ? html`<${Spinner} size=${18} />` : html`<${Icon} name="arrow-down" size=${18} />`}
          <span>Load more</span>
        </button>`}
      </div>`;
    }
  }

  return html`<section class=${cx('clips-page', collapsed && 'is-collapsed', narrow && 'is-narrow')} ref=${rootRef} aria-label="Media on grok.com">
    <div class="clips-page-head">
      <button type="button" class="clips-page-toggle" aria-expanded=${!collapsed} onClick=${onToggle} title=${collapsed ? 'Show media detected on grok.com' : 'Collapse'}>
        <${Icon} name=${collapsed ? 'chevron-right' : 'chevron-down'} size=${14} />
        <span class="clips-page-title">On grok.com</span>
        ${items.length > 0 && html`<span class="clips-page-count">${items.length}</span>`}
        <span class=${cx('clips-page-conn', connected && 'is-on')} title=${connected ? `Connected to grok.com: ${ROUTE_LABEL[route] || 'page'}` : 'Not connected to grok.com'}>
          <span class="clips-page-conn-text">${connected ? ROUTE_LABEL[route] || 'Connected' : 'Not connected'}</span>
        </span>
      </button>
      ${!collapsed && !narrow && items.length > 0 && html`<${Segmented} size="sm" value=${filter} options=${PAGE_FILTERS} onChange=${setFilter} />`}
      <span class="spacer"></span>
      ${narrow
        ? html`<div class="clips-page-auto is-compact">
            <${Toggle} checked=${autoCollect} disabled=${!connected} onChange=${(v) => setAutoCollect('autoCollect', v)} label="Auto-add" title=${connected ? `${autoTitle('videos')} (images: … menu)` : NEEDS_GROK} />
          </div>`
        : html`<div class="clips-page-auto" title=${connected ? 'Automatically add new generations to the bin while the studio is open' : NEEDS_GROK}>
            <span class="clips-page-auto-label">Auto-add</span>
            <${Toggle} checked=${autoCollect} disabled=${!connected} onChange=${(v) => setAutoCollect('autoCollect', v)} label="Videos" title=${autoTitle('videos')} />
            <${Toggle} checked=${autoImages} disabled=${!connected} onChange=${(v) => setAutoCollect('autoCollectImages', v)} label="Images" title=${autoTitle('images')} />
          </div>`}
      ${selected.length
        ? html`<${Button} size="sm" kind="primary" icon="plus" onClick=${() => addSelected()} title="Add the selected items to the bin">Add ${selected.length}<//>`
        : html`<${Button} size="sm" kind=${newVideos.length ? 'primary' : 'default'} icon="plus" disabled=${!newVideos.length} onClick=${() => addItems(newVideos, inBin)} title="Add every video on the page that isn't in the bin yet">
            ${narrow ? `All videos` : `Add all videos`}${newVideos.length ? ` (${newVideos.length})` : ''}
          <//>`}
      ${selected.length > 0 && html`<${IconButton} icon="x" size="sm" title="Clear selection" onClick=${clearSel} />`}
      <${IconButton} icon="more" size="sm" title="More: load more, rescan, auto-add…" onClick=${moreMenu} />
    </div>
    ${!collapsed && narrow && items.length > 0 && html`<div class="clips-page-filters"><${Segmented} size="sm" value=${filter} options=${PAGE_FILTERS} onChange=${setFilter} /></div>`}
    ${body && html`<div class="clips-page-body">${body}</div>`}
  </section>`;
}
