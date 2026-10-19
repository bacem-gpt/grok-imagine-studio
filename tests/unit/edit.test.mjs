// Unit tests for the Edit tab's pure modules: ui/edit/timeline-math.js, ui/edit/edit-ops.js and ui/edit/edit-layout.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../extension/studio/core/model.js';
import * as T from '../../extension/studio/ui/edit/timeline-math.js';
import * as Ops from '../../extension/studio/ui/edit/edit-ops.js';
import { editLayout } from '../../extension/studio/ui/edit/edit-layout.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

function fixture() {
  let p = M.createProject('t');
  const a = M.createMediaItem({ id: 'a', kind: 'video', duration: 6, width: 1280, height: 720, hasAudio: true, status: 'ready' });
  const b = M.createMediaItem({ id: 'b', kind: 'video', duration: 4, width: 640, height: 360, hasAudio: true, status: 'ready' });
  const c = M.createMediaItem({ id: 'c', kind: 'video', duration: 5, width: 720, height: 1280, hasAudio: false, status: 'ready' });
  const img = M.createMediaItem({ id: 'img', kind: 'image', width: 800, height: 800, status: 'ready' });
  const mus = M.createMediaItem({ id: 'mus', kind: 'audio', duration: 30, status: 'ready' });
  for (const m of [a, b, c, img, mus]) p = M.addMedia(p, m);
  return M.appendMediaToTimeline(p, ['a', 'b', 'c']).project;
}

// ---------------------------------------------------------------------------------------------------------
// timeline-math
// ---------------------------------------------------------------------------------------------------------

test('zoom: clamping, log slider round trip, fit and steps', () => {
  assert.equal(T.clampZoom(0), T.DEFAULT_ZOOM);
  assert.equal(T.clampZoom(-5), T.DEFAULT_ZOOM);
  assert.equal(T.clampZoom(1e9), T.MAX_ZOOM);
  assert.equal(T.clampZoom(1), T.MIN_ZOOM);
  assert.equal(T.zoomToSlider(T.MIN_ZOOM), 0);
  assert.equal(T.zoomToSlider(T.MAX_ZOOM), 1000);
  for (const z of [5, 20, 80, 200, 500]) near(T.sliderToZoom(T.zoomToSlider(z)), z, z * 0.01);
  near(T.fitZoom(10, 836, 36), 80);
  assert.equal(T.fitZoom(0, 800), T.DEFAULT_ZOOM);
  assert.equal(T.fitZoom(10000, 800), T.MIN_ZOOM);
  assert.ok(T.stepZoom(80, 1) > 80 && T.stepZoom(80, -1) < 80);
  assert.equal(T.stepZoom(T.MAX_ZOOM, 1), T.MAX_ZOOM);
  near(T.anchoredScroll(10, 100, 250), 750);
  assert.equal(T.anchoredScroll(1, 100, 250), 0);
});

test('ruler ticks adapt to zoom: labelled majors far enough apart, minors subdivide', () => {
  for (const zoom of [4, 12, 40, 80, 200, 640]) {
    const { major, minor, ticks } = T.rulerTicks(zoom, 0, 60);
    assert.ok(major * zoom >= 72 || major === 3600, `major ${major}s at ${zoom}px/s is ${major * zoom}px`);
    const majors = ticks.filter((t) => t.major);
    assert.ok(majors.length >= 1);
    assert.ok(majors.every((t) => typeof t.label === 'string'));
    assert.ok(ticks.filter((t) => !t.major).every((t) => t.label === null));
    for (let i = 1; i < majors.length; i++) near(majors[i].t - majors[i - 1].t, major, 1e-6);
    if (minor * zoom >= 6) assert.ok(ticks.some((t) => !t.major));
  }
  const at80 = T.rulerTicks(80, 2.3, 5.1);
  assert.equal(at80.major, 1);
  assert.ok(at80.ticks[0].t <= 2.3 && at80.ticks[at80.ticks.length - 1].t >= 5.1);
  assert.deepEqual(
    at80.ticks.filter((t) => t.major).map((t) => t.label),
    ['0:03', '0:04', '0:05'],
  );
  // never negative, never absurdly many ticks
  assert.ok(T.rulerTicks(80, -10, 1).ticks.every((t) => t.t >= 0));
  assert.ok(T.rulerTicks(640, 0, 100000).ticks.length <= 5000);
});

