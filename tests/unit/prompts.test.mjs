// Prompt engine: text helpers, Prompt Builder composition and token expansion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseSpaces,
  cleanPhrase,
  capitalizeFirst,
  ensureSentence,
  tokenKey,
  splitPhrases,
  hasPhrase,
  togglePhrase,
  stripMarkdown,
  unquote,
  normalizeForMatch,
  contentWords,
  textStats,
} from '../../extension/studio/prompts/text.js';
import { composePrompt, BUILDER_FIELDS, DEFAULT_ORDER, ORDER_PRESETS, fieldText, hasFields, compactFields, startsWithGerund, orderFor } from '../../extension/studio/prompts/compose.js';
import { expandTokens, findTokens, bibleEntries, unknownTokens } from '../../extension/studio/prompts/tokens.js';
import * as P from '../../extension/studio/prompts/index.js';

// ---------------------------------------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------------------------------------

test('collapseSpaces / cleanPhrase normalise whitespace and trailing punctuation', () => {
  assert.equal(collapseSpaces('  a \n\t b  '), 'a b');
  assert.equal(collapseSpaces(null), '');
  assert.equal(cleanPhrase('  Wide shot.  '), 'Wide shot');
  assert.equal(cleanPhrase('- golden hour,'), 'golden hour');
  assert.equal(cleanPhrase('fade out...'), 'fade out...');
  assert.equal(cleanPhrase('slow pan;  '), 'slow pan');
  assert.equal(cleanPhrase(''), '');
});

test('capitalizeFirst / ensureSentence', () => {
  assert.equal(capitalizeFirst('wide shot'), 'Wide shot');
  assert.equal(capitalizeFirst('"quiet" night'), '"Quiet" night');
  assert.equal(capitalizeFirst('@mara walks'), '@mara walks');
  assert.equal(capitalizeFirst('{{style}}'), '{{style}}');
  assert.equal(capitalizeFirst('Été'), 'Été');
  assert.equal(capitalizeFirst('élan'), 'Élan');
  assert.equal(ensureSentence('a dog'), 'a dog.');
  assert.equal(ensureSentence('a dog!'), 'a dog!');
  assert.equal(ensureSentence('she says "run."'), 'she says "run."');
  assert.equal(ensureSentence('list:'), 'list.');
  assert.equal(ensureSentence('   '), '');
});

test('tokenKey canonicalises names', () => {
  assert.equal(tokenKey('Captain Nova'), 'captain-nova');
  assert.equal(tokenKey('captain_nova'), 'captain-nova');
  assert.equal(tokenKey(' Captain--Nova! '), 'captain-nova');
  assert.equal(tokenKey('Zoë'), 'zoe');
  assert.equal(tokenKey(''), '');
});

