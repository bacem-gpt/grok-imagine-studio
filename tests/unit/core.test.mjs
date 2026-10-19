import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectStore, createStore } from '../../extension/studio/core/store.js';
import * as M from '../../extension/studio/core/model.js';
import { formatTime, parseTime, formatDuration, shallowEqual, mapLimit, createQueue, sanitizeFilename, asciiFilename, extFromMime, debounce, splitGraphemes } from '../../extension/studio/core/utils.js';
import * as U from '../../extension/shared/grok-urls.js';
import { encodeForRuntime, decodeFromRuntime } from '../../extension/shared/protocol.js';

test('createStore notifies with next and previous state, skips no-ops', () => {
  const s = createStore({ a: 1 });
  const seen = [];
  s.subscribe((next, prev) => seen.push([next.a, prev.a]));
  s.set({ a: 2 });
  s.set((st) => st); // no-op
  s.set((st) => ({ ...st, a: 3 }));
  assert.deepEqual(seen, [[2, 1], [3, 2]]);
});

test('project store: undo/redo and merge keys collapse a gesture into one step', () => {
  const ps = createProjectStore();
  let p = M.createProject('x');
  p = M.addMedia(p, M.createMediaItem({ id: 'a', kind: 'video', duration: 6, status: 'ready' }));
  ps.load(p);
  assert.equal(ps.canUndo(), false);
  ps.update((q) => M.appendMediaToTimeline(q, ['a']).project, { label: 'add' });
  const clipId = ps.get().tracks.video[0].id;
  for (const out of [5, 4, 3]) ps.update((q) => M.trimVideoClip(q, clipId, 'out', out), { label: 'trim', merge: 'drag-1' });
  assert.equal(ps.get().tracks.video[0].out, 3);
  assert.equal(ps.undo(), true);
  assert.equal(ps.get().tracks.video[0].out, 6, 'one undo reverts the whole drag');
  assert.equal(ps.undo(), true);
  assert.equal(ps.get().tracks.video.length, 0);
  assert.equal(ps.undo(), false);
  ps.redo();
  ps.redo();
  assert.equal(ps.get().tracks.video[0].out, 3);
  assert.equal(ps.canRedo(), false);
});

test('project store: a new edit clears redo; same-function no-op is ignored', () => {
  const ps = createProjectStore();
  ps.load(M.createProject('x'));
  ps.update((q) => M.renameProject(q, 'one'));
  ps.undo();
  assert.equal(ps.canRedo(), true);
  ps.update((q) => M.renameProject(q, 'two'));
  assert.equal(ps.canRedo(), false);
  const before = ps.get();
  ps.update((q) => q);
  assert.equal(ps.get(), before);
});

test('project store: history:false media status survives undo/redo', () => {
  const ps = createProjectStore();
  let p = M.createProject('x');
  p = M.addMedia(p, M.createMediaItem({ id: 'a', kind: 'video', status: 'loading' }));
  ps.load(p);
  ps.update((q) => M.renameProject(q, 'renamed'), { label: 'rename' });
  ps.update((q) => M.updateMedia(q, 'a', { status: 'ready', duration: 4 }), { history: false });
  ps.undo();
  assert.equal(ps.get().name, 'x');
  assert.equal(ps.get().media.a.status, 'ready', 'background status is not rolled back by undo');
  assert.equal(ps.get().media.a.duration, 4);
  ps.redo();
  assert.equal(ps.get().media.a.status, 'ready');
});

test('formatTime / parseTime round trip', () => {
  assert.equal(formatTime(0), '0:00.00');
  assert.equal(formatTime(75.5), '1:15.50');
  assert.equal(formatTime(3725.25), '1:02:05.25');
  assert.equal(formatTime(1.5, { fps: 30, frames: true }), '0:01:15');
  assert.equal(parseTime('1:15.5'), 75.5);
  assert.equal(parseTime('75.5'), 75.5);
  assert.equal(parseTime('1:02:05.25'), 3725.25);
  assert.equal(parseTime('0:00:01:15', 30), 1.5);
  assert.ok(Number.isNaN(parseTime('abc')));
  assert.equal(formatDuration(4.24), '4.2s');
  assert.equal(formatDuration(75), '1:15');
});

