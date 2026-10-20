import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../extension/studio/prompts/dialogue.js';
import * as S from '../../extension/studio/prompts/shots.js';
import * as M from '../../extension/studio/core/model.js';

const SCRIPT = `ALICE: Did you see the light over the hill last night?
BOB: I did. I thought it was a plane at first.
ALICE: Planes don't stop in the middle of the sky and hover for ten minutes.
BOB (whispering): Then what was it?
(They both look up.)
NARRATION LINE WITHOUT SPEAKER
ALICE: I don't know. But I think it's coming back tonight, and I want to be there when it does.`;

test('parseLine reads speakers, directions and narration', () => {
  assert.deepEqual(D.parseLine('ALICE: Hello there.'), { speaker: 'ALICE', direction: '', text: 'Hello there.' });
  assert.deepEqual(D.parseLine('Bob (whispering): "Then what?"'), { speaker: 'Bob', direction: 'whispering', text: 'Then what?' });
  assert.deepEqual(D.parseLine('(They both look up.)'), { speaker: null, direction: 'They both look up.', text: '' });
  assert.equal(D.parseLine('The night was quiet: nobody moved.').speaker, null); // too many words for a name
  assert.equal(D.parseLine('Dr. Smith: Sit down.').speaker, 'Dr. Smith');
  assert.equal(D.parseLine('Dr Smith: Sit down.').speaker, 'Dr Smith');
  assert.equal(D.parseLine('أليس: مرحبا').speaker, 'أليس');
  assert.deepEqual(D.speakersOf(SCRIPT), ['ALICE', 'BOB']);
});

test('estimateSeconds scales with words and speed', () => {
  const t = 'ALICE: one two three four five six seven eight nine ten';
  assert.ok(Math.abs(D.estimateSeconds(t, { wps: 2.5 }) - 4) < 1e-9);
  assert.ok(D.estimateSeconds(t, { wps: 2 }) > D.estimateSeconds(t, { wps: 3 }));
  assert.ok(D.estimateSeconds('A: one\nB: two') > D.estimateSeconds('A: one two'));
  assert.ok(D.countWords('你好，世界') >= 2);
});

test('splitDialogue keeps parts under the clip capacity and keeps lines whole', () => {
  const settings = { clipSeconds: 8, wps: 2.5 };
  const parts = D.splitDialogue(SCRIPT, settings);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(D.estimateSeconds(p, settings) <= D.partCapacity(settings) + 1e-6, p);
  const flat = parts.join('\n').split('\n');
  assert.ok(flat.includes('BOB (whispering): Then what was it?'));
  assert.ok(flat.includes('(They both look up.)'));
  // nothing lost: every word of the script is in a part
  // (a line broken over two parts repeats its speaker)
  const words = (s) => s.replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter((w) => w && !['ALICE', 'BOB', 'whispering'].includes(w));
  assert.deepEqual(words(parts.join(' ')), words(SCRIPT));
});

test('a line longer than a clip breaks at sentences then words, keeping the speaker', () => {
  const long = `ALICE: ${'This is a fairly long sentence with many words in it. '.repeat(6)}`;
  const parts = D.splitDialogue(long, { clipSeconds: 6, wps: 2.5 });
  assert.ok(parts.length > 3);
  for (const p of parts) {
    assert.match(p, /^ALICE: /);
    assert.ok(D.estimateSeconds(p, { wps: 2.5 }) <= 5 + 1e-6);
  }
  const huge = `BOB: ${'word '.repeat(60)}`;
  for (const p of D.splitDialogue(huge, { clipSeconds: 6, wps: 2.5 })) assert.ok(D.estimateSeconds(p, { wps: 2.5 }) <= 5 + 1e-6);
});

