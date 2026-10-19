// Source monitor: a large player for one bin item with a custom transport (play/pause, frame step, J/K/L shuttle,
// loop), a filmstrip scrub bar with draggable IN/OUT marks (uiStore.sourceIn / sourceOut), volume, and the
// actions that send the marked range to the timeline, grab frames, or hand the last frame / prompt back to Grok.
// Previous / next follow the Clips tab's current filtered order. Keyboard shortcuts are dispatched by ClipsView
// through `apiRef` so the whole tab shares one gated hotkey map.
import { html, useEffect, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { formatDuration, formatTime, formatBytes, parseTime, clamp } from '../../core/utils.js';
import { useProject, useUI } from '../hooks.js';
import { Icon, IconButton, Button, Rating, Spinner, showMenu, toast, cx } from '../kit.js';
import { retryMedia } from '../../core/media.js';
import { neighborId, applyMark, markTime, markedRange, displayTitle, EMPTY_MARKS } from './bin-logic.js';
import { useSourcePlayer, useMediaSrc, ScrubBar, TimeReadout } from './source-player.js';
import { usePreviews, Waveform } from './media-thumb.js';
import { usePref } from './prefs.js';
import {
  setMarks,
  openInSource,
  closeSource,
  addToTimeline,
  insertAtPlayhead,
  addAsAudio,
  canBeAudio,
  grabFrameFlow,
  lastFrameToGrok,
  copyPrompt,
  sendPromptToGrok,
  revealOnGrok,
  downloadMedia,
  renameMedia,
  removeFromBin,
  toggleFlag,
  rateMedia,
  SEND_PROMPT_LABEL,
  SEND_PROMPT_HINT,
} from './actions.js';

const ORIGIN_LABEL = { grok: 'grok.com', file: 'Local file', url: 'URL', frame: 'Frame grab', export: 'Export' };

/** Small "loading / failed" overlay for the stage. */
export function StageStatus({ media }) {
  if (!media || media.status === 'ready') return null;
  if (media.status === 'error') {
    return html`<div class="src-stage-status is-error">
      <${Icon} name="alert" size=${22} />
      <div class="src-stage-status-title">Couldn't load this media</div>
      <div class="src-stage-status-msg">${media.error || 'Unknown error'}</div>
      <${Button} size="sm" icon="refresh" onClick=${() => retryMedia(media.id).then((ok) => !ok && toast('Still failing. Re-open the post on grok.com or import the file.', { kind: 'error' }))}>Retry<//>
    </div>`;
  }
  return html`<div class="src-stage-status"><${Spinner} size=${26} /><div class="src-stage-status-title">${media.status === 'pending' ? 'Queued for download…' : 'Downloading…'}</div></div>`;
}

/**
 * IN/OUT time input ("1:02.5", "62.5"…). Enter or leaving the field applies the typed time; Escape puts the mark back
 * and leaves the field without closing the monitor (the event is consumed before the tab's hotkeys see it).
 */
function MarkField({ value, onCommit, fps = 30, max = Infinity, disabled = false, title }) {
  const [text, setText] = useState(formatTime(value || 0));
  const editing = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(formatTime(value || 0));
  }, [value]);
  const commit = () => {
    const n = parseTime(text, fps);
    if (Number.isFinite(n)) onCommit?.(clamp(n, 0, max));
    setText(formatTime(Number.isFinite(n) ? clamp(n, 0, max) : value || 0));
  };
  return html`<input
    class="time-field src-mark-field"
    value=${text}
    title=${title}
    aria-label=${title}
    disabled=${disabled}
    spellcheck="false"
    onFocus=${(e) => {
      editing.current = true;
      e.currentTarget.select();
    }}
    onInput=${(e) => setText(e.currentTarget.value)}
    onBlur=${() => {
      editing.current = false;
      if (cancelled.current) {
        cancelled.current = false;
        setText(formatTime(value || 0));
      } else commit();
    }}
    onKeyDown=${(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelled.current = true;
        e.currentTarget.blur();
      }
    }}
  />`;
}

/** Picks / rejects + stars for one media item. */
export function FlagControls({ media, size = 'md' }) {
  if (!media) return null;
  return html`<div class=${cx('src-flags', `is-${size}`)}>
    <button type="button" class=${cx('src-flag-btn', 'is-pick', media.flag === 'pick' && 'is-on')} title="Pick (P)" aria-pressed=${media.flag === 'pick'} onClick=${() => toggleFlag([media.id], 'pick')}>
      <${Icon} name="flag" size=${14} /><span>Pick</span>
    </button>
    <button type="button" class=${cx('src-flag-btn', 'is-reject', media.flag === 'reject' && 'is-on')} title="Reject (X)" aria-pressed=${media.flag === 'reject'} onClick=${() => toggleFlag([media.id], 'reject')}>
      <${Icon} name="x" size=${14} /><span>Reject</span>
    </button>
    <${Rating} value=${media.rating || 0} size=${size === 'lg' ? 18 : 15} onChange=${(n) => rateMedia([media.id], n)} />
  </div>`;
}

