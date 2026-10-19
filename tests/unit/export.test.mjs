// Pure logic of the export area: audio mix plan / gain envelopes / limiter / WAV encoding (engine/audio-mix.js)
// and frame planning / bitrates / ranges / validation (engine/exporter.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../extension/studio/core/model.js';
import {
  equalPowerIn,
  equalPowerOut,
  fadeGain,
  mainClipGainAt,
  audioClipGainAt,
  gainEnvelope,
  buildMixPlan,
  hasAudibleContent,
  applyLimiter,
  applyEdgeFades,
  encodeWav,
  timeStretch,
  runSteps,
  runStepsSliced,
  timeStretchSteps,
  limiterSteps,
  wavSteps,
  soundShortfalls,
  DECLICK,
} from '../../extension/studio/engine/audio-mix.js';
import {
  videoBitrateFor,
  audioBitrateFor,
  evenDimensions,
  resolveRange,
  planFrames,
  estimateExportBytes,
  exportFilename,
  exportProblems,
  pictureTail,
  releasableAudioIds,
  decodeGapMessage,
  untaggedVideoMatrix,
  StillCache,
  QUALITY_PRESETS,
} from '../../extension/studio/engine/exporter.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** red 4s -> green 3s (crossfade 0.5) -> blue 5s (wipe 0.5), music 12s on the audio track. */
function sampleProject({ hasAudio = true } = {}) {
  let p = M.createProject('Test');
  p = M.addMedia(p, M.createMediaItem({ id: 'r', kind: 'video', duration: 4, hasAudio, status: 'ready', name: 'red' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'g', kind: 'video', duration: 3, hasAudio, status: 'ready', name: 'green' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'b', kind: 'video', duration: 5, hasAudio, status: 'ready', name: 'blue' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'm', kind: 'audio', duration: 12, hasAudio: true, status: 'ready', name: 'music' }));
  p = M.appendMediaToTimeline(p, ['r', 'g', 'b']).project;
  p = M.setTransition(p, p.tracks.video[1].id, { type: 'crossfade', duration: 0.5 });
  p = M.setTransition(p, p.tracks.video[2].id, { type: 'wipe-left', duration: 0.5 });
  return p;
}

// ---------------------------------------------------------------------------------------------- gains

test('equal-power curves keep constant power and hit their endpoints', () => {
  for (let i = 0; i <= 20; i++) {
    const p = i / 20;
    assert.ok(near(equalPowerIn(p) ** 2 + equalPowerOut(p) ** 2, 1, 1e-12));
  }
  assert.equal(equalPowerIn(0), 0);
  assert.ok(near(equalPowerIn(1), 1));
  assert.equal(equalPowerOut(0), 1);
  assert.ok(near(equalPowerOut(1), 0));
  assert.equal(equalPowerIn(-1), 0); // clamped
  assert.ok(near(equalPowerOut(2), 0));
});

test('fadeGain applies linear fade in / out', () => {
  assert.equal(fadeGain(0, 10, 2, 0), 0);
  assert.equal(fadeGain(1, 10, 2, 0), 0.5);
  assert.equal(fadeGain(5, 10, 2, 2), 1);
  assert.equal(fadeGain(9, 10, 0, 2), 0.5);
  assert.equal(fadeGain(10, 10, 0, 2), 0);
  assert.equal(fadeGain(5, 10), 1);
});

