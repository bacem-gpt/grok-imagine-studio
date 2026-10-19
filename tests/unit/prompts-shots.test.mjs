// Shot model, take links, timeline assembly and take matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../extension/studio/core/model.js';
import * as S from '../../extension/studio/prompts/shots.js';
import { promptSimilarity, matchTakes, pageCandidates, binCandidates, DEFAULT_MATCH_THRESHOLD } from '../../extension/studio/prompts/match.js';

function projectWithMedia(n = 3, extra = {}) {
  let p = M.createProject('t');
  for (let i = 1; i <= n; i++) p = M.addMedia(p, M.createMediaItem({ id: `m${i}`, kind: 'video', duration: 4 + i, status: 'ready', ...extra }));
  return p;
}

test('createShot fills defaults and repairs bad input', () => {
  const s = S.createShot();
  assert.match(s.id, /^sht_/);
  assert.deepEqual(
    { title: s.title, prompt: s.prompt, fields: s.fields, ingredientIds: s.ingredientIds, duration: s.duration, mode: s.mode, notes: s.notes, status: s.status, takes: s.takes, chosenTake: s.chosenTake, sentAt: s.sentAt, sentText: s.sentText },
    { title: '', prompt: '', fields: {}, ingredientIds: [], duration: 6, mode: 'video', notes: '', status: 'draft', takes: [], chosenTake: null, sentAt: null, sentText: '' },
  );
  const bad = S.normalizeShot({ id: 'x', status: 'weird', mode: 'nope', duration: -2, takes: ['a', 'a', 3, null, 'b'], chosenTake: 'zzz', fields: ['no'], ingredientIds: 'no' });
  assert.equal(bad.id, 'x');
  assert.equal(bad.status, 'draft');
  assert.equal(bad.mode, 'video');
  assert.equal(bad.duration, 6);
  assert.deepEqual(bad.takes, ['a', 'b']);
  assert.equal(bad.chosenTake, null);
  assert.deepEqual(bad.fields, {});
  assert.deepEqual(bad.ingredientIds, []);
  assert.equal(S.createShot({ duration: 500 }).duration, S.MAX_SHOT_DURATION);
  assert.equal(S.normalizeShot(null).status, 'draft');
});

test('addShot / addShots insert at index and always start as fresh drafts', () => {
  let p = M.createProject('t');
  const a = S.addShot(p, { title: 'A', status: 'approved', takes: ['m1'] });
  p = a.project;
  assert.equal(p.shots[0].status, 'draft');
  assert.deepEqual(p.shots[0].takes, []);
  const b = S.addShots(p, [{ title: 'B' }, { title: 'C' }], 0);
  p = b.project;
  assert.deepEqual(p.shots.map((s) => s.title), ['B', 'C', 'A']);
  assert.equal(b.ids.length, 2);
  p = S.addShot(p, { title: 'D' }, 99).project;
  assert.deepEqual(p.shots.map((s) => s.title), ['B', 'C', 'A', 'D']);
  assert.equal(S.getShots({}).length, 0);
});

test('updateShot validates, keeps id, is a no-op without changes', () => {
  let p = S.addShot(M.createProject('t'), { title: 'A' }).project;
  const id = p.shots[0].id;
  const same = S.updateShot(p, id, { title: 'A' });
  assert.equal(same, p);
  assert.equal(S.updateShot(p, 'nope', { title: 'x' }), p);
  p = S.updateShot(p, id, { id: 'hack', title: 'B', status: 'bogus', mode: 'image', duration: '10', ingredientIds: ['i1', 'i1'] });
  const s = p.shots[0];
  assert.equal(s.id, id);
  assert.equal(s.title, 'B');
  assert.equal(s.status, 'draft');
  assert.equal(s.mode, 'image');
  assert.equal(s.duration, 10);
  assert.deepEqual(s.ingredientIds, ['i1']);
  assert.equal(S.updateShot(p, id, { duration: 0 }), p);
});