test('utils: shallowEqual, mapLimit order, queue concurrency, filenames', async () => {
  assert.ok(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' }));
  assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!shallowEqual([1, 2], { 0: 1, 1: 2 }));
  const res = await mapLimit([30, 10, 20], 2, (ms, i) => new Promise((r) => setTimeout(() => r(i), ms)));
  assert.deepEqual(res, [0, 1, 2]);
  const q = createQueue(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    [1, 2, 3, 4, 5].map(() =>
      q.push(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(sanitizeFilename('a/b:c*?.mp4'), 'a_b_c_.mp4');
  assert.equal(extFromMime('video/mp4;codecs=avc1'), 'mp4');
});

test('grok-urls: ids, derivations, keys', () => {
  const v = 'https://assets.grok.com/users/u1/generated/11111111-1111-4111-8111-111111111111/generated_video.mp4?cache=1';
  assert.equal(U.extractPostId(v), '11111111-1111-4111-8111-111111111111');
  assert.equal(U.videoFromThumbnail('https://assets.grok.com/users/u1/generated/x/preview_image.jpg'), 'https://assets.grok.com/users/u1/generated/x/generated_video.mp4');
  assert.equal(U.videoFromThumbnail('https://imagine-public.x.ai/imagine-public/share-videos/abc_thumbnail.jpg'), 'https://imagine-public.x.ai/imagine-public/share-videos/abc.mp4');
  assert.equal(U.fullImageFromPreview('https://a/x/preview_image.jpg'), 'https://a/x/image.jpg');
  assert.equal(U.absolutize('users/u1/generated/x/generated_video.mp4'), 'https://assets.grok.com/users/u1/generated/x/generated_video.mp4');
  assert.equal(U.absolutize('/imagine/post/1'), 'https://grok.com/imagine/post/1');
  assert.ok(U.looksLikeMediaUrl(v));
  assert.ok(!U.looksLikeMediaUrl('https://grok.com/_next/static/logo.png'));
  assert.equal(U.guessKindFromUrl(v), 'video');
  assert.equal(U.guessKindFromUrl('https://x/a.mp3'), 'audio');
  assert.equal(U.normalizeUrl(v), 'https://assets.grok.com/users/u1/generated/11111111-1111-4111-8111-111111111111/generated_video.mp4');
  assert.equal(U.mediaKey({ postId: 'p1', kind: 'video', url: v }), 'video:p1');
  assert.equal(U.mediaKey({ url: v + '#t=1' }), 'url:' + U.normalizeUrl(v));
  assert.equal(U.slugify('Ça va? A red car!'), 'ca-va-a-red-car');
  assert.ok(U.isThumbnailUrl('https://a/x/preview_image.jpg'));
  assert.ok(U.isGrokMediaHost('https://assets.grokusercontent.com/x.png'));
});

test('protocol: blobs survive runtime encoding (nested, with names)', async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3, 250])], { type: 'image/png' });
  const file = new File([new Uint8Array([9, 8])], 'ref.png', { type: 'image/png' });
  const enc = await encodeForRuntime({ a: blob, list: [file, 'x'], n: 1 });
  const json = JSON.parse(JSON.stringify(enc));
  const dec = decodeFromRuntime(json);
  assert.equal(dec.n, 1);
  assert.equal(dec.list[1], 'x');
  assert.deepEqual([...new Uint8Array(await dec.a.arrayBuffer())], [1, 2, 3, 250]);
  assert.equal(dec.a.type, 'image/png');
  assert.equal(dec.list[0].name, 'ref.png');
  assert.deepEqual([...new Uint8Array(await dec.list[0].arrayBuffer())], [9, 8]);
});

test('project store: historyMediaIds covers media only reachable through undo', () => {
  const ps = createProjectStore();
  let p = M.createProject('x');
  p = M.addMedia(p, M.createMediaItem({ id: 'keep', kind: 'video' }));
  p = M.addMedia(p, M.createMediaItem({ id: 'gone', kind: 'video' }));
  ps.load(p);
  ps.update((q) => M.removeMedia(q, ['gone']), { label: 'remove' });
  assert.ok(!ps.get().media.gone);
  assert.ok(ps.historyMediaIds().includes('gone'));
});

test('project store: remembered export settings (history:false) survive undo', () => {
  const ps = createProjectStore();
  ps.load(M.createProject('x'));
  ps.update((q) => M.renameProject(q, 'renamed'), { label: 'rename' });
  ps.update((q) => ({ ...q, exportSettings: { format: 'webm' } }), { history: false });
  ps.undo();
  assert.equal(ps.get().name, 'x');
  assert.deepEqual(ps.get().exportSettings, { format: 'webm' });
  ps.redo();
  assert.deepEqual(ps.get().exportSettings, { format: 'webm' });
});

test('project store: patchMedia reaches redo snapshots (undo "add" mid-download, then redo)', () => {
  const ps = createProjectStore();
  ps.load(M.createProject('x'));
  ps.update((q) => M.addMedia(q, M.createMediaItem({ id: 'a', kind: 'video', status: 'loading' })), { label: 'add' });
  ps.undo(); // item not in the current state any more
  ps.patchMedia('a', { status: 'ready', duration: 5 }); // download finishes in the background
  assert.ok(!ps.get().media.a);
  ps.redo();
  assert.equal(ps.get().media.a.status, 'ready');
  assert.equal(ps.get().media.a.duration, 5);
  assert.equal(ps.canRedo(), false);
});