test('main-track gains crossfade with equal power across a transition', () => {
  const p = sampleProject();
  const lay = M.layoutProject(p);
  const [a, b, c] = lay.video;
  assert.equal(b.start, 3.5); // crossfade window [3.5, 4)
  const ga = (t) => mainClipGainAt(a, b, t);
  const gb = (t) => mainClipGainAt(b, c, t);
  assert.equal(ga(2), 1);
  assert.equal(ga(3.5), 1);
  assert.ok(near(ga(4), 0));
  assert.equal(gb(3.5), 0);
  assert.ok(near(gb(4), 1));
  for (const t of [3.55, 3.7, 3.75, 3.9]) assert.ok(near(ga(t) ** 2 + gb(t) ** 2, 1, 1e-9), `power at ${t}`);
  assert.ok(near(ga(3.75), Math.SQRT1_2) && near(gb(3.75), Math.SQRT1_2));
  assert.equal(ga(4.1), 0); // outside the clip
  // de-click ramp at the very start (hard edge, no fade)
  assert.equal(ga(0), 0);
  assert.ok(near(ga(DECLICK / 2), 0.5));
  // volume, mute
  const loud = { ...a, clip: { ...a.clip, volume: 1.5 } };
  assert.equal(mainClipGainAt(loud, b, 2), 1.5);
  assert.equal(mainClipGainAt({ ...a, clip: { ...a.clip, muted: true } }, b, 2), 0);
  assert.equal(mainClipGainAt({ ...a, clip: { ...a.clip, volume: 0 } }, b, 2), 0);
});

test('clip fades multiply with transitions; audio-track clips fade and de-click', () => {
  let p = sampleProject();
  p = M.updateClip(p, p.tracks.video[0].id, { fadeIn: 1, fadeOut: 1 });
  const lay = M.layoutProject(p);
  const [a, b] = lay.video;
  assert.equal(mainClipGainAt(a, b, 0.5), 0.5); // fade in, no de-click when fading
  // inside both the fade-out (3..4) and the outgoing crossfade (3.5..4): product of both
  const t = 3.75;
  assert.ok(near(mainClipGainAt(a, b, t), 0.25 * equalPowerOut(0.5), 1e-9));

  const m = M.addAudioClip(p, 'm', { start: 1, fadeIn: 2, fadeOut: 3, volume: 0.8 });
  const item = M.layoutProject(m.project).audio[0];
  assert.equal(item.start, 1);
  assert.ok(near(audioClipGainAt(item, 2), 0.4)); // half way into the fade in
  assert.ok(near(audioClipGainAt(item, 7), 0.8));
  assert.ok(near(audioClipGainAt(item, 13 - 1.5), 0.4)); // half way through the fade out (ends at 13)
  assert.equal(audioClipGainAt(item, 0.5), 0);
  const hard = M.layoutProject(M.addAudioClip(p, 'm', { start: 0 }).project).audio[0];
  assert.equal(audioClipGainAt(hard, 0), 0);
  assert.ok(near(audioClipGainAt(hard, DECLICK), 1));
  assert.equal(audioClipGainAt({ ...hard, clip: { ...hard.clip, muted: true } }, 5), 0);
});

test('gainEnvelope is exact at breakpoints and approximates curves within tolerance', () => {
  const f = (t) => (t < 1 ? 1 : t < 2 ? equalPowerOut(t - 1) : 0);
  const env = gainEnvelope(f, [0, 1, 2, 3], { tolerance: 0.002 });
  for (let i = 1; i < env.length; i++) assert.ok(env[i].t > env[i - 1].t, 'strictly increasing times');
  for (const bp of [0, 1, 2, 3]) assert.ok(env.some((p) => near(p.t, bp) && near(p.v, f(bp))), `breakpoint ${bp}`);
  // flat segments add no points; the curve gets several
  assert.equal(env.filter((p) => p.t < 1).length, 1);
  assert.ok(env.filter((p) => p.t > 1 && p.t < 2).length >= 4);
  // linear interpolation error everywhere below tolerance (+ a little slack between probes)
  const lerp = (t) => {
    const i = env.findIndex((p) => p.t >= t);
    if (i <= 0) return env[0].v;
    const a = env[i - 1];
    const b = env[i];
    return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  };
  for (let t = 0; t <= 3; t += 0.0137) assert.ok(Math.abs(lerp(t) - f(t)) < 0.004, `error at ${t}`);
});

// ---------------------------------------------------------------------------------------------- mix plan