test('ruler labels', () => {
  assert.equal(T.rulerLabel(0, 1), '0:00');
  assert.equal(T.rulerLabel(75, 5), '1:15');
  assert.equal(T.rulerLabel(1.5, 0.5), '0:01.5');
  assert.equal(T.rulerLabel(3725, 60), '1:02:05');
});

test('lane counts and track geometry (text lanes highest first, then V1, then audio)', () => {
  let p = fixture();
  assert.deepEqual(T.laneCounts(p), { text: 1, audio: 1 });
  p = M.addAudioClip(p, 'mus', { start: 0, lane: 2 }).project;
  p = M.addTextClip(p, { start: 0, duration: 2, lane: 1 }).project;
  assert.deepEqual(T.laneCounts(p), { text: 2, audio: 3 });
  const g = T.trackGeometry({ text: 2, audio: 3 }, { textH: 30, videoH: 64, audioH: 44 });
  assert.deepEqual(
    g.rows.map((r) => r.label),
    ['T2', 'T1', 'V1', 'A1', 'A2', 'A3'],
  );
  assert.equal(g.videoTop, 60);
  assert.equal(g.height, 60 + 64 + 3 * 44);
  assert.equal(g.laneTop('audio', 1), 60 + 64 + 44);
  assert.equal(g.laneTop('text', 1), 0);
  assert.equal(T.rowAt(g, 70).kind, 'video');
  assert.equal(T.rowAt(g, -10).label, 'T2');
  assert.equal(T.rowAt(g, 10000).label, 'A3');
  // dragging: lanes of the same kind; below the last audio lane -> a new lane; above the text lanes -> a new one
  assert.equal(T.laneAt(g, 'audio', 60 + 64 + 44 + 5), 1);
  assert.equal(T.laneAt(g, 'audio', 10), 0);
  assert.equal(T.laneAt(g, 'audio', 10000), 3);
  assert.equal(T.laneAt(g, 'text', 5), 1);
  assert.equal(T.laneAt(g, 'text', 35), 0);
  assert.equal(T.laneAt(g, 'text', -5), 2);
  assert.equal(T.laneAt(g, 'text', 200), 0);
  const withExtra = T.trackGeometry({ text: 1, audio: 1 }, { extraAudio: 1 });
  assert.equal(withExtra.rows[withExtra.rows.length - 1].extra, true);
});

test('snapMove snaps either edge of a moving block to the closest point', () => {
  const pts = [0, 4, 10];
  assert.deepEqual(T.snapMove(3.9, 2, pts, 0.2), { start: 4, snapped: true, point: 4 });
  assert.deepEqual(T.snapMove(7.95, 2, pts, 0.2), { start: 8, snapped: true, point: 10 });
  assert.equal(T.snapMove(6, 2, pts, 0.2).snapped, false);
  // both edges within reach: the closer one wins
  const r = T.snapMove(3.95, 6.1, pts, 0.2);
  assert.equal(r.point, 4);
});

test('snapCandidates leaves out the dragged clips and adds extras', () => {
  let p = fixture();
  const r = M.addAudioClip(p, 'mus', { start: 2.5 });
  p = r.project;
  const all = T.snapCandidates(p, [], [1.25]);
  assert.ok(all.includes(2.5) && all.includes(1.25));
  const without = T.snapCandidates(p, [r.id], [1.25]);
  assert.ok(!without.includes(2.5));
  assert.ok(without.includes(6)); // main-track boundary stays
});

test('reorderTarget: slots, final index and no-ops', () => {
  const p = fixture(); // a(0-6) b(6-10) c(10-15)
  const lay = M.layoutVideo(p.tracks.video);
  const [a, b, c] = p.tracks.video.map((x) => x.id);
  // drag a to the end
  let t = T.reorderTarget(lay, [a], 14);
  assert.deepEqual({ slot: t.slot, toIndex: t.toIndex, time: t.time, noop: t.noop }, { slot: 3, toIndex: 2, time: 15, noop: false });
  // drag c to the start
  t = T.reorderTarget(lay, [c], 1);
  assert.deepEqual({ slot: t.slot, toIndex: t.toIndex, time: t.time, noop: t.noop }, { slot: 0, toIndex: 0, time: 0, noop: false });
  // dropping b next to itself is a no-op
  assert.equal(T.reorderTarget(lay, [b], 6.5).noop, true);
  assert.equal(T.reorderTarget(lay, [b], 11).noop, true);
  // block of a+b dropped after c
  t = T.reorderTarget(lay, new Set([a, b]), 14);
  assert.equal(t.toIndex, 1);
  assert.equal(t.noop, false);
});