test('updateShotFields merges and removes empty values', () => {
  let p = S.addShot(M.createProject('t'), { fields: { subject: 'a dog' } }).project;
  const id = p.shots[0].id;
  p = S.updateShotFields(p, id, { style: 'anime', subject: '' });
  assert.deepEqual(p.shots[0].fields, { style: 'anime' });
  assert.equal(S.updateShotFields(p, id, { style: 'anime' }), p);
});

test('duplicate / move / reorder / remove', () => {
  let p = projectWithMedia(2);
  p = S.addShots(p, [{ title: 'A', prompt: 'a' }, { title: 'B' }, { title: 'C' }]).project;
  const [a, b, c] = p.shots.map((s) => s.id);
  p = S.linkTake(p, a, 'm1');
  const d = S.duplicateShot(p, a);
  p = d.project;
  assert.deepEqual(p.shots.map((s) => s.title), ['A', 'A (copy)', 'B', 'C']);
  assert.deepEqual(p.shots[1].takes, []);
  assert.equal(p.shots[1].status, 'draft');
  assert.equal(p.shots[1].prompt, 'a');
  assert.equal(S.duplicateShot(p, 'nope').id, null);
  p = S.moveShot(p, c, 0);
  assert.deepEqual(p.shots.map((s) => s.title), ['C', 'A', 'A (copy)', 'B']);
  assert.equal(S.moveShot(p, c, 0), p);
  p = S.moveShot(p, c, 99);
  assert.equal(p.shots[3].title, 'C');
  p = S.reorderShots(p, [b, 'ghost', a]);
  assert.deepEqual(p.shots.map((s) => s.title), ['B', 'A', 'A (copy)', 'C']);
  assert.equal(S.reorderShots(p, p.shots.map((s) => s.id)), p);
  p = S.removeShots(p, [a]);
  assert.equal(p.shots.length, 3);
  assert.equal(p.media.m1.shotId, null, 'media unlinked from removed shot');
  assert.equal(S.removeShots(p, ['ghost']), p);
});

test('status transitions: send, link, unlink, approve', () => {
  let p = projectWithMedia(2);
  p = S.addShot(p, { prompt: 'a red car' }).project;
  const id = p.shots[0].id;
  p = S.markShotSent(p, id, { text: 'a red car, expanded', at: 1000 });
  assert.equal(p.shots[0].status, 'sent');
  assert.equal(p.shots[0].sentAt, 1000);
  assert.equal(p.shots[0].sentText, 'a red car, expanded');
  p = S.linkTake(p, id, 'm1');
  assert.equal(p.shots[0].status, 'generated');
  assert.equal(p.media.m1.shotId, id);
  p = S.markShotSent(p, id, { text: 'again', at: 2000 });
  assert.equal(p.shots[0].status, 'generated', 'resend keeps generated');
  p = S.unlinkTake(p, id, 'm1');
  assert.equal(p.shots[0].status, 'sent', 'falls back to sent');
  assert.equal(p.media.m1.shotId, null);
  p = S.setShotStatus(p, id, 'approved');
  p = S.linkTake(p, id, 'm2');
  assert.equal(p.shots[0].status, 'approved', 'approved stays approved');
  assert.equal(S.statusAfterSend('approved'), 'approved');
  assert.equal(S.statusAfterSend('draft'), 'sent');
  // Never sent: unlinking the last take goes back to draft.
  let q = S.addShot(projectWithMedia(1), {}).project;
  const qid = q.shots[0].id;
  q = S.unlinkTake(S.linkTake(q, qid, 'm1'), qid, 'm1');
  assert.equal(q.shots[0].status, 'draft');
  assert.equal(S.markShotSent(q, 'ghost', {}), q);
});

