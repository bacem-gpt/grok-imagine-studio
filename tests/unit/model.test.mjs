import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../extension/studio/core/model.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

function fixture() {
  let p = M.createProject('t');
  const a = M.createMediaItem({ id: 'a', kind: 'video', duration: 6, width: 1280, height: 720, status: 'ready' });
  const b = M.createMediaItem({ id: 'b', kind: 'video', duration: 4, status: 'ready' });
  const img = M.createMediaItem({ id: 'img', kind: 'image', width: 800, height: 800, status: 'ready' });
  const mus = M.createMediaItem({ id: 'mus', kind: 'audio', duration: 30, status: 'ready' });
  for (const m of [a, b, img, mus]) p = M.addMedia(p, m);
  return p;
}

test('appendMediaToTimeline lays clips back to back, skips audio', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a', 'b', 'img', 'mus']));
  assert.equal(p.tracks.video.length, 3);
  const lay = M.layoutVideo(p.tracks.video);
  near(lay[0].start, 0);
  near(lay[1].start, 6);
  near(lay[2].start, 10);
  near(lay[2].end, 10 + M.DEFAULT_IMAGE_DURATION);
  assert.equal(p.tracks.video[2].fit, 'contain');
  assert.ok(p.tracks.video[2].kenBurns);
});

test('transitions overlap clips and are clamped to half the shorter neighbour', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a', 'b']));
  const second = p.tracks.video[1].id;
  p = M.setTransition(p, second, { type: 'crossfade', duration: 1 });
  let lay = M.layoutVideo(p.tracks.video);
  near(lay[1].start, 5);
  near(M.layoutProject(p).duration, 9);
  assert.deepEqual(lay[1].transIn, { type: 'crossfade', start: 5, end: 6, duration: 1 });
  // 10s requested -> clamped to min(6,4)/2 = 2
  p = M.setTransition(p, second, { type: 'wipe-left', duration: 10 });
  lay = M.layoutVideo(p.tracks.video);
  near(lay[1].transIn.duration, 2);
  near(lay[1].start, 4);
  // Two clips overlap during the transition
  assert.equal(M.videoItemsAt(lay, 5).length, 2);
  assert.equal(M.videoItemsAt(lay, 3.9).length, 1);
  near(M.transitionProgress(lay[1], 5), 0.5);
});

test('first clip never keeps a transition (after move/remove)', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a', 'b'], { transition: { type: 'crossfade', duration: 0.5 } }));
  assert.equal(p.tracks.video[0].transition, null);
  assert.equal(p.tracks.video[1].transition.type, 'crossfade');
  p = M.moveVideoClip(p, p.tracks.video[1].id, 0);
  assert.equal(p.tracks.video[0].transition, null);
  p = M.removeClips(p, [p.tracks.video[0].id]);
  assert.equal(p.tracks.video.length, 1);
  assert.equal(p.tracks.video[0].transition, null);
});

test('split at playhead keeps source continuity and speed', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a', 'b']));
  p = M.updateClip(p, p.tracks.video[0].id, { speed: 2 }); // 6s source at 2x = 3s
  let lay = M.layoutVideo(p.tracks.video);
  near(lay[0].duration, 3);
  const r = M.splitVideoAt(p, 1);
  p = r.project;
  assert.ok(r.leftId && r.rightId);
  assert.equal(p.tracks.video.length, 3);
  near(p.tracks.video[0].out, 2); // 1s timeline at 2x = 2s source
  near(p.tracks.video[1].in, 2);
  near(p.tracks.video[1].out, 6);
  lay = M.layoutVideo(p.tracks.video);
  near(lay[1].start, 1);
  near(lay[2].start, 3);
  // too close to an edge -> no split
  assert.equal(M.splitVideoAt(p, 0.02).leftId, null);
});

test('trim clamps to media bounds and minimum duration', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['b']));
  const id = p.tracks.video[0].id;
  p = M.trimVideoClip(p, id, 'out', 99);
  near(p.tracks.video[0].out, 4);
  p = M.trimVideoClip(p, id, 'in', 3.99);
  near(p.tracks.video[0].in, 3.9);
  p = M.trimVideoClip(p, id, 'in', -5);
  near(p.tracks.video[0].in, 0);
  // images can be stretched freely
  ({ project: p } = M.appendMediaToTimeline(p, ['img']));
  const imgId = p.tracks.video[1].id;
  p = M.trimVideoClip(p, imgId, 'out', 42);
  near(p.tracks.video[1].out, 42);
});