test('edit points and next/previous navigation', () => {
  let p = fixture();
  p = M.addMarker(p, 3).project;
  const pts = T.editPoints(p);
  assert.deepEqual(pts, [0, 3, 6, 10, 15]);
  assert.equal(T.nextEditPoint(pts, 0, 1), 3);
  assert.equal(T.nextEditPoint(pts, 3, 1), 6);
  assert.equal(T.nextEditPoint(pts, 6.0004, -1), 3);
  assert.equal(T.nextEditPoint(pts, 15, 1), null);
  assert.equal(T.nextEditPoint(pts, 0, -1), null);
});

test('filmstrip tiles sample frames by timeline time, honouring in point and speed', () => {
  const tiles = T.filmstripTiles({ widthPx: 400, tileW: 100, zoom: 100, clipIn: 0, speed: 1, mediaDuration: 4, stripCount: 10 });
  assert.equal(tiles.length, 4);
  assert.deepEqual(tiles.map((t) => t.x), [0, 100, 200, 300]);
  assert.deepEqual(tiles.map((t) => t.index), [1, 3, 6, 8]);
  const fast = T.filmstripTiles({ widthPx: 200, tileW: 100, zoom: 100, clipIn: 2, speed: 2, mediaDuration: 6, stripCount: 10 });
  assert.deepEqual(fast.map((t) => t.index), [5, 8]);
  const capped = T.filmstripTiles({ widthPx: 100000, tileW: 50, zoom: 100, clipIn: 0, mediaDuration: 1000, stripCount: 10, max: 100 });
  assert.equal(capped.length, 100);
  assert.deepEqual(T.filmstripTiles({ widthPx: 0, tileW: 10, zoom: 1, clipIn: 0, mediaDuration: 1, stripCount: 10 }), []);
});

// ---------------------------------------------------------------------------------------------------------
// edit-ops
// ---------------------------------------------------------------------------------------------------------

test('moveVideoClips moves single clips and contiguous/non-contiguous blocks', () => {
  let p = fixture();
  const [a, b, c] = p.tracks.video.map((x) => x.id);
  p = M.setTransition(p, b, { type: 'crossfade', duration: 0.5 });
  const single = Ops.moveVideoClips(p, [a], 2);
  assert.deepEqual(single.tracks.video.map((x) => x.id), [b, c, a]);
  assert.equal(single.tracks.video[0].transition, null, 'new first clip loses its transition');
  const block = Ops.moveVideoClips(p, [a, c], 1);
  assert.deepEqual(block.tracks.video.map((x) => x.id), [b, a, c]);
  const back = Ops.moveVideoClips(p, [c, b], 0);
  assert.deepEqual(back.tracks.video.map((x) => x.id), [b, c, a]);
  assert.equal(Ops.moveVideoClips(p, [a, b], 0), p, 'no-op returns the same project');
  assert.equal(Ops.moveVideoClips(p, ['nope'], 0), p);
});

test('setVideoTrack re-validates and fixes the first transition', () => {
  const p = fixture();
  const clips = [{ ...p.tracks.video[1], transition: { type: 'wipe-left', duration: 1 } }, p.tracks.video[0]];
  const q = Ops.setVideoTrack(p, clips);
  assert.equal(q.tracks.video.length, 2);
  assert.equal(q.tracks.video[0].transition, null);
});

