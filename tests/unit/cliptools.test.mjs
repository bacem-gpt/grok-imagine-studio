// iMovie-style clip tools: reverse, freeze frame, instant replay, crop / rotate / flip, white balance, auto enhance,
// ducking, EQ presets, title styles, backgrounds and voice-over helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../extension/studio/core/model.js';
import * as Ops from '../../extension/studio/ui/edit/edit-ops.js';
import {
  whiteBalanceGains,
  gradeGains,
  orientedSize,
  cropRect,
  hasCropRotate,
  buildFilter,
  lumaStats,
  autoEnhanceFilters,
  textAnimationState,
} from '../../extension/studio/engine/effects.js';
import { buildMixPlan, mainClipAudible } from '../../extension/studio/engine/audio-mix.js';
import { videoClipGain, isSeekDriven } from '../../extension/studio/engine/player.js';
import { orderedSamples, planFrames } from '../../extension/studio/engine/exporter.js';
import { EQ_PRESETS, eqFilters, buildEqChain, duckWindows, duckFactorAt, DUCK_RAMP, pickRecorderMime, recordingExtension, micErrorInfo } from '../../extension/studio/engine/audio-fx.js';
import { filmstripTiles } from '../../extension/studio/ui/edit/timeline-math.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

function project(media = [{ id: 'v', kind: 'video', duration: 4 }]) {
  let p = M.createProject('t');
  for (const m of media) p = M.addMedia(p, M.createMediaItem({ status: 'ready', hasAudio: true, ...m }));
  return p;
}
const withClips = (p, ids) => M.appendMediaToTimeline(p, ids).project;
const items = (p) => M.layoutVideo(p.tracks.video);

// ------------------------------------------------------------------------------------------------- reverse

test('reverse: sourceTimeAt runs from out to in, timelineTimeOf inverts it', () => {
  let p = withClips(project(), ['v']);
  const id = p.tracks.video[0].id;
  p = M.updateClip(p, id, { in: 1, out: 3, reverse: true });
  const [it] = items(p);
  near(M.sourceTimeAt(it, 0), 3 - 1e-3);
  near(M.sourceTimeAt(it, 0.5), 2.5);
  near(M.sourceTimeAt(it, 1.5), 1.5);
  near(M.sourceTimeAt(it, 2), 1); // clamped at the in-point
  near(M.timelineTimeOf(it, 2.5), 0.5);
  // with speed: twice as fast backwards
  p = M.updateClip(p, id, { speed: 2 });
  const [it2] = items(p);
  near(it2.duration, 1);
  near(M.sourceTimeAt(it2, 0.25), 2.5);
  near(M.timelineTimeOf(it2, 2.5), 0.25);
});

test('reverse: splitting keeps both halves showing the same frames as before the cut', () => {
  let p = withClips(project(), ['v']);
  p = M.updateClip(p, p.tracks.video[0].id, { in: 0.5, out: 3.5, reverse: true });
  const before = items(p)[0];
  const sample = [0.1, 0.7, 1.2, 1.9, 2.6];
  const want = sample.map((t) => M.sourceTimeAt(before, t));
  const r = M.splitVideoAt(p, 1.2);
  assert.ok(r.rightId);
  const [left, right] = items(r.project);
  assert.equal(left.clip.reverse, true);
  assert.equal(right.clip.reverse, true);
  near(left.clip.in, 2.3);
  near(left.clip.out, 3.5);
  near(right.clip.in, 0.5);
  near(right.clip.out, 2.3);
  sample.forEach((t, i) => {
    const it = t < 1.2 ? left : right;
    near(M.sourceTimeAt(it, t), want[i], 2e-3);
  });
});

