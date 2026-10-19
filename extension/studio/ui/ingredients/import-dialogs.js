// Import dialogs for the Ingredients tab: images detected on grok.com, and bin media (an image, or a frame of a video
// at a chosen time).
import { html, useState, useEffect, useRef, useMemo } from '../../../vendor/preact-htm.mjs';
import { pageStore } from '../../core/store.js';
import { bridge } from '../../core/bridge.js';
import { REQ } from '../../../shared/protocol.js';
import { formatTime, formatDuration, pluralize } from '../../core/utils.js';
import { usePage, useProject, useLibrary, useMediaPreview, useMediaUrl } from '../hooks.js';
import { Icon, Button, IconButton, Modal, EmptyState, Slider, TimeField, Spinner, Badge, Segmented, toast, cx } from '../kit.js';
import { importPageItems, importFromBin, asImageItem } from './actions.js';

// ---------------------------------------------------------------------------------------------------------
// grok.com images
// ---------------------------------------------------------------------------------------------------------

function PageImage({ item, selected, known, onToggle }) {
  const [failed, setFailed] = useState(false);
  const isVideo = item.kind === 'video';
  return html`<button
    type="button"
    class=${cx('ing-pick-card', selected && 'is-selected')}
    aria-pressed=${selected ? 'true' : 'false'}
    title=${item.prompt || item.url}
    onClick=${onToggle}
  >
    <span class="ing-pick-media">
      ${failed
        ? html`<span class="ing-thumb-ph"><${Icon} name="image" size=${18} /></span>`
        : html`<img src=${item.thumbUrl || item.url} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${() => setFailed(true)} />`}
      <span class="ing-pick-check"><${Icon} name="check" size=${12} /></span>
      ${known ? html`<span class="ing-pick-known"><${Badge} kind="ok">In library<//></span>` : isVideo && html`<span class="ing-bin-kind"><${Icon} name="film" size=${11} />Poster</span>`}
    </span>
    <span class="ing-pick-name">${item.prompt || (isVideo ? 'Grok video' : 'Grok image')}</span>
  </button>`;
}

/** Lists images detected on grok.com; selected ones are downloaded into the library. */
export function PageImportDialog({ onClose }) {
  const { connected, items } = usePage((s) => ({ connected: s.connected, items: s.items }));
  const library = useLibrary((l) => l.ingredients);
  const known = useMemo(() => new Set(library.map((i) => i.sourceUrl).filter(Boolean)), [library]);
  const byNewest = (a, b) => (b.seenAt || 0) - (a.seenAt || 0);
  const stills = useMemo(() => items.filter((i) => i.kind === 'image').sort(byNewest), [items]);
  const posters = useMemo(() => items.filter((i) => i.kind === 'video' && i.thumbUrl).sort(byNewest), [items]);
  const [source, setSource] = useState(() => (stills.length || !posters.length ? 'images' : 'posters'));
  const images = source === 'posters' ? posters : stills;
  const [sel, setSel] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const toggle = (key) => setSel((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  const rescan = async () => {
    setScanning(true);
    try {
      const res = await bridge.request(REQ.PAGE_SCAN);
      if (res?.items) pageStore.set((s) => ({ ...s, items: res.items }));
    } catch (e) {
      toast(`Could not scan grok.com: ${e.message || e}`, { kind: 'error' });
    } finally {
      setScanning(false);
    }
  };

  const add = async () => {
    const chosen = [...stills, ...posters].filter((i) => sel.includes(i.key));
    if (!chosen.length) return;
    setAdding(true);
    try {
      const ids = await importPageItems(chosen);
      if (ids.length) onClose();
    } finally {
      setAdding(false);
    }
  };

  const allOn = images.length > 0 && images.every((i) => sel.includes(i.key));
  const footer = stills.length || posters.length
    ? html`
        <button type="button" class="ing-link-btn" disabled=${!images.length} onClick=${() => setSel((s) => (allOn ? s.filter((k) => !images.some((i) => i.key === k)) : [...new Set([...s, ...images.map((i) => i.key)])]))}>${allOn ? 'Select none' : 'Select all'}</button>
        <span class="spacer"></span>
        <${Button} kind="ghost" onClick=${onClose}>Cancel<//>
        <${Button} kind="primary" icon="plus" disabled=${!sel.length || adding} onClick=${add}>${adding ? 'Adding…' : sel.length ? `Add ${pluralize(sel.length, 'image')}` : 'Add'}<//>
      `
    : null;

  return html`<${Modal} title="Images on grok.com" width=${760} class="ing-dialog" onClose=${onClose} footer=${footer}>
    ${!connected
      ? html`<${EmptyState} icon="link" title="Not connected to grok.com" compact=${true}
          action=${html`<${Button} kind="primary" icon="external" onClick=${() => window.open('https://grok.com/imagine', '_blank', 'noopener')}>Open grok.com<//>`}>
          Open Grok Imagine in a tab (or use the studio docked on grok.com). Images you generate there show up here.
        <//>`
      : !stills.length && !posters.length
        ? html`<${EmptyState} icon="images" title="No images detected yet" compact=${true}
            action=${html`<${Button} icon="refresh" disabled=${scanning} onClick=${rescan}>${scanning ? 'Scanning…' : 'Scan again'}<//>`}>
            Generate or open images in Grok Imagine and they appear here. For any frame of a video, add the clip to the bin, then use “From bin”.
          <//>`
        : html`<div class="ing-dialog-head">
              <${Segmented}
                size="sm"
                value=${source}
                onChange=${setSource}
                options=${[
                  { value: 'images', label: `Images (${stills.length})`, title: 'Generated images on the page' },
                  { value: 'posters', label: `Video posters (${posters.length})`, title: 'The poster frame of each generated video' },
                ]}
              />
              <span class="spacer"></span>
              <span class="muted small ing-dialog-hint">${sel.length ? `${sel.length} selected` : 'Click to select'}</span>
              <${IconButton} icon="refresh" size="sm" title="Scan the page again" disabled=${scanning} onClick=${rescan} />
            </div>
            ${!images.length
              ? html`<${EmptyState} icon=${source === 'posters' ? 'film' : 'images'} title=${source === 'posters' ? 'No videos on this page' : 'No images on this page'} compact=${true}>
                  ${source === 'posters' ? 'Generated videos show up here with their poster frame.' : 'Switch to video posters, or generate images in Grok Imagine.'}
                <//>`
              : html`<div class="ing-pick-grid">
                  ${images.map((it) => html`<${PageImage} key=${it.key} item=${it} selected=${sel.includes(it.key)} known=${known.has(asImageItem(it)?.url)} onToggle=${() => toggle(it.key)} />`)}
                </div>`}`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------------------
// Bin: images and video frames
// ---------------------------------------------------------------------------------------------------------

function BinItem({ media, selected, onSelect }) {
  const prev = useMediaPreview(media.id);
  return html`<button type="button" class=${cx('ing-pick-card', 'ing-bin-card', selected && 'is-selected')} aria-pressed=${selected ? 'true' : 'false'} title=${media.name} onClick=${onSelect}>
    <span class="ing-pick-media">
      ${prev?.thumb ? html`<img src=${prev.thumb} alt="" />` : html`<span class="ing-thumb-ph"><${Icon} name=${media.kind === 'video' ? 'film' : 'image'} size=${18} /></span>`}
      <span class="ing-bin-kind">${media.kind === 'video' ? html`<${Icon} name="film" size=${11} />${formatDuration(media.duration)}` : html`<${Icon} name="image" size=${11} />`}</span>
    </span>
    <span class="ing-pick-name">${media.name}</span>
  </button>`;
}

function FrameGrabber({ media, onAdded }) {
  const url = useMediaUrl(media.id);
  const videoRef = useRef(null);
  const [time, setTime] = useState(0);
  const [adding, setAdding] = useState(false);
  const dur = Math.max(0, media.duration || 0);
  const step = 1 / (media.fps || 30);
  const last = Math.max(0, dur - step);
  useEffect(() => setTime(0), [media.id]);
  useEffect(() => {
    const v = videoRef.current;
    if (v && Number.isFinite(time) && Math.abs(v.currentTime - time) > 1e-3) {
      try {
        v.currentTime = time;
      } catch {
        /* not seekable yet */
      }
    }
  }, [time, url]);
  const seek = (t) => setTime(Math.max(0, Math.min(last, t)));
  const add = async () => {
    setAdding(true);
    try {
      const id = await importFromBin(media.id, time, { reveal: true });
      if (id) onAdded?.(id);
    } finally {
      setAdding(false);
    }
  };
  return html`<div class="ing-grab">
    <div class="ing-grab-view checker">
      ${url ? html`<video ref=${videoRef} src=${url} muted playsinline preload="auto" onLoadedMetadata=${() => videoRef.current && (videoRef.current.currentTime = time)}></video>` : html`<${Spinner} size=${20} />`}
    </div>
    <${Slider} label="Frame time" value=${time} min=${0} max=${last || 0.001} step=${step} format=${(v) => formatTime(v)} onChange=${seek} />
    <div class="ing-grab-row">
      <${IconButton} icon="skip-start" size="sm" title="First frame" onClick=${() => seek(0)} />
      <${IconButton} icon="chevron-left" size="sm" title="Previous frame" onClick=${() => seek(time - step)} />
      <${TimeField} value=${time} fps=${media.fps || 30} max=${last} onChange=${seek} title="Frame time" />
      <${IconButton} icon="chevron-right" size="sm" title="Next frame" onClick=${() => seek(time + step)} />
      <${IconButton} icon="skip-end" size="sm" title="Last frame" onClick=${() => seek(last)} />
      <span class="spacer"></span>
      <${Button} size="sm" kind="ghost" onClick=${() => seek(dur / 2)}>Middle<//>
    </div>
    <${Button} kind="primary" icon="camera" disabled=${adding || !url} onClick=${add} data-testid="grab-frame">${adding ? 'Adding…' : `Add frame at ${formatTime(time)}`}<//>
  </div>`;
}

function ImageAdder({ media, onAdded }) {
  const url = useMediaUrl(media.id);
  const [adding, setAdding] = useState(false);
  const add = async () => {
    setAdding(true);
    try {
      const id = await importFromBin(media.id, 0, { reveal: true });
      if (id) onAdded?.(id);
    } finally {
      setAdding(false);
    }
  };
  return html`<div class="ing-grab">
    <div class="ing-grab-view checker">${url ? html`<img src=${url} alt="" />` : html`<${Spinner} size=${20} />`}</div>
    <div class="muted small">${media.width} × ${media.height} px</div>
    <${Button} kind="primary" icon="plus" disabled=${adding} onClick=${add}>${adding ? 'Adding…' : 'Add image to Ingredients'}<//>
  </div>`;
}

/** Picks a bin image, or grabs a frame of a bin video at a chosen time. Stays open to add several. */
export function BinImportDialog({ onClose, initialMediaId = null }) {
  const media = useProject((p) => p.mediaOrder.map((id) => p.media[id]).filter((m) => m && (m.kind === 'image' || m.kind === 'video') && m.status === 'ready'));
  const [selId, setSelId] = useState(initialMediaId);
  const [added, setAdded] = useState(0);
  const selected = media.find((m) => m.id === selId) || media[0] || null;
  const footer = html`
    <span class="muted small">${added ? `${pluralize(added, 'image')} added` : 'Pick a still or a video frame'}</span>
    <span class="spacer"></span>
    <${Button} kind=${added ? 'primary' : 'ghost'} onClick=${onClose}>Done<//>
  `;
  return html`<${Modal} title="Add from the bin" width=${860} class="ing-dialog" onClose=${onClose} footer=${footer}>
    ${!media.length
      ? html`<${EmptyState} icon="film" title="Your bin has no images or videos yet" compact=${true}>
          Collect Grok clips in the Clips tab (or import files there). Then come back to grab stills from them.
        <//>`
      : html`<div class="ing-bin-layout">
          <div class="ing-pick-grid ing-bin-grid">
            ${media.map((m) => html`<${BinItem} key=${m.id} media=${m} selected=${selected?.id === m.id} onSelect=${() => setSelId(m.id)} />`)}
          </div>
          <div class="ing-bin-side">
            ${selected &&
            (selected.kind === 'video'
              ? html`<${FrameGrabber} key=${selected.id} media=${selected} onAdded=${() => setAdded((n) => n + 1)} />`
              : html`<${ImageAdder} key=${selected.id} media=${selected} onAdded=${() => setAdded((n) => n + 1)} />`)}
          </div>
        </div>`}
  <//>`;
}