test('copy/paste keeps relative timing, gives new ids, finds free lanes, skips missing media', () => {
  let p = fixture();
  const ra = M.addAudioClip(p, 'mus', { start: 7, in: 1, out: 4, fadeIn: 0.5 });
  p = ra.project;
  const rt = M.addTextClip(p, { text: 'Hi', start: 8, duration: 2 });
  p = rt.project;
  const bId = p.tracks.video[1].id; // b starts at 6
  const cb = Ops.copyClips(p, [bId, ra.id, rt.id]);
  assert.equal(cb.base, 6);
  assert.equal(cb.video.length, 1);
  const { project: q, ids } = Ops.pasteClips(p, cb, 20);
  assert.equal(ids.length, 3);
  assert.ok(ids.every((id) => ![bId, ra.id, rt.id].includes(id)));
  assert.equal(q.tracks.video.length, 4);
  assert.equal(q.tracks.video[3].mediaId, 'b'); // inserted at the end (t beyond the track)
  const pa = M.findClip(q, ids[1]).clip;
  near(pa.start, 21);
  assert.equal(pa.in, 1);
  assert.equal(pa.fadeIn, 0.5);
  const pt = M.findClip(q, ids[2]).clip;
  near(pt.start, 22);
  assert.equal(pt.text, 'Hi');
  // pasting over the originals' time range puts them on free lanes
  const over = Ops.pasteClips(p, cb, 6);
  assert.equal(M.findClip(over.project, over.ids[1]).clip.lane, 1);
  assert.equal(M.findClip(over.project, over.ids[2]).clip.lane, 1);
  // media removed in the meantime -> skipped
  const gone = Ops.pasteClips(M.removeMedia(p, ['b', 'mus']), cb, 0);
  assert.equal(gone.ids.length, 1);
  assert.equal(Ops.copyClips(p, []), null);
  assert.deepEqual(Ops.pasteClips(p, null, 0).ids, []);
});

test('detachAudio moves the sound to an audio lane and mutes the clip', () => {
  let p = fixture();
  const b = p.tracks.video[1];
  p = M.updateClip(p, b.id, { in: 1, out: 3.5, volume: 0.8, fadeIn: 0.25 });
  assert.equal(Ops.canDetachAudio(p, M.findClip(p, b.id).clip), true);
  const { project: q, id } = Ops.detachAudio(p, b.id);
  assert.ok(id);
  const aud = M.findClip(q, id).clip;
  assert.equal(aud.mediaId, 'b');
  near(aud.start, 6);
  assert.equal(aud.in, 1);
  assert.equal(aud.out, 3.5);
  assert.equal(aud.volume, 0.8);
  assert.equal(aud.fadeIn, 0.25);
  assert.equal(M.findClip(q, b.id).clip.muted, true);
  // no sound / speed-changed -> not possible
  const c = p.tracks.video[2];
  assert.equal(Ops.canDetachAudio(p, c), false);
  assert.equal(Ops.detachAudio(p, c.id).id, null);
  const fast = M.updateClip(p, b.id, { speed: 2 });
  assert.equal(Ops.detachAudio(fast, b.id).id, null);
});

test('trimEdgeTo trims any clip edge to the playhead', () => {
  let p = fixture();
  const a = p.tracks.video[0].id;
  let q = Ops.trimEdgeTo(p, a, 'out', 2.5);
  near(M.findClip(q, a).clip.out, 2.5);
  near(M.layoutProject(q).videoEnd, 15 - 3.5);
  q = Ops.trimEdgeTo(p, a, 'in', 1.5);
  near(M.findClip(q, a).clip.in, 1.5);
  assert.equal(Ops.trimEdgeTo(p, a, 'in', 9), p, 'playhead outside the clip: no change');
  const r = M.addAudioClip(p, 'mus', { start: 2 });
  p = r.project;
  q = Ops.trimEdgeTo(p, r.id, 'in', 5);
  near(M.findClip(q, r.id).clip.start, 5);
  near(M.findClip(q, r.id).clip.in, 3);
  const t = M.addTextClip(p, { start: 1, duration: 4 });
  p = t.project;
  q = Ops.trimEdgeTo(p, t.id, 'in', 2);
  assert.deepEqual([M.findClip(q, t.id).clip.start, M.findClip(q, t.id).clip.duration], [2, 3]);
  q = Ops.trimEdgeTo(p, t.id, 'out', 3);
  assert.equal(M.findClip(q, t.id).clip.duration, 2);
});

