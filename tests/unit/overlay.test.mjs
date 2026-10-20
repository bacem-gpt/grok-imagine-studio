// Overlay track (picture in picture, cutaway, side by side, green screen): model ops and layout (core/model.js),
// clipboard / geometry helpers (ui/edit), frame planning and mix plan (engine/exporter.js, engine/audio-mix.js) and
// the pure renderer helpers (engine/overlays.js: chroma key, transitions, PiP / split geometry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../extension/studio/core/model.js';
import * as Ops from '../../extension/studio/ui/edit/edit-ops.js';
import * as T from '../../extension/studio/ui/edit/timeline-math.js';
import { planFrames, exportProblems, pictureTail } from '../../extension/studio/engine/exporter.js';
import { buildMixPlan, hasAudibleContent } from '../../extension/studio/engine/audio-mix.js';
import { overlayClipGain } from '../../extension/studio/engine/player.js';
import { chromaKey, hexToRgb, rgbToHex, overlayTransitionState, pipRect, pipPositionFor, splitRects } from '../../extension/studio/engine/overlays.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Main track: red 4s + green 3s; bin: blue 5s video (with sound), a still, music. */
function base() {
  let p = M.createProject('Overlay test');
  p = M.addMedia(p, M.createMediaItem({ id: 'r', kind: 'video', duration: 4, hasAudio: true, status: 'ready', name: 'red', width: 1280, height: 720 }));
  p = M.addMedia(p, M.createMediaItem({ id: 'g', kind: 'video', duration: 3, hasAudio: true, status: 'ready', name: 'green' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'b', kind: 'video', duration: 5, hasAudio: true, status: 'ready', name: 'blue' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'img', kind: 'image', status: 'ready', name: 'still', width: 800, height: 600 }));
  p = M.addMedia(p, M.createMediaItem({ id: 'm', kind: 'audio', duration: 12, status: 'ready', name: 'music' }));
  p = M.appendMediaToTimeline(p, ['r', 'g']).project;
  return p;
}

// ---------------------------------------------------------------------------------------------- model

test('createProject has an overlay track; old projects without one load', () => {
  assert.deepEqual(M.createProject().tracks.overlay, []);
  const old = base();
  const raw = JSON.parse(JSON.stringify({ ...old, tracks: { video: old.tracks.video, audio: [], text: [] } }));
  const n = M.normalizeProject(raw);
  assert.deepEqual(n.tracks.overlay, []);
  assert.equal(M.layoutProject(n).overlay.length, 0);
  // a layout of a bare {tracks} without overlay still works (timeline passes only tracks)
  assert.deepEqual(M.layoutProject({ tracks: { video: [], audio: [], text: [] } }).overlay, []);
});

test('addOverlayClip: videos and stills (3 s default), not audio; free lanes; sanitized settings', () => {
  let p = base();
  const a = M.addOverlayClip(p, 'b', { start: 1 });
  p = a.project;
  const c = M.findClip(p, a.id);
  assert.equal(c.track, 'overlay');
  assert.deepEqual([c.clip.start, c.clip.in, c.clip.out, c.clip.lane, c.clip.mode], [1, 0, 5, 0, 'pip']);
  assert.deepEqual(c.clip.pip, { ...M.PIP_DEFAULTS });
  const s = M.addOverlayClip(p, 'img', { start: 2 });
  p = s.project;
  const still = M.findClip(p, s.id).clip;
  assert.equal(M.clipDuration(still), M.DEFAULT_IMAGE_DURATION);
  assert.equal(still.lane, 1, 'overlaps the first overlay: next lane');
  assert.equal(M.addOverlayClip(p, 'm').id, null, 'audio cannot be an overlay');
  assert.equal(M.addOverlayClip(p, 'nope').id, null);
  // sanitize clamps everything
  const bad = M.updateClip(p, a.id, { mode: 'weird', pip: { x: 4, y: -1, scale: 9, borderColor: 'red' }, split: { side: 'diag', size: 3 }, key: { tolerance: 7 }, transitionIn: { type: 'spin', duration: 99 }, speed: 10, out: 99 });
  const bc = M.findClip(bad, a.id).clip;
  assert.equal(bc.mode, 'pip');
  assert.deepEqual([bc.pip.x, bc.pip.y, bc.pip.scale, bc.pip.borderColor], [1, 0, 1, '#ffffff']);
  assert.deepEqual(bc.split, { side: 'left', size: 0.8 });
  assert.equal(bc.key.tolerance, 1);
  assert.equal(bc.transitionIn.type, 'none');
  assert.equal(bc.speed, M.MAX_SPEED);
  assert.equal(bc.out, 5, 'clamped to the media');
  assert.ok(bc.transitionIn.duration <= M.clipDuration(bc) / 2 + 1e-9);
});