test('sanitizeFilename: names Chrome downloads would refuse become valid, readable ones', () => {
  // Unicode format characters (ZWJ emoji, RTL marks, zero-width spaces, bidi embeddings / isolates, tag characters)
  assert.equal(sanitizeFilename('Coding night 👩\u200d💻.png'), 'Coding night 👩💻.png');
  assert.equal(sanitizeFilename('\u200fرجل يمشي\u200e.mp4'), 'رجل يمشي.mp4');
  assert.equal(sanitizeFilename('a\u200bb\u202ac\u202ed\u2066e\u2069.webm'), 'abcde.webm');
  assert.equal(sanitizeFilename('flag 🏴\u{E0067}\u{E0062}\u{E007F}.png'), 'flag 🏴.png');
  // leading dots / tildes / spaces, trailing dots / spaces, control characters, reserved punctuation
  assert.equal(sanitizeFilename('.hidden.txt'), 'hidden.txt');
  assert.equal(sanitizeFilename('~draft.mp4'), 'draft.mp4');
  assert.equal(sanitizeFilename('  name . .'), 'name');
  assert.equal(sanitizeFilename('name.txt.'), 'name.txt');
  assert.equal(sanitizeFilename('tab\there\nnow.json'), 'tab here now.json');
  assert.equal(sanitizeFilename('a/b:c*?.mp4'), 'a_b_c_.mp4');
  // Windows device names and shell files, also with extensions
  assert.equal(sanitizeFilename('CON.gis.json'), '_CON.gis.json');
  assert.equal(sanitizeFilename('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFilename('com1'), '_com1');
  assert.equal(sanitizeFilename('desktop.ini'), '_desktop.ini');
  assert.equal(sanitizeFilename('console.mp4'), 'console.mp4');
  assert.equal(sanitizeFilename('shortcut.lnk'), 'shortcut.lnk_');
  // empty / nothing left
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename('...'), 'file');
  assert.equal(sanitizeFilename('\u200b', { fallback: 'sequence' }), 'sequence');
  // lone surrogates (half an emoji) never survive
  assert.ok(!/[\ud800-\udfff]/.test(sanitizeFilename('lone \ud83c.png').replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')));
  // idempotent
  for (const n of ['Coding night 👩‍💻.png', 'CON.gis.json', '~x.', 'a'.repeat(300) + '.mp4']) assert.equal(sanitizeFilename(sanitizeFilename(n)), sanitizeFilename(n));
});

test('sanitizeFilename: long names keep their extension and whole characters, within 200 UTF-8 bytes', () => {
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  const long = sanitizeFilename(`${'A long prompt that keeps going '.repeat(8)}.mp4`);
  assert.ok(long.endsWith('.mp4'), long);
  assert.ok(bytes(long) <= 200);
  const emoji = sanitizeFilename(`${'x'.repeat(175)}🎬🎬🎬.mp4`);
  assert.ok(emoji.endsWith('.mp4'));
  assert.ok(!/[\ud800-\udfff]\./.test(emoji.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')), 'no half emoji before the extension');
  const cjk = sanitizeFilename(`${'東'.repeat(180)}.webm`);
  assert.ok(cjk.endsWith('.webm') && bytes(cjk) <= 200, `${bytes(cjk)} bytes`);
  assert.equal(splitGraphemes(cjk.slice(0, -5)).every((g) => g === '東'), true);
  const family = sanitizeFilename(`${'y'.repeat(170)}👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧.png`, { maxBytes: 190 });
  assert.ok(family.endsWith('.png') && bytes(family) <= 190);
});

test('asciiFilename: plain fallback name for downloads, extension kept', () => {
  assert.equal(asciiFilename('Coding night 👩‍💻.png'), 'Coding night.png');
  assert.equal(asciiFilename('Ça va? Été.mp4'), 'Ca va_ Ete.mp4');
  assert.equal(asciiFilename('東京.mp4'), 'file.mp4');
  assert.equal(asciiFilename('CON.json'), '_CON.json');
});

test('splitGraphemes keeps emoji sequences whole', () => {
  assert.deepEqual(splitGraphemes('a👨‍👩‍👧b🎬'), ['a', '👨‍👩‍👧', 'b', '🎬']);
  assert.deepEqual(splitGraphemes('é'), ['é']);
});

test('debounce: pending / flush / cancel', () => {
  const calls = [];
  const d = debounce((x) => calls.push(x), 1000);
  assert.equal(d.pending, false);
  assert.equal(d.flush(), undefined, 'nothing pending: flush() does not call');
  d(1);
  d(2);
  assert.equal(d.pending, true);
  d.flush();
  assert.deepEqual(calls, [2], 'the pending call runs once, with the latest args');
  assert.equal(d.pending, false);
  d.flush(3);
  assert.deepEqual(calls, [2, 3], 'flush(args) always runs');
  d(4);
  d.cancel();
  assert.equal(d.pending, false);
  d.flush();
  assert.deepEqual(calls, [2, 3]);
});