test('linkTake moves media between shots; chooseTake; effectiveTake; validTakes', () => {
  let p = projectWithMedia(3);
  p = S.addShots(p, [{ title: 'A' }, { title: 'B' }]).project;
  const [a, b] = p.shots.map((s) => s.id);
  p = S.linkTakes(p, [
    { shotId: a, mediaId: 'm1' },
    { shotId: a, mediaId: 'm2', choose: true },
  ]);
  assert.deepEqual(p.shots[0].takes, ['m1', 'm2']);
  assert.equal(p.shots[0].chosenTake, 'm2');
  p = S.linkTake(p, b, 'm2');
  assert.deepEqual(p.shots[0].takes, ['m1']);
  assert.equal(p.shots[0].chosenTake, null, 'chosen cleared when moved away');
  assert.deepEqual(p.shots[1].takes, ['m2']);
  assert.equal(p.media.m2.shotId, b);
  assert.equal(S.linkTake(p, a, 'missing'), p);
  assert.equal(S.linkTake(p, 'ghost', 'm1'), p);
  p = S.chooseTake(p, a, 'm3'); // links then chooses
  assert.deepEqual(p.shots[0].takes, ['m1', 'm3']);
  assert.equal(p.shots[0].chosenTake, 'm3');
  assert.equal(S.effectiveTake(p, p.shots[0]), 'm3');
  p = S.chooseTake(p, a, null);
  assert.equal(S.effectiveTake(p, p.shots[0]), 'm1');
  assert.equal(S.chooseTake(p, a, 'missing'), p);
  // Deleted media is ignored.
  p = M.removeMedia(p, ['m1']);
  assert.deepEqual(S.validTakes(p, p.shots[0]), ['m3']);
  assert.equal(S.effectiveTake(p, p.shots[0]), 'm3');
  assert.equal(S.shotForMedia(p, 'm2').id, b);
  assert.equal(S.shotForMedia(p, 'nope'), null);
  assert.deepEqual(S.validTakes(p, null), []);
});

test('syncTakes repairs dangling and missing links', () => {
  let p = projectWithMedia(2);
  p = S.addShot(p, {}).project;
  const id = p.shots[0].id;
  p = { ...p, shots: [{ ...p.shots[0], takes: ['m1', 'gone'], chosenTake: 'gone' }] };
  p = M.updateMedia(p, 'm2', { shotId: id });
  p = M.updateMedia(p, 'm1', { shotId: 'deleted-shot' });
  const fixed = S.syncTakes(p);
  assert.deepEqual(fixed.shots[0].takes, ['m1', 'm2']);
  assert.equal(fixed.shots[0].chosenTake, null);
  assert.equal(fixed.media.m1.shotId, null);
  assert.equal(S.syncTakes(fixed), fixed, 'consistent project is returned as-is');
});

test('assembleTimeline: chosen (or first) takes in shot order, append or replace, transitions', () => {
  let p = projectWithMedia(4);
  p = M.addMedia(p, M.createMediaItem({ id: 'aud', kind: 'audio', duration: 9, status: 'ready' }));
  p = S.addShots(p, [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }]).project;
  const [a, b, c, d] = p.shots.map((s) => s.id);
  p = S.linkTake(p, a, 'm2');
  p = S.linkTake(p, a, 'm1');
  p = S.linkTake(p, b, 'm3');
  p = S.linkTake(p, b, 'm4', { choose: true });
  p = S.linkTake(p, d, 'aud'); // audio takes are skipped
  p = M.appendMediaToTimeline(p, ['m1']).project; // existing clip
  const res = S.assembleTimeline(p, {});
  assert.deepEqual(res.used.map((u) => u.mediaId), ['m2', 'm4']);
  assert.deepEqual(res.skipped, [c, d]);
  assert.deepEqual(res.project.tracks.video.map((v) => v.mediaId), ['m1', 'm2', 'm4']);
  assert.equal(res.clipIds.length, 2);
  const rep = S.assembleTimeline(p, { replace: true, transition: { type: 'crossfade', duration: 0.5 } });
  assert.deepEqual(rep.project.tracks.video.map((v) => v.mediaId), ['m2', 'm4']);
  assert.equal(rep.project.tracks.video[0].transition, null);
  assert.equal(rep.project.tracks.video[1].transition.type, 'crossfade');
  const cut = S.assembleTimeline(p, { replace: true, transition: { type: 'cut' } });
  assert.equal(cut.project.tracks.video[1].transition, null);
  p = S.setShotStatus(p, b, 'approved');
  assert.deepEqual(S.assembleTimeline(p, { replace: true, approvedOnly: true }).project.tracks.video.map((v) => v.mediaId), ['m4']);
  assert.deepEqual(S.assembleTimeline(p, { shotIds: [a] }).used.map((u) => u.mediaId), ['m2']);
  // Nothing to place -> same project.
  const empty = S.addShot(M.createProject('e'), {}).project;
  const none = S.assembleTimeline(empty, { replace: true });
  assert.equal(none.project, empty);
  assert.equal(none.skipped.length, 1);
});