test('layout: overlay items look like main items, duration includes overlay ends, items at t sorted by lane', () => {
  let p = base(); // main ends at 7
  const a = M.addOverlayClip(p, 'b', { start: 5, speed: 2 }); // 5s at 2x = 2.5s -> ends 7.5
  p = a.project;
  const s = M.addOverlayClip(p, 'img', { start: 6, lane: 3 });
  p = s.project;
  const lay = M.layoutProject(p);
  assert.equal(lay.overlay.length, 2);
  const it = lay.overlay.find((x) => x.clip.id === a.id);
  assert.deepEqual([it.track, it.start, it.end, it.duration], ['overlay', 5, 7.5, 2.5]);
  assert.equal(lay.duration, 9, 'still ends at 6 + 3');
  assert.ok(near(M.sourceTimeAt(it, 6), 2), 'sourceTimeAt works for overlays (speed 2)');
  assert.ok(near(M.fadeFactor(it, 6), 1));
  assert.deepEqual(M.overlayItemsAt(lay.overlay, 6.5).map((x) => x.clip.lane), [0, 3]);
  assert.deepEqual(M.overlayItemsAt(lay.overlay, 4.9), []);
  assert.equal(M.layoutItemKey(it), `ov:${a.id}`);
  assert.equal(M.layoutItemKey(lay.video[1]), 1);
  // snap points include overlay edges
  const pts = M.snapPoints(p);
  for (const x of [5, 7.5, 6, 9]) assert.ok(pts.includes(x), `snap point ${x}`);
});

test('move, trim (video & still), split, splitAllAt', () => {
  let p = base();
  const a = M.addOverlayClip(p, 'b', { start: 1, in: 1, out: 4 }); // 3s
  p = a.project;
  p = M.moveOverlayClip(p, a.id, 2, 2);
  let c = M.findClip(p, a.id).clip;
  assert.deepEqual([c.start, c.lane], [2, 2]);
  // trim in: keeps the end (5), moves the source in-point along
  p = M.trimOverlayClip(p, a.id, 'in', 2.5);
  c = M.findClip(p, a.id).clip;
  assert.ok(near(c.start, 2.5) && near(c.in, 1.5) && near(c.out, 4));
  // extending left stops at source 0
  p = M.trimOverlayClip(p, a.id, 'in', 0);
  c = M.findClip(p, a.id).clip;
  assert.ok(near(c.in, 0) && near(c.start, 1));
  // trim out
  p = M.trimOverlayClip(p, a.id, 'out', 3);
  c = M.findClip(p, a.id).clip;
  assert.ok(near(c.out, 2));
  // a still grows to the left freely
  const s = M.addOverlayClip(p, 'img', { start: 4 });
  p = M.trimOverlayClip(s.project, s.id, 'in', 2);
  const sc = M.findClip(p, s.id).clip;
  assert.ok(near(sc.start, 2) && near(M.clipDuration(sc), 5));
  // split
  const r = M.splitOverlayAt(p, a.id, 2);
  assert.ok(r.rightId);
  const left = M.findClip(r.project, a.id).clip;
  const right = M.findClip(r.project, r.rightId).clip;
  assert.ok(near(left.out, 1) && near(right.in, 1) && near(right.start, 2));
  assert.equal(M.splitOverlayAt(p, a.id, 1.02).rightId, null, 'too close to the edge');
  // splitAllAt splits selected overlays too
  const all = M.splitAllAt(p, 2, [a.id]);
  assert.equal(all.tracks.overlay.length, 3);
});

test('findClip / updateClip / removeClips / duplicateClips / removeMedia / mediaUsage cover overlays', () => {
  let p = base();
  const a = M.addOverlayClip(p, 'b', { start: 1, mode: 'split' });
  p = a.project;
  assert.equal(M.findClip(p, a.id).track, 'overlay');
  p = M.updateClip(p, a.id, { pip: { ...M.PIP_DEFAULTS, x: 0 } });
  assert.equal(M.findClip(p, a.id).clip.pip.x, 0);
  const d = M.duplicateClips(p, [a.id]);
  assert.equal(d.project.tracks.overlay.length, 2);
  const copy = M.findClip(d.project, d.ids[0]).clip;
  assert.equal(copy.start, 6);
  assert.equal(copy.mode, 'split');
  assert.notEqual(copy.pip, M.findClip(d.project, a.id).clip.pip, 'deep copy');
  assert.deepEqual(M.mediaUsage(p, 'b').map((u) => u.track), ['overlay']);
  assert.equal(M.removeClips(p, [a.id]).tracks.overlay.length, 0);
  assert.equal(M.removeClips(p, [p.tracks.video[0].id]).tracks.overlay.length, 1, 'removing a main clip keeps overlays');
  assert.equal(M.removeMedia(p, ['b']).tracks.overlay.length, 0);
  assert.equal(M.removeMedia(p, ['r']).tracks.overlay.length, 1);
});