test('sourceTimeAt maps timeline to source including speed', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a', 'b'], { ranges: { b: { in: 1, out: 3 } } }));
  p = M.updateClip(p, p.tracks.video[1].id, { speed: 0.5 });
  const lay = M.layoutVideo(p.tracks.video);
  near(lay[1].duration, 4);
  near(M.sourceTimeAt(lay[1], 6), 1);
  near(M.sourceTimeAt(lay[1], 8), 2);
  near(M.timelineTimeOf(lay[1], 2), 8);
  assert.ok(M.sourceTimeAt(lay[1], 100) < 3);
});

test('fades produce opacity ramps', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a']));
  p = M.updateClip(p, p.tracks.video[0].id, { fadeIn: 1, fadeOut: 2 });
  const [it] = M.layoutVideo(p.tracks.video);
  near(M.fadeFactor(it, 0), 0);
  near(M.fadeFactor(it, 0.5), 0.5);
  near(M.fadeFactor(it, 3), 1);
  near(M.fadeFactor(it, 5), 0.5);
});

test('audio clips: lanes, trim, split, fit to video', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a', 'b']));
  let r = M.addAudioClip(p, 'mus', { start: 0 });
  p = r.project;
  const first = r.id;
  r = M.addAudioClip(p, 'mus', { start: 5 });
  p = r.project;
  assert.equal(M.findClip(p, r.id).clip.lane, 1); // overlaps first -> lane 1
  near(M.layoutProject(p).duration, 35);
  p = M.trimAudioClip(p, first, 'in', 2);
  const c = M.findClip(p, first).clip;
  near(c.start, 2);
  near(c.in, 2);
  const s = M.splitAudioAt(p, first, 10);
  p = s.project;
  assert.ok(s.rightId);
  near(M.findClip(p, s.rightId).clip.in, 10);
  p = M.fitAudioToVideo(p, 1);
  const lay = M.layoutProject(p);
  near(lay.duration, 10);
  for (const a of lay.audio) assert.ok(a.end <= 10 + 1e-6);
});

test('text clips: add, split, lanes', () => {
  let p = fixture();
  let r = M.addTextClip(p, { text: 'Hello', start: 1, duration: 4 });
  p = r.project;
  const s = M.splitTextAt(p, r.id, 2);
  p = s.project;
  assert.equal(p.tracks.text.length, 2);
  near(M.findClip(p, s.rightId).clip.duration, 3);
  const r2 = M.addTextClip(p, { start: 1.5, duration: 1 });
  assert.equal(M.findClip(r2.project, r2.id).clip.lane, 1);
});

test('removeMedia removes referencing clips', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a', 'b', 'a']));
  p = M.addAudioClip(p, 'mus').project;
  p = M.removeMedia(p, ['a', 'mus']);
  assert.equal(p.tracks.video.length, 1);
  assert.equal(p.tracks.audio.length, 0);
  assert.ok(!p.mediaOrder.includes('a'));
});

test('duplicateClips inserts copies after originals', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a', 'b']));
  const { project, ids } = M.duplicateClips(p, [p.tracks.video[0].id]);
  assert.equal(project.tracks.video.length, 3);
  assert.equal(project.tracks.video[1].id, ids[0]);
  assert.equal(project.tracks.video[1].mediaId, 'a');
});

test('snapTime picks nearest point within threshold', () => {
  const pts = [0, 2, 5];
  assert.deepEqual(M.snapTime(2.05, pts, 0.1), { time: 2, snapped: true, point: 2 });
  assert.equal(M.snapTime(3, pts, 0.1).snapped, false);
});

test('insertionIndexAt finds nearest boundary', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a', 'b']));
  const lay = M.layoutVideo(p.tracks.video);
  assert.equal(M.insertionIndexAt(lay, 1), 0);
  assert.equal(M.insertionIndexAt(lay, 4), 1);
  assert.equal(M.insertionIndexAt(lay, 9.5), 2);
});