test('buildMixPlan schedules main-track sound and music with source offsets', () => {
  let p = sampleProject();
  const music = M.addAudioClip(p, 'm', { start: 0.5, in: 2, fadeOut: 2 });
  p = M.updateClip(music.project, music.id, { out: 10 });
  const plan = buildMixPlan(p);
  assert.deepEqual(plan.map((s) => s.mediaId), ['r', 'g', 'b', 'm']);
  const [r, g, b, m] = plan;
  assert.deepEqual([r.when, r.offset, r.duration, r.rate], [0, 0, 4, 1]);
  assert.deepEqual([g.when, g.offset, g.duration], [3.5, 0, 3]);
  assert.deepEqual([b.when, b.offset, b.duration], [6, 0, 5]);
  assert.deepEqual([m.when, m.offset, m.duration, m.track], [0.5, 2, 8, 'audio']);
  // envelopes start at `when` and end at its end, times relative to the range start
  for (const s of plan) {
    assert.ok(near(s.envelope[0].t, s.when));
    assert.ok(near(s.envelope[s.envelope.length - 1].t, s.when + s.duration / s.rate));
  }
  // the music fades out to silence
  assert.ok(near(m.envelope[m.envelope.length - 1].v, 0));
});

test('buildMixPlan honours speed, ranges, mutes, images and silent media', () => {
  let p = sampleProject();
  p = M.updateClip(p, p.tracks.video[0].id, { speed: 2 }); // red now lasts 2s on the timeline
  const lay = M.layoutProject(p);
  assert.equal(lay.video[0].duration, 2);
  const plan = buildMixPlan(p, { start: 1, end: 5 });
  const r = plan.find((s) => s.mediaId === 'r');
  assert.deepEqual([r.when, r.offset, r.duration, r.rate], [0, 2, 2, 2]); // starts 1s into the clip = 2s of source
  assert.ok(plan.every((s) => s.when >= 0 && s.envelope.every((e) => e.t >= 0 && e.t <= 4 + 1e-9)));
  const g = plan.find((s) => s.mediaId === 'g'); // green: 1.5s .. 4.5s on the timeline
  assert.deepEqual([g.when, g.offset, g.duration], [0.5, 0, 3]);
  const b = plan.find((s) => s.mediaId === 'b'); // blue starts at 4s, cut at the range end (5s)
  assert.deepEqual([b.when, b.offset, b.duration], [3, 0, 1]);

  let q = M.updateClip(sampleProject(), sampleProject().tracks.video[0].id, {});
  q = M.updateClip(q, q.tracks.video[1].id, { muted: true });
  assert.ok(!buildMixPlan(q).some((s) => s.mediaId === 'g'));
  const silent = sampleProject({ hasAudio: false });
  assert.equal(buildMixPlan(silent).length, 0);
  assert.equal(hasAudibleContent(silent), false);
  assert.equal(hasAudibleContent(M.addAudioClip(silent, 'm', { start: 0 }).project), true);
  assert.equal(hasAudibleContent(M.addAudioClip(silent, 'm', { start: 20 }).project, { start: 0, end: 5 }), false);

  let img = M.createProject();
  img = M.addMedia(img, M.createMediaItem({ id: 'i', kind: 'image', status: 'ready' }));
  img = M.appendMediaToTimeline(img, ['i']).project;
  assert.equal(buildMixPlan(img).length, 0);
  // a video used on the audio track contributes its sound
  const vid = M.addAudioClip(sampleProject(), 'r', { start: 1 }).project;
  assert.ok(buildMixPlan(vid).some((s) => s.track === 'audio' && s.mediaId === 'r'));
});

// ---------------------------------------------------------------------------------------------- limiter & wav