test('main <-> overlay moves keep range, speed, sound and look', () => {
  let p = base();
  const green = p.tracks.video[1].id;
  p = M.updateClip(p, green, { in: 0.5, speed: 1.5, volume: 0.4, filters: { ...M.FILTER_DEFAULTS, sepia: 0.5 } });
  const r = M.videoClipToOverlay(p, green);
  assert.equal(r.project.tracks.video.length, 1);
  const ov = M.findClip(r.project, r.id).clip;
  assert.deepEqual([ov.start, ov.in, ov.speed, ov.volume, ov.filters.sepia], [4, 0.5, 1.5, 0.4, 0.5]);
  const back = M.overlayClipToMain(r.project, r.id);
  assert.equal(back.project.tracks.overlay.length, 0);
  assert.equal(back.project.tracks.video.length, 2);
  const v = M.findClip(back.project, back.id);
  assert.equal(v.track, 'video');
  assert.equal(v.index, 1, 'inserted at the cut nearest to where it started');
});

test('normalizeProject / mergeProjects / dedupeMedia handle the overlay track', () => {
  let p = base();
  p = M.addOverlayClip(p, 'b', { start: 1 }).project;
  const raw = JSON.parse(JSON.stringify(p));
  raw.tracks.overlay.push({ id: 'ghost', mediaId: 'missing', start: 0 }); // unknown media is dropped
  raw.tracks.overlay.push({ id: 'snd', mediaId: 'm', start: 0 }); // audio can't be an overlay
  raw.tracks.overlay[0].pip = { x: 0.2 }; // partial settings are completed
  const n = M.normalizeProject(raw);
  assert.deepEqual(n.tracks.overlay.map((c) => c.id), [p.tracks.overlay[0].id]);
  assert.deepEqual(n.tracks.overlay[0].pip, { ...M.PIP_DEFAULTS, x: 0.2 });
  // merge: their overlay edit survives when mine didn't touch the track
  const theirs = M.addOverlayClip(p, 'img', { start: 3 }).project;
  const mine = M.renameProject(p, 'Renamed');
  const merged = M.mergeProjects(p, mine, theirs);
  assert.equal(merged.tracks.overlay.length, 2);
  assert.equal(merged.name, 'Renamed');
  // merged-away media drops its overlay clips
  const gone = M.removeMedia(theirs, ['img']);
  assert.equal(M.mergeProjects(theirs, theirs, gone).tracks.overlay.length, 1);
  // dedupe moves overlay clips to the kept copy
  let q = M.createProject();
  q = M.addMedia(q, M.createMediaItem({ id: 'a1', kind: 'video', origin: 'grok', postId: 'P', addedAt: 1, status: 'ready', duration: 2 }));
  q = M.addMedia(q, M.createMediaItem({ id: 'a2', kind: 'video', origin: 'grok', postId: 'P', addedAt: 2, status: 'ready', duration: 2 }));
  q = M.addOverlayClip(q, 'a2').project;
  assert.equal(M.dedupeMedia(q).tracks.overlay[0].mediaId, 'a1');
});

// ---------------------------------------------------------------------------------------------- edit helpers

