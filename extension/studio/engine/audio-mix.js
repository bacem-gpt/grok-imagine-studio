// Offline audio mixdown of a sequence (used by the video exporter and the WAV export).
//
//   renderAudioMix(project, {start, end, sampleRate}) -> Promise<AudioBuffer>   (stereo, limited)
//
// Every audible source is scheduled into an OfflineAudioContext:
//   * main-track clips with sound: placed at their timeline start, offset = clip.in, playbackRate = speed,
//     gain = volume x fade in/out x equal-power crossfade across each transition window (the outgoing clip
//     ramps down while the incoming one ramps up), plus a few-millisecond de-click ramp at hard cuts;
//   * audio-track clips (music, voice, sfx — or the sound of a video): volume x fade in/out.
// A look-ahead peak limiter then keeps the master below full scale (it leaves material that never clips
// untouched — no make-up gain, no latency, so the mix matches the preview levels and stays in sync).
//
// Long CPU work (pitch-preserving stretches, the limiter, WAV encoding) is written as step generators: the sync
// wrappers (timeStretch, applyLimiter, encodeWav) run them in one go, while renderAudioMix() and the exporter run
// them in short slices (runStepsSliced) so the page stays responsive, progress keeps moving and Cancel works.
//
// Everything above renderAudioMix() is pure (no DOM / Web Audio) and unit-tested in node
// (tests/unit/export.test.mjs). core/media.js is imported lazily so this module stays importable from node.

import { layoutProject } from '../core/model.js';
import { clamp, formatTime, formatDuration } from '../core/utils.js';

export const DEFAULT_SAMPLE_RATE = 48000;
/** Micro-fade (seconds) applied where a sound starts or stops abruptly, to avoid clicks. */
export const DECLICK = 0.004;
/** Master limiter defaults: ceiling ≈ -0.5 dBFS, 5 ms look-ahead attack, 150 ms release. */
export const LIMITER_DEFAULTS = Object.freeze({ ceiling: 0.944, attack: 0.005, release: 0.15 });
/** Seconds of sound a source may lack (decoder priming and padding, a last partial frame) before it counts as missing. */
const SHORTFALL_TOLERANCE = 0.25;

const abortError = () => new DOMException('Export cancelled', 'AbortError');
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Equal-power crossfade curve for the incoming sound (0 → 1 over p = 0..1). */
export const equalPowerIn = (p) => Math.sin(clamp(p, 0, 1) * Math.PI * 0.5);
/** Equal-power crossfade curve for the outgoing sound (1 → 0 over p = 0..1). */
export const equalPowerOut = (p) => Math.cos(clamp(p, 0, 1) * Math.PI * 0.5);

/** Linear fade factor at `local` seconds into a sound of `duration` seconds with fade in/out lengths. */
export function fadeGain(local, duration, fadeIn = 0, fadeOut = 0) {
  let g = 1;
  if (fadeIn > 0) g = Math.min(g, clamp(local / fadeIn, 0, 1));
  if (fadeOut > 0) g = Math.min(g, clamp((duration - local) / fadeOut, 0, 1));
  return g;
}

/** True when a main-track clip contributes sound (a video with an audio track, not muted, volume > 0). */
export function mainClipAudible(project, clip) {
  const m = project.media?.[clip.mediaId];
  if (!m || m.kind !== 'video' || m.hasAudio === false) return false;
  return !clip.muted && (clip.volume ?? 1) > 0;
}

/** True when an audio-track clip contributes sound (audio media, or a video's sound). */
export function audioClipAudible(project, clip) {
  const m = project.media?.[clip.mediaId];
  if (!m || m.kind === 'image' || (m.kind === 'video' && m.hasAudio === false)) return false;
  return !clip.muted && (clip.volume ?? 1) > 0;
}