test('limiter leaves quiet material untouched and caps peaks smoothly', () => {
  const sr = 1000;
  const quiet = [Float32Array.from({ length: 500 }, (_, i) => 0.5 * Math.sin(i / 5))];
  const copy = Float32Array.from(quiet[0]);
  assert.deepEqual(applyLimiter(quiet, sr), { minGain: 1 });
  assert.deepEqual(quiet[0], copy);

  const n = 2000;
  const left = Float32Array.from({ length: n }, (_, i) => (i >= 1000 && i < 1010 ? 1.8 : 0.5));
  const right = Float32Array.from({ length: n }, () => 0.3);
  const { minGain } = applyLimiter([left, right], sr, { ceiling: 0.9, attack: 0.005, release: 0.05 });
  assert.ok(minGain <= 0.5 + 1e-6);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(left[i]) <= 0.9 + 1e-6 && Math.abs(right[i]) <= 0.9 + 1e-6);
  assert.ok(left[990] < 0.5, 'gain reduction starts ahead of the peak');
  assert.ok(left[500] > 0.4999, 'far from the peak the signal is untouched');
  assert.ok(right[1005] < 0.3, 'channels are linked');
  assert.ok(left[1100] > left[1020], 'gain recovers after the peak');
});

test('timeStretch changes duration but keeps pitch and level (WSOLA)', () => {
  const sr = 48000;
  const n = sr; // 1 s
  const sine = (f, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));
  const amp = (x, f, from, len) => {
    // Goertzel amplitude of frequency f over x[from, from + len)
    const k = (2 * Math.PI * f) / sr;
    let p1 = 0;
    let p2 = 0;
    for (let i = 0; i < len; i++) {
      const p0 = x[from + i] + 2 * Math.cos(k) * p1 - p2;
      p2 = p1;
      p1 = p0;
    }
    return (2 * Math.hypot(p1 - p2 * Math.cos(k), p2 * Math.sin(k))) / len;
  };
  for (const rate of [0.5, 2, 0.75, 1.5]) {
    const [l, r] = timeStretch([sine(440), sine(660, 0.25)], rate, sr);
    assert.equal(l.length, Math.round(n / rate), `length at ${rate}x`);
    assert.equal(r.length, l.length);
    const from = 2400;
    const len = Math.min(12000, l.length - 2 * from);
    assert.ok(amp(l, 440, from, len) > 0.4, `440 Hz kept at ${rate}x (${amp(l, 440, from, len)})`);
    assert.ok(amp(l, 440 / rate, from, len) < 0.1, `no pitch shift at ${rate}x`);
    assert.ok(amp(r, 660, from, len) > 0.2, `right channel kept at ${rate}x`);
  }
  const same = timeStretch([sine(440)], 1, sr);
  assert.deepEqual(same[0], sine(440));
  assert.equal(timeStretch([new Float32Array(0)], 2, sr)[0].length, 0);
});

test('edge fades ramp both ends', () => {
  const ch = [new Float32Array(100).fill(1)];
  applyEdgeFades(ch, 1000, 0.01);
  assert.equal(ch[0][0], 0);
  assert.equal(ch[0][99], 0);
  assert.equal(ch[0][50], 1);
  assert.ok(ch[0][5] > 0 && ch[0][5] < 1);
});

test('encodeWav writes a valid 16-bit PCM RIFF file', () => {
  const l = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
  const r = Float32Array.from([0.25, 0, 0, 0, 0, -2]);
  const buf = encodeWav([l, r], 48000);
  const v = new DataView(buf);
  const str = (o, len) => String.fromCharCode(...new Uint8Array(buf, o, len));
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), buf.byteLength - 8);
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(str(12, 4), 'fmt ');
  assert.equal(v.getUint16(20, true), 1); // PCM
  assert.equal(v.getUint16(22, true), 2); // channels
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(28, true), 48000 * 4); // byte rate
  assert.equal(v.getUint16(32, true), 4); // block align
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(str(36, 4), 'data');
  assert.equal(v.getUint32(40, true), 6 * 4);
  assert.equal(buf.byteLength, 44 + 24);
  const s = (frame, ch) => v.getInt16(44 + frame * 4 + ch * 2, true);
  assert.equal(s(0, 0), 0);
  assert.equal(s(0, 1), Math.round(0.25 * 32767));
  assert.equal(s(1, 0), Math.round(0.5 * 32767));
  assert.equal(s(2, 0), Math.round(-0.5 * 32768));
  assert.equal(s(3, 0), 32767);
  assert.equal(s(4, 0), -32768);
  assert.equal(s(5, 0), 32767); // clipped
  assert.equal(s(5, 1), -32768);
  assert.equal(encodeWav([new Float32Array(0)], 44100).byteLength, 44);
});