test('helpers: totalDuration, statusCounts, shotLabel, nextDraftShot', () => {
  let p = M.createProject('t');
  p = S.addShots(p, [{ prompt: 'a', duration: 6 }, { prompt: '', duration: 10 }, { prompt: 'c', duration: 4 }]).project;
  const [a, b, c] = p.shots.map((s) => s.id);
  assert.equal(S.totalDuration(p.shots), 20);
  assert.equal(S.totalDuration(null), 0);
  p = S.markShotSent(p, a, { text: 'a', at: 1 });
  assert.deepEqual(S.statusCounts(p.shots), { draft: 2, sent: 1, generated: 0, approved: 0 });
  assert.equal(S.shotLabel(p.shots[0], 0), 'Shot 1');
  assert.equal(S.shotLabel({ title: 'Intro' }, 2), 'Shot 3 · Intro');
  assert.equal(S.nextDraftShot(p).id, c, 'skips sent and empty-prompt shots');
  assert.equal(S.nextDraftShot(p, c).id, c, 'wraps around');
  p = S.markShotSent(p, c, { text: 'c' });
  assert.equal(S.nextDraftShot(p), null);
  assert.equal(S.nextDraftShot(M.createProject('x')), null);
  assert.ok(b);
});

// ---------------------------------------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------------------------------------

test('promptSimilarity: identical, truncated, rewritten, unrelated', () => {
  const sent = 'A red sports car drifting through neon rain, cinematic tracking shot, wet asphalt reflections';
  assert.equal(promptSimilarity(sent, sent), 1);
  assert.equal(promptSimilarity(sent, sent.toUpperCase() + '!!'), 1);
  assert.ok(promptSimilarity(sent, 'A red sports car drifting through neon rain') >= DEFAULT_MATCH_THRESHOLD, 'truncated');
  assert.ok(promptSimilarity(sent, 'Cinematic tracking shot of a red sports car drifting in neon rain on wet asphalt') >= DEFAULT_MATCH_THRESHOLD, 'reordered');
  assert.ok(promptSimilarity(sent, 'A misty green forest at dawn, slow dolly forward') < 0.3, 'unrelated');
  assert.equal(promptSimilarity('', sent), 0);
  assert.equal(promptSimilarity('the a of', 'the a of in'), 0);
  assert.ok(promptSimilarity('red car', 'red bus') < DEFAULT_MATCH_THRESHOLD, 'short prompts need all words');
});

