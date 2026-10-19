// Unit tests for the pure helpers of the realtime preview engine (engine/player.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../extension/studio/core/model.js';
import { videoClipGain, audioEnvelope, audioPlan, audioSignature } from '../../extension/studio/engine/player.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

function project() {
  let p = M.createProject('t');
  p = M.addMedia(p, M.createMediaItem({ id: 'a', kind: 'video', duration: 4, hasAudio: true, status: 'ready' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'b', kind: 'video', duration: 4, hasAudio: true, status: 'ready' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'mus', kind: 'audio', duration: 20, status: 'ready' }));
  return M.appendMediaToTimeline(p, ['a', 'b']).project;
}

test('videoClipGain: volume, mute, fades', () => {
  let p = project();
  const id = p.tracks.video[0].id;
  p = M.updateClip(p, id, { volume: 0.5, fadeIn: 1 });
  let lay = M.layoutVideo(p.tracks.video);
  near(videoClipGain(lay, lay[0], 0.5), 0.25);
  near(videoClipGain(lay, lay[0], 2), 0.5);
  assert.equal(videoClipGain(lay, lay[0], 9), 0, 'outside the clip');
  p = M.updateClip(p, id, { muted: true });
  lay = M.layoutVideo(p.tracks.video);
  assert.equal(videoClipGain(lay, lay[0], 2), 0);
});

test('videoClipGain: equal-power crossfade across a transition (matches the export mixdown)', () => {
  let p = project();
  p = M.setTransition(p, p.tracks.video[1].id, { type: 'crossfade', duration: 1 });
  const lay = M.layoutVideo(p.tracks.video); // a 0-4, b 3-7, transition window [3, 4)
  const mid = 3.5;
  const out = videoClipGain(lay, lay[0], mid);
  const inn = videoClipGain(lay, lay[1], mid);
  near(out, Math.cos(Math.PI / 4));
  near(inn, Math.sin(Math.PI / 4));
  near(out * out + inn * inn, 1); // constant power
  near(videoClipGain(lay, lay[0], 2), 1);
  near(videoClipGain(lay, lay[1], 5), 1);
  near(videoClipGain(lay, lay[1], 3), 0);
});

test('audioEnvelope: exact kinks of min(fade in, fade out) with de-click edges', () => {
  let p = project();
  const r = M.addAudioClip(p, 'mus', { start: 2, in: 0, out: 10, fadeIn: 2, fadeOut: 4 });
  p = r.project;
  const item = M.layoutProject(p).audio[0]; // 2..12
  const env = audioEnvelope(item);
  assert.deepEqual(
    env.map((x) => [x.t, x.g]),
    [
      [2, 0],
      [4, 1],
      [8, 1],
      [12, 0],
    ],
  );
  // starting mid-fade
  const mid = audioEnvelope(item, 3);
  assert.deepEqual(mid[0], { t: 3, g: 0.5 });
  // overlapping fades: the ramps cross below 1
  const r2 = M.addAudioClip(project(), 'mus', { start: 0, in: 0, out: 2, fadeIn: 2, fadeOut: 2 });
  const item2 = M.layoutProject(r2.project).audio[0];
  const env2 = audioEnvelope(item2);
  const peak = env2.find((x) => Math.abs(x.t - 1) < 1e-9);
  assert.ok(peak);
  near(peak.g, 0.5);
  assert.ok(env2.every((x) => x.g <= 0.5 + 1e-9));
  // no fades: a few-millisecond de-click ramp at both ends
  const r3 = M.addAudioClip(project(), 'mus', { start: 1, in: 0, out: 3 });
  const env3 = audioEnvelope(M.layoutProject(r3.project).audio[0]);
  assert.equal(env3[0].g, 0);
  assert.equal(env3[env3.length - 1].g, 0);
  assert.ok(env3[1].t - env3[0].t < 0.01);
  assert.equal(env3[1].g, 1);
});

test('audioPlan: offsets from the playhead, skips past clips, stops at a loop end', () => {
  let p = project();
  const r1 = M.addAudioClip(p, 'mus', { start: 1, in: 2, out: 6 }); // 1..5
  p = r1.project;
  const r2 = M.addAudioClip(p, 'mus', { start: 6, in: 0, out: 3 }); // 6..9
  p = r2.project;
  const lay = M.layoutProject(p).audio;
  let plan = audioPlan(lay, 3);
  assert.equal(plan.length, 2);
  assert.deepEqual([plan[0].begin, plan[0].offset, plan[0].duration], [3, 4, 2]);
  assert.deepEqual([plan[1].begin, plan[1].offset, plan[1].duration], [6, 0, 3]);
  plan = audioPlan(lay, 5.5);
  assert.equal(plan.length, 1);
  plan = audioPlan(lay, 0, 7);
  assert.equal(plan.length, 2);
  near(plan[1].duration, 1);
  assert.equal(audioPlan(lay, 9).length, 0);
});

test('audioSignature changes with timing/fades but not with volume', () => {
  let p = project();
  const r = M.addAudioClip(p, 'mus', { start: 1 });
  p = r.project;
  const s0 = audioSignature(p);
  assert.equal(audioSignature(M.updateClip(p, r.id, { volume: 0.3 })), s0);
  assert.notEqual(audioSignature(M.updateClip(p, r.id, { start: 2 })), s0);
  assert.notEqual(audioSignature(M.updateClip(p, r.id, { fadeOut: 1 })), s0);
});