test('reverse: trimPatchAt maps the left edge to the out-point', () => {
  let p = withClips(project(), ['v']);
  p = M.updateClip(p, p.tracks.video[0].id, { in: 1, out: 3, reverse: true });
  const [it] = items(p);
  assert.deepEqual(M.trimPatchAt(it, 'in', 0.5), { out: 2.5 }); // left edge moves right: the clip starts later in reverse
  assert.deepEqual(M.trimPatchAt(it, 'out', 1.5), { in: 1.5 });
  // forward clips keep the old formula
  const fwd = { ...it, clip: { ...it.clip, reverse: false } };
  assert.deepEqual(M.trimPatchAt(fwd, 'in', 0.5), { in: 1.5 });
  assert.deepEqual(M.trimPatchAt(fwd, 'out', 1.5), { out: 2.5 });
  // trimEdgeTo (Q / W) goes through it
  const q = Ops.trimEdgeTo(p, it.clip.id, 'in', 0.5);
  near(M.findClip(q, it.clip.id).clip.out, 2.5);
  near(M.findClip(q, it.clip.id).clip.in, 1);
});

test('reverse: preview sound is silent, the mixdown plays the source backwards', () => {
  let p = withClips(project(), ['v']);
  p = M.updateClip(p, p.tracks.video[0].id, { in: 1, out: 3, reverse: true });
  const lay = items(p);
  assert.equal(videoClipGain(lay, lay[0], 1), 0);
  assert.equal(isSeekDriven(lay[0].clip), true);
  const plan = buildMixPlan(p, { start: 0.5, end: 1.5 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].reverse, true);
  near(plan[0].offset, 1.5); // timeline [0.5, 1.5) = source [1.5, 2.5) played backwards
  near(plan[0].duration, 1);
});

test('reverse: export frame plan asks for decreasing timestamps; orderedSamples serves them in order', async () => {
  let p = withClips(project(), ['v']);
  p = M.updateClip(p, p.tracks.video[0].id, { in: 0, out: 1, reverse: true });
  const plan = planFrames(M.layoutProject(p), { start: 0, end: 1, fps: 10 });
  const times = plan.items[0].times;
  assert.ok(times[0] > times[times.length - 1]);
  const decoded = [];
  const closed = [];
  const sink = {
    async *samplesAtTimestamps(ts) {
      decoded.push([...ts]);
      for (const t of ts) yield { t, clone() { return { t, clone: this.clone }; }, close() { closed.push(t); } };
    },
  };
  const got = [];
  for await (const s of orderedSamples(sink, times, { window: 4 })) got.push(s.t);
  assert.deepEqual(got, times);
  for (const call of decoded) assert.deepEqual(call, [...call].sort((a, b) => a - b)); // each window decodes forward
  assert.equal(decoded.length, Math.ceil(times.length / 4));
  assert.equal(closed.length, times.length); // every decoded sample released
});

test('orderedSamples decodes a repeated timestamp once per window (freeze frames)', async () => {
  let calls = 0;
  const sink = {
    async *samplesAtTimestamps(ts) {
      calls += ts.length;
      for (const t of ts) yield { t, clone() { return { t }; }, close() {} };
    },
  };
  const out = [];
  for await (const s of orderedSamples(sink, Array(10).fill(1.5), { window: 5 })) out.push(s.t);
  assert.deepEqual(out, Array(10).fill(1.5));
  assert.equal(calls, 2);
});

// ------------------------------------------------------------------------------------------------- freeze frame

