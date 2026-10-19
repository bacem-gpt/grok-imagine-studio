// Clips tab pure logic (extension/studio/ui/media/bin-logic.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../extension/studio/core/model.js';
import * as L from '../../extension/studio/ui/media/bin-logic.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

function bin() {
  let p = M.createProject('t');
  const items = [
    { id: 'red', kind: 'video', name: 'Red car', prompt: 'A red sports car drifting through neon rain', duration: 4, rating: 3, flag: 'pick', addedAt: 1000, tags: ['cars'] },
    { id: 'green', kind: 'video', name: 'Forest', prompt: 'A misty green forest at dawn', duration: 3, rating: 5, flag: null, addedAt: 2000 },
    { id: 'blue', kind: 'video', name: 'ocean 10', prompt: 'Deep blue ocean waves', duration: 5, rating: 0, flag: 'reject', addedAt: 3000 },
    { id: 'img', kind: 'image', name: 'ocean 2', prompt: null, duration: 0, rating: 3, flag: null, addedAt: 4000, note: 'poster idea' },
    { id: 'mus', kind: 'audio', name: 'Music', duration: 12, rating: 1, flag: 'pick', addedAt: 4000 },
  ];
  // addMedia puts each new item first: add oldest first so mediaOrder ends up newest first.
  for (const it of items) p = M.addMedia(p, M.createMediaItem({ ...it, status: 'ready' }));
  return p;
}

test('normalizeFilter repairs persisted junk; isFilterActive ignores sort', () => {
  assert.deepEqual(L.normalizeFilter(null), L.DEFAULT_FILTER);
  assert.deepEqual(L.normalizeFilter({ kind: 'gif', flag: 'maybe', minRating: '9', search: 3, sort: 'random' }), { kind: 'all', flag: 'all', minRating: 5, search: '', sort: 'newest' });
  assert.equal(L.isFilterActive({ sort: 'name' }), false);
  assert.equal(L.isFilterActive({ search: '  ' }), false);
  assert.equal(L.isFilterActive({ search: 'car' }), true);
  assert.equal(L.isFilterActive({ flag: 'hide-rejected' }), true);
  assert.equal(L.isFilterActive({ minRating: 2 }), true);
});

test('filterAndSort: kinds, flags, min rating', () => {
  const p = bin();
  assert.deepEqual(L.filterAndSort(p, {}), ['mus', 'img', 'blue', 'green', 'red'], 'newest first; addedAt tie keeps bin order');
  assert.deepEqual(L.filterAndSort(p, { kind: 'video' }), ['blue', 'green', 'red']);
  assert.deepEqual(L.filterAndSort(p, { kind: 'image' }), ['img']);
  assert.deepEqual(L.filterAndSort(p, { flag: 'pick' }), ['mus', 'red']);
  assert.deepEqual(L.filterAndSort(p, { flag: 'reject' }), ['blue']);
  assert.deepEqual(L.filterAndSort(p, { flag: 'unflagged' }), ['img', 'green']);
  assert.deepEqual(L.filterAndSort(p, { flag: 'hide-rejected' }), ['mus', 'img', 'green', 'red']);
  assert.deepEqual(L.filterAndSort(p, { minRating: 3 }), ['img', 'green', 'red']);
  assert.deepEqual(L.filterAndSort(p, { minRating: 3, kind: 'video', flag: 'pick' }), ['red']);
});

test('filterAndSort: search matches name, prompt, tags and note (all terms, case-insensitive)', () => {
  const p = bin();
  assert.deepEqual(L.filterAndSort(p, { search: 'OCEAN' }), ['img', 'blue']);
  assert.deepEqual(L.filterAndSort(p, { search: 'neon car' }), ['red'], 'every term must match');
  assert.deepEqual(L.filterAndSort(p, { search: 'cars' }), ['red'], 'tags');
  assert.deepEqual(L.filterAndSort(p, { search: 'poster' }), ['img'], 'note');
  assert.deepEqual(L.filterAndSort(p, { search: 'zebra' }), []);
});