test('normalizeProject repairs partial data and drops orphan clips', () => {
  const raw = {
    name: 'x',
    media: { a: { kind: 'video', duration: 5, status: 'loading', sourceUrl: 'https://assets.grok.com/x.mp4' } },
    tracks: { video: [{ mediaId: 'a', id: 'c1', in: 0, out: 9, transition: { type: 'crossfade', duration: 1 } }, { mediaId: 'zzz', id: 'c2' }] },
  };
  const p = M.normalizeProject(raw);
  assert.equal(p.tracks.video.length, 1);
  assert.equal(p.tracks.video[0].out, 5);
  assert.equal(p.tracks.video[0].transition, null);
  assert.equal(p.media.a.status, 'pending');
  assert.deepEqual(p.mediaOrder, ['a']);
  assert.equal(p.settings.fps, 30);
});

test('splitAllAt splits selected audio and text too', () => {
  let p = fixture();
  ({ project: p } = M.appendMediaToTimeline(p, ['a']));
  const au = M.addAudioClip(p, 'mus');
  p = au.project;
  const tx = M.addTextClip(p, { start: 0, duration: 5 });
  p = tx.project;
  p = M.splitAllAt(p, 2, [au.id, tx.id]);
  assert.equal(p.tracks.video.length, 2);
  assert.equal(p.tracks.audio.length, 2);
  assert.equal(p.tracks.text.length, 2);
});

test('clips placed before the media duration is known are marked autoOut; edits clear it', () => {
  let p = M.createProject('t');
  p = M.addMedia(p, M.createMediaItem({ id: 'v', kind: 'video', duration: 0, status: 'loading' }));
  p = M.appendMediaToTimeline(p, ['v']).project;
  const c = p.tracks.video[0];
  assert.equal(c.autoOut, true);
  assert.equal(c.out, M.DEFAULT_IMAGE_DURATION);
  // the media gets probed: widening the placeholder (what core/media.js does) clears the flag
  p = M.updateMedia(p, 'v', { duration: 8, status: 'ready' });
  p = M.updateClip(p, c.id, { out: 8 });
  assert.equal(p.tracks.video[0].out, 8);
  assert.equal(p.tracks.video[0].autoOut, false);
  // a user trim before probing also clears it
  let p2 = M.addMedia(M.createProject('t'), M.createMediaItem({ id: 'w', kind: 'video', duration: 0 }));
  p2 = M.appendMediaToTimeline(p2, ['w']).project;
  p2 = M.trimVideoClip(p2, p2.tracks.video[0].id, 'out', 2);
  assert.equal(p2.tracks.video[0].autoOut, false);
  // known durations never get the flag
  let p3 = M.addMedia(M.createProject('t'), M.createMediaItem({ id: 'k', kind: 'video', duration: 5 }));
  p3 = M.appendMediaToTimeline(p3, ['k']).project;
  assert.equal(p3.tracks.video[0].autoOut, false);
});

test('mergeById keeps both sides additions/deletions; mine wins conflicts', () => {
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
  const mine = [{ id: 'a', v: 2 }, { id: 'b', v: 1 }, { id: 'm', v: 1 }]; // edited a, deleted c, added m
  const theirs = [{ id: 'a', v: 3 }, { id: 'b', v: 5 }, { id: 'c', v: 1 }, { id: 't', v: 1 }]; // edited a+b, added t
  const out = M.mergeById(base, mine, theirs);
  assert.deepEqual(out.map((x) => x.id), ['t', 'a', 'b', 'm']);
  assert.equal(out.find((x) => x.id === 'a').v, 2, 'conflict: mine wins');
  assert.equal(out.find((x) => x.id === 'b').v, 5, 'only they changed b');
  assert.ok(!out.find((x) => x.id === 'c'), 'deleted by me stays deleted');
  // deleted by them, untouched by me -> deleted
  assert.deepEqual(M.mergeById([{ id: 'x' }], [{ id: 'x' }], []).length, 0);
});