/** Whether anything on the timeline would be heard within [start, end). */
export function hasAudibleContent(project, { start = 0, end = Infinity } = {}) {
  const lay = layoutProject(project);
  const overlaps = (it) => it.end > start && it.start < end;
  return lay.video.some((it) => overlaps(it) && mainClipAudible(project, it.clip)) || lay.audio.some((it) => overlaps(it) && audioClipAudible(project, it.clip));
}

/**
 * Gain of a main-track clip's sound at timeline time t (0 outside the clip).
 * @param {Object} item  VideoLayoutItem (layoutVideo / layoutProject().video)
 * @param {Object|null} next  the following layout item — its `transIn` window overlaps this clip's tail
 */
export function mainClipGainAt(item, next, t, { declick = DECLICK } = {}) {
  const { clip } = item;
  const volume = clip.muted ? 0 : Math.max(0, clip.volume ?? 1);
  if (volume <= 0 || t < item.start || t > item.end) return 0;
  const local = t - item.start;
  const dur = item.duration;
  let g = volume * fadeGain(local, dur, clip.fadeIn || 0, clip.fadeOut || 0);
  if (item.transIn) {
    if (t < item.transIn.end) g *= equalPowerIn((t - item.transIn.start) / item.transIn.duration);
  } else if (declick > 0 && !(clip.fadeIn > 0)) {
    g *= clamp(local / declick, 0, 1);
  }
  const out = next?.transIn;
  if (out) {
    if (t > out.start) g *= equalPowerOut((t - out.start) / out.duration);
  } else if (declick > 0 && !(clip.fadeOut > 0)) {
    g *= clamp((dur - local) / declick, 0, 1);
  }
  return g;
}

/** Gain of an audio-track clip at timeline time t (item from layoutProject().audio). */
export function audioClipGainAt(item, t, { declick = DECLICK } = {}) {
  const { clip } = item;
  const volume = clip.muted ? 0 : Math.max(0, clip.volume ?? 1);
  if (volume <= 0 || t < item.start || t > item.end) return 0;
  const local = t - item.start;
  let g = volume * fadeGain(local, item.duration, clip.fadeIn || 0, clip.fadeOut || 0);
  if (declick > 0) {
    if (!(clip.fadeIn > 0)) g *= clamp(local / declick, 0, 1);
    if (!(clip.fadeOut > 0)) g *= clamp((item.duration - local) / declick, 0, 1);
  }
  return g;
}

/**
 * Piecewise-linear approximation [{t, v}] of a gain function: exact values at every breakpoint, and adaptive
 * subdivision wherever the curve bends (equal-power ramps, overlapping fades) until the linear interpolation
 * error is below `tolerance`. Feed the points to AudioParam.linearRampToValueAtTime().
 */
export function gainEnvelope(gainAt, breakpoints, { tolerance = 0.002, maxDepth = 10 } = {}) {
  const pts = [...new Set(breakpoints.filter(Number.isFinite))].sort((a, b) => a - b);
  const out = [];
  const push = (t, v) => {
    const last = out[out.length - 1];
    if (last && t - last.t < 1e-9) return;
    out.push({ t, v });
  };
  const refine = (t0, v0, t1, v1, depth) => {
    if (depth >= maxDepth || t1 - t0 < 1e-4) return;
    const lerpAt = (k) => v0 + (v1 - v0) * k;
    const tm = (t0 + t1) / 2;
    const vm = gainAt(tm);
    const bent =
      Math.abs(vm - lerpAt(0.5)) > tolerance ||
      Math.abs(gainAt(t0 + (t1 - t0) * 0.25) - lerpAt(0.25)) > tolerance ||
      Math.abs(gainAt(t0 + (t1 - t0) * 0.75) - lerpAt(0.75)) > tolerance;
    if (!bent) return;
    refine(t0, v0, tm, vm, depth + 1);
    push(tm, vm);
    refine(tm, vm, t1, v1, depth + 1);
  };
  for (let i = 0; i < pts.length; i++) {
    const v = gainAt(pts[i]);
    if (i > 0) refine(pts[i - 1], out[out.length - 1].v, pts[i], v, 0);
    push(pts[i], v);
  }
  return out;
}