test('trimTextTo keeps the opposite edge fixed and respects the minimum length', () => {
  let p = fixture();
  const r = M.addTextClip(p, { start: 2, duration: 3 });
  p = r.project;
  const orig = M.findClip(p, r.id).clip;
  let q = Ops.trimTextTo(p, r.id, 'in', 4.99, orig);
  near(M.findClip(q, r.id).clip.start, 5 - M.MIN_CLIP_DURATION);
  near(M.findClip(q, r.id).clip.duration, M.MIN_CLIP_DURATION);
  q = Ops.trimTextTo(p, r.id, 'in', -3, orig);
  assert.deepEqual([M.findClip(q, r.id).clip.start, M.findClip(q, r.id).clip.duration], [0, 5]);
  q = Ops.trimTextTo(p, r.id, 'out', 9, orig);
  assert.equal(M.findClip(q, r.id).clip.duration, 7);
});

test('presets: Ken Burns, filters, resolution, size for media', () => {
  const kb = Ops.kenBurnsPreset('pan-left');
  assert.ok(kb.from.x > kb.to.x);
  assert.equal(Ops.matchKenBurnsPreset(kb), 'pan-left');
  kb.from.x = 0.1;
  assert.equal(Ops.matchKenBurnsPreset(kb), null);
  assert.equal(Ops.kenBurnsPreset('nope'), null);
  assert.equal(Ops.filterPresetValues('none'), null);
  const noir = Ops.filterPresetValues('noir');
  assert.equal(noir.grayscale, 1);
  assert.equal(noir.brightness, 1);
  assert.equal(Ops.matchFilterPreset(noir), 'noir');
  assert.equal(Ops.matchFilterPreset(null), 'none');
  assert.equal(Ops.matchFilterPreset({ ...M.FILTER_DEFAULTS, hue: 33 }), null);
  assert.equal(Ops.resolutionPresetId({ width: 1080, height: 1920 }), '1080v');
  assert.equal(Ops.resolutionPresetId({ width: 1000, height: 1000 }), 'custom');
  assert.deepEqual(Ops.sizeForMedia({ width: 720, height: 1280 }), { width: 720, height: 1280 });
  assert.deepEqual(Ops.sizeForMedia({ width: 3840, height: 2160 }), { width: 1920, height: 1080 });
  assert.deepEqual(Ops.sizeForMedia({ width: 641, height: 359 }), { width: 642, height: 360 });
  assert.equal(Ops.sizeForMedia({ width: 0, height: 0 }), null);
});

test('clipsAt, selectionRange, allClipIds, sequenceStats', () => {
  let p = fixture();
  p = M.setTransition(p, p.tracks.video[1].id, { type: 'crossfade', duration: 1 });
  const r = M.addAudioClip(p, 'mus', { start: 1 });
  p = r.project;
  const t = M.addTextClip(p, { start: 5, duration: 1 });
  p = t.project;
  const at = Ops.clipsAt(p, 5.5);
  assert.deepEqual(at.map((x) => x.track).sort(), ['audio', 'text', 'video', 'video']);
  const range = Ops.selectionRange(p, [t.id, p.tracks.video[0].id]);
  assert.deepEqual(range, { start: 0, end: 6 });
  assert.equal(Ops.selectionRange(p, ['x']), null);
  assert.equal(Ops.allClipIds(p).length, 5);
  const s = Ops.sequenceStats(p);
  assert.equal(s.clips, 3);
  assert.equal(s.transitions, 1);
  assert.equal(s.audio, 1);
  assert.equal(s.text, 1);
  near(s.duration, 31);
});

test('updateClipIfChanged: no-op patches return the same project (no empty undo steps)', () => {
  const p = fixture();
  const id = p.tracks.video[0].id;
  assert.equal(Ops.updateClipIfChanged(p, id, { fit: 'cover' }), p, 'already cover');
  assert.equal(Ops.updateClipIfChanged(p, id, { speed: 99 }) === p, false, 'clamped to 4 is still a change');
  const fast = Ops.updateClipIfChanged(p, id, { speed: 4 });
  assert.equal(Ops.updateClipIfChanged(fast, id, { speed: 99 }), fast, 'past the limit: nothing changes');
  assert.equal(Ops.updateClipIfChanged(p, 'missing', { speed: 2 }), p);
  const f = Ops.updateClipIfChanged(p, id, { filters: Ops.filterPresetValues('noir') });
  assert.notEqual(f, p);
  assert.equal(Ops.updateClipIfChanged(f, id, { filters: Ops.filterPresetValues('noir') }), f);
});

