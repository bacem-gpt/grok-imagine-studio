// Audio clip tools shared by the realtime preview (engine/player.js) and the export mixdown (engine/audio-mix.js):
//
//  * EQ presets (iMovie's Equalizer menu) as BiquadFilterNode chains — identical in the AudioContext of the preview
//    and the OfflineAudioContext of the mixdown, so both sound the same.
//  * Ducking (iMovie's "Reduce volume of other tracks"): an audio-track clip with `duck` lowers every other sound
//    (main-track clips, overlays, the other audio clips) by `duckAmount` while it plays, with short ramps before it
//    starts and after it ends. duckFactorAt() is the gain multiplier at a timeline time; both engines use it.
//  * Voice-over recording helpers (recorder MIME type choice, file names).
//
// Everything here except buildEqChain() is pure and unit-tested in node (tests/unit/cliptools.test.mjs).

import { layoutProject, DEFAULT_DUCK_AMOUNT } from '../core/model.js';
import { clamp } from '../core/utils.js';

/** Seconds over which ducking fades in before a ducking clip starts (and back out after it ends). */
export const DUCK_RAMP = 0.3;

/**
 * Equalizer presets: [{id, name, filters: [{type, frequency, Q, gain}]}] — BiquadFilterNode parameters.
 * Hum reduction notches the mains frequency and its first harmonics; background-noise reduction is a band limit
 * (rumble below 100 Hz and hiss above 7.5 kHz) — not a full noise gate.
 */
export const EQ_PRESETS = [
  { id: 'none', name: 'None', filters: [] },
  {
    id: 'voice',
    name: 'Voice enhance',
    filters: [
      { type: 'highpass', frequency: 90, Q: 0.7 },
      { type: 'peaking', frequency: 250, Q: 1, gain: -3 },
      { type: 'peaking', frequency: 3200, Q: 0.9, gain: 4 },
    ],
  },
  {
    id: 'music',
    name: 'Music enhance',
    filters: [
      { type: 'lowshelf', frequency: 110, gain: 3 },
      { type: 'peaking', frequency: 1000, Q: 0.7, gain: -1 },
      { type: 'highshelf', frequency: 8000, gain: 3 },
    ],
  },
  { id: 'bass', name: 'Bass boost', filters: [{ type: 'lowshelf', frequency: 120, gain: 6 }] },
  { id: 'treble', name: 'Treble boost', filters: [{ type: 'highshelf', frequency: 4000, gain: 6 }] },
  {
    id: 'hum50',
    name: 'Hum reduction (50 Hz)',
    filters: [50, 100, 150].map((frequency) => ({ type: 'notch', frequency, Q: 25 })),
  },
  {
    id: 'hum60',
    name: 'Hum reduction (60 Hz)',
    filters: [60, 120, 180].map((frequency) => ({ type: 'notch', frequency, Q: 25 })),
  },
  {
    id: 'denoise',
    name: 'Reduce background noise',
    filters: [
      { type: 'highpass', frequency: 100, Q: 0.7 },
      { type: 'lowpass', frequency: 7500, Q: 0.7 },
    ],
  },
];

const EQ_BY_ID = new Map(EQ_PRESETS.map((p) => [p.id, p]));

/** Filter specs of an EQ preset id ([] for none / unknown ids). */
export const eqFilters = (id) => EQ_BY_ID.get(id || 'none')?.filters || [];

/** Display name of an EQ preset id. */
export const eqName = (id) => EQ_BY_ID.get(id || 'none')?.name || 'None';

/**
 * Builds a BiquadFilterNode chain for an EQ preset in any BaseAudioContext.
 * @returns {{input: AudioNode, output: AudioNode, nodes: BiquadFilterNode[]}|null} null for 'none' (connect directly)
 */