test('freeze frame: splits the clip and inserts a held still of the exact frame', () => {
  let p = withClips(project(), ['v']);
  p = M.updateClip(p, p.tracks.video[0].id, { filters: { ...M.FILTER_DEFAULTS, saturate: 1.5 }, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
  const r = M.insertFreezeFrame(p, 1.5, { duration: 2 });
  assert.ok(r.id);
  const lay = items(r.project);
  assert.equal(lay.length, 3);
  const still = lay[1];
  assert.equal(still.clip.id, r.id);
  assert.equal(still.clip.freeze, true);
  near(still.clip.freezeAt, 1.5);
  near(still.start, 1.5);
  near(still.duration, 2);
  near(M.sourceTimeAt(still, 2.7), 1.5);
  near(M.timelineTimeOf(still, 1.5), 1.5);
  assert.deepEqual(still.clip.crop, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }); // same look as the clip
  assert.equal(still.clip.filters.saturate, 1.5);
  near(M.layoutProject(r.project).duration, 6);
  near(M.sourceTimeAt(lay[2], 3.5), 1.5); // the clip resumes on the same frame
  assert.equal(mainClipAudible(r.project, still.clip), false); // a freeze frame is silent
  assert.equal(isSeekDriven(still.clip), true);
});

test('freeze frame: at a clip edge inserts without splitting; never on stills', () => {
  const p = withClips(project([{ id: 'v', kind: 'video', duration: 4 }, { id: 'i', kind: 'image' }]), ['v', 'i']);
  const atStart = M.insertFreezeFrame(p, 0);
  assert.equal(atStart.project.tracks.video.length, 3);
  assert.equal(atStart.project.tracks.video[0].id, atStart.id);
  near(atStart.project.tracks.video[0].freezeAt, 0);
  const onImage = M.insertFreezeFrame(p, 5);
  assert.equal(onImage.id, null);
  assert.equal(onImage.project, p);
});

test('freeze frame: its hold is not bound by the media length and survives sanitize / split / normalize', () => {
  const p = withClips(project(), ['v']);
  const r = M.insertFreezeFrame(p, 3.9, { duration: 6 });
  const still = M.findClip(r.project, r.id).clip;
  assert.equal(still.out - still.in, 6); // longer than the 4 s media
  assert.equal(still.speed, 1);
  const longer = M.updateClip(r.project, r.id, { out: 9, speed: 3 });
  assert.equal(M.findClip(longer, r.id).clip.out, 9);
  assert.equal(M.findClip(longer, r.id).clip.speed, 1);
  const lay = items(r.project);
  const sit = lay.find((x) => x.clip.id === r.id);
  const s = M.splitVideoAt(r.project, sit.start + 1, r.id);
  const halves = s.project.tracks.video.filter((c) => c.freeze);
  assert.equal(halves.length, 2);
  for (const h of halves) near(h.freezeAt, still.freezeAt);
  const n = M.normalizeProject(JSON.parse(JSON.stringify(r.project)));
  const ns = M.findClip(n, r.id).clip;
  assert.equal(ns.freeze, true);
  assert.equal(ns.out - ns.in, 6);
});

// ------------------------------------------------------------------------------------------------- instant replay

test('instant replay: the 2 s before the playhead play again at half speed right after it', () => {
  const p = withClips(project(), ['v']);
  const id = p.tracks.video[0].id;
  const r = M.instantReplay(p, 3, { seconds: 2, rate: 0.5, clipId: id });
  assert.ok(r.id);
  const lay = items(r.project);
  assert.equal(lay.length, 3);
  const rep = lay[1].clip;
  near(rep.in, 1);
  near(rep.out, 3);
  near(rep.speed, 0.5);
  near(r.start, 3);
  near(r.duration, 4);
  near(lay[2].start, 7);
  near(M.layoutProject(r.project).duration, 8);
  // playhead outside the selected clip: its last seconds
  const end = M.instantReplay(p, 10, { clipId: id });
  near(M.findClip(end.project, end.id).clip.in, 2);
  near(M.findClip(end.project, end.id).clip.out, 4);
  // never below the minimum speed; reversed clips replay the same frames backwards
  const slow = M.instantReplay(M.updateClip(p, id, { speed: 0.25 }), 3, { clipId: id, rate: 0.5 });
  near(M.findClip(slow.project, slow.id).clip.speed, M.MIN_SPEED);
  const rev = M.updateClip(p, id, { reverse: true });
  const rr = M.instantReplay(rev, 3, { clipId: id });
  const rc = M.findClip(rr.project, rr.id).clip;
  assert.equal(rc.reverse, true);
  near(rc.in, 1); // timeline 1..3 of a reversed 0..4 clip shows source 3..1
  near(rc.out, 3);
});

// ------------------------------------------------------------------------------------------------- crop / rotate / flip

test('crop & rotation: normalization and oriented geometry', () => {
  assert.equal(M.normalizeCrop(null), null);
  assert.equal(M.normalizeCrop({ x: 0, y: 0, w: 1, h: 1 }), null);
  assert.deepEqual(M.normalizeCrop({ x: 0.9, y: -1, w: 0.5, h: 0.01 }), { x: 0.5, y: 0, w: 0.5, h: M.MIN_CROP });
  assert.equal(M.normalizeRotation(-90), 270);
  assert.equal(M.normalizeRotation(450), 90);
  assert.equal(M.normalizeRotation(100), 90);
  const clip = { crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, rotate: 90 };
  assert.deepEqual(cropRect(clip, 1280, 720), { sx: 320, sy: 0, sw: 640, sh: 720 });
  assert.deepEqual(orientedSize(clip, 1280, 720), { w: 720, h: 640 });
  assert.deepEqual(orientedSize({ rotate: 180 }, 1280, 720), { w: 1280, h: 720 });
  assert.equal(hasCropRotate({}), false);
  assert.equal(hasCropRotate({ flipV: true }), true);
  let p = withClips(project(), ['v']);
  const id = p.tracks.video[0].id;
  p = M.rotateClip(p, id, -1);
  assert.equal(M.findClip(p, id).clip.rotate, 270);
  p = M.updateClip(p, id, { crop: { x: 2, y: 0, w: 0.5, h: 0.5 }, flipH: 1 });
  assert.deepEqual(M.findClip(p, id).clip.crop, { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  assert.equal(M.findClip(p, id).clip.flipH, true);
});

test('crop presets and the crop drag keep the aspect and stay inside the picture', () => {
  const c169 = Ops.cropForAspect(1, 1600, 900); // square out of 16:9
  near(c169.w, 900 / 1600, 1e-4);
  near(c169.h, 1);
  near(c169.x, (1 - 900 / 1600) / 2, 1e-4);
  // rotated 90°: a 9:16 result needs a 16:9 source region = the whole picture
  assert.equal(Ops.cropForAspect(9 / 16, 1600, 900, 90), null);
  const moved = Ops.dragCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'move', 0.5, -0.5);
  assert.deepEqual(moved, { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  const free = Ops.dragCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'se', 0.1, 0.2);
  near(free.w, 0.6);
  near(free.h, 0.7);
  near(free.x, 0.2);
  const locked = Ops.dragCrop({ x: 0.1, y: 0.1, w: 0.4, h: 0.2 }, 'nw', -0.05, 0, 2);
  near(locked.w / locked.h, 2);
  near(locked.x + locked.w, 0.5); // the opposite corner stays put
  near(locked.y + locked.h, 0.3);
  const capped = Ops.dragCrop({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 'se', 1, 1, 1);
  assert.ok(capped.x + capped.w <= 1 + 1e-9 && capped.y + capped.h <= 1 + 1e-9);
});

// ------------------------------------------------------------------------------------------------- colour

test('white balance gains keep the luma and push red / blue the right way', () => {
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (const [t, m] of [[1, 0], [-1, 0], [0, 1], [0.4, -0.6]]) near(luma(whiteBalanceGains(t, m)), 1, 1e-9);
  const warm = whiteBalanceGains(1, 0);
  assert.ok(warm[0] > 1 && warm[2] < 1 && warm[0] > warm[1]);
  const cool = whiteBalanceGains(-1, 0);
  assert.ok(cool[2] > cool[0]);
  const magenta = whiteBalanceGains(0, 1);
  assert.ok(magenta[1] < magenta[0]);
  assert.equal(gradeGains(null), null);
  assert.equal(gradeGains({ ...M.FILTER_DEFAULTS }), null);
  assert.ok(gradeGains({ temperature: 0.5 }));
});

test('new filter keys: defaults are neutral, exposure folds into brightness, old looks still match', () => {
  assert.equal(M.FILTER_DEFAULTS.temperature, 0);
  assert.equal(M.FILTER_DEFAULTS.tint, 0);
  assert.equal(M.FILTER_DEFAULTS.exposure, 0);
  assert.equal(M.filtersAreNeutral({ brightness: 1, contrast: 1 }), true); // stored by an older version
  assert.equal(M.filtersAreNeutral({ ...M.FILTER_DEFAULTS, temperature: 0.2 }), false);
  assert.equal(buildFilter({ exposure: 1 }, 720), 'brightness(2)');
  assert.equal(buildFilter({ brightness: 1.2, exposure: -1 }, 720), 'brightness(0.6)');
  assert.equal(buildFilter({ temperature: 0.5, tint: -0.2 }, 720), 'none'); // white balance is a separate pass
  assert.equal(Ops.matchFilterPreset({ contrast: 1.15, saturate: 0.85, vignette: 0.35 }), 'cinematic');
  assert.equal(Ops.matchFilterPreset({ ...Ops.filterPresetValues('noir'), temperature: 0.3 }), null);
});

test('auto enhance brightens a dark, flat picture and leaves a balanced one near neutral', () => {
  const px = (fn, n = 400) => {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = fn(i / n);
      d.set([r, g, b, 255], i * 4);
    }
    return d;
  };
  const dark = lumaStats(px((k) => [30 + k * 40, 30 + k * 40, 34 + k * 40]));
  assert.ok(dark.mean < 0.25 && dark.high < 0.35);
  const fix = autoEnhanceFilters(dark);
  assert.ok(fix.brightness > 1.2 && fix.contrast > 1.2 && fix.saturate > 1);
  const good = autoEnhanceFilters(lumaStats(px((k) => [Math.min(255, k * 300), k * 255, k * 220])));
  assert.ok(Math.abs(good.brightness - 1) < 0.12 && Math.abs(good.contrast - 1) < 0.12);
});

// ------------------------------------------------------------------------------------------------- audio

test('ducking: a voice-over lowers the music and the clip sound, ramped, but not itself', () => {
  let p = project([
    { id: 'v', kind: 'video', duration: 10 },
    { id: 'music', kind: 'audio', duration: 10 },
    { id: 'voice', kind: 'audio', duration: 2 },
  ]);
  p = withClips(p, ['v']);
  p = M.addAudioClip(p, 'music', { start: 0 }).project;
  const r = M.addAudioClip(p, 'voice', { start: 4 });
  p = M.updateClip(r.project, r.id, { duck: true, duckAmount: 0.75 });
  const w = duckWindows(p);
  assert.deepEqual(w, [{ id: r.id, start: 4, end: 6, amount: 0.75 }]);
  near(duckFactorAt(w, 2), 1);
  near(duckFactorAt(w, 4 - DUCK_RAMP / 2), 1 - 0.75 / 2);
  near(duckFactorAt(w, 5), 0.25);
  near(duckFactorAt(w, 6 + DUCK_RAMP), 1);
  const plan = buildMixPlan(p, { start: 0, end: 10, declick: 0 });
  const at = (src, t) => {
    const env = src.envelope;
    for (let i = 1; i < env.length; i++) {
      if (t <= env[i].t) return env[i - 1].v + ((env[i].v - env[i - 1].v) * (t - env[i - 1].t)) / (env[i].t - env[i - 1].t || 1);
    }
    return env[env.length - 1].v;
  };
  const music = plan.find((x) => x.mediaId === 'music');
  const clip = plan.find((x) => x.track === 'video');
  const voice = plan.find((x) => x.mediaId === 'voice');
  near(at(music, 2), 1, 1e-3);
  near(at(music, 5), 0.25, 1e-3);
  near(at(clip, 5), 0.25, 1e-3);
  near(at(voice, 5), 1, 1e-3);
  near(at(music, 8), 1, 1e-3);
  // off / muted duckers duck nothing
  assert.deepEqual(duckWindows(M.updateClip(p, r.id, { duck: false })), []);
  assert.deepEqual(duckWindows(M.updateClip(p, r.id, { volume: 0 })), []);
});

test('EQ presets: specs, mixdown plan, filter chain', () => {
  assert.ok(EQ_PRESETS.some((x) => x.id === 'voice'));
  assert.deepEqual(eqFilters('none'), []);
  assert.deepEqual(eqFilters('bogus'), []);
  assert.deepEqual(eqFilters('hum50').map((f) => [f.type, f.frequency]), [['notch', 50], ['notch', 100], ['notch', 150]]);
  assert.deepEqual(eqFilters('hum60').map((f) => f.frequency), [60, 120, 180]);
  let p = withClips(project([{ id: 'v', kind: 'video', duration: 3 }, { id: 'a', kind: 'audio', duration: 3 }]), ['v']);
  p = M.updateClip(p, p.tracks.video[0].id, { eq: 'voice' });
  const r = M.addAudioClip(p, 'a', { start: 0 });
  p = M.updateClip(r.project, r.id, { eq: 'bass' });
  const plan = buildMixPlan(p, {});
  assert.equal(plan.find((x) => x.track === 'video').eq, 'voice');
  assert.equal(plan.find((x) => x.track === 'audio').eq, 'bass');
  const made = [];
  const param = () => ({ value: 0 });
  const ctx = {
    createBiquadFilter() {
      const n = { frequency: param(), Q: param(), gain: param(), type: '', next: null, connect(x) { n.next = x; return x; } };
      made.push(n);
      return n;
    },
  };
  assert.equal(buildEqChain(ctx, 'none'), null);
  const chain = buildEqChain(ctx, 'voice');
  assert.equal(chain.nodes.length, 3);
  assert.equal(chain.input, made[0]);
  assert.equal(made[0].next, made[1]);
  assert.equal(chain.output, made[2]);
  assert.equal(made[0].type, 'highpass');
  assert.equal(made[2].gain.value, 4);
});

// ------------------------------------------------------------------------------------------------- persistence

test('new fields survive normalize / merge; older clips keep their shape', () => {
  let p = withClips(project([{ id: 'v', kind: 'video', duration: 4 }, { id: 'a', kind: 'audio', duration: 4 }]), ['v']);
  const plain = JSON.parse(JSON.stringify(p));
  const n0 = M.normalizeProject(plain);
  for (const k of ['crop', 'rotate', 'flipH', 'flipV', 'reverse', 'freeze', 'eq']) assert.ok(!(k in n0.tracks.video[0]), `no ${k} added to old clips`);
  const id = p.tracks.video[0].id;
  p = M.updateClip(p, id, { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, rotate: 90, flipV: true, reverse: true, eq: 'treble' });
  const r = M.addAudioClip(p, 'a', { start: 0 });
  p = M.updateClip(r.project, r.id, { duck: true, duckAmount: 3, eq: 'voice' });
  assert.equal(M.findClip(p, r.id).clip.duckAmount, 1);
  const n = M.normalizeProject(JSON.parse(JSON.stringify(p)));
  const c = M.findClip(n, id).clip;
  assert.deepEqual(c.crop, { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
  assert.equal(c.rotate, 90);
  assert.equal(c.flipV, true);
  assert.equal(c.reverse, true);
  assert.equal(c.eq, 'treble');
  const a = M.findClip(n, r.id).clip;
  assert.equal(a.duck, true);
  assert.equal(a.eq, 'voice');
  // three-way merge: their crop edit lands when I didn't touch the track
  const base = n;
  const theirs = M.updateClip(base, id, { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
  const merged = M.mergeProjects(base, base, theirs);
  assert.deepEqual(M.findClip(merged, id).clip.crop, { x: 0, y: 0, w: 0.5, h: 0.5 });
});

// ------------------------------------------------------------------------------------------------- titles & backgrounds

test('title presets: one-click styles, credits roll, applying keeps custom text', () => {
  assert.ok(Ops.TITLE_PRESETS.length >= 10);
  assert.ok(M.TEXT_ANIMATIONS.includes('scroll-up'));
  for (const pr of Ops.TITLE_PRESETS) assert.ok(M.TEXT_ANIMATIONS.includes(pr.animation), pr.id);
  const credits = Ops.titlePresetClip('credits');
  assert.equal(credits.animation, 'scroll-up');
  assert.equal(credits.style.size, 0.05);
  assert.equal(Ops.titlePresetClip('nope'), null);
  let p = project();
  const r = M.addTextClip(p, { text: 'My trip', start: 0, duration: 2 });
  p = Ops.applyTitlePreset(r.project, r.id, 'credits');
  const c = M.findClip(p, r.id).clip;
  assert.equal(c.text, 'My trip');
  assert.equal(c.duration, 8); // credits need longer
  assert.equal(Ops.matchTitlePreset(c), 'credits');
  const r2 = M.addTextClip(p, { text: 'Your title', start: 0, duration: 3 });
  const p2 = Ops.applyTitlePreset(r2.project, r2.id, 'pop');
  assert.equal(M.findClip(p2, r2.id).clip.text, 'WOW!');
  assert.equal(M.findClip(p2, r2.id).clip.style.letterbox, false);
  const s0 = textAnimationState('scroll-up', 0, 8, 10);
  const s1 = textAnimationState('scroll-up', 8, 8, 10);
  assert.equal(s0.scroll, 0);
  assert.equal(s1.scroll, 1);
  assert.equal(s0.alpha, 1);
});

test('backgrounds: presets paint solid fills and gradients', () => {
  assert.ok(Ops.BACKGROUND_PRESETS.length >= 6);
  const ops = [];
  const ctx = {
    set fillStyle(v) {
      ops.push(['fill', typeof v === 'string' ? v : 'gradient']);
    },
    fillRect: (...a) => ops.push(['rect', ...a]),
    createLinearGradient: () => ({ addColorStop: (o, c) => ops.push(['stop', o, c]) }),
    createRadialGradient: () => ({ addColorStop: (o, c) => ops.push(['stop', o, c]) }),
  };
  Ops.paintBackground(ctx, Ops.BACKGROUND_PRESETS.find((b) => b.id === 'black'), 100, 50);
  assert.deepEqual(ops, [['fill', '#000000'], ['rect', 0, 0, 100, 50]]);
  ops.length = 0;
  Ops.paintBackground(ctx, Ops.BACKGROUND_PRESETS.find((b) => b.id === 'sunset'), 100, 50);
  assert.deepEqual(ops.filter((o) => o[0] === 'stop').map((o) => o[2]), ['#ff7e5f', '#feb47b']);
  assert.match(Ops.backgroundCss(Ops.BACKGROUND_PRESETS.find((b) => b.id === 'ocean')), /^linear-gradient/);
});

// ------------------------------------------------------------------------------------------------- misc

test('timeline filmstrip follows reversed clips backwards and repeats a freeze frame', () => {
  const base = { widthPx: 300, tileW: 100, zoom: 100, mediaDuration: 4, stripCount: 4 };
  assert.deepEqual(filmstripTiles({ ...base, clipIn: 0, speed: 1 }).map((t) => t.index), [0, 1, 2]);
  assert.deepEqual(filmstripTiles({ ...base, clipIn: 3, speed: -1 }).map((t) => t.index), [2, 1, 0]);
  assert.deepEqual(filmstripTiles({ ...base, clipIn: 2.5, speed: 1e-9 }).map((t) => t.index), [2, 2, 2]);
});

test('voice-over helpers: recorder type, file extension, microphone errors', () => {
  assert.equal(pickRecorderMime((t) => t === 'audio/webm'), 'audio/webm');
  assert.equal(pickRecorderMime(() => false), '');
  assert.equal(pickRecorderMime(() => { throw new Error('x'); }), '');
  assert.equal(recordingExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(recordingExtension('audio/ogg'), 'ogg');
  assert.equal(recordingExtension('audio/mp4'), 'm4a');
  const blocked = micErrorInfo({ name: 'NotAllowedError' }, { embedded: true });
  assert.equal(blocked.tab, true);
  assert.equal(micErrorInfo({ name: 'NotAllowedError' }, { embedded: false }).tab, false);
  assert.equal(micErrorInfo({ name: 'NotFoundError' }, { embedded: true }).tab, false);
  assert.ok(Ops.canDetachAudio(project(), { mediaId: 'v', speed: 1 }));
  assert.equal(Ops.canDetachAudio(project(), { mediaId: 'v', speed: 1, reverse: true }), false);
});