export function SourceMonitor({ active, orderedIds, variant = 'right', onVariant = null, apiRef = null }) {
  const mediaId = useUI((s) => s.sourceMediaId);
  const marks = useUI((s) => ({ in: s.sourceIn, out: s.sourceOut }));
  const m = useProject((p) => (mediaId ? p.media[mediaId] || null : null));
  const ready = m?.status === 'ready';
  const src = useMediaSrc(mediaId, ready);
  const previews = usePreviews(mediaId, !!m && m.kind === 'video');
  const [volume, setVolume] = usePref('volume', 1);
  const [muted, setMuted] = usePref('muted', false);
  const [loop, setLoop] = usePref('loop', false);
  const [promptOpen, setPromptOpen] = useState(false);
  const player = useSourcePlayer({ media: m, src, active, marks, loop, volume, muted });
  const lastIndex = useRef(-1);

  // The item was removed (or the project switched): close.
  useEffect(() => {
    if (mediaId && !m) closeSource();
  }, [mediaId, m]);
  useEffect(() => setPromptOpen(false), [mediaId]);
  useEffect(() => () => apiRef && (apiRef.current = null), []);

  const idx = orderedIds.indexOf(mediaId);
  if (idx >= 0) lastIndex.current = idx;
  const prevId = neighborId(orderedIds, mediaId, -1, lastIndex.current);
  const nextId = neighborId(orderedIds, mediaId, 1, lastIndex.current);
  const go = (id) => id && openInSource(id, { select: true });

  const kind = m?.kind || 'video';
  const timed = kind !== 'image';
  const broken = m?.status === 'error';
  const dur = m ? m.duration || player.duration() : 0;
  const fps = m?.fps || 30;
  const range = markedRange(m, marks.in, marks.out);
  const hasMarks = marks.in != null || marks.out != null;

  const markIn = () => timed && setMarks(mediaId, applyMark(marks, 'in', markTime('in', player.getTime(), fps, dur), dur), { label: 'Mark IN' });
  const markOut = () => timed && setMarks(mediaId, applyMark(marks, 'out', markTime('out', player.getTime(), fps, dur), dur), { label: 'Mark OUT' });
  const clearMarks = () => setMarks(mediaId, EMPTY_MARKS, { label: 'Clear IN/OUT' });
  const add = () => m && addToTimeline([mediaId], { ranges: range ? { [mediaId]: range } : {} });
  const insert = () => m && insertAtPlayhead([mediaId], { ranges: range ? { [mediaId]: range } : {} });
  const asAudio = () => m && addAsAudio(mediaId, range || undefined);
  const grab = () => m && grabFrameFlow(mediaId, timed ? player.getTime() : 0);
  const lastFrame = () => m && lastFrameToGrok(mediaId, { time: timed ? Math.max(0, (marks.out ?? dur) - 0.5 / fps) : 0 });

  if (apiRef) {
    apiRef.current = {
      mediaId,
      playing: player.playing,
      toggle: () => (timed ? player.toggle() : null),
      shuttle: (k) => timed && player.shuttle(k),
      step: (d) => timed && player.step(d),
      goTo: (w) => timed && player.goTo(w),
      markIn,
      markOut,
      clearMarks,
      add,
      insert,
      grab,
      prev: () => go(prevId),
      next: () => go(nextId),
    };
  }

  if (!m) return null;

  const moreMenu = (e) =>
    showMenu(e, [
      { label: 'Copy prompt', icon: 'copy', disabled: !m.prompt, onClick: () => copyPrompt(m.prompt) },
      { label: SEND_PROMPT_LABEL, icon: 'send', disabled: !m.prompt, onClick: () => sendPromptToGrok(m.prompt) },
      { label: 'Reveal on grok.com', icon: 'target', disabled: !m.pageKey, onClick: () => revealOnGrok(m.id) },
      '-',
      { label: 'Download original', icon: 'download', disabled: !ready, onClick: () => downloadMedia([m.id]) },
      { label: 'Rename…', icon: 'edit', onClick: () => renameMedia(m.id) },
      { label: 'Remove from bin', icon: 'trash', danger: true, onClick: () => removeFromBin([m.id]) },
    ]);

  const info = [
    m.width && m.height ? `${m.width}×${m.height}` : null,
    m.fps ? `${Math.round(m.fps * 100) / 100} fps` : null,
    timed && m.duration ? formatDuration(m.duration) : null,
    m.size ? formatBytes(m.size) : null,
    ORIGIN_LABEL[m.origin] || null,
  ].filter(Boolean);

  return html`<div class=${cx('src-monitor', `is-${variant}`)} data-media-id=${m.id} aria-label="Source monitor">
    <header class="src-head">
      <${IconButton} icon="chevron-left" size="sm" title="Previous clip (←)" disabled=${!prevId} onClick=${() => go(prevId)} />
      <${IconButton} icon="chevron-right" size="sm" title="Next clip (→)" disabled=${!nextId} onClick=${() => go(nextId)} />
      <div class="src-title" title=${displayTitle(m)}>
        <span class="src-title-name">${m.name}</span>
        ${idx >= 0 && html`<span class="src-title-pos">${idx + 1} / ${orderedIds.length}</span>`}
      </div>
      ${onVariant &&
      variant !== 'sheet' &&
      html`<${IconButton}
        icon=${variant === 'right' ? 'dock-bottom' : 'dock-right'}
        size="sm"
        title=${variant === 'right' ? 'Dock the monitor below the bin' : 'Dock the monitor beside the bin'}
        onClick=${() => onVariant(variant === 'right' ? 'bottom' : 'right')}
      />`}
      <${IconButton} icon="x" size="sm" title="Close monitor (Esc)" onClick=${closeSource} />
    </header>

    <div class="src-body">
      <div class="src-player">
        <div class=${cx('src-stage', `is-${kind}`)} onClick=${() => timed && ready && player.toggle()}>
          ${kind === 'image'
            ? src && html`<img class="src-image" src=${src} alt="" draggable="false" />`
            : html`${kind === 'audio' && html`<${Waveform} mediaId=${m.id} ready=${ready} class="src-wave" color="#41d3a0" />`}
                <video class="src-video" ref=${player.videoRef} src=${src || undefined} preload="auto" playsInline ...${player.videoProps}></video>`}
          <${StageStatus} media=${m} />
          ${timed && ready && !player.playing && html`<div class="src-stage-play" aria-hidden="true"><${Icon} name="play" size=${26} /></div>`}
          ${player.rate !== 0 && player.rate !== 1 && html`<div class="src-stage-rate">${player.rate > 0 ? '▶▶' : '◀◀'} ${Math.abs(player.rate)}×</div>`}
        </div>

        ${timed &&
        html`<${ScrubBar}
          duration=${dur}
          time=${player.time}
          marks=${marks}
          strip=${previews?.strip || null}
          disabled=${!ready}
          onSeek=${(t) => player.seek(t)}
          onMarks=${(mk, phase, gesture) => setMarks(m.id, mk, { label: gesture.role === 'in' ? 'Trim IN' : 'Trim OUT', merge: gesture.key })}
        />`}

        ${timed &&
        html`<div class="src-transport">
          <${TimeReadout} time=${player.time} duration=${dur} />
          <div class="src-transport-main">
            <${IconButton} icon="skip-start" size="sm" title=${hasMarks ? 'Go to IN (Shift+I)' : 'Go to start (Home)'} disabled=${!ready} onClick=${() => player.goTo(hasMarks ? 'in' : 'start')} />
            <${IconButton} icon="chevron-left" size="sm" title="Previous frame (,)" disabled=${!ready} onClick=${() => player.step(-1)} />
            <${IconButton} icon=${player.playing ? 'pause' : 'play'} size="md" kind="solid" class="src-play" title="Play / pause (Space) · shuttle J K L" disabled=${!ready} onClick=${player.toggle} />
            <${IconButton} icon="chevron-right" size="sm" title="Next frame (.)" disabled=${!ready} onClick=${() => player.step(1)} />
            <${IconButton} icon="skip-end" size="sm" title=${hasMarks ? 'Go to OUT (Shift+O)' : 'Go to end (End)'} disabled=${!ready} onClick=${() => player.goTo(hasMarks ? 'out' : 'end')} />
            <${IconButton} icon="repeat" size="sm" title=${loop ? 'Loop on (loops the IN–OUT range)' : 'Loop off'} active=${loop} onClick=${() => setLoop(!loop)} />
          </div>
          <div class="src-volume">
            <${IconButton} icon=${muted || volume === 0 ? 'volume-x' : 'volume'} size="sm" title=${muted ? 'Unmute' : 'Mute'} onClick=${() => setMuted(!muted)} />
            <input
              type="range"
              class="src-volume-range"
              min="0"
              max="1"
              step="0.05"
              value=${muted ? 0 : volume}
              style=${`--pct:${(muted ? 0 : volume) * 100}%`}
              aria-label="Volume"
              onInput=${(e) => {
                setVolume(Number(e.currentTarget.value));
                if (muted) setMuted(false);
              }}
            />
          </div>
        </div>`}
      </div>

      <div class="src-side">
        ${timed &&
        html`<div class="src-marks">
          <div class="src-mark">
            <${Button} size="sm" icon="mark-in" class=${cx('src-mark-btn', marks.in != null && 'is-set')} title="Mark IN at the current frame (I)" disabled=${!ready} onClick=${markIn}>In<//>
            <${MarkField} value=${marks.in ?? 0} max=${dur || Infinity} fps=${fps} title="IN point" disabled=${!ready} onCommit=${(t) => setMarks(m.id, applyMark(marks, 'in', t, dur), { label: 'Set IN' })} />
          </div>
          <div class="src-mark">
            <${Button} size="sm" icon="mark-out" class=${cx('src-mark-btn', marks.out != null && 'is-set')} title="Mark OUT at the current frame (O)" disabled=${!ready} onClick=${markOut}>Out<//>
            <${MarkField} value=${marks.out ?? dur} max=${dur || Infinity} fps=${fps} title="OUT point" disabled=${!ready} onCommit=${(t) => setMarks(m.id, applyMark(marks, 'out', t, dur), { label: 'Set OUT' })} />
          </div>
          <div class="src-mark-len" title="Length of the marked range">
            <${Icon} name="scissors" size=${13} />
            <span>${range ? formatTime((range.out ?? dur) - range.in) : formatTime(dur)}</span>
            ${hasMarks && html`<${IconButton} icon="x" size="sm" title="Clear marks (Ctrl+Shift+X)" onClick=${clearMarks} />`}
          </div>
        </div>`}

        <div class="src-actions">
          <${Button}
            kind="primary"
            icon="plus"
            disabled=${broken}
            title=${broken
              ? 'This item failed to download: retry it first'
              : kind === 'audio'
                ? `Add ${range ? 'the marked range' : 'it'} to an audio track at the timeline playhead (E)`
                : `Append ${range ? 'the marked range' : 'the clip'} to the end of the timeline (E)`}
            onClick=${add}
            >Add to timeline<//
          >
          ${kind !== 'audio' && html`<${Button} icon="arrow-down" disabled=${broken} title="Insert at the timeline playhead (W)" onClick=${insert}>Insert at playhead<//>`}
          ${kind === 'video' &&
          html`<${Button}
            icon="music"
            disabled=${!canBeAudio(m)}
            title=${broken ? 'This item failed to download: retry it first' : canBeAudio(m) ? 'Use the sound as an audio clip at the timeline playhead' : 'This clip has no sound'}
            onClick=${asAudio}
            >Add as audio<//
          >`}
          ${kind !== 'audio' && html`<${Button} icon="camera" disabled=${!ready} title="Grab the current frame: add it to the bin, Ingredients, clipboard or a file" onClick=${grab}>Grab frame<//>`}
          ${kind === 'video' &&
          html`<${Button} icon="send" disabled=${!ready} class="src-lastframe" title="Attach the last frame (or the OUT frame) to the Grok composer to continue the shot" onClick=${lastFrame}>Last frame → Grok<//>`}
          <${IconButton} icon="more" title="More actions" kind="solid" onClick=${moreMenu} />
        </div>

        <div class="src-info">
          <${FlagControls} media=${m} />
          ${m.prompt
            ? html`<div class=${cx('src-prompt', promptOpen && 'is-open')}>
                <div class="src-prompt-text" title="Click to expand" onClick=${() => setPromptOpen(!promptOpen)}>${m.prompt}</div>
                <div class="src-prompt-actions">
                  <${Button} size="sm" kind="ghost" icon="copy" onClick=${() => copyPrompt(m.prompt)}>Copy prompt<//>
                  <${Button} size="sm" kind="ghost" icon="send" title=${SEND_PROMPT_HINT} onClick=${() => sendPromptToGrok(m.prompt)}>${SEND_PROMPT_LABEL}<//>
                </div>
              </div>`
            : html`<div class="src-prompt is-empty">No prompt: ${m.origin === 'grok' ? 'Grok did not expose it for this item.' : 'imported media.'}</div>`}
          ${info.length > 0 && html`<div class="src-meta">${info.join(' · ')}</div>`}
        </div>
      </div>
    </div>
  </div>`;
}