test('separator lines force breaks; script round trip keeps ids', () => {
  const texts = D.splitDialogue('A: one\n---\nB: two', { clipSeconds: 15 });
  assert.deepEqual(texts, ['A: one', 'B: two']);
  let p = M.createProject();
  p = D.setScript(p, 'A: one\n---\nB: two\n---\nC: three');
  const ids = D.getDialogue(p).parts.map((x) => x.id);
  assert.equal(ids.length, 3);
  assert.equal(D.scriptFromParts(D.getDialogue(p).parts), 'A: one\n\n---\n\nB: two\n\n---\n\nC: three');
  // insert a part before "B": the unchanged parts keep their ids
  p = D.setScript(p, 'A: one\n---\nX: new\n---\nB: two\n---\nC: three');
  const after = D.getDialogue(p).parts;
  assert.equal(after[0].id, ids[0]);
  assert.equal(after[2].id, ids[1]);
  assert.equal(after[3].id, ids[2]);
  assert.ok(!ids.includes(after[1].id));
});

test('part editing ops', () => {
  let p = D.setScript(M.createProject(), 'A: one\nB: two\nA: three\n---\nB: four');
  const [p1, p2] = D.getDialogue(p).parts;
  p = D.moveLine(p, p1.id, 'last-down');
  assert.deepEqual(D.getDialogue(p).parts.map((x) => x.text), ['A: one\nB: two', 'A: three\nB: four']);
  p = D.moveLine(p, p2.id, 'first-up');
  assert.deepEqual(D.getDialogue(p).parts.map((x) => x.text), ['A: one\nB: two\nA: three', 'B: four']);
  const r = D.splitPartAt(p, p1.id, 1);
  assert.deepEqual(D.getDialogue(r.project).parts.map((x) => x.text), ['A: one', 'B: two\nA: three', 'B: four']);
  p = D.mergeWithNext(r.project, p1.id);
  assert.deepEqual(D.getDialogue(p).parts.map((x) => x.text), ['A: one\nB: two\nA: three', 'B: four']);
  p = D.removeParts(p, p2.id);
  assert.equal(D.getDialogue(p).parts.length, 1);
  const same = D.setPartText(p, p1.id, 'A: one\nB: two\nA: three');
  assert.equal(same, p); // unchanged: same project
});

test('prompts: formats, speakers, scene, continuity and phrases', () => {
  let p = D.setScript(M.createProject(), 'ALICE: Hi.\nBOB (laughing): Hello!\n(silence)\n---\nALICE: Bye.');
  p = D.setScene(p, 'Two friends in a cafe at night');
  p = D.setSpeaker(p, 'Alice', { voice: 'soft voice', mention: '@Alice' });
  p = D.setDialogueSettings(p, { phrases: ['clear lip-synced speech'] });
  const d = D.getDialogue(p);
  assert.equal(D.buildPartPrompt(d, 0), 'Two friends in a cafe at night. @Alice (soft voice) says: “Hi.” BOB (laughing) says: “Hello!” (silence) Clear lip-synced speech.');
  assert.equal(D.buildPartPrompt(d, 1), 'Two friends in a cafe at night. The conversation continues from the previous video. @Alice (soft voice) says: “Bye.” Clear lip-synced speech.');
  const s2 = { ...d, settings: { ...d.settings, format: 'script', continuity: false, phrases: [] }, speakers: {} };
  assert.equal(D.buildPartPrompt(s2, 1), 'Two friends in a cafe at night. ALICE: “Bye.”');
  const s3 = { ...s2, settings: { ...s2.settings, format: 'quotes' }, scene: '' };
  assert.equal(D.buildPartPrompt(s3, 0), '“Hi.” “Hello!” (silence)');
  assert.equal(D.partTitle(d.parts[0], 0), 'Part 1 · ALICE & BOB');
});

