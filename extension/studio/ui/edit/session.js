// Edit-tab session: owns the link between the Player (created by the program monitor), the timeline, the inspector
// and the keyboard shortcuts. Per-frame time goes through a tiny event bus (components update the DOM directly);
// uiStore.playhead / uiStore.playing are kept in sync (throttled while playing) for everything else.

import { uiStore, projectStore } from '../../core/store.js';
import { createEmitter, clamp } from '../../core/utils.js';
import * as M from '../../core/model.js';
import { editPoints, nextEditPoint } from './timeline-math.js';
import { toast } from '../kit.js';

const PLAYHEAD_WRITE_MS = 120;
/** A requested title focus is honoured this long (covers the inspector / drawer mounting after the request). */
const TEXT_FOCUS_TTL_MS = 2000;

/** Creates the session object shared by the Edit tab's components (one per EditView). */
export function createEditSession() {
  const bus = createEmitter();
  let player = null;
  let lastWritten = uiStore.get().playhead || 0;
  let lastWriteAt = 0;
  let writeTimer = null;
  let state = { playing: false, rate: 1, loop: null, volume: 1, muted: false };
  let textFocus = null; // {id, at}: a title whose text field should take the keyboard as soon as it is shown

  const writePlayhead = (t, immediate) => {
    clearTimeout(writeTimer);
    const commit = () => {
      lastWritten = t;
      lastWriteAt = performance.now();
      uiStore.set((s) => (s.playhead === t ? s : { ...s, playhead: t }));
    };
    if (immediate || performance.now() - lastWriteAt >= PLAYHEAD_WRITE_MS) commit();
    else writeTimer = setTimeout(commit, PLAYHEAD_WRITE_MS);
  };

  const duration = () => {
    const p = projectStore.get();
    return p ? M.sequenceDuration(p) : 0;
  };
  const hasContent = () => {
    if (duration() > 0) return true;
    toast('Nothing to play yet — add clips to the timeline first', { kind: 'info' });
    return false;
  };

  const session = {
    bus,
    /** The Player, once the monitor mounted. */
    get player() {
      return player;
    },
    get state() {
      return state;
    },
    attach(p) {
      player = p;
      const t = clamp(uiStore.get().playhead || 0, 0, Math.max(0, p.duration));
      if (t > 0) p.seek(t);
    },
    detach(p) {
      if (player === p) player = null;
    },
    /** Called by the player for every frame / seek. */
    handleTime(t) {
      bus.emit('time', t);
      writePlayhead(t, !state.playing);
    },
    handleState(s) {
      state = s;
      bus.emit('state', s);
      if (!s.playing) writePlayhead(player ? player.time : lastWritten, true);
      uiStore.set((u) => (u.playing === s.playing ? u : { ...u, playing: s.playing }));
    },
    /** True when a uiStore playhead value did not come from this session (someone else moved it). */
    isExternalPlayhead(t) {
      return Math.abs(t - lastWritten) > 1e-6;
    },
    /**
     * Asks the inspector to put the keyboard in a title's text field. The request is kept (not just emitted)
     * because the inspector may not be mounted yet — collapsed panel or closed drawer — and only mounts after this
     * event; its text panel claims the request with consumeTextFocus() when it renders.
     */
    requestTextFocus(id) {
      textFocus = id ? { id, at: performance.now() } : null;
      bus.emit('focusText', { id });
    },
    /** True (once) when a recent requestTextFocus() targeted this clip. */
    consumeTextFocus(id) {
      if (!textFocus || textFocus.id !== id) return false;
      const fresh = performance.now() - textFocus.at < TEXT_FOCUS_TTL_MS;
      textFocus = null;
      return fresh;
    },
    onTime: (fn) => bus.on('time', fn),
    onState: (fn) => bus.on('state', fn),
    /** Generic session events: 'reveal' {clipId}, 'popover' {clipId}, 'zoom' {...}. */
    on: (name, fn) => bus.on(name, fn),
    emit: (name, payload) => bus.emit(name, payload),

    time() {
      return player ? player.time : uiStore.get().playhead || 0;
    },
    duration,
    isPlaying() {
      return !!player?.playing;
    },
    fps() {
      return projectStore.get()?.settings?.fps || 30;
    },

    seek(t) {
      const target = clamp(Number(t) || 0, 0, Math.max(0, duration()));
      if (player) player.seek(target);
      else session.handleTime(target);
    },
    seekBy(dt) {
      session.seek(session.time() + dt);
    },
    /** Moves by whole frames (pauses first, snaps to the frame grid). */
    step(frames) {
      const fps = session.fps();
      if (player?.playing) player.pause();
      const cur = Math.round(session.time() * fps);
      session.seek((cur + frames) / fps);
    },
    jumpEdit(dir) {
      const p = projectStore.get();
      if (!p) return;
      const t = nextEditPoint(editPoints(p), session.time(), dir);
      if (t != null) session.seek(t);
    },
    toStart() {
      session.seek(0);
    },
    toEnd() {
      session.seek(duration());
    },
    play() {
      if (!player || !hasContent()) return;
      player.setRate(1);
      player.play();
    },
    pause() {
      player?.pause();
    },
    toggle() {
      if (!player) return;
      if (!player.playing && !hasContent()) return;
      if (player.playing && player.rate === 1) player.pause();
      else {
        player.setRate(1);
        player.play();
      }
    },
    /** J / K / L shuttle: dir -1 reverse (x1, x2, x4), 0 stop, +1 forward (x1, x2, x4). */
    shuttle(dir) {
      if (!player) return;
      if (dir !== 0 && !player.playing && !hasContent()) return;
      if (dir === 0) {
        player.pause();
        player.setRate(1);
        return;
      }
      const r = player.playing ? player.rate : 0;
      let next;
      if (dir > 0) next = r > 0 ? Math.min(4, r * 2) : 1;
      else next = r < 0 ? Math.max(-4, r * 2) : -1;
      player.setRate(next);
      if (!player.playing) player.play();
    },
    /**
     * Transport buttons: back = reverse 1×, then 2×, 4×; forward = fast forward 2×, then 4× (the play button is 1×).
     */
    shuttleButton(dir) {
      if (!player) return;
      if (!player.playing && !hasContent()) return;
      const r = player.playing ? player.rate : 0;
      const next = dir > 0 ? (r >= 2 ? Math.min(4, r * 2) : 2) : r < 0 ? Math.max(-4, r * 2) : -1;
      player.setRate(next);
      if (!player.playing) player.play();
    },
    toggleLoop() {
      if (!player) return;
      player.setLoop(player.loop ? null : { start: 0, end: Infinity });
    },
    /** Loops a specific range (e.g. the selected clips); null clears. */
    loopRange(range) {
      player?.setLoop(range);
    },
    setVolume(v) {
      player?.setVolume(v);
    },
    toggleMute() {
      if (player) player.setMuted(!player.muted);
    },
    dispose() {
      clearTimeout(writeTimer);
    },
  };
  return session;
}