test('filterAndSort: sort orders', () => {
  const p = bin();
  assert.deepEqual(L.filterAndSort(p, { sort: 'oldest' }), ['red', 'green', 'blue', 'img', 'mus']);
  assert.deepEqual(L.filterAndSort(p, { sort: 'rating' }), ['green', 'red', 'img', 'mus', 'blue'], 'rating desc, picks before unflagged on ties');
  assert.deepEqual(L.filterAndSort(p, { sort: 'duration' }), ['mus', 'blue', 'red', 'green', 'img']);
  assert.deepEqual(L.filterAndSort(p, { sort: 'name' }), ['green', 'mus', 'img', 'blue', 'red'], 'natural sort: "ocean 2" before "ocean 10"');
});

test('nextSelection: click, ctrl/cmd toggle, shift range, ctrl+shift add range', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  let s = L.nextSelection({ orderedIds: ids, id: 'b' });
  assert.deepEqual(s, { selection: ['b'], anchor: 'b' });
  s = L.nextSelection({ ...s, orderedIds: ids, id: 'd', shift: true });
  assert.deepEqual(s, { selection: ['b', 'c', 'd'], anchor: 'b' });
  s = L.nextSelection({ ...s, orderedIds: ids, id: 'a', shift: true });
  assert.deepEqual(s.selection, ['a', 'b'], 'range re-anchors from the original anchor');
  s = L.nextSelection({ ...s, orderedIds: ids, id: 'e', mod: true });
  assert.deepEqual(s, { selection: ['a', 'b', 'e'], anchor: 'e' });
  s = L.nextSelection({ ...s, orderedIds: ids, id: 'a', mod: true });
  assert.deepEqual(s.selection, ['b', 'e'], 'mod-click toggles off');
  s = L.nextSelection({ selection: ['a'], anchor: 'c', orderedIds: ids, id: 'd', shift: true, mod: true });
  assert.deepEqual(s.selection, ['a', 'c', 'd']);
  s = L.nextSelection({ selection: ['a'], anchor: 'zzz', orderedIds: ids, id: 'd', shift: true });
  assert.deepEqual(s, { selection: ['d'], anchor: 'd' }, 'unknown anchor degrades to a plain click');
});

test('orderedSelection follows display order; actionTargets', () => {
  assert.deepEqual(L.orderedSelection(['d', 'x', 'a'], ['a', 'b', 'c', 'd']), ['a', 'd', 'x']);
  assert.deepEqual(L.actionTargets('a', ['a', 'b']), ['a', 'b']);
  assert.deepEqual(L.actionTargets('c', ['a', 'b']), ['c']);
  assert.deepEqual(L.actionTargets('a', ['a']), ['a']);
});

test('neighborId walks the list and survives the current item leaving it', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.equal(L.neighborId(ids, 'b', 1), 'c');
  assert.equal(L.neighborId(ids, 'b', -1), 'a');
  assert.equal(L.neighborId(ids, 'a', -1), null);
  assert.equal(L.neighborId(ids, 'd', 1), null);
  const after = ['a', 'c', 'd']; // b was at index 1 and got filtered out
  assert.equal(L.neighborId(after, 'b', 1, 1), 'c');
  assert.equal(L.neighborId(after, 'b', -1, 1), 'a');
  assert.equal(L.neighborId([], 'b', 1, 1), null);
  assert.equal(L.neighborId(['a'], 'gone', 1, 5), null);
  assert.equal(L.neighborId(['a'], 'gone', -1, 5), 'a');
});