test('sameTransitions compares every junction', () => {
  const p = fixture();
  const a = M.setAllTransitions(p, { type: 'crossfade', duration: 0.5 });
  assert.equal(Ops.sameTransitions(p, p), true);
  assert.equal(Ops.sameTransitions(p, a), false);
  assert.equal(Ops.sameTransitions(a, M.setAllTransitions(a, { type: 'crossfade', duration: 0.5 })), true);
  assert.equal(Ops.sameTransitions(a, M.setAllTransitions(a, { type: 'crossfade', duration: 0.6 })), false);
  assert.equal(Ops.sameTransitions(a, M.setTransition(a, a.tracks.video[1].id, { type: 'wipe-left', duration: 0.5 })), false);
});

test('moveMarker keeps markers sorted, clamps at 0, and is a no-op when nothing moves', () => {
  let p = fixture();
  p = M.addMarker(p, 2, 'a').project;
  const r = M.addMarker(p, 5, 'b');
  p = r.project;
  const q = Ops.moveMarker(p, r.id, 1);
  assert.deepEqual(q.markers.map((m) => m.label), ['b', 'a']);
  assert.equal(q.markers[0].time, 1);
  assert.equal(Ops.moveMarker(q, r.id, -3).markers[0].time, 0);
  assert.equal(Ops.moveMarker(q, r.id, 1), q);
  assert.equal(Ops.moveMarker(q, 'nope', 4), q);
});

test('audioTrimFloor: extending an audio clip start never shifts its sound against the timeline', () => {
  let p = fixture();
  const r = M.addAudioClip(p, 'mus', { start: 1, in: 2, out: 8 });
  p = r.project;
  const c = M.findClip(p, r.id).clip;
  const heardAt = (clip, t) => clip.in + (t - clip.start); // source second heard at timeline t
  assert.equal(Ops.audioTrimFloor(c), 0); // in (2) > start (1): the floor is timeline 0
  const q = M.trimAudioClip(p, r.id, 'in', Math.max(-2, Ops.audioTrimFloor(c)));
  const c2 = M.findClip(q, r.id).clip;
  assert.equal(c2.start, 0);
  assert.equal(c2.in, 1);
  assert.equal(heardAt(c2, 3), heardAt(c, 3));
  // start > in: the floor is where the source starts
  const r2 = M.addAudioClip(p, 'mus', { start: 6, in: 1, out: 4, lane: 1 });
  const d = M.findClip(r2.project, r2.id).clip;
  assert.equal(Ops.audioTrimFloor(d), 5);
  const d2 = M.findClip(M.trimAudioClip(r2.project, r2.id, 'in', Ops.audioTrimFloor(d)), r2.id).clip;
  assert.deepEqual([d2.start, d2.in], [5, 0]);
  assert.equal(heardAt(d2, 7), heardAt(d, 7));
});

test('cutTransitions: hard cuts only, one transition everywhere, or a mix', () => {
  const p = fixture(); // 3 clips = 2 cuts
  const [, b, c] = p.tracks.video;
  assert.deepEqual(Ops.cutTransitions(p), { cuts: 2, withTransition: 0, kind: 'none', type: null, duration: null, types: [] });
  const all = M.setAllTransitions(p, { type: 'crossfade', duration: 0.5 });
  assert.deepEqual(Ops.cutTransitions(all), { cuts: 2, withTransition: 2, kind: 'same', type: 'crossfade', duration: 0.5, types: ['crossfade'] });
  // same type, other durations: still one transition everywhere (the first cut's duration)
  assert.equal(Ops.cutTransitions(M.setTransition(all, c.id, { type: 'crossfade', duration: 0.9 })).kind, 'same');
  // only some cuts, or different types: mixed (the 'Every cut' picker must not claim 'Cut' or one type then)
  const some = M.setTransition(p, b.id, { type: 'wipe-left', duration: 0.5 });
  assert.deepEqual(Ops.cutTransitions(some), { cuts: 2, withTransition: 1, kind: 'mixed', type: null, duration: null, types: ['wipe-left'] });
  const two = M.setTransition(some, c.id, { type: 'crossfade', duration: 0.5 });
  assert.deepEqual([Ops.cutTransitions(two).kind, Ops.cutTransitions(two).types], ['mixed', ['wipe-left', 'crossfade']]);
  // a single clip has no cut
  const one = Ops.setVideoTrack(p, [p.tracks.video[0]]);
  assert.deepEqual([Ops.cutTransitions(one).cuts, Ops.cutTransitions(one).kind], [0, 'none']);
});

