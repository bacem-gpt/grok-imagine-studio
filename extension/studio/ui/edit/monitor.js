// Program monitor: the composited sequence preview (canvas letterboxed to the project aspect ratio, rendered by the
// Player at display resolution), transport (start/end, previous/next cut, shuttle back/forward (J/L), frame step,
// play, loop), timecode, volume, fullscreen and "grab frame". On a narrow monitor (≤ 600 px, e.g. docked at 480 px)
// the cut/shuttle buttons move into a "more" menu and the volume slider into a popover.

import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { projectStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { getMediaUrl, getMediaBlob, getAudioBuffer } from '../../core/media.js';
import { formatTime } from '../../core/utils.js';
import { Player } from '../../engine/player.js';
import { useProject, useElementSize, useStore } from '../hooks.js';
import { useHotkeys, comboLabel } from '../hotkeys.js';
import { Icon, IconButton, showMenu, toast, cx } from '../kit.js';
import * as A from './actions.js';
import { VoiceOverOverlay, voiceOverMenu, voiceOverStore } from './voiceover.js';
import { MonitorOverlayHandles } from './overlay-handles.js';

/** Monitor width at or below which the transport is compacted (keep in sync with `@container mon` in edit.css). */
const COMPACT_W = 600;
/** A single click on the picture waits this long for a second one (double click = full screen, not play + pause). */
const DBLCLICK_MS = 230;

/** Preview volume slider (inline on wide monitors, inside the popover on narrow ones). */
function VolumeRange({ st, session, klass }) {
  const v = st.muted ? 0 : st.volume;
  return html`<input
    type="range"
    class=${klass}
    min="0"
    max="1"
    step="0.01"
    value=${v}
    aria-label="Preview volume"
    title=${`Preview volume ${Math.round(v * 100)}%`}
    style=${`--pct:${v * 100}%`}
    onInput=${(e) => {
      const nv = Number(e.currentTarget.value);
      if (st.muted && nv > 0) session.toggleMute();
      session.setVolume(nv);
    }}
  />`;
}

/** Small popover with the volume slider and mute (narrow monitors). Closes on outside press or Escape. */
function VolumePopover({ st, session, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.mon-vol-btn')) onClose();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const v = st.muted ? 0 : st.volume;
  return html`<div class="mon-vol-pop" ref=${ref} role="dialog" aria-label="Preview volume">
    <${IconButton} icon=${v === 0 ? 'volume-x' : 'volume'} size="sm" title=${st.muted ? 'Unmute preview' : 'Mute preview'} onClick=${() => session.toggleMute()} />
    <${VolumeRange} st=${st} session=${session} klass="mon-vol-range" />
    <span class="mon-vol-val mono">${Math.round(v * 100)}%</span>
  </div>`;
}

/**
 * @param {Object} props
 * @param {Object} props.session  edit session (creates/attaches the Player here)
 * @param {boolean} props.active
 */
export function ProgramMonitor({ session, active }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const curRef = useRef(null);
  const [stageRef, stage] = useElementSize();
  const settings = useProject((p) => p.settings);
  const duration = useProject((p) => M.sequenceDuration(p));
  const hasPicture = useProject((p) => p.tracks.video.length + p.tracks.text.length + (p.tracks.overlay || []).length > 0);
  const [st, setSt] = useState(session.state);
  const recording = useStore(voiceOverStore, (s) => s.phase !== 'idle');
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [volOpen, setVolOpen] = useState(false);
  const closeVol = useMemo(() => () => setVolOpen(false), []);
  const clickTimer = useRef(0);
  const compact = stage.width > 0 && stage.width <= COMPACT_W;
  useEffect(() => {
    if (!compact || !active) setVolOpen(false);
  }, [compact, active]);
  useEffect(() => () => clearTimeout(clickTimer.current), []);

  // Player lifecycle: one per monitor; project edits only need a redraw request.
  useEffect(() => {
    const player = new Player({
      canvas: canvasRef.current,
      getProject: () => projectStore.get(),
      onTime: (t) => session.handleTime(t),
      onState: (s) => session.handleState(s),
      onWarning: (msg) => toast(msg, { kind: 'warn', duration: 6000 }),
      media: { getMediaUrl, getMediaBlob, getAudioBuffer },
    });
    player.setActive(active);
    session.attach(player);
    const off = projectStore.subscribe(() => player.invalidate());
    return () => {
      off();
      session.detach(player);
      player.destroy();
    };
  }, [session]);

  useEffect(() => session.player?.setActive(active), [active]);
  useEffect(() => session.onState(setSt), [session]);
  useEffect(
    () =>
      session.onTime((t) => {
        if (curRef.current) curRef.current.textContent = formatTime(t);
      }),
    [session],
  );
  useLayoutEffect(() => {
    if (curRef.current) curRef.current.textContent = formatTime(session.time());
  });

  // Letterbox the canvas inside the stage; the canvas resolution follows the displayed size (capped at the output).
  const W = settings.width || 1280;
  const H = settings.height || 720;
  const aspect = W / H;
  let dispW = stage.width;
  let dispH = dispW / aspect;
  if (dispH > stage.height) {
    dispH = stage.height;
    dispW = dispH * aspect;
  }
  dispW = Math.max(0, Math.floor(dispW));
  dispH = Math.max(0, Math.floor(dispH));
  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c || !dispW || !dispH) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.min(1, (dispW * dpr) / W);
    const cw = Math.max(2, Math.round(W * scale));
    const ch = Math.max(2, Math.round(H * scale));
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
      session.player?.invalidate();
    }
  }, [dispW, dispH, W, H]);

  useEffect(() => {
    const on = () => setFullscreen(!!wrapRef.current && document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    try {
      await wrapRef.current.requestFullscreen();
    } catch {
      setExpanded(true); // fullscreen not allowed (e.g. embedded without permission): fill the studio instead
    }
  };
  useHotkeys({ f: () => toggleFullscreen() }, { enabled: active });
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded]);
  useEffect(() => {
    if (!active && expanded) setExpanded(false);
  }, [active]);

  const grabMenu = (e) =>
    showMenu(e, [
      { header: 'Grab this frame' },
      { label: 'Add to the bin', icon: 'image', onClick: () => A.grabFrame(session, 'bin') },
      { label: 'Save as ingredient', icon: 'images', onClick: () => A.grabFrame(session, 'ingredient') },
      { label: 'Download PNG', icon: 'download', onClick: () => A.grabFrame(session, 'download') },
      { label: 'Copy image', icon: 'copy', onClick: () => A.grabFrame(session, 'copy') },
    ]);

  // Narrow monitor: the transport buttons that don't fit live in this menu.
  const moreMenu = (e) =>
    showMenu(e, [
      { label: 'Previous cut', icon: 'chevrons-left', shortcut: 'arrowup', onClick: () => session.jumpEdit(-1) },
      { label: 'Next cut', icon: 'chevrons-right', shortcut: 'arrowdown', onClick: () => session.jumpEdit(1) },
      '-',
      { label: 'Play backwards', icon: 'rewind', shortcut: 'j', onClick: () => session.shuttleButton(-1) },
      { label: `Fast forward${st.playing && st.rate >= 2 ? ` (${Math.min(4, st.rate * 2)}×)` : ' (2×)'}`, icon: 'fast-forward', shortcut: 'l', onClick: () => session.shuttleButton(1) },
    ]);

  // Single click = play / pause; double click = full screen (the single click waits, so a double click doesn't
  // start and stop playback on its way).
  const onStageClick = (e) => {
    if (!hasPicture || e.detail > 1) return;
    clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => session.toggle(), DBLCLICK_MS);
  };
  const onStageDblClick = () => {
    clearTimeout(clickTimer.current);
    toggleFullscreen();
  };

  const playing = st.playing;
  const shuttle = playing && st.rate !== 1;
  const volumeIcon = st.muted || st.volume === 0 ? 'volume-x' : 'volume';
  return html`<div class=${cx('mon', expanded && 'is-expanded', fullscreen && 'is-fullscreen')} ref=${wrapRef}>
    <div class="mon-stage" ref=${stageRef} onClick=${onStageClick} onDblClick=${onStageDblClick}>
      <canvas ref=${canvasRef} class="mon-canvas" width="2" height="2" style=${`width:${dispW}px;height:${dispH}px`} aria-label="Sequence preview"></canvas>
      <${MonitorOverlayHandles} session=${session} dispW=${dispW} dispH=${dispH} active=${active} />
      ${!hasPicture &&
      html`<div class="mon-empty">
        <${Icon} name="play2" size=${28} />
        <div>Your sequence plays here</div>
        <div class="mon-empty-sub">Add clips to the timeline below</div>
      </div>`}
      ${shuttle && html`<div class="mon-rate">${st.rate > 0 ? '▶▶' : '◀◀'} ${Math.abs(st.rate)}×</div>`}
      ${st.loop && html`<div class="mon-loop-badge" title="Looping"><${Icon} name="repeat" size=${11} /> Loop</div>`}
      <${VoiceOverOverlay} session=${session} />
    </div>
    <div class="mon-transport">
      <div class="mon-time" title="Current time / sequence duration">
        <span class="mon-cur mono" ref=${curRef}>0:00.00</span>
        <span class="mon-dur mono">/ ${formatTime(duration)}</span>
      </div>
      <div class="mon-buttons">
        <${IconButton} icon="skip-start" size="sm" title="Go to start (Home)" onClick=${() => session.toStart()} />
        <${IconButton} icon="chevrons-left" size="sm" class="mon-opt" title="Previous cut (↑)" onClick=${() => session.jumpEdit(-1)} />
        <${IconButton} icon="chevron-left" size="sm" title="Back one frame (←, Shift = 1 s)" onClick=${() => session.step(-1)} />
        <${IconButton}
          icon="rewind"
          size="sm"
          class="mon-opt"
          title=${`Play backwards (${comboLabel('j')} — again for 2×, 4×)`}
          active=${playing && st.rate < 0}
          onClick=${() => session.shuttleButton(-1)}
        />
        <button type="button" class=${cx('mon-play', playing && 'is-playing')} title=${playing ? 'Pause (Space / K)' : 'Play (Space / L)'} aria-label=${playing ? 'Pause' : 'Play'} onClick=${() => session.toggle()}>
          <${Icon} name=${playing && !shuttle ? 'pause' : 'play'} size=${16} />
        </button>
        <${IconButton}
          icon="fast-forward"
          size="sm"
          class="mon-opt"
          title=${`Fast forward 2× (${comboLabel('l')} — again for 4×)`}
          active=${playing && st.rate > 1}
          onClick=${() => session.shuttleButton(1)}
        />
        <${IconButton} icon="chevron-right" size="sm" title="Forward one frame (→, Shift = 1 s)" onClick=${() => session.step(1)} />
        <${IconButton} icon="chevrons-right" size="sm" class="mon-opt" title="Next cut (↓)" onClick=${() => session.jumpEdit(1)} />
        <${IconButton} icon="skip-end" size="sm" title="Go to end (End)" onClick=${() => session.toEnd()} />
        <${IconButton} icon="more" size="sm" class="mon-more" title="More: previous / next cut, play backwards, fast forward" onClick=${moreMenu} />
      </div>
      <div class="mon-right">
        <${IconButton} icon="repeat" size="sm" title=${st.loop ? 'Looping — click to stop looping' : 'Loop playback'} active=${!!st.loop} onClick=${() => session.toggleLoop()} />
        <div class="mon-volume">
          <${IconButton}
            icon=${volumeIcon}
            size="sm"
            class="mon-vol-btn"
            title=${compact ? 'Preview volume' : st.muted ? 'Unmute preview' : 'Mute preview'}
            active=${compact && volOpen}
            onClick=${() => (compact ? setVolOpen((o) => !o) : session.toggleMute())}
          />
          <${VolumeRange} st=${st} session=${session} klass="mon-vol" />
          ${compact && volOpen && html`<${VolumePopover} st=${st} session=${session} onClose=${closeVol} />`}
        </div>
        <${IconButton}
          icon="mic"
          size="sm"
          class=${cx('mon-mic', recording && 'is-recording')}
          title=${recording ? 'Stop recording the voice-over' : 'Record a voice-over from the playhead'}
          active=${recording}
          onClick=${(e) => voiceOverMenu(e, session)}
        />
        <${IconButton} icon="camera" size="sm" title="Grab this frame (bin, ingredient, PNG…)" disabled=${!hasPicture} onClick=${grabMenu} />
        <${IconButton} icon=${fullscreen || expanded ? 'minimize' : 'maximize'} size="sm" title=${fullscreen || expanded ? 'Exit full screen (Esc)' : 'Full screen (F)'} onClick=${toggleFullscreen} />
      </div>
    </div>
  </div>`;
}