test('gridMove: arrows by item and by row, home/end, partial last row', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']; // 3 columns: a b c / d e f / g
  assert.equal(L.gridMove(ids, 'b', 'arrowright', 3), 'c');
  assert.equal(L.gridMove(ids, 'b', 'arrowleft', 3), 'a');
  assert.equal(L.gridMove(ids, 'a', 'arrowleft', 3), 'a');
  assert.equal(L.gridMove(ids, 'b', 'arrowdown', 3), 'e');
  assert.equal(L.gridMove(ids, 'e', 'arrowup', 3), 'b');
  assert.equal(L.gridMove(ids, 'b', 'arrowup', 3), 'b');
  assert.equal(L.gridMove(ids, 'e', 'arrowdown', 3), 'g', 'down into the partial last row lands on its last item');
  assert.equal(L.gridMove(ids, 'g', 'arrowdown', 3), 'g');
  assert.equal(L.gridMove(ids, 'c', 'home', 3), 'a');
  assert.equal(L.gridMove(ids, 'c', 'end', 3), 'g');
  assert.equal(L.gridMove(ids, null, 'arrowright', 3), 'a', 'no current item starts at the first');
  assert.equal(L.gridMove([], 'a', 'arrowright', 3), null);
});

test('applyMark sets I/O and clears the other mark when they cross', () => {
  let m = L.applyMark(L.EMPTY_MARKS, 'in', 1, 4);
  assert.deepEqual(m, { in: 1, out: null });
  m = L.applyMark(m, 'out', 3, 4);
  assert.deepEqual(m, { in: 1, out: 3 });
  assert.deepEqual(L.applyMark(m, 'in', 3.5, 4), { in: 3.5, out: null }, 'IN after OUT starts a new range');
  assert.deepEqual(L.applyMark(m, 'out', 0.5, 4), { in: null, out: 0.5 }, 'OUT before IN clears IN');
  assert.deepEqual(L.applyMark(m, 'out', 99, 4), { in: 1, out: 4 }, 'clamped to the clip');
  assert.deepEqual(L.applyMark(m, 'in', -2, 4), { in: 0, out: 3 });
  assert.deepEqual(L.applyMark(null, 'out', 2, 0), { in: null, out: 2 }, 'unknown duration');
});

test('markTime snaps IN to the frame start and includes the current frame in OUT', () => {
  near(L.markTime('in', 1.02, 30, 4), 1, 1e-9);
  near(L.markTime('out', 1.02, 30, 4), 31 / 30, 1e-9);
  near(L.markTime('out', 3.99, 30, 4), 4, 1e-9); // clamped to the clip end
  near(L.markTime('in', 1 / 30 + 1e-4, 30, 4), 1 / 30, 1e-9); // a frame-step position marks that frame
  near(L.markTime('in', 1.234, 0, 4), 1.234); // unknown fps keeps the time
  near(L.markTime('out', 9, 30, 0), 271 / 30, 1e-9); // unknown duration
});

test('dragMark clamps against the other mark instead of clearing it', () => {
  const m = { in: 1, out: 3 };
  assert.deepEqual(L.dragMark(m, 'in', 2.95, 4), { in: 3 - M.MIN_CLIP_DURATION, out: 3 });
  assert.deepEqual(L.dragMark(m, 'out', 0, 4), { in: 1, out: 1 + M.MIN_CLIP_DURATION });
  assert.deepEqual(L.dragMark(m, 'out', 10, 4), { in: 1, out: 4 });
  assert.deepEqual(L.dragMark({ in: null, out: null }, 'in', 3.99, 4), { in: 4 - M.MIN_CLIP_DURATION, out: null });
  assert.deepEqual(L.dragMark({ in: null, out: null }, 'out', 0.01, 4), { in: null, out: M.MIN_CLIP_DURATION });
});