test('mergeProjects: media added in two windows is never lost; untouched timeline takes theirs', () => {
  let base = M.createProject('p');
  base = M.addMedia(base, M.createMediaItem({ id: 'a', kind: 'video', duration: 4 }));
  base = M.appendMediaToTimeline(base, ['a']).project;
  // window 1 (mine): adds media m, renames
  let mine = M.addMedia(base, M.createMediaItem({ id: 'm', kind: 'video', duration: 2 }));
  mine = M.renameProject(mine, 'renamed by me');
  // window 2 (theirs): adds media t and appends it to the timeline
  let theirs = M.addMedia(base, M.createMediaItem({ id: 't', kind: 'video', duration: 3 }));
  theirs = M.appendMediaToTimeline(theirs, ['t']).project;
  const merged = M.mergeProjects(base, mine, theirs);
  assert.deepEqual(Object.keys(merged.media).sort(), ['a', 'm', 't']);
  assert.deepEqual(merged.mediaOrder, ['t', 'm', 'a']);
  assert.equal(merged.name, 'renamed by me');
  assert.equal(merged.tracks.video.length, 2, 'my timeline untouched -> theirs');
  // both edited the timeline -> mine wins as a whole
  const mine2 = M.removeClips(mine, [mine.tracks.video[0].id]);
  const merged2 = M.mergeProjects(base, mine2, theirs);
  assert.equal(merged2.tracks.video.length, 0);
  // their deletion of media also removes its clips from the chosen timeline
  const theirs3 = M.removeMedia(base, ['a']);
  const merged3 = M.mergeProjects(base, base, theirs3);
  assert.ok(!merged3.media.a);
  assert.equal(merged3.tracks.video.length, 0);
});

test('trimAudioClip left edge never goes before 0:00 and keeps the sound in sync', () => {
  let p = M.createProject('t');
  p = M.addMedia(p, M.createMediaItem({ id: 'mus', kind: 'audio', duration: 30 }));
  const r = M.addAudioClip(p, 'mus', { start: 0.5, in: 2 });
  p = M.trimAudioClip(r.project, r.id, 'in', -1);
  const c = M.findClip(p, r.id).clip;
  assert.equal(c.start, 0);
  assert.ok(Math.abs(c.in - 1.5) < 1e-9, `in should move with start (got ${c.in})`);
});

test('transitions: every frame where two clips are active is inside the transition (no one-frame flash of the next clip)', () => {
  // The reported case: 30 fps, clip A trimmed to 66 frames, B dips to black for 0.5 s -> B.start = 1.7000000000000002.
  let p = M.createProject('flash');
  p = M.addMedia(p, M.createMediaItem({ id: 'a', kind: 'video', duration: 6, status: 'ready' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'b', kind: 'video', duration: 6, status: 'ready' }));
  p = M.appendMediaToTimeline(p, ['a', 'b'], { ranges: { a: { in: 0, out: 66 / 30 } } }).project;
  p = M.setTransition(p, p.tracks.video[1].id, { type: 'fade-black', duration: 0.5 });
  const lay = M.layoutVideo(p.tracks.video);
  const items = M.videoItemsAt(lay, 51 / 30);
  assert.equal(items.length, 2);
  assert.equal(M.transitionProgress(items[1], 51 / 30), 0, 'the frame at the start of the window is p = 0 (A), not "no transition" (B)');
  // Sweep: random frame-aligned trims at common frame rates and transition lengths.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let checked = 0;
  for (let run = 0; run < 600; run++) {
    const fps = [24, 25, 30, 60][run % 4];
    let q = M.createProject('sweep');
    const n = 2 + (run % 4);
    const ids = Array.from({ length: n }, (_, i) => `m${i}`);
    const ranges = {};
    for (const id of ids) {
      q = M.addMedia(q, M.createMediaItem({ id, kind: 'video', duration: 12, status: 'ready' }));
      const first = Math.floor(rnd() * 60);
      ranges[id] = { in: first / fps, out: (first + 30 + Math.floor(rnd() * 150)) / fps };
    }
    q = M.appendMediaToTimeline(q, ids, { ranges }).project;
    for (let i = 1; i < n; i++) q = M.setTransition(q, q.tracks.video[i].id, { type: 'crossfade', duration: [6, 9, 12, 15, 18, 24][(run + i) % 6] / fps });
    const L = M.layoutVideo(q.tracks.video);
    const end = L[L.length - 1].end;
    for (let f = 0; f / fps < end; f++) {
      const t = f / fps;
      const active = M.videoItemsAt(L, t);
      if (active.length !== 2) continue;
      checked++;
      const pr = M.transitionProgress(active[1], t);
      assert.ok(pr != null && pr >= 0 && pr <= 1, `run ${run} frame ${f} @${fps}: p=${pr}`);
    }
  }
  assert.ok(checked > 1000, `checked ${checked} transition frames`);
});

