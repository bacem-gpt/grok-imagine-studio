// Clip views for the timeline: main-track clips (filmstrip tiled by time), audio clips (waveform canvas that only
// draws the visible part, so any zoom stays crisp), text clips and transition badges. Pure presentation: every
// pointer interaction is delegated to the Timeline through the `on*` props.

import { html, useEffect, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { getPeaks, PEAKS_PER_SECOND, onMediaEvent } from '../../core/media.js';
import { filtersAreNeutral } from '../../core/model.js';
import { formatDuration } from '../../core/utils.js';
import { useMediaPreview } from '../hooks.js';
import { Icon, cx } from '../kit.js';
import { filmstripTiles } from './timeline-math.js';
import { transitionName, TransitionSwatch } from './transition-popover.js';

const clipName = (clip, media) => clip.label || media?.name || (media ? 'Untitled' : 'Missing media');
/** Narrower main-track clips show the "Media offline" state as the alert icon alone (the clip's title explains it). */
const OFFLINE_LABEL_MIN_W = 90;

function Filmstrip({ mediaId, media, clip, widthPx, height, zoom }) {
  const previews = useMediaPreview(mediaId);
  if (!media) return html`<div class="tl-strip tl-strip-missing"></div>`;
  if (media.status === 'error') {
    return html`<div class="tl-strip tl-strip-error"><${Icon} name="alert" size=${14} />${widthPx >= OFFLINE_LABEL_MIN_W && html`<span>Media offline</span>`}</div>`;
  }
  if (!previews || (!previews.strip && !previews.thumb)) return html`<div class="tl-strip tl-strip-loading"></div>`;
  if (media.kind === 'image' || !previews.strip) {
    return html`<div class="tl-strip" style=${`background-image:url("${previews.thumb}");background-size:auto 100%;background-repeat:repeat-x`}></div>`;
  }
  const tileW = Math.max(24, Math.round((height * 128) / 72));
  // A reversed clip runs from its out-point backwards; a freeze frame repeats one frame.
  const from = clip.freeze ? clip.freezeAt || 0 : clip.reverse ? clip.out : clip.in;
  const rate = clip.freeze ? 1e-9 : (clip.speed || 1) * (clip.reverse ? -1 : 1);
  const tiles = filmstripTiles({ widthPx, tileW, zoom, clipIn: from, speed: rate, mediaDuration: media.duration, stripCount: previews.stripCount });
  const bg = `background-image:url("${previews.strip}");background-size:${previews.stripCount * tileW}px ${height}px`;
  return html`<div class="tl-strip">
    ${tiles.map((tile) => html`<div class="tl-tile" key=${tile.x} style=${`${bg};left:${tile.x}px;width:${tileW}px;background-position:${-tile.index * tileW}px 0`}></div>`)}
  </div>`;
}

function FadeShapes({ fadeIn, fadeOut, zoom, widthPx }) {
  const fi = Math.min(widthPx, Math.max(0, fadeIn * zoom));
  const fo = Math.min(widthPx, Math.max(0, fadeOut * zoom));
  return html`${fi > 0.5 && html`<div class="tl-fade tl-fade-in" style=${`width:${fi}px`}></div>`}${fo > 0.5 && html`<div class="tl-fade tl-fade-out" style=${`width:${fo}px`}></div>`}`;
}

function FadeHandles({ fadeIn, fadeOut, zoom, widthPx, onFadeDown }) {
  if (widthPx < 46) return null;
  const fi = Math.min(widthPx - 8, Math.max(0, fadeIn * zoom));
  const fo = Math.min(widthPx - 8, Math.max(0, fadeOut * zoom));
  return html`<div class="tl-fadeh tl-fadeh-in" style=${`left:${fi}px`} title="Drag to fade in" onPointerDown=${(e) => onFadeDown(e, 'fadeIn')}></div>
    <div class="tl-fadeh tl-fadeh-out" style=${`right:${fo}px`} title="Drag to fade out" onPointerDown=${(e) => onFadeDown(e, 'fadeOut')}></div>`;
}

/** Main-track clip. `shift` = temporary visual x offset (px) used while ripple-trimming. */
export function VideoClipView({ item, media, zoom, top, height, selected, shift = 0, dragging = false, onPointerDown, onContextMenu, onTrimDown, onFadeDown, onDblClick }) {
  const clip = item.clip;
  const left = item.start * zoom + shift;
  const widthPx = Math.max(3, item.duration * zoom);
  const isImage = media?.kind === 'image';
  const name = clipName(clip, media);
  const offline = media?.status === 'error';
  const badges = [];
  if (Math.abs((clip.speed || 1) - 1) > 1e-3) badges.push(html`<span class="tl-badge" title="Speed">${+(clip.speed || 1).toFixed(2)}×</span>`);
  if (!filtersAreNeutral(clip.filters)) badges.push(html`<span class="tl-badge tl-badge-icon" title="Color filter"><${Icon} name="palette" size=${11} /></span>`);
  if (clip.kenBurns && !isImage) badges.push(html`<span class="tl-badge tl-badge-icon" title="Ken Burns motion"><${Icon} name="zoom-in" size=${11} /></span>`);
  if (clip.reverse) badges.push(html`<span class="tl-badge tl-badge-icon" title="Reversed"><${Icon} name="rewind" size=${11} /></span>`);
  if (clip.freeze) badges.push(html`<span class="tl-badge tl-badge-icon" title="Freeze frame"><${Icon} name="snowflake" size=${11} /></span>`);
  if (clip.crop || clip.rotate || clip.flipH || clip.flipV) badges.push(html`<span class="tl-badge tl-badge-icon" title="Cropped / rotated"><${Icon} name="crop" size=${11} /></span>`);
  if (clip.muted && media?.kind === 'video') badges.push(html`<span class="tl-badge tl-badge-icon" title="Muted"><${Icon} name="volume-x" size=${11} /></span>`);
  return html`<div
    class=${cx('tl-clip', 'tl-clip-video', isImage && 'is-image', selected && 'is-selected', dragging && 'is-dragging', offline && 'is-error', widthPx < 30 && 'is-tiny')}
    style=${`left:${left}px;width:${widthPx}px;top:${top}px;height:${height}px`}
    data-clip-id=${clip.id}
    data-track="video"
    title=${`${name} · ${formatDuration(item.duration)}${offline ? ' · Media offline — retry it in the bin' : ''}`}
    onPointerDown=${onPointerDown}
    onContextMenu=${onContextMenu}
    onDblClick=${onDblClick}
  >
    <${Filmstrip} mediaId=${clip.mediaId} media=${media} clip=${clip} widthPx=${widthPx} height=${height - 2} zoom=${zoom} />
    <${FadeShapes} fadeIn=${clip.fadeIn} fadeOut=${clip.fadeOut} zoom=${zoom} widthPx=${widthPx} />
    ${widthPx > 30 &&
    html`<div class="tl-clip-top">
      ${isImage && html`<${Icon} name="image" size=${11} />`}
      <span class="tl-clip-name">${name}</span>
      ${widthPx > 90 && badges}
      ${widthPx > 120 && html`<span class="tl-clip-dur">${formatDuration(item.duration)}</span>`}
    </div>`}
    ${selected && html`<${FadeHandles} fadeIn=${clip.fadeIn} fadeOut=${clip.fadeOut} zoom=${zoom} widthPx=${widthPx} onFadeDown=${onFadeDown} />`}
    <div class="tl-trim tl-trim-in" title="Drag to trim the start" onPointerDown=${(e) => onTrimDown(e, 'in')}></div>
    <div class="tl-trim tl-trim-out" title="Drag to trim the end" onPointerDown=${(e) => onTrimDown(e, 'out')}></div>
  </div>`;
}

/** Waveform canvas for an audio clip; draws only the part of the clip inside the viewport. */
function Waveform({ mediaId, srcIn, srcOut, leftPx, widthPx, zoom, height, viewport }) {
  const ref = useRef(null);
  const [peaks, setPeaks] = useState(null);
  useEffect(() => {
    if (!mediaId) return undefined;
    let alive = true;
    const load = () => getPeaks(mediaId).then((p) => alive && setPeaks(p || null));
    load();
    const off = onMediaEvent((e) => e.id === mediaId && e.type === 'ready' && load());
    return () => {
      alive = false;
      off();
    };
  }, [mediaId]);
  useEffect(() => {
    const draw = () => {
      const c = ref.current;
      if (!c) return;
      const vp = viewport.get();
      const visW = Math.max(1, Math.min(widthPx, vp.width + 4));
      const off = Math.max(0, Math.min(vp.left - leftPx, widthPx - visW));
      c.style.transform = `translateX(${off}px)`;
      c.style.width = `${visW}px`;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.max(1, Math.round(visW * dpr));
      const H = Math.max(1, Math.round(height * dpr));
      if (c.width !== W) c.width = W;
      if (c.height !== H) c.height = H;
      const g = c.getContext('2d');
      g.clearRect(0, 0, W, H);
      if (!peaks || !peaks.length) return;
      const buckets = peaks.length / 2;
      const mid = H / 2;
      const amp = H * 0.47;
      const perPx = 1 / (dpr * zoom); // source seconds per device pixel
      g.fillStyle = 'rgba(200, 255, 228, 0.82)';
      for (let x = 0; x < W; x++) {
        const t0 = srcIn + off / zoom + x * perPx;
        if (t0 >= srcOut) break;
        const b0 = Math.floor(t0 * PEAKS_PER_SECOND);
        if (b0 >= buckets) break;
        const b1 = Math.max(b0 + 1, Math.ceil((t0 + perPx) * PEAKS_PER_SECOND));
        let mn = 0;
        let mx = 0;
        for (let b = b0; b < b1 && b < buckets; b++) {
          if (peaks[b * 2] < mn) mn = peaks[b * 2];
          if (peaks[b * 2 + 1] > mx) mx = peaks[b * 2 + 1];
        }
        const y0 = mid - mx * amp;
        const y1 = mid - mn * amp;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    };
    draw();
    return viewport.subscribe(draw);
  }, [peaks, srcIn, srcOut, leftPx, widthPx, zoom, height, viewport]);
  return html`<canvas class="tl-wave" ref=${ref} aria-hidden="true"></canvas>`;
}

export function AudioClipView({ item, media, zoom, top, height, selected, viewport, onPointerDown, onContextMenu, onTrimDown, onFadeDown, onDblClick }) {
  const clip = item.clip;
  const left = item.start * zoom;
  const widthPx = Math.max(3, item.duration * zoom);
  const name = clipName(clip, media);
  const fromVideo = media?.kind === 'video';
  return html`<div
    class=${cx('tl-clip', 'tl-clip-audio', fromVideo && 'is-from-video', selected && 'is-selected', media?.status === 'error' && 'is-error', widthPx < 30 && 'is-tiny')}
    style=${`left:${left}px;width:${widthPx}px;top:${top}px;height:${height}px`}
    data-clip-id=${clip.id}
    data-track="audio"
    title=${`${name} · ${formatDuration(item.duration)}${clip.volume !== 1 ? ` · ${Math.round((clip.volume ?? 1) * 100)}%` : ''}`}
    onPointerDown=${onPointerDown}
    onContextMenu=${onContextMenu}
    onDblClick=${onDblClick}
  >
    <${Waveform} mediaId=${media && media.status === 'ready' ? clip.mediaId : null} srcIn=${clip.in} srcOut=${clip.out} leftPx=${left} widthPx=${widthPx} zoom=${zoom} height=${height - 2} viewport=${viewport} />
    <${FadeShapes} fadeIn=${clip.fadeIn} fadeOut=${clip.fadeOut} zoom=${zoom} widthPx=${widthPx} />
    ${widthPx > 30 &&
    html`<div class="tl-clip-top">
      <${Icon} name=${fromVideo ? 'film' : 'music'} size=${11} />
      <span class="tl-clip-name">${name}</span>
      ${widthPx > 110 && (clip.volume ?? 1) !== 1 && html`<span class="tl-badge">${Math.round((clip.volume ?? 1) * 100)}%</span>`}
    </div>`}
    ${media && media.status !== 'ready' && media.status !== 'error' && html`<span class="tl-clip-status">Loading…</span>`}
    ${selected && html`<${FadeHandles} fadeIn=${clip.fadeIn} fadeOut=${clip.fadeOut} zoom=${zoom} widthPx=${widthPx} onFadeDown=${onFadeDown} />`}
    <div class="tl-trim tl-trim-in" title="Drag to trim" onPointerDown=${(e) => onTrimDown(e, 'in')}></div>
    <div class="tl-trim tl-trim-out" title="Drag to trim" onPointerDown=${(e) => onTrimDown(e, 'out')}></div>
  </div>`;
}

export function TextClipView({ item, zoom, top, height, selected, onPointerDown, onContextMenu, onTrimDown, onDblClick }) {
  const clip = item.clip;
  const left = item.start * zoom;
  const widthPx = Math.max(3, item.duration * zoom);
  const text = String(clip.text || '').replace(/\s+/g, ' ').trim() || 'Empty title';
  return html`<div
    class=${cx('tl-clip', 'tl-clip-text', selected && 'is-selected', widthPx < 30 && 'is-tiny')}
    style=${`left:${left}px;width:${widthPx}px;top:${top}px;height:${height}px`}
    data-clip-id=${clip.id}
    data-track="text"
    title=${`${text} · ${formatDuration(item.duration)}`}
    onPointerDown=${onPointerDown}
    onContextMenu=${onContextMenu}
    onDblClick=${onDblClick}
  >
    ${widthPx > 18 && html`<${Icon} name="type" size=${11} />`}
    ${widthPx > 34 && html`<span class="tl-clip-name">${text}</span>`}
    <div class="tl-trim tl-trim-in" title="Drag to change the start" onPointerDown=${(e) => onTrimDown(e, 'in')}></div>
    <div class="tl-trim tl-trim-out" title="Drag to change the duration" onPointerDown=${(e) => onTrimDown(e, 'out')}></div>
  </div>`;
}

/** Junction badge between main-track clips (`item` = the clip the transition leads into). */
export function TransitionBadge({ item, zoom, top, height, shift = 0, active, onOpen }) {
  const tr = item.transIn;
  // Bottom-aligned so the clip edges above stay free for trim handles.
  const size = Math.min(18, height - 12);
  const y = top + height - size - 5;
  if (tr) {
    const w = Math.max(size, tr.duration * zoom);
    const x = (tr.start + tr.duration / 2) * zoom + shift - w / 2;
    return html`<button
      type="button"
      class=${cx('tl-trbadge', 'has-transition', active && 'is-active')}
      data-tr-for=${item.clip.id}
      style=${`left:${x}px;width:${w}px;top:${y}px;height:${size}px`}
      title=${`${transitionName(tr.type)} · ${tr.duration.toFixed(2)}s — click to change`}
      onPointerDown=${(e) => e.stopPropagation()}
      onClick=${(e) => onOpen(e, item.clip.id)}
    >
      <${TransitionSwatch} type=${tr.type} size="sm" />
      ${w > 84 && html`<span>${transitionName(tr.type)}</span>`}
    </button>`;
  }
  const x = item.start * zoom + shift - size / 2;
  return html`<button
    type="button"
    class=${cx('tl-trbadge', active && 'is-active')}
    data-tr-for=${item.clip.id}
    style=${`left:${x}px;width:${size}px;top:${y}px;height:${size}px`}
    title="Add a transition"
    aria-label="Add a transition"
    onPointerDown=${(e) => e.stopPropagation()}
    onClick=${(e) => onOpen(e, item.clip.id)}
  >
    <${Icon} name="plus" size=${11} />
  </button>`;
}

const OVERLAY_MODE_BADGE = { pip: ['pip', 'Picture in picture'], cutaway: ['film', 'Cutaway'], split: ['split-v', 'Side by side'], greenscreen: ['layers', 'Green/blue screen'] };

/** Overlay-track clip (V2…): filmstrip like the main track, free-positioned, with its overlay mode as a badge. */
export function OverlayClipView({ item, media, zoom, top, height, selected, onPointerDown, onContextMenu, onTrimDown, onFadeDown, onDblClick }) {
  const clip = item.clip;
  const left = item.start * zoom;
  const widthPx = Math.max(3, item.duration * zoom);
  const name = clipName(clip, media);
  const offline = media?.status === 'error';
  const [modeIcon, modeName] = OVERLAY_MODE_BADGE[clip.mode] || OVERLAY_MODE_BADGE.pip;
  const badges = [];
  if (Math.abs((clip.speed || 1) - 1) > 1e-3) badges.push(html`<span class="tl-badge" title="Speed">${+(clip.speed || 1).toFixed(2)}×</span>`);
  if (!filtersAreNeutral(clip.filters)) badges.push(html`<span class="tl-badge tl-badge-icon" title="Color filter"><${Icon} name="palette" size=${11} /></span>`);
  if (clip.muted && media?.kind === 'video') badges.push(html`<span class="tl-badge tl-badge-icon" title="Muted"><${Icon} name="volume-x" size=${11} /></span>`);
  return html`<div
    class=${cx('tl-clip', 'tl-clip-overlay', media?.kind === 'image' && 'is-image', selected && 'is-selected', offline && 'is-error', widthPx < 30 && 'is-tiny')}
    style=${`left:${left}px;width:${widthPx}px;top:${top}px;height:${height}px`}
    data-clip-id=${clip.id}
    data-track="overlay"
    data-mode=${clip.mode || 'pip'}
    title=${`${name} · ${modeName} · ${formatDuration(item.duration)}${offline ? ' · Media offline — retry it in the bin' : ''}`}
    onPointerDown=${onPointerDown}
    onContextMenu=${onContextMenu}
    onDblClick=${onDblClick}
  >
    <${Filmstrip} mediaId=${clip.mediaId} media=${media} clip=${clip} widthPx=${widthPx} height=${height - 2} zoom=${zoom} />
    <${FadeShapes} fadeIn=${clip.fadeIn} fadeOut=${clip.fadeOut} zoom=${zoom} widthPx=${widthPx} />
    ${widthPx > 24 &&
    html`<div class="tl-clip-top">
      <span class="tl-ov-mode" title=${modeName}><${Icon} name=${modeIcon} size=${11} /></span>
      ${widthPx > 44 && html`<span class="tl-clip-name">${name}</span>`}
      ${widthPx > 100 && badges}
      ${widthPx > 140 && html`<span class="tl-clip-dur">${formatDuration(item.duration)}</span>`}
    </div>`}
    ${selected && html`<${FadeHandles} fadeIn=${clip.fadeIn} fadeOut=${clip.fadeOut} zoom=${zoom} widthPx=${widthPx} onFadeDown=${onFadeDown} />`}
    <div class="tl-trim tl-trim-in" title="Drag to trim the start" onPointerDown=${(e) => onTrimDown(e, 'in')}></div>
    <div class="tl-trim tl-trim-out" title="Drag to trim the end" onPointerDown=${(e) => onTrimDown(e, 'out')}></div>
  </div>`;
}