/**
 * The mix as a list of scheduled sources, relative to the render range start (pure).
 * @returns {Array<{mediaId:string, clipId:string, track:'video'|'audio', when:number, offset:number,
 *   duration:number, rate:number, envelope:Array<{t:number, v:number}>}>}
 *   when / envelope times: seconds from `start`; offset / duration: source-media seconds (buffer time).
 */
export function buildMixPlan(project, { start = 0, end = Infinity, declick = DECLICK } = {}) {
  const lay = layoutProject(project);
  const stop = Math.min(end, lay.duration);
  const plan = [];
  const add = (entry, gainAt, bps) => {
    const env = gainEnvelope(gainAt, bps.filter((x) => x >= entry.a - 1e-9 && x <= entry.b + 1e-9).concat([entry.a, entry.b]));
    if (!env.some((p) => p.v > 1e-5)) return; // silent all the way through
    plan.push({
      mediaId: entry.mediaId,
      clipId: entry.clipId,
      track: entry.track,
      when: entry.a - start,
      offset: entry.offset,
      duration: entry.duration,
      rate: entry.rate,
      envelope: env.map((p) => ({ t: Math.max(0, p.t - start), v: p.v })),
    });
  };

  lay.video.forEach((item, i) => {
    const { clip } = item;
    if (!mainClipAudible(project, clip)) return;
    const a = Math.max(item.start, start);
    const b = Math.min(item.end, stop);
    if (b - a <= 1e-6) return;
    const next = lay.video[i + 1] || null;
    const speed = clip.speed || 1;
    const bps = [item.start, item.start + declick, item.start + (clip.fadeIn || 0), item.end - (clip.fadeOut || 0), item.end - declick, item.end];
    if (item.transIn) bps.push(item.transIn.start, item.transIn.end);
    if (next?.transIn) bps.push(next.transIn.start, next.transIn.end);
    add(
      { mediaId: clip.mediaId, clipId: clip.id, track: 'video', a, b, offset: clip.in + (a - item.start) * speed, duration: (b - a) * speed, rate: speed },
      (t) => mainClipGainAt(item, next, t, { declick }),
      bps,
    );
  });

  for (const item of lay.audio) {
    const { clip } = item;
    if (!audioClipAudible(project, clip)) continue;
    const a = Math.max(item.start, start);
    const b = Math.min(item.end, stop);
    if (b - a <= 1e-6) continue;
    const bps = [item.start, item.start + declick, item.start + (clip.fadeIn || 0), item.end - (clip.fadeOut || 0), item.end - declick, item.end];
    add(
      { mediaId: clip.mediaId, clipId: clip.id, track: 'audio', a, b, offset: clip.in + (a - item.start), duration: b - a, rate: 1 },
      (t) => audioClipGainAt(item, t, { declick }),
      bps,
    );
  }
  return plan;
}

/**
 * Sources whose decoded sound ends before the mix needs it to (a truncated or damaged file, or an audio track that
 * is shorter than its video), per media: `[{mediaId, end, silent}]` — `end`: seconds of sound the file has,
 * `silent`: seconds of the render range where that sound should play but can't. Shortfalls under `tolerance`
 * seconds per clip (encoder padding, a last AAC frame) are ignored.
 * @param {Array} plan  buildMixPlan() entries
 * @param {Map<string, number>} durations  decoded duration (seconds) per media id
 * @returns {Array<{mediaId:string, end:number, silent:number}>}
 */
