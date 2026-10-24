// Playback machinery shared by the source monitor and review mode:
//   useSourcePlayer()  <video> controller: play/pause, frame stepping, J/K/L shuttle (reverse = rAF-driven seeks),
//                      looping over the marked range, volume; pauses while the view is inactive.
//   ScrubBar           filmstrip scrub bar with the IN/OUT range and draggable handles; the playhead follows the
//                      player's time signal without re-rendering the panel.
//   TimeReadout, useMediaSrc, createSignal / useSignalValue (high-frequency values without full re-renders).
import { html, useState, useEffect, useRef, useMemo } from '../../../vendor/preact-htm.mjs';
import { trackPointer } from '../pointer.js';
import { getMediaUrl, peekMediaUrl } from '../../core/media.js';
import { clamp, formatTime } from '../../core/utils.js';
import { cx } from '../kit.js';
import { shuttleRate, frameStepTime, dragMark, markBounds, EMPTY_MARKS } from './bin-logic.js';

/** Tiny observable value. */
export function createSignal(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const fn of [...subs]) fn(value);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Re-renders the calling component whenever the signal changes. */
export function useSignalValue(signal) {
  const [, force] = useState(0);
  useEffect(() => signal.subscribe(() => force((x) => x + 1)), [signal]);
  return signal.get();
}

/** Object URL of a ready media item's binary; never returns another item's URL while switching. */
export function useMediaSrc(mediaId, ready) {
  const [state, setState] = useState({ id: null, url: null });
  useEffect(() => {
    if (!mediaId || !ready) return undefined;
    let alive = true;
    getMediaUrl(mediaId).then(
      (url) => alive && setState({ id: mediaId, url }),
      () => alive && setState({ id: mediaId, url: null }),
    );
    return () => {
      alive = false;
    };
  }, [mediaId, ready]);
  if (!ready) return null;
  return state.id === mediaId ? state.url : peekMediaUrl(mediaId);
}

/**
 * Controller for the <video> that shows one media item (videos and audio files; images have no transport).
 * Returns {videoRef, videoProps, time (signal), playing, rate, duration(), getTime(), seek, play, pause, toggle,
 * shuttle(key), step(dir), jump(seconds), goTo('start'|'end'|'in'|'out')}.
 */