// ---------------------------------------------------------------------------------------------------------
// Player with minimal DOM / WebAudio fakes (node has neither): gain bookkeeping and strict frame capture.
// ---------------------------------------------------------------------------------------------------------

class FakeParam {
  constructor(v) {
    this.value = v;
  }
  setTargetAtTime(v) {
    this.value = v; // the fake jumps straight to the target
  }
  setValueAtTime(v) {
    this.value = v;
  }
  linearRampToValueAtTime(v) {
    this.value = v;
  }
  cancelScheduledValues() {}
}
class FakeNode {
  connect(n) {
    return n;
  }
  disconnect() {}
}
class FakeGain extends FakeNode {
  constructor() {
    super();
    this.gain = new FakeParam(1);
  }
}
class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = new FakeNode();
  }
  createGain() {
    return new FakeGain();
  }
  createMediaElementSource() {
    return new FakeNode();
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  addEventListener() {}
  removeEventListener() {}
}
class FakeVideo {
  constructor() {
    this.paused = true;
    this.currentTime = 0;
    this.readyState = 4;
    this.seeking = false;
    this.playbackRate = 1;
    this.muted = false;
    this.volume = 1;
    this.videoWidth = 640;
    this.videoHeight = 360;
    this._src = null;
  }
  set src(v) {
    this._src = v;
  }
  get src() {
    return this._src;
  }
  getAttribute(name) {
    return name === 'src' ? this._src : null;
  }
  removeAttribute() {
    this._src = null;
  }
  load() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener() {}
  removeEventListener() {}
}
function fakeCanvas(width = 320, height = 180) {
  const canvas = { width, height };
  const methods = {
    canvas,
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  const ctx = new Proxy(methods, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => ((t[k] = v), true),
  });
  canvas.getContext = () => ctx;
  return canvas;
}

let rafQueue = [];
function installDomFakes() {
  rafQueue = [];
  globalThis.window = { AudioContext: FakeAudioContext };
  globalThis.document = {
    hidden: false,
    createElement: (tag) => (tag === 'video' ? new FakeVideo() : fakeCanvas()),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.requestAnimationFrame = (fn) => rafQueue.push(fn);
  globalThis.cancelAnimationFrame = () => {};
}
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));
const runFrames = (n = 1) => {
  for (let i = 0; i < n; i++) {
    const q = rafQueue;
    rafQueue = [];
    for (const fn of q) fn();
  }
};
const fakeMedia = { getMediaUrl: async (id) => `blob:fake/${id}`, getMediaBlob: async () => null, getAudioBuffer: async () => null };

test('Player: a clip keeps its sound after pause -> play inside the same clip (gain re-applied)', async () => {
  installDomFakes();
  const { Player } = await import('../../extension/studio/engine/player.js');
  const p = project();
  const player = new Player({ canvas: fakeCanvas(), getProject: () => p, media: fakeMedia });
  try {
    player.seek(1);
    player.play();
    await flushMicrotasks(); // object URL resolves
    runFrames(2); // slot assigned, element playing, gains applied
    const slot = player._slots.get(p.tracks.video[0].id);
    assert.ok(slot, 'the playing clip has an element');
    near(slot.gain.gain.value, 1);
    player.pause();
    assert.equal(slot.gain.gain.value, 0, 'paused: silent');
    player.play();
    runFrames(1);
    near(slot.gain.gain.value, 1); // was stuck at 0 before the fix
    // K then L (pause + rate reset, then play) and a reverse shuttle back to forward behave the same
    player.pause();
    player.setRate(1);
    player.play();
    runFrames(1);
    near(slot.gain.gain.value, 1);
    player.setRate(-1);
    runFrames(1);
    assert.equal(slot.gain.gain.value, 0, 'reverse scrub is silent');
    player.setRate(1);
    runFrames(1);
    near(slot.gain.gain.value, 1);
  } finally {
    player.destroy();
  }
});

test('Player.captureFrame strict: refuses offline media and frames still loading', async () => {
  installDomFakes();
  const { Player } = await import('../../extension/studio/engine/player.js');
  let p = project();
  p = M.updateMedia(p, 'a', { status: 'error', error: 'gone' });
  const player = new Player({ canvas: fakeCanvas(), getProject: () => p, media: fakeMedia });
  try {
    await assert.rejects(player.captureFrame({ width: 64, height: 36, strict: true }), /offline media/);
    const loose = await player.captureFrame({ width: 64, height: 36 }); // non-strict: draws the placeholder card
    assert.equal(loose.width, 64);
    p = M.updateMedia(p, 'a', { status: 'loading', error: null });
    await assert.rejects(player.captureFrame({ width: 64, height: 36, strict: true, timeout: 60 }), /still loading/);
    p = M.updateMedia(p, 'a', { status: 'ready' });
    const ok = await player.captureFrame({ width: 64, height: 36, strict: true, timeout: 2000 });
    assert.equal(ok.height, 36);
  } finally {
    player.destroy();
  }
});