test('markedRange turns marks into a clip range', () => {
  const v = { kind: 'video', duration: 4 };
  assert.equal(L.markedRange(v, null, null), null, 'no marks = whole clip');
  assert.deepEqual(L.markedRange(v, 1, 3), { in: 1, out: 3 });
  assert.deepEqual(L.markedRange(v, 1, null), { in: 1, out: 4 });
  assert.deepEqual(L.markedRange(v, null, 2.5), { in: 0, out: 2.5 });
  assert.equal(L.markedRange(v, 2, 2.05), null, 'too short');
  assert.equal(L.markedRange({ kind: 'image', duration: 0 }, 1, 2), null, 'images ignore marks');
  assert.deepEqual(L.markedRange({ kind: 'video', duration: 0 }, 1, null), { in: 1 }, 'unknown duration keeps the IN');
  assert.deepEqual(L.markBounds({ in: 1, out: null }, 4), { start: 1, end: 4, active: true });
  assert.deepEqual(L.markBounds(L.EMPTY_MARKS, 4), { start: 0, end: 4, active: false });
});

test('shuttleRate: J/K/L', () => {
  assert.equal(L.shuttleRate(0, 'l'), 1);
  assert.equal(L.shuttleRate(1, 'l'), 2);
  assert.equal(L.shuttleRate(4, 'l'), 8);
  assert.equal(L.shuttleRate(8, 'l'), 8);
  assert.equal(L.shuttleRate(2, 'j'), -1, 'J while going forward reverses at 1x');
  assert.equal(L.shuttleRate(-1, 'j'), -2);
  assert.equal(L.shuttleRate(-8, 'j'), -8);
  assert.equal(L.shuttleRate(-4, 'l'), 1);
  assert.equal(L.shuttleRate(3, 'k'), 0);
});

test('frameStepTime steps whole frames and clamps to the clip', () => {
  near(L.frameStepTime(1, 30, 1, 4), 31 / 30);
  near(L.frameStepTime(1, 30, -1, 4), 29 / 30);
  near(L.frameStepTime(1.0166, 30, 1, 4), 31 / 30, 1e-9);
  near(L.frameStepTime(0, 30, -1, 4), 0);
  near(L.frameStepTime(4, 30, 1, 4), 119 / 30, 1e-9);
  near(L.frameStepTime(1, 0, 1, 0), 31 / 30, 1e-9);
  near(L.frameStepTime(2, 24, 1, 6), 49 / 24, 1e-9);
});

test('stripCell maps the pointer to a filmstrip frame', () => {
  assert.equal(L.stripCell(0, 200, 10), 0);
  assert.equal(L.stripCell(19.9, 200, 10), 0);
  assert.equal(L.stripCell(20, 200, 10), 1);
  assert.equal(L.stripCell(199, 200, 10), 9);
  assert.equal(L.stripCell(260, 200, 10), 9);
  assert.equal(L.stripCell(-5, 200, 10), 0);
  assert.equal(L.stripCell(50, 0, 10), 0);
  near(L.stripCellTime(0, 10, 4), 0.2);
  near(L.stripCellTime(9, 10, 4), 3.8);
  near(L.posterTime(4), 0.6);
  near(L.posterTime(20), 1);
});

test('flags and ratings ops are no-ops when nothing changes', () => {
  const p = bin();
  const q = L.setFlagOp(p, ['green', 'img'], 'pick');
  assert.equal(q.media.green.flag, 'pick');
  assert.equal(q.media.img.flag, 'pick');
  assert.equal(L.setFlagOp(q, ['green', 'img'], 'pick'), q);
  assert.equal(L.setFlagOp(p, ['nope'], 'pick'), p);
  const r = L.setRatingOp(p, ['blue'], 4.4);
  assert.equal(r.media.blue.rating, 4);
  assert.equal(L.setRatingOp(r, ['blue'], 4), r);
  assert.equal(L.setRatingOp(p, ['blue'], 9).media.blue.rating, 5);
  assert.equal(L.toggledFlag(p, ['red', 'mus'], 'pick'), null, 'all picked -> toggle clears');
  assert.equal(L.toggledFlag(p, ['red', 'green'], 'pick'), 'pick');
  assert.equal(L.flagLabel('pick'), 'Pick');
  assert.equal(L.flagLabel('reject', 3), 'Reject 3 items');
  assert.equal(L.flagLabel(null), 'Unflag');
  assert.deepEqual(L.flagStats(p, p.mediaOrder), { total: 5, picked: 2, rejected: 1, unflagged: 2, rated: 4 });
});

