// Realtime preview engine for the Edit tab's program monitor.
//
// Every frame is rendered through the shared compositor (engine/compositor.js drawFrame) so the preview matches
// the export pixel for pixel. Sources:
//  * main-track videos: a small pool of hidden <video> elements (one per clip near the playhead, object URLs from
//    core/media.js). Active clips play at playbackRate = speed and are re-synced when they drift from the master
//    clock; the next clip is loaded and parked on its first frame ~1 s before it starts. While paused, seeking sets
//    currentTime on the visible clips and the frame is redrawn on 'seeked'. A clip that is still seeking keeps the
//    last good frame on screen instead of flashing black.
//  * stills: decoded ImageBitmaps (cached per media).
//  * sound: one AudioContext. Each clip element -> MediaElementAudioSourceNode -> gain (volume x mute x fades x
//    equal-power transition crossfade, same curves as engine/audio-mix.js) -> master. Audio-track clips are decoded
//    AudioBuffers scheduled with AudioBufferSourceNodes (offset/duration, linear fade ramps) on play/seek.
// The master clock is AudioContext.currentTime (performance.now() while the context is suspended).
//
//   const player = new Player({canvas, getProject, onTime(t), onState(state), media})
//   player.play() / pause() / toggle() / seek(t) / time / playing / duration / rate
//   player.setLoop({start, end} | null) / setVolume(v) / setMuted(b) / setRate(r)  (r < 0 = reverse scrub)
//   player.playRange(start, end)   play once through a range (e.g. a transition preview)
//   player.invalidate()            redraw (project edits are picked up automatically; call after canvas resizes)
//   player.captureFrame({width, height, strict}) -> Promise<OffscreenCanvas>  full-quality still of the current frame
//   player.outputNode              master GainNode (level meters, tests)
//   player.destroy()
//
// Pure helpers (videoClipGain, audioEnvelope, audioPlan, audioSignature) are exported for unit tests.

import { layoutProject, videoItemsAt, sourceTimeAt, fadeFactor, transitionProgress } from '../core/model.js';
import { drawFrame, createScratch } from './compositor.js';