// ---------------------------------------------------------------------------------------------- exporter helpers

test('bitrates scale with pixels x fps and respect clamps', () => {
  const hd = videoBitrateFor({ width: 1280, height: 720, fps: 30, quality: 'high' });
  assert.equal(hd, Math.round(1280 * 720 * 30 * QUALITY_PRESETS.high.bpp));
  assert.ok(videoBitrateFor({ width: 1920, height: 1080, fps: 30, quality: 'high' }) > hd);
  assert.ok(videoBitrateFor({ width: 1280, height: 720, fps: 60, quality: 'high' }) > hd);
  assert.ok(videoBitrateFor({ width: 1280, height: 720, fps: 30, quality: 'low' }) < videoBitrateFor({ width: 1280, height: 720, fps: 30, quality: 'max' }));
  assert.equal(videoBitrateFor({ width: 16, height: 16, fps: 1, quality: 'low' }), 250_000);
  assert.equal(videoBitrateFor({ width: 7680, height: 4320, fps: 120, quality: 'max' }), 60_000_000);
  assert.equal(videoBitrateFor({ width: 1280, height: 720, fps: 30, quality: 'nope' }), hd); // unknown -> high
  assert.ok(audioBitrateFor('low') < audioBitrateFor('max'));
});

test('evenDimensions, resolveRange, estimates and filenames', () => {
  assert.deepEqual(evenDimensions(1281, 719), { width: 1282, height: 720 });
  assert.deepEqual(evenDimensions(3, 100000), { width: 16, height: 7680 });
  assert.deepEqual(resolveRange(null, 11), { start: 0, end: 11 });
  assert.deepEqual(resolveRange({ start: 2, end: 8 }, 11), { start: 2, end: 8 });
  assert.deepEqual(resolveRange({ start: 8, end: 2 }, 11), { start: 2, end: 8 });
  assert.deepEqual(resolveRange({ start: -5, end: 50 }, 11), { start: 0, end: 11 });
  assert.deepEqual(resolveRange({ start: 3, end: 3 }, 11), { start: 0, end: 11 }); // empty -> whole
  assert.equal(estimateExportBytes({ duration: 10, videoBitrate: 8_000_000, audioBitrate: 0 }), Math.round(10_000_000 * 1.02));
  assert.equal(exportFilename('My: cut/1', 'mp4'), 'My_ cut_1.mp4');
  assert.equal(exportFilename('', 'wav'), 'sequence.wav');
});

test('planFrames follows videoItemsAt frame by frame, with overlapping transitions', () => {
  const p = sampleProject();
  const lay = M.layoutProject(p);
  assert.equal(lay.duration, 11);
  const plan = planFrames(lay, { start: 0, end: 11, fps: 30 });
  assert.equal(plan.frames, 330);
  assert.equal(plan.duration, 11);
  const [r, g, b] = plan.items;
  assert.equal(r.first, 0);
  assert.equal(r.last, 119); // red visible until 4s (exclusive)
  assert.equal(g.first, 105); // green starts at 3.5s: frames 105..119 overlap (crossfade)
  assert.equal(b.first, 180);
  assert.equal(b.last, 329);
  for (const e of plan.items) {
    assert.equal(e.times.length, e.last - e.first + 1);
    for (let i = 1; i < e.times.length; i++) assert.ok(e.times[i] >= e.times[i - 1], 'source times are monotonic');
  }
  assert.ok(near(g.times[0], 0) && near(g.times[15], 0.5, 1e-9)); // frame 120 = 0.5s into green
  // matches videoItemsAt exactly
  for (const k of [0, 104, 105, 119, 120, 179, 180, 194, 195, 329]) {
    const active = M.videoItemsAt(lay.video, k / 30).map((it) => it.index);
    const planned = plan.items.filter((e) => e.first <= k && e.last >= k).map((e) => e.item.index);
    assert.deepEqual(planned, active, `frame ${k}`);
  }
  // ranges and speed
  const part = planFrames(lay, { start: 2, end: 5, fps: 24 });
  assert.equal(part.frames, 72);
  assert.ok(near(part.items[0].times[0], 2));
  const fast = M.updateClip(p, p.tracks.video[0].id, { speed: 2 });
  const fp = planFrames(M.layoutProject(fast), { start: 0, end: 1, fps: 10 });
  assert.ok(near(fp.items[0].times[5], 1)); // 0.5s on the timeline = 1s of source at 2x
  // empty timeline still yields one (background) frame
  assert.equal(planFrames(M.layoutProject(M.createProject()), { start: 0, end: 0, fps: 30 }).frames, 1);
});