export function soundShortfalls(plan, durations, { tolerance = SHORTFALL_TOLERANCE } = {}) {
  const out = new Map();
  for (const src of plan) {
    const end = durations.get(src.mediaId);
    if (!(end >= 0)) continue;
    const silent = clamp(src.offset + src.duration - end, 0, src.duration) / src.rate;
    if (silent <= tolerance) continue;
    const e = out.get(src.mediaId) || { mediaId: src.mediaId, end, silent: 0 };
    e.silent += silent;
    out.set(src.mediaId, e);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------------------
// Step generators: long CPU work that can run in one go (runSteps) or in slices (runStepsSliced)
// ---------------------------------------------------------------------------------------------------------

/** Runs a step generator (timeStretchSteps, limiterSteps, wavSteps) to completion in one go; returns its result. */
export function runSteps(steps) {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * Hands control back to the event loop so input, rendering, timers and other queued tasks run first. A posted
 * message queues behind them; scheduler.yield() is deliberately not used — its continuations jump ahead of
 * other tasks, so chained yields starve timers (measured: 0 setInterval ticks per second while mixing).
 */
function yieldToEventLoop() {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => {
        port1.close();
        resolve();
      };
      port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Runs a step generator without freezing the page: after every `slice` ms of work it yields to the event loop,
 * reports the latest progress the generator yielded (a number 0..1) and throws an AbortError once `signal` is
 * aborted.
 * @returns {Promise<*>} the generator's return value
 */
export async function runStepsSliced(steps, { signal = null, slice = 12, onProgress = null } = {}) {
  if (signal?.aborted) throw abortError();
  let t0 = now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (now() - t0 < slice) continue;
    if (onProgress && typeof r.value === 'number') onProgress(clamp(r.value, 0, 1));
    await yieldToEventLoop();
    if (signal?.aborted) {
      steps.return();
      throw abortError();
    }
    t0 = now();
  }
}

const STEP_CHUNK = 1 << 16; // samples processed between check-ins of the step generators below

/** True if any sample of ch[i0, i1) exceeds ±ceiling. */
function exceeds(ch, i0, i1, ceiling) {
  for (let i = i0; i < i1; i++) if (ch[i] > ceiling || ch[i] < -ceiling) return true;
  return false;
}

/** g[i] = min(g[i], ceiling / |ch[i]|) over [i0, i1). */
function limitGain(g, ch, i0, i1, ceiling) {
  for (let i = i0; i < i1; i++) {
    const a = Math.abs(ch[i]);
    if (a > ceiling) g[i] = Math.min(g[i], ceiling / a);
  }
}

/** Backward look-ahead pass over [i0, i1) (descending): gain reduction ramps in ahead of each peak. */
function attackPass(g, i0, i1, k) {
  for (let i = i1 - 1; i >= i0; i--) {
    const ahead = 1 - (1 - g[i + 1]) * k;
    if (ahead < g[i]) g[i] = ahead;
  }
}

/** Forward release pass over [i0, i1); returns the smallest gain seen. */
function releasePass(g, i0, i1, k, minGain) {
  for (let i = i0; i < i1; i++) {
    const held = 1 - (1 - g[i - 1]) * k;
    if (held < g[i]) g[i] = held;
    if (g[i] < minGain) minGain = g[i];
  }
  return minGain;
}

function applyGain(ch, g, i0, i1) {
  for (let i = i0; i < i1; i++) ch[i] *= g[i];
}

/**
 * Look-ahead peak limiter as a step generator (yields progress 0..1; returns {minGain}). Applied in place to
 * planar channel data (Float32Array per channel). Guarantees |sample| <= ceiling. Gain reduction starts `attack`
 * seconds ahead of each peak (exponential) and recovers with the `release` time constant. Material that never
 * exceeds the ceiling is left bit-identical.
 */
export function* limiterSteps(channels, sampleRate, { ceiling = LIMITER_DEFAULTS.ceiling, attack = LIMITER_DEFAULTS.attack, release = LIMITER_DEFAULTS.release } = {}) {
  const n = channels[0]?.length || 0;
  const C = channels.length;
  const passes = 3 * C + 2; // scan, gain, attack, release, apply
  let pass = 0;
  const at = (done) => (pass + done / Math.max(1, n)) / passes;
  let over = false;
  for (const ch of channels) {
    for (let i0 = 0; i0 < n && !over; i0 += STEP_CHUNK) {
      over = exceeds(ch, i0, Math.min(n, i0 + STEP_CHUNK), ceiling);
      yield at(i0);
    }
    if (over) break;
    pass++;
  }
  if (!over) return { minGain: 1 };
  pass = C;
  const g = new Float32Array(n).fill(1);
  for (const ch of channels) {
    for (let i0 = 0; i0 < n; i0 += STEP_CHUNK) {
      limitGain(g, ch, i0, Math.min(n, i0 + STEP_CHUNK), ceiling);
      yield at(i0);
    }
    pass++;
  }
  const ka = Math.exp(-1 / Math.max(1, attack * sampleRate));
  for (let i1 = n - 1; i1 > 0; i1 -= STEP_CHUNK) {
    attackPass(g, Math.max(0, i1 - STEP_CHUNK), i1, ka);
    yield at(n - i1);
  }
  pass++;
  const kr = Math.exp(-1 / Math.max(1, release * sampleRate));
  let minGain = n ? g[0] : 1;
  for (let i0 = 1; i0 < n; i0 += STEP_CHUNK) {
    minGain = releasePass(g, i0, Math.min(n, i0 + STEP_CHUNK), kr, minGain);
    yield at(i0);
  }
  pass++;
  for (const ch of channels) {
    for (let i0 = 0; i0 < n; i0 += STEP_CHUNK) {
      applyGain(ch, g, i0, Math.min(n, i0 + STEP_CHUNK));
      yield at(i0);
    }
    pass++;
  }
  return { minGain };
}

/**
 * Look-ahead peak limiter, applied in place to planar channel data (see limiterSteps).
 * @returns {{minGain: number}}
 */
export function applyLimiter(channels, sampleRate, opts) {
  return runSteps(limiterSteps(channels, sampleRate, opts));
}

/** dst[i] += src[i] */
function addInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] += src[i];
}

/**
 * Pitch-preserving time stretch as a step generator (yields progress 0..1; returns the new channels).
 * WSOLA, the algorithm family Chrome uses for media elements with preservesPitch, so retimed clips sound like
 * the preview. rate > 1 speeds up (shorter output), rate < 1 slows down. Frames of `windowMs` are overlap-added
 * with a periodic Hann window at half-window hops; each frame's source position is searched within ±`searchMs`
 * of its nominal position for the best (normalized) continuation of the previous one.
 */
export function* timeStretchSteps(channels, rate, sampleRate, { windowMs = 20, searchMs = 10 } = {}) {
  const n = channels[0]?.length || 0;
  const outLen = rate > 0 ? Math.max(0, Math.round(n / rate)) : 0;
  const out = channels.map(() => new Float32Array(outLen));
  if (!n || !outLen) return out;
  if (Math.abs(rate - 1) < 1e-6) {
    channels.forEach((ch, c) => out[c].set(ch.subarray(0, outLen)));
    return out;
  }
  const W = Math.max(64, 2 * Math.round((windowMs / 2000) * sampleRate));
  const hop = W / 2;
  const delta = Math.max(1, Math.round((searchMs / 1000) * sampleRate));
  const win = new Float32Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W);
  const mono = new Float32Array(n);
  for (const ch of channels) addInto(mono, ch);
  yield 0;
  const at = (i) => (i >= 0 && i < n ? mono[i] : 0);
  // Normalized similarity of the candidate's first half-window with the natural continuation of the last frame.
  const score = (p, target, step) => {
    let dot = 0;
    let energy = 1e-9;
    for (let i = 0; i < hop; i += step) {
      const x = at(p + i);
      dot += x * at(target + i);
      energy += x * x;
    }
    return dot / Math.sqrt(energy);
  };
  let prev = 0;
  /** Places frame k: finds its best-matching source position and overlap-adds it. */
  const place = (k) => {
    let pos = 0;
    if (k > 0) {
      const target = prev + hop;
      const nominal = Math.round(k * hop * rate);
      const lo = Math.max(0, nominal - delta);
      const hi = Math.max(lo, Math.min(n - 1, nominal + delta));
      let best = Math.min(Math.max(nominal, lo), hi);
      let bestScore = -Infinity;
      for (let p = lo; p <= hi; p += 4) {
        const s = score(p, target, 4);
        if (s > bestScore) [bestScore, best] = [s, p];
      }
      const lo2 = Math.max(lo, best - 3);
      const hi2 = Math.min(hi, best + 3);
      bestScore = -Infinity;
      for (let p = lo2; p <= hi2; p++) {
        const s = score(p, target, 1);
        if (s > bestScore) [bestScore, best] = [s, p];
      }
      pos = best;
    }
    const o = k * hop;
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = out[c];
      for (let i = 0; i < W && o + i < outLen; i++) {
        const si = pos + i;
        // The first frame has no predecessor to overlap with: keep its leading half at full gain.
        if (si < n) dst[o + i] += src[si] * (k === 0 && i < hop ? 1 : win[i]);
      }
    }
    prev = pos;
  };
  const frames = Math.ceil(outLen / hop);
  for (let k = 0; k < frames; k++) {
    place(k);
    if ((k & 31) === 31) yield k / frames;
  }
  return out;
}