test('matchTakes: best shot per candidate, respects send time, kinds and threshold', () => {
  const shots = [
    { id: 'A', sentAt: 10_000, sentText: 'A red sports car drifting through neon rain', mode: 'video' },
    { id: 'B', sentAt: 50_000, sentText: 'A misty green forest at dawn, slow dolly forward', mode: 'video' },
    { id: 'C', sentAt: null, sentText: '', prompt: 'never sent' },
    { id: 'D', sentAt: 60_000, sentText: 'A colorful test pattern poster', mode: 'image' },
  ];
  const candidates = [
    { key: 'k1', kind: 'video', prompt: 'A red sports car drifting through neon rain', seenAt: 20_000 },
    { key: 'k2', kind: 'video', prompt: 'A misty green forest at dawn, slow dolly forward', seenAt: 1_000 }, // before B was sent
    { key: 'k3', kind: 'video', prompt: 'Totally unrelated ocean waves', seenAt: 70_000 },
    { key: 'k4', kind: 'image', prompt: 'A colorful test pattern poster', seenAt: 61_000 },
    { key: 'k5', kind: 'video', prompt: 'A colorful test pattern poster', seenAt: 61_000 }, // wrong kind for an image shot
    { key: 'k6', kind: 'video', prompt: '', seenAt: 61_000 },
  ];
  const res = matchTakes({ shots, candidates });
  assert.deepEqual(
    res.map((r) => [r.candidate.key, r.shotId]),
    [
      ['k1', 'A'],
      ['k4', 'D'],
    ],
  );
  // Ties go to the most recent send.
  const tie = matchTakes({
    shots: [
      { id: 'old', sentAt: 1, sentText: 'a fox in the snow at night' },
      { id: 'new', sentAt: 2, sentText: 'a fox in the snow at night' },
    ],
    candidates: [{ key: 'x', kind: 'video', prompt: 'a fox in the snow at night', seenAt: 3 }],
  });
  assert.equal(tie[0].shotId, 'new');
  assert.deepEqual(matchTakes({ shots: [], candidates }), []);
  // Seen a little before the send was recorded: still a take; seen well before: an older video.
  const near = matchTakes({ shots: [shots[0]], candidates: [{ ...candidates[0], seenAt: 9_000 }] });
  assert.equal(near.length, 1);
  const old = matchTakes({ shots: [shots[0]], candidates: [{ ...candidates[0], seenAt: 1_000 }] });
  assert.equal(old.length, 0);
  assert.deepEqual(matchTakes({}), []);
});

test('pageCandidates / binCandidates', () => {
  let p = M.createProject('t');
  p = M.addMedia(p, M.createMediaItem({ id: 'b1', kind: 'video', origin: 'grok', prompt: 'p1', pageKey: 'video:1', addedAt: 5 }));
  p = M.addMedia(p, M.createMediaItem({ id: 'b2', kind: 'video', origin: 'grok', prompt: 'p2', pageKey: 'video:2', shotId: 'S' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'b3', kind: 'video', origin: 'file', prompt: 'p3' }));
  const items = [
    { key: 'video:1', kind: 'video', prompt: 'p1', seenAt: 1 },
    { key: 'video:2', kind: 'video', prompt: 'p2', seenAt: 1 },
    { key: 'video:9', kind: 'video', prompt: 'p9', seenAt: 1 },
    { key: 'video:10', kind: 'video', prompt: null, seenAt: 1 },
  ];
  const pc = pageCandidates(items, p);
  assert.deepEqual(
    pc.map((c) => [c.key, c.mediaId]),
    [
      ['page:video:1', 'b1'],
      ['page:video:9', null],
    ],
  );
  assert.deepEqual(binCandidates(p).map((c) => c.mediaId), ['b1']);
  assert.deepEqual(pageCandidates(null, p), []);
});