export function buildEqChain(ctx, id) {
  const specs = eqFilters(id);
  if (!specs.length) return null;
  const nodes = specs.map((f) => {
    const n = ctx.createBiquadFilter();
    n.type = f.type;
    n.frequency.value = f.frequency;
    if (f.Q != null) n.Q.value = f.Q;
    if (f.gain != null) n.gain.value = f.gain;
    return n;
  });
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
  return { input: nodes[0], output: nodes[nodes.length - 1], nodes };
}

// ---------------------------------------------------------------------------------------------------------
// Ducking
// ---------------------------------------------------------------------------------------------------------

/** True when an audio-track clip ducks the other sounds (it must be audible itself). */
export function isDucker(project, clip) {
  if (!clip?.duck) return false;
  const m = project.media?.[clip.mediaId];
  if (!m || m.kind === 'image' || (m.kind === 'video' && m.hasAudio === false)) return false;
  return !clip.muted && (clip.volume ?? 1) > 0 && (clip.duckAmount ?? DEFAULT_DUCK_AMOUNT) > 0;
}

/**
 * Time windows where ducking applies: [{id, start, end, amount}] (timeline seconds), one per ducking clip.
 * @param {Object} project
 * @param {Object} [layout]  layoutProject(project), when already computed
 */
export function duckWindows(project, layout = null) {
  const lay = layout || layoutProject(project);
  return lay.audio
    .filter((it) => isDucker(project, it.clip))
    .map((it) => ({ id: it.clip.id, start: it.start, end: it.end, amount: clamp(it.clip.duckAmount ?? DEFAULT_DUCK_AMOUNT, 0, 1) }));
}

/**
 * Gain multiplier (0..1) that ducking applies to a ducked sound at timeline time t: 1 - amount, ramped linearly over
 * DUCK_RAMP seconds before each window starts and after it ends; overlapping windows take the deepest reduction.
 */
export function duckFactorAt(windows, t, ramp = DUCK_RAMP) {
  let f = 1;
  for (const w of windows) {
    let k = 0;
    if (t >= w.start && t <= w.end) k = 1;
    else if (ramp > 0 && t > w.start - ramp && t < w.start) k = (t - (w.start - ramp)) / ramp;
    else if (ramp > 0 && t > w.end && t < w.end + ramp) k = 1 - (t - w.end) / ramp;
    if (k > 0) f = Math.min(f, 1 - w.amount * k);
  }
  return f;
}

/** Every kink of duckFactorAt() (for piecewise-linear gain envelopes). */
export const duckBreakpoints = (windows, ramp = DUCK_RAMP) => windows.flatMap((w) => [w.start - ramp, w.start, w.end, w.end + ramp]);

// ---------------------------------------------------------------------------------------------------------
// Voice-over recording
// ---------------------------------------------------------------------------------------------------------

const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', ''];

/** First MediaRecorder MIME type this browser supports ('' = the browser's default). */
export function pickRecorderMime(isTypeSupported = () => false) {
  for (const t of RECORDER_TYPES) {
    if (!t) return '';
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      /* try the next one */
    }
  }
  return '';
}

/** File extension for a recorded blob's MIME type. */
export function recordingExtension(mime = '') {
  if (/ogg/.test(mime)) return 'ogg';
  if (/mp4|aac/.test(mime)) return 'm4a';
  return 'webm';
}

/**
 * What a microphone error means for the user: {message, tab} — `tab` true when opening the studio in its own tab
 * may help (the page embedding it blocks the microphone).
 */
export function micErrorInfo(err, { embedded = false } = {}) {
  const name = err?.name || '';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { message: 'No microphone was found — plug one in and try again.', tab: false };
  if (name === 'NotReadableError') return { message: 'The microphone is busy in another app — close it and try again.', tab: false };
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return embedded
      ? { message: 'This page blocks the microphone for the studio. Open the studio in its own tab to record a voice-over.', tab: true }
      : { message: 'Microphone access was denied — allow it in the browser’s site settings and try again.', tab: false };
  }
  return { message: `Could not start the microphone${err?.message ? `: ${err.message}` : ''}.`, tab: embedded };
}