test('exportProblems reports media that would block an export', () => {
  let p = sampleProject();
  assert.deepEqual(exportProblems(p), []);
  p = M.updateMedia(p, 'g', { status: 'loading' });
  p = M.updateMedia(p, 'm', { status: 'error', error: 'HTTP 404' });
  p = M.addAudioClip(p, 'm', { start: 0 }).project;
  const all = exportProblems(p);
  assert.deepEqual(all.map((x) => x.mediaId).sort(), ['g', 'm']);
  assert.match(all.find((x) => x.mediaId === 'm').message, /failed to download \(HTTP 404\)/);
  assert.match(all.find((x) => x.mediaId === 'g').message, /still downloading/);
  assert.deepEqual(exportProblems(p, { start: 0, end: 3 }).map((x) => x.mediaId), ['m']); // green starts at 3.5
  assert.deepEqual(exportProblems(p, { audio: false }).map((x) => x.mediaId), ['g']);
  const mutedGreen = M.updateClip(p, p.tracks.video[1].id, { muted: true });
  assert.deepEqual(exportProblems(mutedGreen, { video: false }).map((x) => x.mediaId), ['m']); // WAV ignores silent pictures
});

test('pictureTail finds the end of a range that only music or titles cover', () => {
  let p = M.createProject('Tail');
  p = M.addMedia(p, M.createMediaItem({ id: 'v', kind: 'video', duration: 4, hasAudio: true, status: 'ready' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'm', kind: 'audio', duration: 60, hasAudio: true, status: 'ready' }));
  p = M.appendMediaToTimeline(p, ['v']).project;
  assert.equal(pictureTail(p), null); // the clip fills the sequence
  // a 4 s clip under a 60 s song: the last 56 s are background colour
  const song = M.addAudioClip(p, 'm', { start: 0 }).project;
  assert.deepEqual(pictureTail(song), { from: 4, duration: 56, sound: true, titles: false, clips: true });
  assert.deepEqual(pictureTail(song, { start: 2, end: 10 }), { from: 4, duration: 6, sound: true, titles: false, clips: true });
  // ranges that end with (or before) the last clip have none; one inside the tail shows no clip at all
  assert.equal(pictureTail(song, { start: 0, end: 4 }), null);
  assert.equal(pictureTail(song, { start: 1, end: 3 }), null);
  assert.deepEqual(pictureTail(song, { start: 10, end: 20 }), { from: 10, duration: 10, sound: true, titles: false, clips: false });
  // titles over the end (an end card); a muted song still stretches the sequence with nothing in it
  const card = M.addTextClip(p, { text: 'THE END', start: 3, duration: 4 }).project;
  assert.deepEqual(pictureTail(card), { from: 4, duration: 3, sound: false, titles: true, clips: true });
  const a = M.addAudioClip(p, 'm', { start: 0 });
  assert.deepEqual(pictureTail(M.updateClip(a.project, a.id, { volume: 0 })), { from: 4, duration: 56, sound: false, titles: false, clips: true });
  // only sound on the timeline: all of it is background
  let bare = M.createProject();
  bare = M.addMedia(bare, M.createMediaItem({ id: 'm', kind: 'audio', duration: 8, status: 'ready' }));
  bare = M.addAudioClip(bare, 'm', { start: 0 }).project;
  assert.deepEqual(pictureTail(bare), { from: 0, duration: 8, sound: true, titles: false, clips: false });
  // "Fit audio to video" (offered next to the note) removes the tail
  assert.equal(pictureTail(M.fitAudioToVideo(song)), null);
});