test('mediaUsageCounts is cached per tracks object and counts audio uses', () => {
  let p = bin();
  ({ project: p } = M.appendMediaToTimeline(p, ['red', 'red', 'green']));
  ({ project: p } = M.addAudioClip(p, 'mus', { start: 0 }));
  ({ project: p } = M.addAudioClip(p, 'red', { start: 0 }));
  const counts = L.mediaUsageCounts(p);
  assert.equal(counts.get('red'), 3);
  assert.equal(counts.get('green'), 1);
  assert.equal(counts.get('mus'), 1);
  assert.equal(counts.get('blue'), undefined);
  assert.equal(L.mediaUsageCounts(p), counts, 'cached');
  assert.equal(L.mediaUsageCounts(M.renameProject(p, 'x')), counts, 'unrelated edits keep the cache (same tracks object)');
});

test('page items: view filters, newest first, in-bin detection', () => {
  let p = M.createProject('t');
  p = M.addMedia(p, M.createMediaItem({ id: 'm1', pageKey: 'video:1' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'm2', pageKey: null }));
  const keys = new Set(L.parsePageIndex(L.binPageIndexString(p)).keys());
  assert.deepEqual([...keys], ['video:1']);
  const items = [
    { key: 'video:1', kind: 'video', seenAt: 10 },
    { key: 'video:2', kind: 'video', seenAt: 30 },
    { key: 'image:3', kind: 'image', seenAt: 20 },
    { key: '', kind: 'video', seenAt: 99 },
  ];
  assert.deepEqual(L.pageItemsView(items).map((i) => i.key), ['video:2', 'image:3', 'video:1']);
  assert.deepEqual(L.pageItemsView(items, 'image').map((i) => i.key), ['image:3']);
  assert.deepEqual(L.pageItemsView(items, 'new', keys).map((i) => i.key), ['video:2', 'image:3']);
  assert.deepEqual(L.missingFromBin(items, keys, 'video').map((i) => i.key), ['video:2']);
  assert.deepEqual(L.missingFromBin(items, keys).map((i) => i.key), ['video:2', 'image:3']);
});

test('page index maps grok page keys to bin media ids', () => {
  let p = M.createProject('t');
  p = M.addMedia(p, M.createMediaItem({ id: 'm1', pageKey: 'video:1' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'm2', pageKey: null }));
  p = M.addMedia(p, M.createMediaItem({ id: 'm3', pageKey: 'image:3' }));
  const idx = L.parsePageIndex(L.binPageIndexString(p));
  assert.deepEqual([...idx.entries()], [['image:3', 'm3'], ['video:1', 'm1']]);
  assert.equal(L.parsePageIndex('').size, 0);
  assert.equal(L.binPageIndexString(null), '');
});

test('parseMediaDrag and snippet', () => {
  assert.deepEqual(L.parseMediaDrag('["a","b"]'), ['a', 'b']);
  assert.deepEqual(L.parseMediaDrag('["a",3,null,""]'), ['a']);
  assert.deepEqual(L.parseMediaDrag('{"a":1}'), []);
  assert.deepEqual(L.parseMediaDrag('nope'), []);
  assert.equal(L.snippet('  a   b  '), 'a b');
  assert.equal(L.snippet('x'.repeat(20), 10), 'xxxxxxxxx…');
});