/**
 * Pitch-preserving time stretch (see timeStretchSteps).
 * @param {Float32Array[]} channels
 * @returns {Float32Array[]} new channels of length round(n / rate)
 */
export function timeStretch(channels, rate, sampleRate, opts) {
  return runSteps(timeStretchSteps(channels, rate, sampleRate, opts));
}

/** Short linear fade at both ends of the master (avoids clicks when a range starts/ends mid-sound). */
export function applyEdgeFades(channels, sampleRate, seconds = 0.002) {
  const n = channels[0]?.length || 0;
  const len = Math.min(Math.floor(n / 2), Math.round(seconds * sampleRate));
  if (len <= 0) return;
  for (const ch of channels) {
    for (let i = 0; i < len; i++) {
      const k = i / len;
      ch[i] *= k;
      ch[n - 1 - i] *= k;
    }
  }
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Float sample -> 16-bit PCM (clipped). */
const toPcm16 = (x) => {
  const s = x > 1 ? 1 : x < -1 ? -1 : x || 0;
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
};

/** Interleaves channel c of frames [i0, i1) into pcm. */
function pcmChunk(pcm, ch, c, numCh, i0, i1) {
  for (let i = i0, o = i0 * numCh + c; i < i1; i++, o += numCh) pcm[o] = toPcm16(ch[i]);
}

/**
 * 16-bit PCM WAV encoder as a step generator (yields progress 0..1; returns the file as an ArrayBuffer).
 * RIFF, little endian, interleaved.
 */
export function* wavSteps(channels, sampleRate) {
  const numCh = Math.max(1, channels.length);
  const n = channels[0]?.length || 0;
  const blockAlign = numCh * 2;
  const dataSize = n * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);
  if (LITTLE_ENDIAN) {
    const pcm = new Int16Array(buf, 44, n * numCh);
    for (let c = 0; c < numCh; c++) {
      const ch = channels[c] || channels[0];
      for (let i0 = 0; i0 < n; i0 += STEP_CHUNK) {
        pcmChunk(pcm, ch, c, numCh, i0, Math.min(n, i0 + STEP_CHUNK));
        yield (c + i0 / n) / numCh;
      }
    }
  } else {
    for (let i0 = 0; i0 < n; i0 += STEP_CHUNK) {
      const i1 = Math.min(n, i0 + STEP_CHUNK);
      for (let i = i0, o = 44 + i0 * blockAlign; i < i1; i++) {
        for (let c = 0; c < numCh; c++, o += 2) view.setInt16(o, toPcm16((channels[c] || channels[0])[i]), true);
      }
      yield i0 / n;
    }
  }
  return buf;
}