test('exports drop decoded main-track sound but keep the audio-track sources the preview Player holds', () => {
  let p = sampleProject();
  assert.deepEqual(releasableAudioIds(p, ['r', 'g', 'b']), ['r', 'g', 'b']);
  p = M.addAudioClip(p, 'm', { start: 0 }).project;
  assert.deepEqual(releasableAudioIds(p, ['r', 'g', 'b', 'm']), ['r', 'g', 'b']);
  // a video whose sound is also on the audio track (e.g. detached audio) stays cached too
  p = M.addAudioClip(p, 'g', { start: 2 }).project;
  assert.deepEqual(releasableAudioIds(p, ['r', 'g', 'b', 'm']), ['r', 'b']);
  assert.deepEqual(releasableAudioIds(p, []), []);
});

test('decodeGapMessage describes frames a clip could not decode, and ignores a stray frame or two', () => {
  const base = { from: 1.83, at: 5.83, fps: 30, decoded: true, resumed: false };
  assert.equal(decodeGapMessage('broken', { ...base, frames: 5 }), null); // 0.17 s: not worth a warning
  const stop = decodeGapMessage('broken', { ...base, frames: 65 });
  assert.match(stop, /^"broken" stops decoding at 0:01\.83 \(the file may be damaged or incomplete\)/);
  assert.match(stop, /last good frame is held for 2\.2s from 0:05\.83 on the timeline/);
  assert.match(decodeGapMessage('broken', { ...base, frames: 12, resumed: true }), /^Parts of "broken" couldn't be decoded .*its last good frame stands in for 0\.4s, first at 0:05\.83/);
  assert.match(decodeGapMessage('broken', { ...base, frames: 90, decoded: false }), /^"broken" couldn't be decoded .*the background shows instead of it for 3s from 0:05\.83/);
});

test('soundShortfalls reports sound that ends before its clips (truncated files), per media', () => {
  let p = sampleProject(); // red 4 s, green 3 s, blue 5 s with sound
  const music = M.addAudioClip(p, 'm', { start: 0 });
  p = M.updateClip(music.project, music.id, { out: 11 });
  const plan = buildMixPlan(p);
  const full = new Map([['r', 4], ['g', 3], ['b', 5], ['m', 12]]);
  assert.deepEqual(soundShortfalls(plan, full), []);
  // red's sound stops at 1.8 s (truncated download), the music lacks its last 0.1 s (padding: ignored)
  const cut = new Map([...full, ['r', 1.8], ['m', 10.9]]);
  const [r, ...rest] = soundShortfalls(plan, cut);
  assert.equal(rest.length, 0);
  assert.equal(r.mediaId, 'r');
  assert.equal(r.end, 1.8);
  assert.ok(near(r.silent, 2.2));
  // a range that skips the missing part has nothing to report; a retimed clip is measured on the timeline
  assert.deepEqual(soundShortfalls(buildMixPlan(p, { start: 0, end: 1.5 }), cut), []);
  const fast = M.updateClip(p, p.tracks.video[0].id, { speed: 2 }); // red: 4 s of source in 2 s
  assert.ok(near(soundShortfalls(buildMixPlan(fast), cut).find((s) => s.mediaId === 'r').silent, 1.1));
  // media without a decoded buffer (reported elsewhere) is skipped
  assert.deepEqual(soundShortfalls(plan, new Map([['m', 12]])), []);
});

test('untagged colour fallback mirrors Chrome <video>', () => {
  assert.equal(untaggedVideoMatrix('avc', 360), 'smpte170m');
  assert.equal(untaggedVideoMatrix('avc', 704), 'smpte170m');
  assert.equal(untaggedVideoMatrix('avc', 720), 'bt709');
  assert.equal(untaggedVideoMatrix('avc', 1280), 'bt709');
  assert.equal(untaggedVideoMatrix('vp9', 1080), 'smpte170m');
  assert.equal(untaggedVideoMatrix('vp8', 360), 'smpte170m');
  assert.equal(untaggedVideoMatrix('av1', 360), 'bt709');
});

// ---------------------------------------------------------------------------------------------- long-running work

/** A step generator doing ~`ms` of busy work per step; returns the sum of the step indices. */
function* busySteps(n, ms = 1) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      /* spin */
    }
    sum += i;
    yield (i + 1) / n;
  }
  return sum;
}