test('displayTitle: a name the user gave wins over the prompt; prompt-derived names show the full prompt', () => {
  const prompt = 'A red sports car drifting through neon rain, cinematic tracking shot';
  // Grok imports: the name is the prompt truncated with '…' (or the whole prompt when short).
  const grok = { name: 'A red sports car drifting through neon rain, ci…', prompt };
  assert.equal(L.isPromptName(grok), true);
  assert.equal(L.displayTitle(grok), prompt);
  assert.equal(L.displaySubtitle(grok), null);
  assert.equal(L.isPromptName({ name: 'Short one', prompt: '  Short   one ' }), true, 'whitespace-insensitive');
  // Renamed: the custom name is the title, the prompt the second line.
  const renamed = { name: 'HERO SHOT', prompt };
  assert.equal(L.isPromptName(renamed), false);
  assert.equal(L.displayTitle(renamed), 'HERO SHOT');
  assert.equal(L.displaySubtitle(renamed), prompt);
  // A rename to a prefix of the prompt (no ellipsis) still counts as a chosen name.
  assert.equal(L.displayTitle({ name: 'A red sports car', prompt }), 'A red sports car');
  // Frame grabs: "<title> · frame 0:01.00" is a chosen name.
  assert.equal(L.displayTitle({ name: 'A red sports car… · frame 0:01.00', prompt }), 'A red sports car… · frame 0:01.00');
  // No prompt: the name; nothing at all: Untitled.
  assert.equal(L.displayTitle({ name: 'clip-red', prompt: null }), 'clip-red');
  assert.equal(L.displaySubtitle({ name: 'clip-red', prompt: null }), null);
  assert.equal(L.displayTitle({ name: '', prompt: '  p  q ' }), 'p q');
  assert.equal(L.displayTitle({ name: '', prompt: null }), 'Untitled');
});

test('filterAndSort: "name" sorts by the title the card shows', () => {
  let p = M.createProject('t');
  const items = [
    { id: 'grok', name: 'Zebra crossing at night, rain…', prompt: 'Zebra crossing at night, rain on the asphalt', addedAt: 1 },
    { id: 'renamed', name: 'Alpha take', prompt: 'Zulu sunrise over the dunes', addedAt: 2 },
    { id: 'file', name: 'middle', prompt: null, addedAt: 3 },
  ];
  for (const it of items) p = M.addMedia(p, M.createMediaItem({ ...it, status: 'ready' }));
  assert.deepEqual(L.filterAndSort(p, { sort: 'name' }), ['renamed', 'file', 'grok']);
});

test('mediaMarks reads marks stored on the item and drops junk', () => {
  assert.equal(L.mediaMarks(null), L.EMPTY_MARKS);
  assert.equal(L.mediaMarks({ marks: null }), L.EMPTY_MARKS);
  assert.equal(L.mediaMarks({ marks: { in: 'x', out: NaN } }), L.EMPTY_MARKS);
  assert.deepEqual(L.mediaMarks({ marks: { in: 1.5, out: null } }), { in: 1.5, out: null });
  assert.deepEqual(L.mediaMarks({ marks: { in: 1, out: 3 } }), { in: 1, out: 3 });
  assert.equal(L.hasMarks({ marks: { in: null, out: 2 } }), true);
  assert.equal(L.hasMarks({}), false);
});

test('review walk skips items removed since the snapshot', () => {
  const list = ['a', 'b', 'c', 'd'];
  const gone = new Set(['b']);
  const alive = (id) => !gone.has(id);
  assert.equal(L.resolveWalk(list, 0, alive), 0);
  assert.equal(L.resolveWalk(list, 1, alive), 2, 'cursor on a removed item moves to the next one');
  assert.equal(L.walkStep(list, 0, 1, alive), 2, 'next skips removed items');
  assert.equal(L.walkStep(list, 2, -1, alive), 0, 'prev skips removed items');
  assert.equal(L.walkStep(list, 0, -1, alive), 0, 'prev from the first stays');
  assert.equal(L.walkStep(list, 3, 1, alive), 4, 'next from the last = summary');
  assert.equal(L.walkStep(list, 4, -1, alive), 3, 'prev from the summary = last item');
  gone.add('c').add('d');
  assert.equal(L.resolveWalk(list, 2, alive), 4, 'nothing left after the cursor = summary');
  assert.equal(L.walkStep(list, 4, -1, alive), 0);
  gone.add('a');
  assert.equal(L.resolveWalk(list, 0, alive), 4, 'everything removed');
  assert.equal(L.walkStep(list, 4, -1, alive), 4);
  assert.equal(L.resolveWalk([], 0, alive), 0);
});