/**
 * Encodes planar float channels as a 16-bit PCM WAV file (RIFF, little endian, interleaved).
 * @param {Float32Array[]} channels
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate) {
  return runSteps(wavSteps(channels, sampleRate));
}

// ---------------------------------------------------------------------------------------------------------
// Web Audio rendering (browser only)
// ---------------------------------------------------------------------------------------------------------

function applyEnvelope(param, envelope) {
  const [first, ...rest] = envelope;
  param.value = first.v;
  param.setValueAtTime(first.v, first.t);
  for (const p of rest) param.linearRampToValueAtTime(p.v, p.t);
}

/** Planar channel views of an AudioBuffer. */
export const bufferChannels = (buffer) => Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));

/** Seconds of sound a media file's audio track claims to hold (its packet index), or null when that can't be read. */
async function declaredAudioDuration(mediaId) {
  let input = null;
  try {
    const media = await import('../core/media.js');
    const blob = await media.getMediaBlob(mediaId);
    if (!blob) return null;
    const MB = await media.loadMediabunny();
    input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(blob) });
    const track = await input.getPrimaryAudioTrack();
    return track ? await track.computeDuration() : null;
  } catch {
    return null;
  } finally {
    input?.dispose?.();
  }
}

/** The [offset, offset + duration) source seconds of `buffer`, time-stretched by `rate`, as a new AudioBuffer. */
async function stretchedSegment(ctx, buffer, offset, duration, rate, run) {
  const sr = buffer.sampleRate;
  const s0 = Math.max(0, Math.floor(offset * sr));
  const s1 = Math.min(buffer.length, Math.ceil((offset + duration) * sr));
  const parts = bufferChannels(buffer).map((ch) => ch.subarray(s0, Math.max(s0, s1)));
  const stretched = await run(timeStretchSteps(parts, rate, sr));
  const out = ctx.createBuffer(buffer.numberOfChannels, Math.max(1, stretched[0].length), sr);
  stretched.forEach((ch, c) => out.copyToChannel(ch, c));
  return out;
}