test('splitPhrases respects quotes and brackets; toggle/has are case-insensitive', () => {
  assert.deepEqual(splitPhrases('a, b; c\nd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitPhrases('she says "wait, stop", rain'), ['she says "wait, stop"', 'rain']);
  assert.deepEqual(splitPhrases('lens (35mm, f/1.4), bokeh'), ['lens (35mm, f/1.4)', 'bokeh']);
  assert.deepEqual(splitPhrases(['a, b', ' c ']), ['a', 'b', 'c']);
  assert.deepEqual(splitPhrases(''), []);
  assert.equal(hasPhrase('Slow pan, Neon glow', 'neon glow'), true);
  assert.equal(hasPhrase('Slow pan', 'pan'), false);
  assert.equal(togglePhrase('', 'neon glow'), 'neon glow');
  assert.equal(togglePhrase('slow pan', 'neon glow'), 'slow pan, neon glow');
  assert.equal(togglePhrase('slow pan, Neon Glow', 'neon glow'), 'slow pan');
  assert.equal(togglePhrase('a, b', ''), 'a, b');
});

test('stripMarkdown / unquote', () => {
  assert.equal(stripMarkdown('**Bold** and __under__ and `code`'), 'Bold and under and code');
  assert.equal(stripMarkdown('an *emphasised* word'), 'an emphasised word');
  assert.equal(stripMarkdown('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(unquote('"A dog runs"'), 'A dog runs');
  assert.equal(unquote('“A dog runs”'), 'A dog runs');
  assert.equal(unquote('"a" and "b"'), '"a" and "b"');
  assert.equal(unquote('no quotes'), 'no quotes');
});

test('normalizeForMatch / contentWords / textStats', () => {
  assert.equal(normalizeForMatch('A Red-Car, drifting!'), 'a red car drifting');
  assert.deepEqual(contentWords('The red car and the red road'), ['red', 'car', 'road']);
  assert.deepEqual(textStats('two words'), { chars: 9, words: 2 });
  assert.deepEqual(textStats(''), { chars: 0, words: 0 });
});

// ---------------------------------------------------------------------------------------------------------
// composePrompt
// ---------------------------------------------------------------------------------------------------------

const FULL = {
  shot: 'Wide shot',
  subject: 'A lone astronaut',
  action: 'walking across red dunes',
  setting: 'a dusty valley on Mars at dusk',
  camera: 'slow dolly-in',
  lens: '35mm lens',
  motion: 'gentle motion',
  lighting: 'golden hour',
  style: 'cinematic',
  mood: 'melancholic',
  palette: 'teal and orange',
  audio: 'wind howling, distant thunder',
  extra: 'no text or watermarks',
};

test('composePrompt: full field set reads as natural sentences', () => {
  assert.equal(
    composePrompt(FULL),
    'Wide shot of a lone astronaut walking across red dunes in a dusty valley on Mars at dusk. Slow dolly-in, 35mm lens, gentle motion. ' +
      'Golden hour lighting. Cinematic style, melancholic mood, teal and orange color palette. Sound: wind howling, distant thunder. No text or watermarks.',
  );
});

test('composePrompt: order presets move whole sentences, scene grammar stays intact', () => {
  const style = composePrompt(FULL, orderFor('style'));
  assert.ok(style.startsWith('Cinematic style, melancholic mood, teal and orange color palette. Wide shot of a lone astronaut'), style);
  const cam = composePrompt(FULL, ORDER_PRESETS.find((o) => o.id === 'camera').order);
  assert.ok(cam.startsWith('Slow dolly-in, 35mm lens, gentle motion. Wide shot of'), cam);
  // Keys missing from a partial order are appended, nothing is dropped.
  const partial = composePrompt(FULL, ['audio']);
  assert.ok(partial.startsWith('Sound: wind howling'), partial);
  assert.ok(partial.includes('Wide shot of a lone astronaut'));
  assert.equal(orderFor('nope'), DEFAULT_ORDER);
});

test('composePrompt: shot + finite verb action becomes two sentences; gerunds join with "of"', () => {
  assert.equal(composePrompt({ shot: 'Close-up', subject: '@Mara', action: 'walks into the bar' }), 'Close-up. @Mara walks into the bar.');
  assert.equal(composePrompt({ shot: 'Close-up', subject: 'the old man', action: 'smiling' }), 'Close-up of the old man smiling.');
  assert.equal(composePrompt({ shot: 'Close-up', action: 'hands kneading dough' }), 'Close-up. Hands kneading dough.');
  assert.equal(composePrompt({ shot: 'Low-angle shot', subject: 'a robot' }), 'Low-angle shot of a robot.');
  assert.equal(composePrompt({ shot: 'Close-up of', subject: 'a rose' }), 'Close-up of a rose.');
  assert.equal(composePrompt({ shot: 'Wide shot', subject: 'a fox', action: 'who stops to listen' }), 'Wide shot of a fox who stops to listen.');
  assert.equal(composePrompt({ subject: 'A red fox', action: 'leaps over a frozen stream', style: 'anime' }), 'A red fox leaps over a frozen stream. Anime style.');
});

test('composePrompt: setting gets "in" unless it starts with a preposition', () => {
  assert.equal(composePrompt({ subject: 'a cat', setting: 'a sunny kitchen' }), 'A cat in a sunny kitchen.');
  assert.equal(composePrompt({ subject: 'a cat', setting: 'on a windowsill' }), 'A cat on a windowsill.');
  assert.equal(composePrompt({ setting: 'under the northern lights' }), 'Under the northern lights.');
  assert.equal(composePrompt({ shot: 'Aerial shot', setting: 'over a glacier' }), 'Aerial shot. Over a glacier.');
  assert.equal(composePrompt({ subject: 'a cat', setting: '@Kitchen' }), 'A cat @Kitchen.');
});

test('composePrompt: suffix rules only apply to bare adjectives', () => {
  assert.equal(composePrompt({ mood: 'tense, suspenseful' }), 'Tense, suspenseful mood.');
  assert.equal(composePrompt({ mood: 'eerie atmosphere' }), 'Eerie atmosphere.');
  assert.equal(composePrompt({ palette: 'muted pastel tones' }), 'Muted pastel tones.');
  assert.equal(composePrompt({ palette: 'emerald and gold' }), 'Emerald and gold color palette.');
  assert.equal(composePrompt({ lighting: 'neon glow' }), 'Neon glow.');
  assert.equal(composePrompt({ lighting: 'Rembrandt' }), 'Rembrandt lighting.');
  assert.equal(composePrompt({ style: 'film noir' }), 'Film noir.');
  assert.equal(composePrompt({ style: 'cyberpunk' }), 'Cyberpunk style.');
  assert.equal(composePrompt({ style: '{{style}}' }), '{{style}}.');
});

test('composePrompt: audio prefix, de-duplication, arrays, custom keys, empty input', () => {
  assert.equal(composePrompt({ audio: 'soft piano music' }), 'Sound: soft piano music.');
  assert.equal(composePrompt({ audio: 'ambient city noise' }), 'Ambient city noise.');
  assert.equal(composePrompt({ audio: 'no music' }), 'No music.');
  assert.equal(composePrompt({ camera: 'whip pan, Whip pan, crash zoom' }), 'Whip pan, crash zoom.');
  assert.equal(composePrompt({ style: ['cinematic', 'photorealistic'] }), 'Cinematic, photorealistic style.');
  assert.equal(composePrompt({ subject: 'a dog', weather: 'light drizzle' }), 'A dog. Light drizzle.');
  assert.equal(composePrompt({ subject: 'a dog', _private: 'x' }), 'A dog.');
  assert.equal(composePrompt({}), '');
  assert.equal(composePrompt(null), '');
  assert.equal(composePrompt({ subject: '   ', extra: '' }), '');
});

test('composePrompt: punctuation is tidy and tokens survive', () => {
  const out = composePrompt({ subject: '  @Mara ,', action: 'turns to camera.', extra: 'Keep {{style}}  ,  no text.' });
  assert.equal(out, '@Mara turns to camera. Keep {{style}}, no text.');
  assert.ok(!/\s[,.]/.test(out));
});

test('builder helpers: fieldText, hasFields, compactFields, startsWithGerund', () => {
  assert.equal(BUILDER_FIELDS.length, 14);
  assert.deepEqual([...new Set(BUILDER_FIELDS.map((f) => f.key))].sort(), [...DEFAULT_ORDER].sort());
  assert.equal(fieldText('style', 'a, a, b'), 'a, b');
  assert.equal(fieldText('subject', 'a man, a woman'), 'a man, a woman');
  assert.equal(fieldText('style', null), '');
  assert.equal(hasFields({ subject: '' }), false);
  assert.equal(hasFields({ subject: ' x ' }), true);
  assert.equal(hasFields(null), false);
  assert.deepEqual(compactFields({ a: '', b: 'x', c: ['y', 'z'], _d: 'q' }), { b: 'x', c: 'y, z' });
  assert.equal(startsWithGerund('walking home'), true);
  assert.equal(startsWithGerund('something strange'), false);
  assert.equal(startsWithGerund('walks home'), false);
  assert.equal(startsWithGerund(''), false);
});

// ---------------------------------------------------------------------------------------------------------
// expandTokens
// ---------------------------------------------------------------------------------------------------------

const BIBLE = {
  characters: [
    { id: 'c1', name: 'Mara', description: 'a woman in her 30s with short silver hair' },
    { id: 'c2', name: 'Captain Nova', description: 'a stern starship captain' },
    { id: 'c3', name: 'Rex', description: '' },
  ],
  locations: [{ id: 'l1', name: 'Neon Alley', description: 'a rain-soaked alley lit by pink neon' }],
  style: 'cinematic, 35mm film grain',
  notes: 'keep it moody',
};
const SNIPPETS = [
  { id: 's1', title: 'No text', text: 'no text, no watermarks' },
  { id: 's2', title: 'Look', text: '{{style}}, shallow depth of field' },
  { id: 's3', title: 'Loop', text: 'again {{loop}}' },
];

test('expandTokens: @mentions expand with description on first mention only', () => {
  const r = expandTokens('@Mara meets @Captain Nova. @Mara smiles at @captain_nova in @neon-alley.', { bible: BIBLE });
  assert.equal(
    r.text,
    'Mara (a woman in her 30s with short silver hair) meets Captain Nova (a stern starship captain). Mara smiles at Captain Nova in Neon Alley (a rain-soaked alley lit by pink neon).',
  );
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.used.sort(), ['Captain Nova', 'Mara', 'Neon Alley']);
});

test('expandTokens: describe option, names without description, case-insensitive', () => {
  assert.equal(expandTokens('@mara and @MARA', { bible: BIBLE }, { describe: 'all' }).text, 'Mara (a woman in her 30s with short silver hair) and Mara (a woman in her 30s with short silver hair)');
  assert.equal(expandTokens('@Mara', { bible: BIBLE }, { describe: 'none' }).text, 'Mara');
  assert.equal(expandTokens('@Rex barks', { bible: BIBLE }).text, 'Rex barks');
});

test('expandTokens: possessives, emails, longer words and escapes', () => {
  assert.equal(expandTokens("@Mara's sword", { bible: BIBLE }, { describe: 'none' }).text, "Mara's sword");
  const mail = expandTokens('write to mara@example.com', { bible: BIBLE });
  assert.equal(mail.text, 'write to mara@example.com');
  assert.deepEqual(mail.unknown, []);
  const longer = expandTokens('@Maradona plays', { bible: BIBLE });
  assert.deepEqual(longer.unknown, ['@Maradona']);
  assert.equal(longer.text, '@Maradona plays');
  assert.equal(expandTokens('price \\@Mara and \\{{style}}', { bible: BIBLE }).text, 'price @Mara and {{style}}');
  assert.equal(expandTokens('@ alone and @', { bible: BIBLE }).text, '@ alone and @');
});

test('expandTokens: {{variables}}, built-ins, snippets, bible names and fallbacks', () => {
  const r = expandTokens('{{subject}} in {{Neon Alley}}. {{style}}. {{no-text}} / {{No text}}. {{mood|calm}} {{notes}}', {
    bible: BIBLE,
    snippets: SNIPPETS,
    variables: { Subject: '@Mara' },
  });
  assert.equal(
    r.text,
    'Mara (a woman in her 30s with short silver hair) in Neon Alley (a rain-soaked alley lit by pink neon). cinematic, 35mm film grain. no text, no watermarks / no text, no watermarks. calm keep it moody',
  );
  assert.deepEqual(r.unknown, []);
  const seg = r.segments.find((s) => s.token === '{{mood|calm}}');
  assert.equal(seg.status, 'fallback');
});

test('expandTokens: unknown tokens are kept verbatim and reported', () => {
  const r = expandTokens('A {{lighting}} shot of @Bob.', { bible: BIBLE });
  assert.equal(r.text, 'A {{lighting}} shot of @Bob.');
  assert.deepEqual(r.unknown, ['{{lighting}}', '@Bob']);
  assert.deepEqual(unknownTokens('@Bob', {}), ['@Bob']);
});

test('expandTokens: nested snippets expand, cycles terminate', () => {
  assert.equal(expandTokens('{{look}}', { bible: BIBLE, snippets: SNIPPETS }).text, 'cinematic, 35mm film grain, shallow depth of field');
  const r = expandTokens('{{loop}}', { snippets: SNIPPETS });
  assert.equal(r.text, 'again {{loop}}');
  assert.deepEqual(r.unknown, ['{{loop}}']);
});

test('expandTokens: empty values are reported and leave tidy text', () => {
  const r = expandTokens('A cat, {{style}}, sleeping.', { bible: { style: '' } });
  assert.equal(r.text, 'A cat, sleeping.');
  assert.deepEqual(r.empty, ['style']);
  const v = expandTokens('Hello {{name}} !', { variables: { name: '' } });
  assert.equal(v.text, 'Hello!');
  assert.deepEqual(v.empty, ['name']);
  assert.equal(expandTokens('x {{name|friend}}', { variables: { name: ' ' } }).text, 'x friend');
});

test('expandTokens: with empty tokens the preview segments still join to exactly the sent text', () => {
  const cases = [
    ['A boat, {{style}}, at night', { bible: { style: '' } }, 'A boat, at night'],
    ['{{style}}, a boat drifting', { bible: { style: '' } }, 'a boat drifting'],
    ['A boat {{a}} {{b}} at night.', { variables: { a: '', b: '' } }, 'A boat at night.'],
    ['Hello {{name}} !', { variables: { name: '' } }, 'Hello!'],
    ['  {{x}}  A dog with @Mara;; {{y}}.', { variables: { x: '', y: '' }, bible: BIBLE }, 'A dog with Mara (a woman in her 30s with short silver hair).'],
  ];
  for (const [text, ctx, want] of cases) {
    const r = expandTokens(text, ctx);
    assert.equal(r.text, want, text);
    assert.equal(r.segments.map((s) => s.text).join(''), r.text, text);
    assert.ok(r.segments.some((s) => s.status === 'empty'), `${text}: empty tokens stay marked`);
  }
});

test('expandTokens: segments rebuild the text and mark tokens', () => {
  const r = expandTokens('Hi @Mara and {{x}}', { bible: BIBLE });
  assert.equal(r.segments.map((s) => s.text).join(''), r.text);
  assert.deepEqual(
    r.segments.filter((s) => s.token).map((s) => [s.token, s.status]),
    [
      ['@Mara', 'ok'],
      ['{{x}}', 'unknown'],
    ],
  );
  assert.deepEqual(expandTokens('', {}).segments, []);
  assert.equal(expandTokens(null, {}).text, '');
});

test('findTokens / bibleEntries', () => {
  const t = findTokens('Use {{style|x}} with @Mara_K, not a@b.c or \\@esc');
  assert.deepEqual(
    t.map((x) => [x.kind, x.name, x.fallback]),
    [
      ['var', 'style', 'x'],
      ['mention', 'Mara_K', null],
    ],
  );
  const entries = bibleEntries(BIBLE);
  assert.equal(entries[0].name, 'Captain Nova'); // longest first
  assert.equal(entries.length, 4);
  assert.deepEqual(bibleEntries(null), []);
});

test('index re-exports the whole engine', () => {
  for (const name of ['composePrompt', 'expandTokens', 'parsePromptList', 'exportPromptList', 'variations', 'createShot', 'linkTake', 'assembleTimeline', 'fillTemplate', 'matchTakes', 'createQueueRunner', 'createSnippet', 'PRESETS', 'BUILTIN_TEMPLATES']) {
    assert.equal(typeof P[name] !== 'undefined', true, name);
  }
});