export function useSourcePlayer({ media, src, active = true, marks = EMPTY_MARKS, loop = false, autoplay = false, volume = 1, muted = false }) {
  const videoRef = useRef(null);
  const time = useMemo(() => createSignal(0), []);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(0);
  const st = useRef({ raf: 0, rate: 0, lastTs: 0, revTarget: 0 }).current;
  const opts = useRef(null);
  opts.current = { media, marks, loop, autoplay, volume, muted };

  const duration = () => {
    const d = opts.current.media?.duration;
    if (d > 0) return d;
    const v = videoRef.current;
    return v && Number.isFinite(v.duration) ? v.duration : 0;
  };
  const bounds = () => {
    const d = duration();
    const b = markBounds(opts.current.marks, d);
    return { start: b.start, end: b.active ? b.end : d, active: b.active };
  };
  const setRate = (r) => {
    st.rate = r;
    setRateState(r);
  };

  const stopLoop = () => {
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = 0;
  };
  const tick = (ts) => {
    st.raf = 0;
    const v = videoRef.current;
    if (!v) return;
    if (st.rate < 0) {
      // Reverse shuttle: browsers can't play backwards, so walk a target time back and seek when idle.
      const dt = st.lastTs ? Math.min(0.1, (ts - st.lastTs) / 1000) : 0;
      st.lastTs = ts;
      const { start, end } = bounds();
      const floor = opts.current.loop ? start : 0;
      st.revTarget += st.rate * dt;
      if (st.revTarget <= floor) {
        if (opts.current.loop && end > start) st.revTarget = end - 0.001;
        else {
          st.revTarget = floor;
          v.currentTime = floor;
          time.set(floor);
          setRate(0);
          setPlaying(false);
          return;
        }
      }
      if (!v.seeking) v.currentTime = st.revTarget;
      time.set(st.revTarget);
    } else {
      time.set(v.currentTime);
      if (opts.current.loop && !v.paused) {
        const { start, end } = bounds();
        if (end - start > 0.05 && v.currentTime >= end - 0.02) {
          v.currentTime = start;
          time.set(start);
        }
      }
    }
    if (st.rate < 0 || !v.paused) st.raf = requestAnimationFrame(tick);
  };
  const startLoop = () => {
    if (st.raf) return;
    st.lastTs = 0;
    st.raf = requestAnimationFrame(tick);
  };
  const stopReverse = () => {
    if (st.rate < 0) {
      setRate(0);
      setPlaying(false);
    }
  };

  const api = {
    videoRef,
    time,
    playing: playing || rate < 0,
    rate,
    duration,
    getTime: () => (st.rate < 0 ? st.revTarget : videoRef.current?.currentTime || 0),
    seek(t) {
      const v = videoRef.current;
      if (!v) return;
      stopReverse();
      const d = duration();
      const tt = clamp(Number(t) || 0, 0, d > 0 ? d : 0);
      v.currentTime = tt;
      time.set(tt);
    },
    play() {
      const v = videoRef.current;
      if (!v || !v.currentSrc) return;
      stopReverse();
      const d = duration();
      const b = bounds();
      const t = v.currentTime;
      // Play from the playhead (like an NLE); a looped range starts at IN, and the end restarts from IN / 0.
      if (opts.current.loop && b.active && (t < b.start - 0.01 || t >= b.end - 0.03)) v.currentTime = b.start;
      else if (d > 0 && t >= d - 0.05) v.currentTime = b.active ? b.start : 0;
      v.playbackRate = 1;
      setRate(1);
      v.play().catch(() => {});
    },
    pause() {
      const v = videoRef.current;
      stopReverse();
      setRate(0);
      v?.pause();
    },
    toggle() {
      const v = videoRef.current;
      if (st.rate < 0 || (v && !v.paused)) api.pause();
      else api.play();
    },
    shuttle(key) {
      const v = videoRef.current;
      if (!v || !v.currentSrc) return;
      const next = shuttleRate(st.rate, key);
      if (next === 0) return api.pause();
      if (next > 0) {
        stopReverse();
        setRate(next);
        v.playbackRate = next;
        if (v.paused) v.play().catch(() => {});
        return;
      }
      v.pause();
      st.revTarget = v.currentTime;
      setRate(next);
      setPlaying(true);
      startLoop();
    },
    step(dir) {
      const v = videoRef.current;
      if (!v) return;
      api.pause();
      const t = frameStepTime(v.currentTime, opts.current.media?.fps || 30, dir, duration());
      v.currentTime = t + 1e-4; // just past the frame start so the decoder shows that frame
      time.set(t);
    },
    jump(seconds) {
      api.seek(api.getTime() + seconds);
    },
    goTo(where) {
      const b = bounds();
      const d = duration();
      if (where === 'start') api.seek(0);
      else if (where === 'end') api.seek(Math.max(0, d - 0.5 / (opts.current.media?.fps || 30)));
      else if (where === 'in') api.seek(b.start);
      else if (where === 'out') api.seek(Math.max(b.start, b.end - 0.5 / (opts.current.media?.fps || 30)));
    },
  };

  api.videoProps = {
    onPlay: () => {
      setPlaying(true);
      if (st.rate <= 0) setRate(videoRef.current?.playbackRate || 1);
      startLoop();
    },
    onPause: () => {
      if (st.rate < 0) return; // reverse shuttle pauses the element on purpose
      setPlaying(false);
      setRate(0);
      time.set(videoRef.current?.currentTime || 0);
    },
    onEnded: () => {
      const v = videoRef.current;
      if (v && opts.current.loop) {
        v.currentTime = bounds().start;
        v.play().catch(() => {});
        return;
      }
      setPlaying(false);
      setRate(0);
    },
    onSeeked: () => {
      if (st.rate >= 0) time.set(videoRef.current?.currentTime || 0);
    },
    onTimeUpdate: () => {
      if (st.rate >= 0 && !st.raf) time.set(videoRef.current?.currentTime || 0);
    },
    onLoadedMetadata: () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = clamp(opts.current.volume, 0, 1);
      v.muted = !!opts.current.muted;
      time.set(v.currentTime || 0);
      if (opts.current.autoplay && active) api.play();
    },
  };

  // New source: reset transport state.
  useEffect(() => {
    stopLoop();
    st.rate = 0;
    setRateState(0);
    setPlaying(false);
    time.set(0);
  }, [src]);

  // Volume / mute.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = clamp(volume, 0, 1);
    v.muted = !!muted;
  }, [volume, muted, src]);

  // Hidden view: stop playback.
  useEffect(() => {
    if (!active) api.pause();
  }, [active]);

  // Unmount: release the decoder.
  useEffect(
    () => () => {
      stopLoop();
      const v = videoRef.current;
      if (v) {
        v.pause();
        v.removeAttribute('src');
        try {
          v.load();
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  return api;
}

/** Current time / duration, re-rendering only itself as the time signal moves. */
export function TimeReadout({ time, duration, class: klass = '' }) {
  const t = useSignalValue(time);
  return html`<span class=${cx('src-time', klass)}><b>${formatTime(t)}</b><span class="src-time-sep">/</span><span class="src-time-dur">${formatTime(duration || 0)}</span></span>`;
}

/**
 * Scrub bar: filmstrip background, marked range, IN/OUT handles (always draggable; dimmed until set) and the playhead.
 * onSeek(t, phase) while clicking/dragging the track; onMarks(marks, phase, {role, key}) while dragging a handle (the
 * player also seeks to the handle so you see the frame); phase is 'start' | 'move' | 'end'; role 'in' | 'out'; key is
 * unique per drag gesture (use it as the undo merge key).
 */
export function ScrubBar({ duration, time, marks = EMPTY_MARKS, onSeek, onMarks, strip = null, disabled = false, class: klass = '' }) {
  const ref = useRef(null);
  const headRef = useRef(null);
  const drag = useRef(null);
  const d = duration > 0 ? duration : 0;
  const pct = (t) => (d > 0 ? clamp(t / d, 0, 1) * 100 : 0);

  useEffect(() => {
    const place = (t) => {
      if (headRef.current) headRef.current.style.left = `${pct(t)}%`;
    };
    place(time.get());
    return time.subscribe(place);
  }, [time, d]);

  const timeAt = (clientX) => {
    const r = ref.current.getBoundingClientRect();
    return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * d;
  };
  const apply = (e, phase) => {
    const g = drag.current;
    if (!g) return;
    const t = timeAt(e.clientX);
    if (g.role === 'seek') {
      onSeek?.(t, phase);
      return;
    }
    const m = dragMark(marks, g.role, t, d);
    onMarks?.(m, phase, { role: g.role, key: g.key });
    onSeek?.(g.role === 'in' ? m.in : Math.max(0, m.out - 0.001), phase);
  };
  const applyRef = useRef(apply);
  applyRef.current = apply; // the drag calls the latest render's apply (current marks / duration)
  const onDown = (e) => {
    if (disabled || !(d > 0) || e.button !== 0) return;
    e.preventDefault();
    const role = e.target.closest?.('[data-handle]')?.dataset.handle || 'seek';
    drag.current = { role, id: e.pointerId, key: `scrub-${role}-${e.pointerId}-${Math.round(e.timeStamp)}` };
    apply(e, 'start');
    // Always ends (ui/pointer.js): a missed release never leaves the bar following the mouse.
    trackPointer(e, {
      target: ref.current,
      onMove: (ev) => applyRef.current(ev, 'move'),
      onEnd: (ev) => {
        applyRef.current(ev, 'end');
        drag.current = null;
      },
    });
  };

  const b = markBounds(marks, d);
  const inPos = pct(marks.in ?? 0);
  const outPos = pct(marks.out ?? d);
  return html`<div
    class=${cx('src-scrub', disabled && 'is-disabled', b.active && 'has-range', klass)}
    ref=${ref}
    onPointerDown=${onDown}
  >
    <div class="src-scrub-track">
      ${strip ? html`<div class="src-scrub-strip" style=${`background-image:url("${strip}")`}></div>` : html`<div class="src-scrub-ticks"></div>`}
      ${b.active &&
      html`<div class="src-scrub-dim" style=${`left:0;width:${pct(b.start)}%`}></div>
        <div class="src-scrub-dim" style=${`left:${pct(b.end)}%;right:0`}></div>
        <div class="src-scrub-range" style=${`left:${pct(b.start)}%;width:${Math.max(0, pct(b.end) - pct(b.start))}%`}></div>`}
    </div>
    ${d > 0 &&
    html`<div class=${cx('src-scrub-handle', 'is-in', marks.in != null && 'is-set')} data-handle="in" style=${`left:${inPos}%`} title="IN point: drag to trim the start (I)"></div>
      <div class=${cx('src-scrub-handle', 'is-out', marks.out != null && 'is-set')} data-handle="out" style=${`left:${outPos}%`} title="OUT point: drag to trim the end (O)"></div>`}
    <div class="src-scrub-head" ref=${headRef}></div>
  </div>`;
}
