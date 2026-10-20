import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../extension/studio/prompts/phrases.js';

test('addPhraseToPrompt joins as sentences or with commas', () => {
  assert.equal(P.addPhraseToPrompt('', 'nobody speaks'), 'Nobody speaks.');
  assert.equal(P.addPhraseToPrompt('A woman walks on a beach', 'nobody speaks'), 'A woman walks on a beach. Nobody speaks.');
  assert.equal(P.addPhraseToPrompt('A woman walks. ', 'camera angle from top'), 'A woman walks. Camera angle from top.');
  assert.equal(P.addPhraseToPrompt('A woman walks', 'nobody speaks', { join: 'comma' }), 'A woman walks, nobody speaks');
  assert.equal(P.addPhraseToPrompt('', 'nobody speaks', { join: 'comma' }), 'nobody speaks');
  // already there (any case): unchanged
  assert.equal(P.addPhraseToPrompt('Nobody  SPEAKS here', 'nobody speaks'), 'Nobody  SPEAKS here');
});

test('promptHasPhrase matches whole words only', () => {
  assert.ok(P.promptHasPhrase('Wide shot. Nobody speaks.', 'nobody speaks'));
  assert.ok(P.promptHasPhrase('wide, no music', 'no music.'));
  assert.ok(!P.promptHasPhrase('no musical instruments', 'no music'));
  assert.ok(!P.promptHasPhrase('anobody speaks', 'nobody speaks'));
  assert.ok(P.promptHasPhrase('Personne ne parle, caméra du haut', 'caméra du haut'));
});

test('removePhraseFromPrompt cleans up separators', () => {
  assert.equal(P.removePhraseFromPrompt('A woman walks. Nobody speaks.', 'nobody speaks'), 'A woman walks.');
  assert.equal(P.removePhraseFromPrompt('Nobody speaks. A woman walks.', 'nobody speaks'), 'A woman walks.');
  assert.equal(P.removePhraseFromPrompt('a, nobody speaks, b', 'nobody speaks'), 'a, b');
  assert.equal(P.removePhraseFromPrompt('a, b, nobody speaks', 'nobody speaks'), 'a, b');
  assert.equal(P.removePhraseFromPrompt('Nobody speaks.', 'nobody speaks'), '');
  assert.equal(P.removePhraseFromPrompt('Line one.\n\nNobody speaks. Line two.', 'nobody speaks'), 'Line one.\n\nLine two.');
});

test('toggle round-trips', () => {
  const base = 'A knight rides through the fog.';
  const on = P.togglePhraseInPrompt(base, 'camera angle from top');
  assert.equal(on, 'A knight rides through the fog. Camera angle from top.');
  assert.equal(P.togglePhraseInPrompt(on, 'camera angle from top'), base);
});

test('phrase list ops dedupe and validate', () => {
  let list = P.addPhrases([], [{ text: ' nobody speaks. ', category: 'dialogue' }, { text: 'Nobody speaks', category: 'other' }, { text: 'x', category: 'bogus' }]);
  assert.equal(list.length, 2);
  assert.equal(list[0].text, 'nobody speaks');
  assert.equal(list[1].category, 'other');
  const same = P.addPhrases(list, { text: 'NOBODY SPEAKS' });
  assert.equal(same, list);
  list = P.updatePhrase(list, list[1].id, { text: 'nobody speaks' }); // duplicate refused
  assert.equal(list[1].text, 'x');
  list = P.updatePhrase(list, list[1].id, { text: 'top view', category: 'angle', auto: true });
  assert.deepEqual([list[1].text, list[1].category, list[1].auto], ['top view', 'angle', true]);
  list = P.movePhrase(list, list[1].id, 0);
  assert.equal(list[0].text, 'top view');
  assert.deepEqual(P.groupPhrases(list).map((g) => g.id), ['dialogue', 'angle']);
  assert.equal(P.autoPhrasePrompt(list), 'Top view.');
  assert.equal(P.removePhrase(list, list[0].id).length, 1);
});

test('phrase sets apply and remove as a whole', () => {
  const set = P.createPhraseSet({ name: 'Dialogue scene', texts: ['nobody speaks', 'static camera', 'Static camera'] });
  assert.deepEqual(set.texts, ['nobody speaks', 'static camera']);
  const on = P.togglePhraseSet('A room.', set);
  assert.equal(on, 'A room. Nobody speaks. Static camera.');
  assert.ok(P.setIsApplied(on, set));
  assert.equal(P.togglePhraseSet(on, set), 'A room.');
  // partially applied: adds the rest
  assert.equal(P.togglePhraseSet('A room. Static camera.', set), 'A room. Static camera. Nobody speaks.');
});

test('import/export phrases as text and JSON', () => {
  const list = P.addPhrases([], [
    { text: 'nobody speaks', category: 'dialogue', auto: true },
    { text: 'stable anatomy, natural hands', category: 'avoid' },
  ]);
  const txt = P.exportPhrasesText(list);
  assert.match(txt, /# Dialogue & voice\n\* nobody speaks/);
  const back = P.parsePhrasesText(txt);
  assert.deepEqual(back, [
    { text: 'nobody speaks', category: 'dialogue', auto: true },
    { text: 'stable anatomy, natural hands', category: 'avoid', auto: false },
  ]);
  assert.deepEqual(P.parsePhrasesText('- one\n2. two\n# camera angle\nfrom top'), [
    { text: 'one', category: 'other', auto: false },
    { text: 'two', category: 'other', auto: false },
    { text: 'from top', category: 'angle', auto: false },
  ]);
  assert.deepEqual(P.parsePhrasesText('["a", {"text":"b","category":"sound"}]').map((x) => [x.text, x.category]), [['a', 'other'], ['b', 'sound']]);
});

test('prepared library is well formed', () => {
  assert.ok(P.PREPARED_PHRASES.length > 80);
  for (const x of P.PREPARED_PHRASES) {
    assert.ok(P.CATEGORY_IDS.includes(x.category), x.text);
    assert.equal(x.text, P.cleanPhraseText(x.text));
  }
  assert.ok(P.STARTER_PHRASES.every(Boolean));
  assert.ok(P.PREPARED_PHRASES.some((x) => x.text === 'nobody speaks'));
  assert.ok(P.PREPARED_PHRASES.some((x) => x.text === 'camera angle from top'));
});