const grokItem = (id, postId, addedAt, extra = {}) =>
  M.createMediaItem({ id, kind: 'video', origin: 'grok', postId, pageKey: `video:${postId}`, duration: 4, status: 'ready', addedAt, ...extra });

test('dedupeMedia: one generation collected twice keeps the first copy and moves every reference to it', () => {
  let p = M.createProject('dup');
  p = M.addMedia(p, grokItem('m2', 'post-1', 2000, { rating: 4, tags: ['b'], flag: 'pick' }));
  p = M.addMedia(p, grokItem('m1', 'post-1', 1000, { tags: ['a'] }));
  p = M.addMedia(p, grokItem('other', 'post-2', 1500));
  p = M.addMedia(p, M.createMediaItem({ id: 'file', kind: 'video', origin: 'file', duration: 3, status: 'ready' }));
  p = M.appendMediaToTimeline(p, ['m2', 'other', 'm2']).project;
  p = { ...p, shots: [{ id: 's1', takes: ['m2', 'm1'], chosenTake: 'm2' }, { id: 's2', takes: ['other'], chosenTake: null }] };
  const d = M.dedupeMedia(p);
  assert.deepEqual(Object.keys(d.media).sort(), ['file', 'm1', 'other']);
  assert.deepEqual(d.tracks.video.map((c) => c.mediaId), ['m1', 'other', 'm1']);
  assert.deepEqual(d.shots[0], { id: 's1', takes: ['m1'], chosenTake: 'm1' });
  assert.equal(d.shots[1], p.shots[1], 'untouched shots keep their identity');
  assert.equal(d.media.m1.rating, 4);
  assert.equal(d.media.m1.flag, 'pick');
  assert.deepEqual(d.media.m1.tags, ['a', 'b']);
  assert.ok(d.mediaOrder.length === new Set(d.mediaOrder).size && d.mediaOrder.every((id) => d.media[id]));
  assert.equal(M.dedupeMedia(d), d, 'nothing left to collapse: same object');
  // same pageKey without post id, and files / links never collapse
  let q = M.addMedia(M.createProject('k'), M.createMediaItem({ id: 'x', origin: 'grok', pageKey: 'url:https://a/x.mp4', addedAt: 5 }));
  q = M.addMedia(q, M.createMediaItem({ id: 'y', origin: 'grok', pageKey: 'url:https://a/x.mp4', addedAt: 6 }));
  q = M.addMedia(q, M.createMediaItem({ id: 'f1', origin: 'url', sourceUrl: 'https://a/m.mp3' }));
  q = M.addMedia(q, M.createMediaItem({ id: 'f2', origin: 'url', sourceUrl: 'https://a/m.mp3' }));
  assert.deepEqual(Object.keys(M.dedupeMedia(q).media).sort(), ['f1', 'f2', 'x']);
});

test('mergeProjects: two windows that collected the same generation converge on one copy', () => {
  const base = M.createProject('p');
  const mine = M.addMedia(base, grokItem('a-copy', 'gen-1', 1000));
  let theirs = M.addMedia(base, grokItem('b-copy', 'gen-1', 1001));
  theirs = { ...theirs, shots: [{ id: 'shot', takes: ['b-copy'], chosenTake: null }] };
  const inA = M.mergeProjects(base, mine, theirs); // window A merging B's save
  const inB = M.mergeProjects(base, theirs, mine); // window B merging A's save
  for (const merged of [inA, inB]) {
    assert.deepEqual(Object.keys(merged.media), ['a-copy']);
    assert.deepEqual(merged.mediaOrder, ['a-copy']);
    assert.deepEqual(merged.shots[0].takes, ['a-copy'], 'the take link follows the kept copy');
  }
  // a project already holding duplicates (older data) is cleaned when loaded
  const raw = { ...M.addMedia(mine, grokItem('late', 'gen-1', 2000)), tracks: { video: [{ id: 'c', mediaId: 'late', in: 0, out: 2 }], audio: [], text: [] } };
  const loaded = M.normalizeProject(raw);
  assert.deepEqual(Object.keys(loaded.media), ['a-copy']);
  assert.equal(loaded.tracks.video[0].mediaId, 'a-copy');
});