/**
 * Renders the sequence's sound between `start` and `end` (timeline seconds) to a stereo AudioBuffer.
 * Sources come from core/media.js getAudioBuffer() (decoded once, cached) unless `getBuffer` is given.
 * Retimed main-track clips keep their pitch (like the preview's media elements) unless `preservePitch` is false.
 * Sources whose sound can't be loaded are left out, and sound that ends before its clips do (truncated or damaged
 * file) leaves silence; both are reported through `onWarning({mediaId, name, message})`.
 * `onProgress(fraction)` follows decoding, stretching, rendering and limiting.
 * @param {Object} project
 * @param {{start?:number, end?:number, sampleRate?:number, signal?:AbortSignal, limiter?:boolean,
 *   preservePitch?:boolean, getBuffer?:(mediaId:string)=>Promise<AudioBuffer|null>,
 *   onProgress?:(fraction:number)=>void, onWarning?:(w:{mediaId:string, name:string, message:string})=>void}} [opts]
 * @returns {Promise<AudioBuffer>}
 */
export async function renderAudioMix(
  project,
  { start = 0, end = null, sampleRate = DEFAULT_SAMPLE_RATE, signal = null, limiter = true, preservePitch = true, getBuffer = null, onProgress = null, onWarning = null } = {},
) {
  if (signal?.aborted) throw abortError();
  const stop = end ?? layoutProject(project).duration;
  const length = Math.max(1, Math.ceil((stop - start) * sampleRate - 1e-6));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const plan = buildMixPlan(project, { start, end: stop });
  const report = (f) => {
    try {
      onProgress?.(clamp(f, 0, 1));
    } catch (e) {
      console.warn('[gis] audio mix progress listener failed', e);
    }
  };
  const run = (steps, from, span) => runStepsSliced(steps, { signal, onProgress: (f) => report(from + span * f) });

  // Progress budget: decoding, pitch-preserving stretches (when any), rendering, limiter.
  const retimed = (src) => preservePitch && Math.abs(src.rate - 1) > 1e-3;
  const stretchTotal = plan.reduce((s, src) => s + (retimed(src) ? src.duration / src.rate : 0), 0);
  const share = stretchTotal > 0 ? { decode: 0.25, stretch: 0.55, render: 0.1 } : { decode: 0.6, stretch: 0, render: 0.2 };
  report(0);

  const load = getBuffer || (await import('../core/media.js')).getAudioBuffer;
  const ids = [...new Set(plan.map((p) => p.mediaId))];
  let loaded = 0;
  const buffers = new Map(
    await Promise.all(
      ids.map(async (id) => {
        let buffer = null;
        let reason = '';
        try {
          buffer = await load(id);
        } catch (e) {
          console.warn('[gis] audio decode failed', id, e);
          reason = e?.message || String(e);
        }
        if (!buffer && !signal?.aborted) {
          const name = project.media?.[id]?.name || 'a clip';
          try {
            onWarning?.({ mediaId: id, name, message: `The sound of "${name}" couldn't be decoded${reason ? ` (${reason})` : ''}, so it is missing from this export.` });
          } catch {
            /* reporting is best effort */
          }
        }
        report(share.decode * (++loaded / ids.length));
        return [id, buffer];
      }),
    ),
  );
  if (signal?.aborted) throw abortError();

  // Sound that ends before its clips do leaves silence. Worth a warning when the file promises more sound than
  // decodes (truncated or damaged download); an audio track that is simply shorter than its video is silent in the
  // preview as well.
  const decoded = new Map([...buffers].filter(([, b]) => b).map(([id, b]) => [id, b.duration]));
  for (const { mediaId, end, silent } of soundShortfalls(plan, decoded)) {
    const declared = getBuffer ? null : await declaredAudioDuration(mediaId);
    if (declared != null && declared <= end + SHORTFALL_TOLERANCE) continue;
    const name = project.media?.[mediaId]?.name || 'a clip';
    try {
      onWarning?.({ mediaId, name, message: `The sound of "${name}" stops at ${formatTime(end)} (the file may be damaged or incomplete), so this export is silent for ${formatDuration(silent)} where it should play.` });
    } catch {
      /* reporting is best effort */
    }
  }
  if (signal?.aborted) throw abortError();

  let stretched = 0;
  for (const src of plan) {
    let buffer = buffers.get(src.mediaId);
    if (!buffer || src.offset >= buffer.duration - 1e-4) continue;
    let { offset, duration, rate } = src;
    if (retimed(src)) {
      const work = duration / rate;
      buffer = await stretchedSegment(ctx, buffer, offset, duration, rate, (steps) =>
        run(steps, share.decode + (share.stretch * stretched) / stretchTotal, (share.stretch * work) / stretchTotal),
      );
      stretched += work;
      [offset, duration, rate] = [0, buffer.duration, 1];
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = rate;
    const gain = ctx.createGain();
    applyEnvelope(gain.gain, src.envelope);
    node.connect(gain).connect(ctx.destination);
    node.start(src.when, offset, duration);
  }
  report(share.decode + share.stretch);
  const rendered = await ctx.startRendering();
  if (signal?.aborted) throw abortError();
  const done = share.decode + share.stretch + share.render;
  report(done);
  const channels = bufferChannels(rendered);
  applyEdgeFades(channels, sampleRate);
  if (limiter) await run(limiterSteps(channels, sampleRate), done, 1 - done);
  report(1);
  return rendered;
}

/** 16-bit PCM WAV Blob of an AudioBuffer. */
export function audioBufferToWav(buffer) {
  return new Blob([encodeWav(bufferChannels(buffer), buffer.sampleRate)], { type: 'audio/wav' });
}