const DRIFT_TOLERANCE = 0.12; // s — resync a playing clip element that drifts further than this
const SYNC_COOLDOWN = 0.4; // s (wall clock) after a play()/seek before drift is measured again
const PRELOAD_AHEAD = 1.0; // s — park the next clip on its first frame this long before it starts
const AUDIO_LEAD = 0.04; // s — scheduling headroom for AudioBufferSourceNodes
const DECLICK = 0.004; // s — micro-ramp where an audio-track clip starts/stops abruptly
const POOL_MAX = 8; // max simultaneous <video> elements
const STALE_LIMIT_MS = 1200; // draw an incomplete frame if no complete one could be drawn for this long
const MAX_RATE = 4;
const EMPTY_LAYOUT = { video: [], audio: [], text: [], videoEnd: 0, duration: 0 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const equalPowerIn = (p) => Math.sin(clamp(p, 0, 1) * Math.PI * 0.5);
const equalPowerOut = (p) => Math.cos(clamp(p, 0, 1) * Math.PI * 0.5);

/**
 * Gain of a main-track item's own sound at timeline time t: volume x mute x fade x transition crossfade
 * (equal-power, matching the export mixdown). 0 outside the item.
 */
export function videoClipGain(videoLayout, item, t) {
  const c = item.clip;
  if (c.muted || t < item.start || t > item.end) return 0;
  let g = Math.max(0, c.volume ?? 1) * fadeFactor(item, t);
  const pin = transitionProgress(item, t);
  if (pin != null) g *= equalPowerIn(pin);
  const next = videoLayout[item.index + 1];
  const pout = next ? transitionProgress(next, t) : null;
  if (pout != null) g *= equalPowerOut(pout);
  return g;
}

/**
 * Piecewise-linear gain envelope (volume excluded) of an audio-track item from timeline time `from` to its end:
 * [{t, g}] with exact values at every kink of min(fade-in ramp, fade-out ramp). Abrupt edges get a short
 * de-click ramp like the export.
 */
export function audioEnvelope(item, from = item.start, { declick = DECLICK } = {}) {
  const { start, end } = item;
  const fi = Math.max(item.clip.fadeIn || 0, declick);
  const fo = Math.max(item.clip.fadeOut || 0, declick);
  const g = (t) => {
    let v = 1;
    if (fi > 0) v = Math.min(v, clamp((t - start) / fi, 0, 1));
    if (fo > 0) v = Math.min(v, clamp((end - t) / fo, 0, 1));
    return v;
  };
  const kinks = [from, start + fi, end - fo, end];
  if (fi + fo > end - start) kinks.push((start * fo + end * fi) / (fi + fo)); // overlapping fades: the ramps cross
  const pts = [];
  for (const t of kinks.filter((x) => x >= from - 1e-9 && x <= end + 1e-9).sort((a, b) => a - b)) {
    if (!pts.length || t - pts[pts.length - 1] > 1e-6) pts.push(t);
  }
  return pts.map((t) => ({ t, g: g(t) }));
}

/**
 * Audio-track items that sound at or after timeline time t (until `end`):
 * [{item, begin, offset, duration}] — begin = timeline time it starts sounding, offset/duration in source seconds.
 */
export function audioPlan(audioLayout, t, end = Infinity) {
  const out = [];
  for (const item of audioLayout) {
    if (item.end <= t + 1e-4 || item.start >= end) continue;
    const begin = Math.max(t, item.start);
    const stop = Math.min(item.end, end);
    if (stop - begin <= 1e-4) continue;
    out.push({ item, begin, offset: item.clip.in + (begin - item.start), duration: stop - begin });
  }
  return out;
}

/** Signature of what requires re-scheduling audio-track sources (volume is applied live, so it's excluded). */
export function audioSignature(project) {
  return project.tracks.audio.map((c) => `${c.id}:${c.mediaId}:${c.start}:${c.in}:${c.out}:${c.fadeIn}:${c.fadeOut}`).join('|');
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class Player {
  /**
   * @param {Object} opts
   * @param {HTMLCanvasElement} opts.canvas      the visible monitor canvas (its size = preview resolution)
   * @param {() => Object} opts.getProject       current project (identity changes are detected every frame)
   * @param {(t: number) => void} [opts.onTime]  every rendered frame while playing, and after seeks
   * @param {(s: Object) => void} [opts.onState] {playing, rate, loop, volume, muted}
   * @param {(msg: string) => void} [opts.onWarning] user-facing problems (e.g. a clip that can't be decoded), once each
   * @param {Object} [opts.media]               {getMediaUrl, getMediaBlob, getAudioBuffer} (default: core/media.js)
   */
  constructor({ canvas, getProject, onTime = () => {}, onState = () => {}, onWarning = () => {}, media = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.getProject = getProject;
    this.onTime = onTime;
    this.onState = onState;
    this.onWarning = onWarning;
    this.media = media;
    this._active = true;
    this._dirty = false;
    this._warned = new Set();
    if (!media) {
      import('../core/media.js').then((m) => {
        this.media = m;
        this._requestRender();
      });
    }
    this._time = 0;
    this._playing = false;
    this._rate = 1;
    this._loop = null;
    this._stopAt = null;
    this._volume = 1;
    this._muted = false;
    this._project = null;
    this._layout = EMPTY_LAYOUT;
    this._slots = new Map(); // clipId -> slot
    this._allSlots = [];
    this._protected = new Set();
    this._urls = new Map(); // mediaId -> object URL | null (pending)
    this._images = new Map(); // mediaId -> {bmp, error}
    this._buffers = new Map(); // mediaId -> AudioBuffer | null (no sound)
    this._bufferPending = new Set();
    this._clipGains = new Map(); // audio clip id -> GainNode
    this._sources = []; // scheduled {src, env}
    this._audioSig = '';
    this._needsReschedule = false;
    this._ac = null;
    this._master = null;
    this._audioFailed = false;
    this._clock = 'perf';
    this._t0 = 0;
    this._ctxStart = 0;
    this._perfStart = 0;
    this._raf = 0;
    this._renderQueued = false;
    this._staleTimer = 0;
    this._hasFrame = false;
    this._staleSince = 0;
    this._lastSize = '';
    this._scratch = createScratch();
    this._slates = new Map();
    this._destroyed = false;
    this._getSource = this._getSource.bind(this);
    this._tick = this._tick.bind(this);
    this._onMediaEvent = () => {
      if (!this._playing) this._requestRender();
    };
    this._onVisibility = () => {
      if (document.hidden) this.pause();
    };
    this._onAcState = () => this._handleAcState();
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  // ------------------------------------------------------------------------------------------------ public API

  get time() {
    return this._time;
  }

  get playing() {
    return this._playing;
  }

  get rate() {
    return this._rate;
  }

  get loop() {
    return this._loop;
  }

  get volume() {
    return this._volume;
  }

  get muted() {
    return this._muted;
  }

  get duration() {
    return this._lay().duration;
  }

  /** The master output GainNode (sets up the audio graph if needed), e.g. to attach a level meter. Null without WebAudio. */
  get outputNode() {
    this._ensureAudio();
    return this._master;
  }

  /** Starts playback (call from a user gesture so the AudioContext may start). Restarts from 0 at the end. */
  play() {
    if (this._playing || this._destroyed || !this._active) return;
    const lay = this._lay();
    if (!(lay.duration > 0)) return;
    const loop = this._validLoop(lay.duration);
    if (this._rate > 0) {
      const end = loop ? loop.end : lay.duration;
      if (this._time >= end - 1e-3 || (loop && this._time < loop.start - 1e-3)) this._time = loop ? loop.start : 0;
    } else if (this._time <= (loop ? loop.start : 0) + 1e-3) {
      this._time = loop ? loop.end : lay.duration;
    }
    const ac = this._ensureAudio();
    if (ac && ac.state !== 'running') ac.resume().catch(() => {});
    // pause() silenced every element: make the first frame re-apply each clip's gain whatever it was before.
    for (const slot of this._allSlots) slot.lastGain = -1;
    this._playing = true;
    this._anchor(this._time);
    this._scheduleAudio(this._time);
    this._syncVideo(this._time, true);
    this._emitState();
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  }

  /** Pauses (at `at` when given, else at the clock time) and shows the exact frame. */
  pause(at = null) {
    if (!this._playing) return;
    const lay = this._lay();
    this._time = clamp(at ?? this._clockTime(), 0, lay.duration);
    this._playing = false;
    this._stopAt = null;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._stopAudioSources();
    for (const slot of this._allSlots) {
      try {
        slot.el.pause();
      } catch {
        /* ignore */
      }
      this._silenceSlot(slot);
    }
    this._syncVideo(this._time, false);
    this._render(this._time);
    this.onTime(this._time);
    this._emitState();
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  /** Moves the playhead (clamped to [0, duration]); keeps playing if playing. */
  seek(t) {
    if (this._destroyed) return;
    const lay = this._lay();
    const target = clamp(Number(t) || 0, 0, Math.max(0, lay.duration));
    this._time = target;
    this._stopAt = null;
    if (this._playing) {
      this._anchor(target);
      this._scheduleAudio(target);
      for (const slot of this._slots.values()) slot.syncAfter = 0;
      this._syncVideo(target, true, true);
    } else {
      this._syncVideo(target, false);
      this._requestRender();
    }
    this.onTime(target);
  }

  /** Loop range while playing (null = play to the end and stop; end may be Infinity = the sequence end). */
  setLoop(loop) {
    const ok = loop && Number.isFinite(loop.start) && typeof loop.end === 'number' && !Number.isNaN(loop.end) && loop.end - loop.start > 0.05;
    this._loop = ok ? { start: Math.max(0, loop.start), end: loop.end } : null;
    if (this._playing) this._needsReschedule = true;
    this._emitState();
  }

  /** Master volume 0..1. */
  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    this._applyMaster();
    this._emitState();
  }

  setMuted(muted) {
    this._muted = !!muted;
    this._applyMaster();
    this._emitState();
  }

  /** Shuttle rate (J/K/L): 0.25..4 forward, negative = reverse scrub (silent). Keeps the play state. */
  setRate(rate) {
    let r = Number(rate) || 1;
    r = Math.sign(r) * clamp(Math.abs(r), 0.25, MAX_RATE);
    if (r === this._rate) return;
    const t = this._playing ? this._clockTime() : this._time;
    this._rate = r;
    if (this._playing) {
      this._time = clamp(t, 0, this._lay().duration);
      this._anchor(this._time);
      this._scheduleAudio(this._time);
      for (const slot of this._slots.values()) slot.syncAfter = 0;
      this._syncVideo(this._time, true, true);
    }
    this._emitState();
  }

  /** Plays once from `start` and stops at `end` (e.g. to preview a transition). */
  playRange(start, end) {
    this.setRate(1);
    this.seek(start);
    this.play();
    this._stopAt = end;
  }

  /** Forces a redraw (project changes are detected automatically; call after resizing the canvas). */
  invalidate() {
    if (this._destroyed) return;
    if (this._playing) return; // the next frame redraws anyway
    this._requestRender();
  }

  /** While inactive (the Edit tab is hidden) playback pauses and redraws are deferred until reactivated. */
  setActive(active) {
    this._active = !!active;
    if (!this._active) this.pause();
    else if (this._dirty) {
      this._dirty = false;
      this._requestRender();
    }
  }

  /**
   * Renders the frame at the current time at full output size (default: project settings) once every visible
   * source is ready (or after `timeout` ms). Returns the canvas.
   * strict: throw instead of returning an incomplete picture (a clip still loading after `timeout`, or a visible clip
   * whose media is missing / offline / undecodable and would only show a placeholder card).
   */
  async captureFrame({ width, height, timeout = 4000, strict = false } = {}) {
    const p = this._proj();
    if (!p) throw new Error('No project');
    const W = Math.max(2, Math.round(width || p.settings.width || 1280));
    const H = Math.max(2, Math.round(height || p.settings.height || 720));
    const canvas = makeCanvas(W, H);
    const g = canvas.getContext('2d');
    const started = performance.now();
    for (;;) {
      const lay = this._lay();
      const t = this._renderTime(this._time, lay);
      if (!this._playing) this._syncVideo(t, false);
      const items = videoItemsAt(lay.video, t);
      const problems = strict ? items.map((it) => this._sourceProblem(it)) : [];
      const hard = problems.find((x) => x && x !== 'loading');
      if (hard) throw new Error(`this frame shows ${hard}`);
      // (a clip whose media is still downloading draws a "Loading…" card: in strict mode that isn't ready either)
      const ready = items.every((it, i) => this._getSource(it) && !problems[i]);
      if (ready || performance.now() - started > timeout) {
        if (!ready && strict) throw new Error('the picture is still loading — try again in a moment');
        drawFrame(g, { project: this._project, layout: lay, t, getSource: this._getSource, scratch: createScratch() });
        return canvas;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  destroy() {
    if (this._destroyed) return;
    this.pause();
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._staleTimer);
    document.removeEventListener('visibilitychange', this._onVisibility);
    for (const slot of this._allSlots) this._disposeSlot(slot);
    this._allSlots = [];
    this._slots.clear();
    for (const e of this._images.values()) e.bmp?.close?.();
    this._images.clear();
    this._stopAudioSources();
    for (const g of this._clipGains.values()) g.disconnect();
    this._clipGains.clear();
    if (this._ac) {
      this._ac.removeEventListener('statechange', this._onAcState);
      this._ac.close().catch(() => {});
      this._ac = null;
    }
    this._buffers.clear();
  }

  // ------------------------------------------------------------------------------------------------ project

  _proj() {
    const p = this.getProject();
    if (p !== this._project) {
      this._project = p || null;
      this._layout = p ? layoutProject(p) : EMPTY_LAYOUT;
      if (p) this._projectChanged(p);
    }
    return this._project;
  }

  _lay() {
    this._proj();
    return this._layout;
  }

  _projectChanged(p) {
    // Free the elements of clips that left the main track; unload elements of media no longer used at all.
    const clipIds = new Set(p.tracks.video.map((c) => c.id));
    const usedMedia = new Set(p.tracks.video.map((c) => c.mediaId));
    for (const [clipId, slot] of [...this._slots]) if (!clipIds.has(clipId)) this._releaseSlot(slot);
    for (const slot of this._allSlots) {
      if (!slot.clipId && slot.mediaId && !usedMedia.has(slot.mediaId)) this._unloadSlot(slot);
    }
    for (const [mediaId, e] of [...this._images]) {
      if (!usedMedia.has(mediaId)) {
        e.bmp?.close?.();
        this._images.delete(mediaId);
      }
    }
    for (const mediaId of [...this._urls.keys()]) if (!p.media[mediaId]) this._urls.delete(mediaId);
    // Audio-track clips: decode ahead of time, apply volumes live, reschedule when timing changed.
    for (const c of p.tracks.audio) {
      const m = p.media[c.mediaId];
      if (m && m.status === 'ready' && !this._buffers.has(c.mediaId)) this._loadBuffer(c.mediaId);
    }
    for (const id of [...this._buffers.keys()]) if (!p.media[id]) this._buffers.delete(id);
    this._applyClipVolumes(p);
    const sig = audioSignature(p);
    if (sig !== this._audioSig) {
      this._audioSig = sig;
      if (this._playing) this._needsReschedule = true;
    }
    if (!this._playing && this._time > this._layout.duration) this._time = this._layout.duration;
  }

  _validLoop(duration) {
    const l = this._loop;
    if (!l) return null;
    const end = Math.min(l.end, duration);
    return end - l.start > 0.05 ? { start: l.start, end } : null;
  }

  /** The time actually drawn: at/after the end we show the last frame instead of the background. */
  _renderTime(t, lay) {
    if (lay.duration > 0 && t >= lay.duration - 1e-4) return Math.max(0, lay.duration - 1e-3);
    return t;
  }

  // ------------------------------------------------------------------------------------------------ clock

  _anchor(t) {
    this._t0 = t;
    const ac = this._ac;
    if (ac && ac.state === 'running' && this._rate > 0) {
      this._clock = 'audio';
      this._ctxStart = ac.currentTime + AUDIO_LEAD;
    } else {
      this._clock = 'perf';
      this._perfStart = performance.now() / 1000;
    }
  }

  _clockTime() {
    if (!this._playing) return this._time;
    if (this._clock === 'audio' && this._ac) {
      const dt = Math.max(0, this._ac.currentTime - this._ctxStart);
      return this._t0 + dt * this._rate;
    }
    return this._t0 + (performance.now() / 1000 - this._perfStart) * this._rate;
  }

  /** AudioContext time at which timeline time T sounds (valid while the audio clock drives playback). */
  _ctxAt(T) {
    return this._ctxStart + (T - this._t0) / this._rate;
  }

  _handleAcState() {
    if (!this._playing || !this._ac) return;
    const running = this._ac.state === 'running';
    if ((running && this._clock !== 'audio') || (!running && this._clock === 'audio')) {
      const t = this._clock === 'audio' ? this._time : this._clockTime();
      this._anchor(t);
      this._scheduleAudio(t);
    }
  }

  // ------------------------------------------------------------------------------------------------ frame loop

  _tick() {
    this._raf = 0;
    if (!this._playing || this._destroyed) return;
    if (this._clock === 'audio' && this._ac && this._ac.state !== 'running') this._anchor(this._time); // device lost
    const lay = this._lay();
    let t = this._clockTime();
    const loop = this._validLoop(lay.duration);
    const startT = loop ? loop.start : 0;
    const endT = loop ? loop.end : lay.duration;
    if (this._stopAt != null && this._rate > 0 && t >= this._stopAt) {
      this.pause(Math.min(this._stopAt, lay.duration));
      return;
    }
    if (this._rate > 0 && t >= endT - 1e-4) {
      if (loop) {
        t = startT;
        this._anchor(t);
        this._needsReschedule = true;
        for (const slot of this._slots.values()) slot.syncAfter = 0;
      } else {
        this.pause(lay.duration);
        return;
      }
    } else if (this._rate < 0 && t <= startT + 1e-4) {
      if (loop) {
        t = endT - 1e-3;
        this._anchor(t);
      } else {
        this.pause(0);
        return;
      }
    }
    this._time = t;
    if (this._needsReschedule) {
      this._needsReschedule = false;
      this._scheduleAudio(t);
    }
    this._syncVideo(t, true);
    this._updateGains(t);
    this._render(t);
    this.onTime(t);
    this._raf = requestAnimationFrame(this._tick);
  }

  _requestRender() {
    if (this._renderQueued || this._playing || this._destroyed) return;
    if (!this._active) {
      this._dirty = true;
      return;
    }
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      if (this._playing || this._destroyed) return;
      this._syncVideo(this._time, false);
      this._render(this._time);
    });
  }

  /** Draws the frame at t. Returns true when the frame was complete. */
  _render(t) {
    const p = this._proj();
    if (!p) return false;
    const cv = this.canvas;
    if (!cv.width || !cv.height) return false;
    const size = `${cv.width}x${cv.height}`;
    if (size !== this._lastSize) {
      this._lastSize = size; // a resize clears the canvas: the next frame must be drawn whatever its state
      this._hasFrame = false;
    }
    const lay = this._layout;
    const rt = this._renderTime(t, lay);
    const complete = videoItemsAt(lay.video, rt).every((it) => this._getSource(it));
    if (!complete && this._hasFrame) {
      const now = performance.now();
      if (!this._staleSince) this._staleSince = now;
      if (now - this._staleSince < STALE_LIMIT_MS) {
        if (!this._playing) {
          clearTimeout(this._staleTimer);
          this._staleTimer = setTimeout(() => this._requestRender(), STALE_LIMIT_MS);
        }
        return false;
      }
    }
    let res;
    try {
      res = drawFrame(this.ctx, { project: p, layout: lay, t: rt, getSource: this._getSource, scratch: this._scratch });
    } catch (e) {
      console.warn('[gis] preview render failed', e);
      return false;
    }
    if (res.ready) {
      this._hasFrame = true;
      this._staleSince = 0;
    }
    return res.ready;
  }

  // ------------------------------------------------------------------------------------------------ sources

  _getSource(item) {
    const p = this._project;
    const media = p?.media[item.clip.mediaId];
    if (!media) return this._slate('Missing media');
    if (media.status === 'error') return this._slate('Media offline');
    if (media.status !== 'ready') return this._slate('Loading…');
    if (media.kind === 'image') return this._imageSource(media);
    if (media.kind !== 'video') return this._slate('No picture');
    const slot = this._slots.get(item.clip.id);
    if (!slot) return null;
    if (slot.error) return this._slate("Can't play this clip");
    const el = slot.el;
    if (el.readyState < 2 || el.seeking) return null;
    return { image: el, width: el.videoWidth || media.width || 16, height: el.videoHeight || media.height || 9 };
  }

  /** Why a main-track item can't show its real picture: 'loading', a user-facing phrase, or null when it can. */
  _sourceProblem(item) {
    const media = this._project?.media[item.clip.mediaId];
    if (!media) return 'missing media';
    if (media.status === 'error') return 'offline media';
    if (media.status !== 'ready') return 'loading';
    if (media.kind === 'image') return this._images.get(media.id)?.error ? 'an image that could not be decoded' : null;
    if (media.kind !== 'video') return 'media without a picture';
    return this._slots.get(item.clip.id)?.error ? 'a clip this browser cannot decode' : null;
  }

  /** A placeholder card ("Loading…", "Media offline") drawn like a 16:9 source. */
  _slate(label) {
    let c = this._slates.get(label);
    if (!c) {
      c = makeCanvas(640, 360);
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 640, 360);
      grad.addColorStop(0, '#1b1b24');
      grad.addColorStop(1, '#101016');
      g.fillStyle = grad;
      g.fillRect(0, 0, 640, 360);
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.lineWidth = 2;
      for (let x = -360; x < 640; x += 28) {
        g.beginPath();
        g.moveTo(x, 360);
        g.lineTo(x + 360, 0);
        g.stroke();
      }
      g.fillStyle = 'rgba(243,243,247,0.75)';
      g.font = '600 28px Inter, system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, 320, 180);
      this._slates.set(label, c);
    }
    return { image: c, width: 640, height: 360 };
  }

  _imageSource(media) {
    let e = this._images.get(media.id);
    if (!e) {
      e = { bmp: null, error: false };
      this._images.set(media.id, e);
      this._decodeImage(media, e);
    }
    if (e.error) return this._slate('Image unavailable');
    return e.bmp ? { image: e.bmp, width: e.bmp.width, height: e.bmp.height } : null;
  }

  async _decodeImage(media, e) {
    try {
      const api = await this._mediaApi();
      const blob = await api.getMediaBlob(media.id);
      if (!blob) throw new Error('image not stored');
      const longSide = Math.max(media.width || 0, media.height || 0);
      const bmp =
        longSide > 4096
          ? await createImageBitmap(blob, media.width >= media.height ? { resizeWidth: 4096, resizeQuality: 'high' } : { resizeHeight: 4096, resizeQuality: 'high' })
          : await createImageBitmap(blob);
      if (this._destroyed || this._images.get(media.id) !== e) {
        bmp.close();
        return;
      }
      e.bmp = bmp;
    } catch (err) {
      e.error = true;
      console.warn('[gis] preview could not decode image', media.id, err);
    }
    this._requestRender();
  }

  _mediaApi() {
    if (this.media) return Promise.resolve(this.media);
    return import('../core/media.js').then((m) => (this.media = m));
  }

  _urlFor(mediaId) {
    if (this._urls.has(mediaId)) return this._urls.get(mediaId);
    this._urls.set(mediaId, null);
    this._mediaApi()
      .then((api) => api.getMediaUrl(mediaId))
      .then((url) => {
        if (this._destroyed) return;
        if (url) this._urls.set(mediaId, url);
        else this._urls.delete(mediaId);
        this._requestRender();
      })
      .catch(() => this._urls.delete(mediaId));
    return null;
  }

  _isPlayableVideo(p, item) {
    const m = p.media[item.clip.mediaId];
    return !!m && m.kind === 'video' && m.status === 'ready';
  }

  _newSlot() {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.playsInline = true;
    el.disableRemotePlayback = true;
    el.muted = false;
    const slot = { el, url: null, mediaId: null, clipId: null, used: 0, error: false, syncAfter: 0, node: null, gain: null, lastGain: -1, mutedFallback: false };
    slot.onError = () => {
      if (!el.getAttribute('src')) return;
      slot.error = true;
      console.warn('[gis] preview could not play clip media', slot.mediaId, el.error?.message || el.error?.code);
      if (slot.mediaId && !this._warned.has(slot.mediaId)) {
        this._warned.add(slot.mediaId);
        const name = this._project?.media[slot.mediaId]?.name || 'A clip';
        this.onWarning(`“${name}” can't be decoded by this browser — it shows as a placeholder in the preview.`);
      }
      this._requestRender();
    };
    for (const ev of ['seeked', 'loadeddata', 'canplay']) el.addEventListener(ev, this._onMediaEvent);
    el.addEventListener('error', slot.onError);
    this._allSlots.push(slot);
    this._routeSlot(slot);
    return slot;
  }

  /** The element assigned to a clip, assigning (and loading) one if needed. Null while the URL is unknown. */
  _slotFor(item) {
    const clip = item.clip;
    let slot = this._slots.get(clip.id);
    if (slot) {
      slot.used = performance.now();
      return slot;
    }
    const url = this._urlFor(clip.mediaId);
    if (!url) return null;
    const free = this._allSlots.filter((s) => !s.clipId);
    slot = free.find((s) => s.url === url) || free[0] || (this._allSlots.length < POOL_MAX ? this._newSlot() : this._evictSlot());
    if (!slot) return null;
    slot.clipId = clip.id;
    slot.used = performance.now();
    slot.syncAfter = 0;
    if (slot.url !== url) {
      slot.error = false;
      slot.url = url;
      slot.mediaId = clip.mediaId;
      slot.el.src = url;
    }
    this._slots.set(clip.id, slot);
    return slot;
  }

  _evictSlot() {
    let victim = null;
    for (const slot of this._slots.values()) {
      if (this._protected.has(slot.clipId)) continue;
      if (!victim || slot.used < victim.used) victim = slot;
    }
    if (!victim) return null;
    this._releaseSlot(victim);
    return victim;
  }

  _releaseSlot(slot) {
    if (slot.clipId) this._slots.delete(slot.clipId);
    slot.clipId = null;
    try {
      slot.el.pause();
    } catch {
      /* ignore */
    }
    this._silenceSlot(slot);
  }

  /**
   * Mutes a clip element's gain right away (pending ramps cancelled). lastGain = -1 means "unknown", so the next
   * _updateGains() always writes the clip's real gain again — otherwise a resume inside the same clip would compare
   * against the stale pre-pause value and leave the sound at 0.
   */
  _silenceSlot(slot) {
    slot.lastGain = -1;
    if (!slot.gain) return;
    try {
      const now = this._ac ? this._ac.currentTime : 0;
      slot.gain.gain.cancelScheduledValues(now);
      slot.gain.gain.setValueAtTime(0, now);
    } catch {
      slot.gain.gain.value = 0;
    }
  }

  _unloadSlot(slot) {
    slot.url = null;
    slot.mediaId = null;
    slot.error = false;
    try {
      slot.el.removeAttribute('src');
      slot.el.load();
    } catch {
      /* ignore */
    }
  }

  _disposeSlot(slot) {
    for (const ev of ['seeked', 'loadeddata', 'canplay']) slot.el.removeEventListener(ev, this._onMediaEvent);
    slot.el.removeEventListener('error', slot.onError);
    this._releaseSlot(slot);
    this._unloadSlot(slot);
    try {
      slot.node?.disconnect();
      slot.gain?.disconnect();
    } catch {
      /* ignore */
    }
  }

  /** Puts the right elements in the right state for time t (play / drift-correct / seek / preload / pause). */
  _syncVideo(t, playing, force = false) {
    const p = this._proj();
    if (!p) return;
    const lay = this._layout;
    const active = videoItemsAt(lay.video, t);
    const keep = new Set(active.map((it) => it.clip.id));
    const upcoming = [];
    const ahead = PRELOAD_AHEAD * Math.max(1, Math.abs(this._rate));
    if (this._rate >= 0 || !playing) {
      for (const it of lay.video) {
        if (keep.has(it.clip.id)) continue;
        if (it.start > t && it.start - t <= ahead) upcoming.push(it);
        else if (it.start > t + ahead) break;
      }
    } else {
      for (const it of lay.video) if (!keep.has(it.clip.id) && it.end <= t && t - it.end <= ahead) upcoming.push(it);
    }
    for (const it of upcoming) keep.add(it.clip.id);
    this._protected = keep;
    const now = performance.now() / 1000;
    const fps = p.settings?.fps || 30;
    const forward = playing && this._rate > 0;
    for (const it of active) {
      if (!this._isPlayableVideo(p, it)) continue;
      const slot = this._slotFor(it);
      if (!slot || slot.error) continue;
      const el = slot.el;
      const want = sourceTimeAt(it, t);
      if (forward) {
        const rate = clamp((it.clip.speed || 1) * this._rate, 0.0625, 16);
        if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
        if (el.paused) {
          if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
          slot.syncAfter = now + SYNC_COOLDOWN;
          this._playElement(slot);
        } else if ((force || now >= slot.syncAfter) && !el.seeking && el.readyState >= 2 && Math.abs(el.currentTime - want) > DRIFT_TOLERANCE) {
          el.currentTime = want;
          slot.syncAfter = now + SYNC_COOLDOWN;
        }
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - want) > 0.5 / fps) el.currentTime = want;
      }
    }
    for (const it of upcoming) {
      if (!this._isPlayableVideo(p, it)) continue;
      const slot = this._slotFor(it);
      if (!slot || slot.error) continue;
      const el = slot.el;
      if (!el.paused) el.pause();
      const want = this._rate >= 0 || !playing ? sourceTimeAt(it, it.start) : sourceTimeAt(it, it.end);
      if (!el.seeking && Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
    }
    for (const slot of this._slots.values()) {
      if (!keep.has(slot.clipId) && !slot.el.paused) slot.el.pause();
    }
  }

  _playElement(slot) {
    const el = slot.el;
    let pr;
    try {
      pr = el.play();
    } catch (e) {
      pr = Promise.reject(e);
    }
    pr?.catch?.((err) => {
      if (!err || err.name === 'AbortError') return; // interrupted by a pause/seek: harmless
      if (err.name === 'NotAllowedError' && !el.muted) {
        // Autoplay policy refused sound: keep the picture moving silently.
        el.muted = true;
        slot.mutedFallback = true;
        if (this._playing) el.play().catch(() => {});
        return;
      }
      console.warn('[gis] preview element failed to play', err);
    });
  }

  // ------------------------------------------------------------------------------------------------ audio

  _ensureAudio() {
    if (this._ac || this._audioFailed) return this._ac;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._ac = new AC({ latencyHint: 'interactive' });
      this._master = this._ac.createGain();
      this._master.connect(this._ac.destination);
      this._ac.addEventListener('statechange', this._onAcState);
      this._applyMaster(true);
      for (const slot of this._allSlots) this._routeSlot(slot);
      if (this._project) this._applyClipVolumes(this._project);
    } catch (e) {
      this._audioFailed = true;
      console.warn('[gis] WebAudio unavailable, preview sound falls back to media elements', e);
    }
    return this._ac;
  }

  _routeSlot(slot) {
    if (!this._ac || slot.node) return;
    try {
      slot.node = this._ac.createMediaElementSource(slot.el);
      slot.gain = this._ac.createGain();
      slot.gain.gain.value = 0;
      slot.node.connect(slot.gain).connect(this._master);
    } catch (e) {
      console.warn('[gis] could not route clip audio', e);
    }
  }

  _applyMaster(immediate = false) {
    if (!this._master) return;
    const v = this._muted ? 0 : this._volume;
    if (immediate) this._master.gain.value = v;
    else this._master.gain.setTargetAtTime(v, this._ac.currentTime, 0.015);
  }

  /** Per-frame gains of the clip elements (silent in reverse scrub). */
  _updateGains(t) {
    const lay = this._layout;
    const byId = new Map();
    for (const it of videoItemsAt(lay.video, t)) byId.set(it.clip.id, it);
    for (const slot of this._slots.values()) {
      const it = byId.get(slot.clipId);
      const g = it && this._rate > 0 ? videoClipGain(lay.video, it, t) : 0;
      if (Math.abs(g - slot.lastGain) < 1e-3) continue;
      slot.lastGain = g;
      if (slot.gain && this._ac) slot.gain.gain.setTargetAtTime(g, this._ac.currentTime, 0.012);
      else if (!slot.gain) slot.el.volume = clamp(g * (this._muted ? 0 : this._volume), 0, 1);
    }
  }

  _clipGain(clip) {
    let g = this._clipGains.get(clip.id);
    if (!g) {
      g = this._ac.createGain();
      g.gain.value = Math.max(0, clip.volume ?? 1);
      g.connect(this._master);
      this._clipGains.set(clip.id, g);
    }
    return g;
  }

  _applyClipVolumes(p) {
    if (!this._ac) return;
    const ids = new Set();
    for (const c of p.tracks.audio) {
      ids.add(c.id);
      const g = this._clipGains.get(c.id);
      const v = Math.max(0, c.volume ?? 1);
      if (g && Math.abs(g.gain.value - v) > 1e-4) g.gain.setTargetAtTime(v, this._ac.currentTime, 0.015);
    }
    for (const [id, g] of [...this._clipGains]) {
      if (!ids.has(id)) {
        g.disconnect();
        this._clipGains.delete(id);
      }
    }
  }

  _loadBuffer(mediaId) {
    if (this._bufferPending.has(mediaId) || this._buffers.has(mediaId)) return;
    this._bufferPending.add(mediaId);
    this._mediaApi()
      .then((api) => api.getAudioBuffer(mediaId))
      .then(
        (buf) => this._buffers.set(mediaId, buf || null),
        () => this._buffers.set(mediaId, null),
      )
      .finally(() => {
        this._bufferPending.delete(mediaId);
        if (this._playing && !this._destroyed && this._buffers.get(mediaId)) this._scheduleAudio(this._time, mediaId);
      });
  }

  _stopAudioSources() {
    for (const s of this._sources) {
      s.src.onended = null;
      try {
        s.src.stop();
      } catch {
        /* not started */
      }
      try {
        s.src.disconnect();
        s.env.disconnect();
      } catch {
        /* ignore */
      }
    }
    this._sources = [];
  }

  /** (Re)schedules audio-track clips from timeline time t. `onlyMedia` adds the clips of one media (buffer ready). */
  _scheduleAudio(t, onlyMedia = null) {
    if (!onlyMedia) this._stopAudioSources();
    const ac = this._ac;
    if (!ac || !this._playing || this._rate <= 0 || this._clock !== 'audio') return;
    const p = this._project;
    const lay = this._layout;
    const loop = this._validLoop(lay.duration);
    const end = Math.min(loop ? loop.end : Infinity, this._stopAt ?? Infinity);
    const now = ac.currentTime;
    for (const plan of audioPlan(lay.audio, t, end)) {
      const clip = plan.item.clip;
      if (onlyMedia && clip.mediaId !== onlyMedia) continue;
      const media = p?.media[clip.mediaId];
      if (!media || media.status !== 'ready') continue;
      if (!this._buffers.has(clip.mediaId)) {
        this._loadBuffer(clip.mediaId);
        continue;
      }
      const buf = this._buffers.get(clip.mediaId);
      if (!buf || plan.offset >= buf.duration - 1e-3) continue;
      const dur = Math.min(plan.duration, buf.duration - plan.offset);
      if (dur <= 0.005) continue;
      try {
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = this._rate;
        const env = ac.createGain();
        const at = (T) => Math.max(now, this._ctxAt(T));
        const pts = audioEnvelope(plan.item, plan.begin);
        env.gain.setValueAtTime(pts[0].g, at(pts[0].t));
        for (let i = 1; i < pts.length; i++) env.gain.linearRampToValueAtTime(pts[i].g, at(pts[i].t));
        src.connect(env).connect(this._clipGain(clip));
        src.start(at(plan.begin), plan.offset, dur);
        const rec = { src, env };
        src.onended = () => {
          try {
            src.disconnect();
            env.disconnect();
          } catch {
            /* ignore */
          }
          this._sources = this._sources.filter((x) => x !== rec);
        };
        this._sources.push(rec);
      } catch (e) {
        console.warn('[gis] could not schedule audio clip', clip.id, e);
      }
    }
  }

  _emitState() {
    this.onState({ playing: this._playing, rate: this._rate, loop: this._loop, volume: this._volume, muted: this._muted });
  }
}