test('createShotsForParts links shots in dialogue order; sync updates drafts only', () => {
  let p = M.createProject();
  p = S.addShot(p, { title: 'Intro', prompt: 'establishing shot' }).project;
  p = D.setScript(p, 'A: one\n---\nB: two\n---\nC: three');
  const r = D.createShotsForParts(p);
  assert.equal(r.created.length, 3);
  p = r.project;
  const d = D.getDialogue(p);
  assert.deepEqual(d.parts.map((x) => x.shotId), r.created);
  assert.deepEqual(S.getShots(p).map((s) => s.title), ['Intro', 'Part 1 · A', 'Part 2 · B', 'Part 3 · C']);
  assert.equal(S.findShot(p, r.created[0]).duration, 15);
  // again: nothing new
  assert.equal(D.createShotsForParts(p).created.length, 0);
  // edit a part: sync rewrites draft shots, not sent ones
  p = S.markShotSent(p, r.created[1], { text: 'x' });
  p = D.setPartText(p, d.parts[0].id, 'A: one more');
  p = D.setPartText(p, d.parts[1].id, 'B: two more');
  const sy = D.syncShotPrompts(p);
  assert.deepEqual(sy.updated, [r.created[0]]);
  assert.match(S.findShot(sy.project, r.created[0]).prompt, /one more/);
  assert.equal(D.syncShotPrompts(p, { includeSent: true }).updated.length, 2);
  // a deleted shot's part is unlinked and gets a new shot
  p = S.removeShots(sy.project, r.created[2]);
  p = D.repairDialogue(p);
  assert.equal(D.getDialogue(p).parts[2].shotId, null);
  const again = D.createShotsForParts(p);
  assert.equal(again.created.length, 1);
  // new shot placed right after part 2's shot
  const titles = S.getShots(again.project).map((s) => s.title);
  assert.deepEqual(titles, ['Intro', 'Part 1 · A', 'Part 2 · B', 'Part 3 · C']);
});

test('takes map back to their part; assemble in dialogue order; subtitles', () => {
  let p = M.createProject();
  p = D.setScript(p, 'A: one two three\n---\nB: four five');
  p = D.createShotsForParts(p).project;
  const d = D.getDialogue(p);
  const m1 = M.createMediaItem({ kind: 'video', duration: 6, status: 'ready' });
  const m2 = M.createMediaItem({ kind: 'video', duration: 6, status: 'ready' });
  p = M.addMedia(M.addMedia(p, m1), m2);
  p = S.linkTake(p, d.parts[1].shotId, m2.id);
  p = S.linkTake(p, d.parts[0].shotId, m1.id);
  assert.equal(D.partForMedia(p, m2.id).index, 1);
  assert.equal(D.partForMedia(p, m1.id).part.id, d.parts[0].id);
  // reverse the shot list: dialogue order still wins
  p = S.reorderShots(p, S.getShots(p).map((s) => s.id).reverse());
  assert.deepEqual(S.takesInShotOrder(p).mediaIds, [m2.id, m1.id]);
  const res = S.assembleTimeline(p, { order: D.partShotIds(p) });
  assert.deepEqual(res.project.tracks.video.map((c) => c.mediaId), [m1.id, m2.id]);
  const subs = D.subtitlePlan(res.project);
  assert.equal(subs.length, 2);
  assert.equal(subs[0].text, 'A: one two three');
  assert.ok(subs[0].start > 0 && subs[0].start < 1);
  assert.ok(subs[1].start >= 6 && subs[1].start < 7);
  assert.ok(subs.every((s) => s.duration > 0.5));
});

test('getDialogue tolerates missing / odd data and merges as one field', () => {
  assert.deepEqual(D.getDialogue({}).parts, []);
  assert.equal(D.getDialogue({ dialogue: { settings: { clipSeconds: 999, format: 'bogus' } } }).settings.clipSeconds, 60);
  assert.equal(D.getDialogue({ dialogue: { settings: { format: 'bogus' } } }).settings.format, 'says');
  const base = M.createProject();
  const mine = { ...base, name: 'mine' };
  const theirs = D.setScript(base, 'A: hi');
  const merged = M.mergeProjects(base, mine, theirs);
  assert.equal(D.getDialogue(merged).parts.length, 1);
  assert.equal(merged.name, 'mine');
});