test('normalizeMode maps Grok modes; repairShots completes partial shots from other tabs', () => {
  assert.equal(S.normalizeMode('animate'), 'animate');
  assert.equal(S.normalizeMode('normal', ['ing1']), 'animate');
  assert.equal(S.normalizeMode('fun', []), 'video');
  assert.equal(S.normalizeMode(undefined), 'video');
  assert.equal(S.createShot({ mode: 'normal', ingredientIds: ['i'] }).mode, 'animate');
  let p = projectWithMedia(1);
  p = S.addShot(p, { title: 'ok' }).project;
  assert.equal(S.repairShots(p), p, 'well-formed shots are untouched');
  const partial = { id: 'sht_x', title: 'From ingredients', prompt: '', fields: {}, ingredientIds: ['i1'], duration: 6, mode: 'normal', notes: '', status: 'draft', takes: [], chosenTake: null, createdAt: 1 };
  const broken = { ...p, shots: [...p.shots, partial, null, 'junk', { ...partial }] };
  const fixed = S.repairShots(broken);
  assert.equal(fixed.shots.length, 2, 'non-objects and duplicate ids dropped');
  assert.equal(fixed.shots[0], p.shots[0], 'good shots keep identity');
  assert.equal(fixed.shots[1].mode, 'animate');
  assert.equal(fixed.shots[1].sentAt, null);
  assert.equal(S.repairShots(fixed), fixed);
  assert.deepEqual(S.repairShots({ ...p, shots: undefined }).shots, []);
  // Engine ops tolerate partial shots too.
  const loose = { ...p, shots: [{ id: 'L', title: 'loose' }] };
  const linked = S.linkTake(loose, 'L', 'm1');
  assert.deepEqual(linked.shots[0].takes, ['m1']);
  assert.equal(S.duplicateShot(loose, 'L').project.shots.length, 2);
  assert.deepEqual(S.validTakes(loose, loose.shots[0]), []);
});

test('failed takes (download error) are never assembled; the chosen take falls back; failures are reported', () => {
  let p = projectWithMedia(3);
  p = M.addMedia(p, M.createMediaItem({ id: 'bad1', kind: 'video', status: 'error', error: 'HTTP 403', duration: 0 }));
  p = M.addMedia(p, M.createMediaItem({ id: 'bad2', kind: 'video', status: 'error', error: 'HTTP 404', duration: 0 }));
  p = M.addMedia(p, M.createMediaItem({ id: 'busy', kind: 'video', status: 'loading', duration: 5 }));
  p = S.addShots(p, [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }]).project;
  const [a, b, c, d] = p.shots.map((s) => s.id);
  p = S.linkTake(p, a, 'bad1'); // first take failed, second is fine
  p = S.linkTake(p, a, 'm1');
  p = S.linkTake(p, b, 'm2');
  p = S.linkTake(p, b, 'bad2', { choose: true }); // chosen take failed -> falls back to m2
  p = S.linkTake(p, c, 'm3');
  p = S.linkTake(p, c, 'busy', { choose: true }); // still downloading: usable
  assert.equal(S.isUsableTake(p.media.m1), true);
  assert.equal(S.isUsableTake(p.media.busy), true);
  assert.equal(S.isUsableTake(p.media.bad1), false);
  assert.equal(S.isUsableTake(null), false);
  assert.equal(S.effectiveTake(p, S.findShot(p, a)), 'm1');
  assert.equal(S.effectiveTake(p, S.findShot(p, b)), 'm2');
  assert.equal(S.effectiveTake(p, S.findShot(p, c)), 'busy');
  const plan = S.takesInShotOrder(p);
  assert.deepEqual(plan.used.map((u) => [u.mediaId, u.fallback]), [
    ['m1', false],
    ['m2', true],
    ['busy', false],
  ]);
  assert.deepEqual(plan.skipped, [d]);
  assert.deepEqual(plan.failed, []);
  // A shot whose only take failed is skipped and reported as failed (linkTake moves bad1 from shot A to D).
  const q = S.linkTake(p, d, 'bad1');
  assert.deepEqual(S.findShot(q, a).takes, ['m1']);
  const res = S.assembleTimeline(q, { replace: true });
  assert.deepEqual(res.project.tracks.video.map((v) => v.mediaId), ['m1', 'm2', 'busy']);
  assert.deepEqual(res.skipped, [d]);
  assert.deepEqual(res.failed, [d]);
  assert.ok(res.project.tracks.video.every((v) => !String(v.mediaId).startsWith('bad')));
});