test('placeholderFixes repairs stand-in clips brought back by undo after the media was probed', () => {
  let p = M.createProject('t');
  p = M.addMedia(p, M.createMediaItem({ id: 'v', kind: 'video', duration: 0, status: 'pending' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'a', kind: 'audio', duration: 0, status: 'pending' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'img', kind: 'image', status: 'ready' }));
  ({ project: p } = M.appendMediaToTimeline(p, ['v', 'v', 'img']));
  ({ project: p } = M.appendMediaToTimeline(p, ['v'], { ranges: { v: { in: 0.5, out: 2 } } })); // marked range: not a stand-in
  ({ project: p } = M.addAudioClip(p, 'a', { start: 0 }));
  assert.deepEqual(p.tracks.video.map((c) => [c.out, !!c.autoOut]), [[3, true], [3, true], [3, false], [2, false]]);
  assert.equal(p.tracks.audio[0].out, 10);
  assert.deepEqual(L.placeholderFixes(p), [], 'nothing to fix while the duration is unknown');
  // The user trims the second clip while it downloads: autoOut is cleared, it is never widened.
  p = M.updateClip(p, p.tracks.video[1].id, { out: 2.5 });
  const beforeProbe = p;
  // Probed (core widens autoOut clips itself; a snapshot from before keeps the stand-in).
  const media = M.updateMedia(M.updateMedia(p, 'v', { duration: 6, status: 'ready' }), 'a', { duration: 25, status: 'ready' }).media;
  const restored = { ...beforeProbe, media }; // what an undo to that snapshot looks like (the store keeps durations)
  const fixes = L.placeholderFixes(restored);
  assert.deepEqual(fixes, [
    { id: p.tracks.video[0].id, track: 'video', out: 6 },
    { id: p.tracks.audio[0].id, track: 'audio', out: 25 },
  ]);
  let q = restored;
  for (const f of fixes) q = M.updateClip(q, f.id, { out: f.out });
  assert.deepEqual(q.tracks.video.map((c) => c.out), [6, 2.5, 3, 2], 'user trim, image and marked range kept');
  assert.equal(q.tracks.audio[0].out, 25);
  assert.deepEqual(L.placeholderFixes(q), [], 'repaired clips are no longer autoOut');
  // Shorter real durations are repaired too (the stand-in would run past the end of the media).
  const short = { ...beforeProbe, media: M.updateMedia(beforeProbe, 'v', { duration: 2, status: 'ready' }).media };
  assert.deepEqual(L.placeholderFixes(short).map((f) => f.out), [2]);
});

test('filterAndSort: "newest" is the bin order, so one import keeps its order even when its items span a millisecond tick', () => {
  // What core/media.js importPageItems builds for a feed [f1 … f6]: mediaOrder = feed order (the first feed item on
  // top), addedAt = one Date.now() per item, here crossing a millisecond after f4.
  let p = M.createProject('t');
  p = M.addMedia(p, M.createMediaItem({ id: 'old', addedAt: 500 }));
  const feed = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
  const at = { f1: 1000, f2: 1000, f3: 1000, f4: 1000, f5: 1001, f6: 1001 };
  for (const id of feed.slice().reverse()) p = M.addMedia(p, M.createMediaItem({ id, addedAt: at[id] }));
  assert.deepEqual(p.mediaOrder, [...feed, 'old']);
  assert.deepEqual(L.filterAndSort(p, {}), [...feed, 'old'], 'newest first = bin order, not addedAt');
  assert.deepEqual(L.filterAndSort(p, { sort: 'oldest' }), ['old', ...feed.slice().reverse()]);
  // Ties of the other sorts fall back to the same order.
  assert.deepEqual(L.filterAndSort(p, { sort: 'rating' }), [...feed, 'old']);
  assert.deepEqual(L.filterAndSort(p, { sort: 'duration' }), [...feed, 'old']);
});