test('copy / paste, trimEdgeTo, clipsAt, allClipIds and timeline geometry include overlays', () => {
  let p = base();
  const a = M.addOverlayClip(p, 'b', { start: 1, mode: 'cutaway' });
  p = a.project;
  const cb = Ops.copyClips(p, [a.id]);
  assert.equal(cb.overlay.length, 1);
  const r = Ops.pasteClips(p, cb, 6);
  assert.equal(r.ids.length, 1);
  const pasted = M.findClip(r.project, r.ids[0]).clip;
  assert.deepEqual([pasted.start, pasted.mode], [6, 'cutaway']);
  assert.ok(Ops.allClipIds(p).includes(a.id));
  assert.deepEqual(Ops.clipsAt(p, 2).map((x) => x.track).sort(), ['overlay', 'video']);
  assert.ok(near(M.findClip(Ops.trimEdgeTo(p, a.id, 'out', 3), a.id).clip.out, 2));
  assert.equal(Ops.sequenceStats(p).overlay, 1);
  assert.deepEqual(Ops.selectionRange(p, [a.id]), { start: 1, end: 6 });
  // geometry: overlay lanes between text and V1, highest first
  assert.equal(T.overlayLaneCount(p), 1);
  assert.equal(T.overlayLaneCount(M.moveOverlayClip(p, a.id, 1, 2)), 3);
  const g = T.trackGeometry({ text: 1, audio: 1, overlay: 2 }, { textH: 30, overlayH: 40, videoH: 64, audioH: 44 });
  assert.deepEqual(g.rows.map((x) => x.label), ['T1', 'V3', 'V2', 'V1', 'A1']);
  assert.equal(g.videoTop, 110);
  assert.equal(T.laneAt(g, 'overlay', 35), 1);
  assert.equal(T.laneAt(g, 'overlay', 75), 0);
  assert.equal(T.laneAt(g, 'overlay', 5), 2, 'above the top overlay lane: a new lane');
  // without overlay lanes the geometry is unchanged
  assert.equal(T.trackGeometry({ text: 1, audio: 1 }).rows.length, 3);
  // snap candidates skip the dragged overlay
  const pts = T.snapCandidates(p, [a.id]);
  assert.ok(!pts.includes(1) && !pts.includes(6));
  assert.ok(T.snapCandidates(p, []).includes(6));
});

// ---------------------------------------------------------------------------------------------- export / mix

test('planFrames gives overlays their own entries keyed ov:<id>; exportProblems and pictureTail see overlays', () => {
  let p = base();
  const a = M.addOverlayClip(p, 'b', { start: 1, out: 2 }); // 1..3
  p = a.project;
  const plan = planFrames(M.layoutProject(p), { start: 0, end: 4, fps: 10 });
  const ov = plan.items.find((e) => e.key === `ov:${a.id}`);
  assert.ok(ov);
  assert.deepEqual([ov.first, ov.last, ov.times.length], [10, 29, 20]);
  assert.ok(near(ov.times[0], 0) && near(ov.times[19], 1.9));
  assert.ok(plan.items.some((e) => e.key === 0));
  // missing / offline overlay media blocks the export
  const off = M.updateMedia(p, 'b', { status: 'error' });
  assert.deepEqual(exportProblems(off).map((x) => x.mediaId), ['b']);
  assert.deepEqual(exportProblems(off, { start: 4, end: 5 }), [], 'outside its range');
  // an overlay past the main track is picture, not background
  const late = M.addOverlayClip(p, 'img', { start: 6 }).project; // main ends 7, still ends 9
  assert.equal(pictureTail(late), null);
});

test('mix plan includes overlay sound with speed, fades and mute', () => {
  let p = base();
  const a = M.addOverlayClip(p, 'b', { start: 1, in: 1, out: 3, speed: 2, fadeIn: 0.5, volume: 0.5 }); // 1s on the timeline
  p = a.project;
  const plan = buildMixPlan(p);
  const s = plan.find((x) => x.clipId === a.id);
  assert.ok(s);
  assert.deepEqual([s.track, s.mediaId, s.when, s.offset, s.duration, s.rate], ['overlay', 'b', 1, 1, 2, 2]);
  assert.ok(near(s.envelope[0].v, 0), 'fades in from silence');
  assert.ok(Math.max(...s.envelope.map((e) => e.v)) <= 0.5 + 1e-9, 'volume');
  const muted = M.updateClip(p, a.id, { muted: true });
  assert.ok(!buildMixPlan(muted).some((x) => x.clipId === a.id));
  // a still overlay is silent; overlay sound counts as audible content
  const still = M.addOverlayClip(M.createProject(), 'x').project;
  assert.equal(still.tracks.overlay.length, 0);
  let solo = M.addMedia(M.createProject(), M.createMediaItem({ id: 'v', kind: 'video', duration: 2, hasAudio: true, status: 'ready' }));
  solo = M.addOverlayClip(solo, 'v').project;
  assert.ok(hasAudibleContent(solo));
  // preview gain follows volume x mute x fades
  const it = M.layoutProject(p).overlay[0];
  assert.ok(near(overlayClipGain(it, 1.25), 0.25));
  assert.ok(near(overlayClipGain(it, 1.75), 0.5));
  assert.equal(overlayClipGain(it, 3), 0);
});

// ---------------------------------------------------------------------------------------------- renderer helpers