test('runStepsSliced keeps the event loop running, reports progress and stops on abort', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const progress = [];
  try {
    const sum = await runStepsSliced(busySteps(60), { slice: 5, onProgress: (f) => progress.push(f) });
    assert.equal(sum, (59 * 60) / 2);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 2, `timers ran between slices (${ticks})`);
  assert.ok(progress.length >= 3, `progress reported per slice (${progress.length})`);
  assert.ok(progress.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= progress[i - 1])), 'progress is monotonic in 0..1');
  assert.equal(runSteps(busySteps(60, 0)), (59 * 60) / 2, 'runSteps gives the same result in one go');

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 15);
  const t0 = performance.now();
  await assert.rejects(runStepsSliced(busySteps(100000), { signal: ac.signal, slice: 2 }), { name: 'AbortError' });
  assert.ok(performance.now() - t0 < 1000, 'abort is noticed at the next slice');
  await assert.rejects(runStepsSliced(busySteps(3), { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('sliced audio work matches the one-go results bit for bit', async () => {
  const sr = 8000;
  const tone = (f, amp, n) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));
  const src = () => [tone(440, 0.5, sr * 3), tone(660, 0.3, sr * 3)];
  const sync = timeStretch(src(), 0.75, sr);
  const sliced = await runStepsSliced(timeStretchSteps(src(), 0.75, sr), { slice: 0 });
  assert.deepEqual(sliced, sync);

  const loud = () => [tone(220, 1.7, 200000), tone(330, 1.2, 200000)]; // > 3 check-in chunks
  const a = loud();
  const b = loud();
  const ra = applyLimiter(a, sr);
  const rb = await runStepsSliced(limiterSteps(b, sr), { slice: 0 });
  assert.deepEqual(rb, ra);
  assert.deepEqual(b, a);
  assert.ok(ra.minGain < 0.6);
  for (const ch of a) for (let i = 0; i < ch.length; i += 997) assert.ok(Math.abs(ch[i]) <= 0.944 + 1e-6);

  const wavSync = new Uint8Array(encodeWav(loud(), sr));
  const wavSliced = new Uint8Array(await runStepsSliced(wavSteps(loud(), sr), { slice: 0 }));
  assert.deepEqual(wavSliced, wavSync);
});

// ---------------------------------------------------------------------------------------------- stills

test('StillCache shares a still between overlapping clips and frees it after the last one', async () => {
  const made = [];
  const cache = new StillCache(async (id) => {
    if (id === 'broken') throw new Error('not an image');
    const bmp = { id, closed: false, close() { this.closed = true; } };
    made.push(bmp);
    return bmp;
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const a1 = await cache.acquire('a');
  const a2 = await cache.acquire('a');
  assert.equal(a1, a2, 'one decode for clips open at the same time');
  assert.equal(made.length, 1);
  cache.release('a');
  await tick();
  assert.equal(a1.closed, false, 'still in use by the second clip');
  cache.release('a');
  await tick();
  assert.equal(a1.closed, true, 'closed with its last user');
  assert.equal(cache.size, 0);
  cache.release('a'); // extra releases are harmless

  const a3 = await cache.acquire('a');
  assert.notEqual(a3, a1, 'a still that comes back later is decoded again');
  const b = await cache.acquire('b');
  await assert.rejects(cache.acquire('broken'), /not an image/);
  cache.release('broken');
  cache.clear();
  await tick();
  assert.ok(a3.closed && b.closed, 'clear() closes everything');
  assert.equal(cache.size, 0);
});