test('transition snapshots: count what a change replaced and put it back', () => {
  const p = fixture();
  const [a, b, c] = p.tracks.video;
  let mixed = M.setTransition(p, b.id, { type: 'wipe-left', duration: 0.5 });
  mixed = M.setTransition(mixed, c.id, { type: 'crossfade', duration: 0.7 });
  const snap = Ops.transitionSnapshot(mixed);
  assert.deepEqual(Object.keys(snap), [a.id, b.id, c.id]);
  assert.equal(snap[a.id], null);
  // dissolve everywhere replaces the wipe only; removing all replaces both
  const dissolve = M.setAllTransitions(mixed, { type: 'crossfade', duration: 0.6 });
  assert.equal(Ops.replacedTransitions(snap, dissolve), 1);
  assert.equal(Ops.replacedTransitions(snap, M.setAllTransitions(mixed, null)), 2);
  assert.equal(Ops.replacedTransitions(snap, mixed), 0);
  // a clip deleted since is not counted as replaced
  assert.equal(Ops.replacedTransitions(snap, M.removeClips(M.setAllTransitions(mixed, null), [b.id])), 1);
  // restore puts back types and durations by clip id, also after a reorder
  const restored = Ops.restoreTransitions(M.setAllTransitions(mixed, null), snap);
  assert.equal(Ops.sameTransitions(restored, mixed), true);
  assert.equal(Ops.restoreTransitions(mixed, snap), mixed); // nothing to restore: same project
  const moved = Ops.moveVideoClips(M.setAllTransitions(mixed, null), [c.id], 1); // a, c, b
  const back = Ops.restoreTransitions(moved, snap);
  assert.deepEqual(back.tracks.video.map((x) => x.transition?.type || null), [null, 'crossfade', 'wipe-left']);
});

test('toolbarLayout: labels follow the toolbar width; the zoom slider goes before Audio / Transitions labels', () => {
  const at = (w) => {
    const l = T.toolbarLayout(w);
    return `${[l.text && 'text', l.audio && 'audio', l.transitions && 'transitions'].filter(Boolean).join('+') || 'icons'}/${l.slider}`;
  };
  assert.equal(at(1440), 'text+audio+transitions/full');
  assert.equal(at(720), 'text+audio+transitions/full'); // the default 720 px dock: room for every label
  assert.equal(at(600), 'text+audio+transitions/small');
  assert.equal(at(540), 'text+audio+transitions/none'); // the slider goes before any label
  assert.equal(at(500), 'audio+transitions/none');
  assert.equal(at(480), 'audio/small'); // docked at 480 px
  assert.equal(at(420), 'audio/none');
  assert.equal(at(360), 'icons/none');
  assert.equal(at(0), 'icons/none');
  // monotonic: a wider toolbar never shows fewer labels
  let prev = 0;
  for (let w = 300; w <= 800; w += 2) {
    const l = T.toolbarLayout(w);
    const n = [l.text, l.audio, l.transitions].filter(Boolean).length;
    assert.ok(n >= prev, `labels drop at ${w}px`);
    prev = n;
  }
});

test('editLayout: arrangement by size, and the inspector never opens as a modal drawer', () => {
  const pick = (w, h) => {
    const l = editLayout(w, h);
    return [l.narrow ? 'narrow' : l.short ? 'short' : l.mid ? 'mid' : 'wide', l.inspector].join(' ');
  };
  assert.equal(pick(1440, 900), 'wide panel');
  assert.equal(pick(1100, 900), 'mid panel');
  assert.equal(pick(720, 900), 'narrow column'); // the default dock: the monitor stays visible beside it
  assert.equal(pick(640, 900), 'narrow column');
  assert.equal(pick(600, 900), 'narrow sheet');
  assert.equal(pick(480, 900), 'narrow sheet'); // over the timeline, the monitor stays visible above
  assert.equal(pick(1440, 495), 'short column'); // dock bottom: a third column right of the timeline
  assert.equal(pick(820, 460), 'short sheet');
  assert.equal(editLayout(720, 900).drawers, true);
  assert.equal(editLayout(1440, 495).drawers, true);
  assert.equal(editLayout(1440, 900).drawers, false);
  assert.equal(pick(0, 0), 'wide panel'); // not measured yet
});