test('filterShowing resets only the criteria that hide an item (sort kept)', () => {
  const p = bin();
  const f = { kind: 'video', flag: 'pick', minRating: 4, search: 'neon', sort: 'name' };
  // red: video, pick, 3 stars, prompt has "neon" -> only the rating hides it
  assert.deepEqual(L.filterShowing(f, p.media.red), { ...f, minRating: 0 });
  // img: image, unflagged, 3 stars, no "neon" -> everything but the sort is reset
  assert.deepEqual(L.filterShowing(f, p.media.img), { kind: 'all', flag: 'all', minRating: 0, search: '', sort: 'name' });
  // blue is rejected: "hide rejected" hides it, "all flags" doesn't
  assert.equal(L.filterShowing({ flag: 'hide-rejected' }, p.media.blue).flag, 'all');
  assert.equal(L.filterShowing({ flag: 'reject' }, p.media.blue).flag, 'reject');
  // nothing hides it: the (normalized) filter is unchanged, and it now passes
  assert.deepEqual(L.filterShowing({ search: 'forest' }, p.media.green), { ...L.DEFAULT_FILTER, search: 'forest' });
  for (const id of Object.keys(p.media)) assert.ok(L.filterAndSort(p, L.filterShowing(f, p.media[id])).includes(id), id);
  assert.deepEqual(L.filterShowing(f, null), f, 'no item: unchanged');
});

test('placedOnTimeline: visual media on the main track, audio files on an audio track', () => {
  let p = bin();
  ({ project: p } = M.appendMediaToTimeline(p, ['red', 'img']));
  ({ project: p } = M.addAudioClip(p, 'mus', { start: 0 }));
  ({ project: p } = M.addAudioClip(p, 'green', { start: 0 })); // only the sound of green is used
  assert.deepEqual(L.placedOnTimeline(p, ['green', 'red', 'blue', 'img', 'mus', 'gone']), ['red', 'img', 'mus']);
  assert.deepEqual(L.placedOnTimeline(p, []), []);
  assert.deepEqual(L.placedOnTimeline(null, ['red']), []);
});

test('urlProblem explains what is wrong with a typed link', () => {
  assert.equal(L.urlProblem('https://assets.grok.com/test/clip.mp4'), null);
  assert.equal(L.urlProblem('  http://example.com/a.mp3  '), null);
  assert.equal(L.urlProblem('data:image/png;base64,AAAA'), null);
  assert.match(L.urlProblem(''), /Paste the link/);
  assert.match(L.urlProblem('   '), /Paste the link/);
  assert.match(L.urlProblem('not a url'), /not a web link/);
  assert.match(L.urlProblem('ftp://example.com/a.mp4'), /not a web link/);
  assert.match(L.urlProblem('example.com/clip.mp4'), /start with https:\/\//);
  assert.match(L.urlProblem('https://'), /not valid/);
});

test('trimLabel describes usable IN/OUT marks only', () => {
  const m = { id: 'v', kind: 'video', duration: 6 };
  assert.equal(L.trimLabel(m), null);
  assert.equal(L.trimLabel({ ...m, marks: { in: 1, out: 3 } }), 'IN/OUT marks set: adding it uses 0:01.00–0:03.00');
  assert.equal(L.trimLabel({ ...m, marks: { in: 2, out: null } }), 'IN/OUT marks set: adding it uses 0:02.00–0:06.00');
  assert.equal(L.trimLabel({ ...m, marks: { in: 2, out: 2.01 } }), null, 'too short to be a range');
  assert.equal(L.trimLabel({ id: 'i', kind: 'image', marks: { in: 1, out: 2 } }), null, 'images have no range');
});