test('chromaKey removes the key colour, keeps others, feathers edges and suppresses spill', () => {
  const px = (r, g, b) => [r, g, b, 255];
  const data = new Uint8ClampedArray([...px(0, 255, 0), ...px(40, 200, 60), ...px(255, 0, 0), ...px(255, 255, 255), ...px(230, 180, 150), ...px(0, 0, 255)]);
  chromaKey(data, { color: '#00ff00', tolerance: 0.4, softness: 0.1, spill: 0.5 });
  const alpha = (i) => data[i * 4 + 3];
  assert.equal(alpha(0), 0, 'pure green keyed');
  assert.equal(alpha(1), 0, 'a real-world green keyed too');
  assert.equal(alpha(2), 255, 'red kept');
  assert.equal(alpha(3), 255, 'white kept');
  assert.equal(alpha(4), 255, 'skin tone kept');
  assert.equal(alpha(5), 255, 'blue kept with a green key');
  // blue key
  const blue = new Uint8ClampedArray([...px(0, 71, 255), ...px(0, 255, 0)]);
  chromaKey(blue, { color: '#0047ff' });
  assert.deepEqual([blue[3], blue[7]], [0, 255]);
  // softness: a colour just outside the tolerance is partly transparent
  const edge = new Uint8ClampedArray([...px(90, 200, 90)]);
  chromaKey(edge, { color: '#00ff00', tolerance: 0.25, softness: 0.3, spill: 0 });
  assert.ok(edge[3] > 0 && edge[3] < 255, `semi-transparent edge (${edge[3]})`);
  // spill: a greenish pixel near the key gets desaturated
  const spill = new Uint8ClampedArray([...px(120, 200, 120)]);
  chromaKey(spill, { color: '#00ff00', tolerance: 0.1, softness: 0.01, spill: 1 });
  assert.ok(spill[1] - spill[0] < 80, 'less green than before');
  assert.equal(spill[3], 255);
  assert.deepEqual(hexToRgb('#0047ff'), [0, 71, 255]);
  assert.equal(rgbToHex(0, 71, 255), '#0047ff');
});

test('overlay transitions: dissolve, zoom and slide in / out plus fades', () => {
  const clip = { start: 0, in: 0, out: 4, speed: 1, fadeIn: 0, fadeOut: 0, transitionIn: { type: 'dissolve', duration: 1 }, transitionOut: { type: 'zoom', duration: 1 } };
  const item = M.layoutOverlay([clip])[0];
  assert.ok(near(overlayTransitionState(item, 0.5).alpha, 0.5));
  assert.equal(overlayTransitionState(item, 0.5).phase, 'in');
  assert.deepEqual(overlayTransitionState(item, 2), { alpha: 1, scale: 1, slide: 0, phase: null, k: 1 });
  const out = overlayTransitionState(item, 3.5);
  assert.equal(out.phase, 'out');
  assert.ok(out.scale > 0 && out.scale < 1);
  const slide = M.layoutOverlay([{ ...clip, transitionIn: { type: 'slide', duration: 1 } }])[0];
  assert.ok(near(overlayTransitionState(slide, 0).slide, 1));
  assert.ok(overlayTransitionState(slide, 0.5).slide < 0.5);
  const faded = M.layoutOverlay([{ ...clip, transitionIn: { type: 'none', duration: 1 }, fadeIn: 2 }])[0];
  assert.ok(near(overlayTransitionState(faded, 1).alpha, 0.5));
});

test('PiP and split geometry', () => {
  const W = 1280;
  const H = 720;
  const m = Math.round(720 * 0.035);
  const tr = pipRect({ x: 1, y: 0, scale: 0.25 }, 1920, 1080, W, H);
  assert.deepEqual([tr.w, tr.h], [320, 180]);
  assert.ok(near(tr.x, W - m - 320) && near(tr.y, m));
  const bl = pipRect({ x: 0, y: 1, scale: 0.25 }, 1920, 1080, W, H);
  assert.ok(near(bl.x, m) && near(bl.y, H - m - 180));
  const tall = pipRect({ x: 0.5, y: 0.5, scale: 1 }, 720, 1280, W, H);
  assert.ok(tall.h <= H * 0.92 + 1e-9, 'never taller than the frame');
  const pos = pipPositionFor(tr.x, tr.y, tr.w, tr.h, W, H);
  assert.ok(near(pos.x, 1) && near(pos.y, 0));
  assert.deepEqual(splitRects({ side: 'left', size: 0.5 }, W, H), { overlay: { x: 0, y: 0, w: 640, h: H }, main: { x: 640, y: 0, w: 640, h: H } });
  assert.deepEqual(splitRects({ side: 'bottom', size: 0.25 }, W, H).overlay, { x: 0, y: 540, w: W, h: 180 });
  assert.deepEqual(splitRects({ side: 'right', size: 0.3 }, W, H).main, { x: 0, y: 0, w: 896, h: H });
});
