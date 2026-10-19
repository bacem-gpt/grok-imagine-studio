// Variations, templates, library (snippets / bible / custom chips), presets and the queue runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../extension/studio/core/model.js';
import { variations, countVariations, variationPrompt } from '../../extension/studio/prompts/variations.js';
import { BUILTIN_TEMPLATES, templateVariables, templateFields, fillTemplate, createTemplate } from '../../extension/studio/prompts/templates.js';
import * as L from '../../extension/studio/prompts/library.js';
import { PRESETS, RECIPES, presetItems, presetGroupsFor, presetTexts, DURATION_OPTIONS, SHOT_MODES } from '../../extension/studio/prompts/presets.js';
import { BUILDER_FIELDS, composePrompt } from '../../extension/studio/prompts/compose.js';
import { createQueueRunner, queueProgress, abortableSleep, MAX_CONSECUTIVE_ERRORS } from '../../extension/studio/prompts/queue.js';

// ---------------------------------------------------------------------------------------------------------
// variations
// ---------------------------------------------------------------------------------------------------------

test('variations: full product in nested order (first key slowest)', () => {
  const v = variations({ subject: 'a fox' }, ['camera', 'lighting'], { camera: ['pan', 'zoom'], lighting: ['neon', 'dawn', 'moon'] }, 10);
  assert.equal(v.length, 6);
  assert.deepEqual(
    v.map((x) => x.label),
    ['pan · neon', 'pan · dawn', 'pan · moon', 'zoom · neon', 'zoom · dawn', 'zoom · moon'],
  );
  assert.deepEqual(v[0].fields, { subject: 'a fox', camera: 'pan', lighting: 'neon' });
  assert.deepEqual(v[4].changes, { camera: 'zoom', lighting: 'dawn' });
});

test('variations: capped subsets are diverse and deterministic; spread:false truncates', () => {
  const opts = { a: ['a1', 'a2', 'a3'], b: ['b1', 'b2', 'b3'], c: ['c1', 'c2'] };
  const v = variations({}, ['a', 'b', 'c'], opts, 4);
  assert.equal(v.length, 4);
  for (const k of ['a', 'b']) assert.ok(new Set(v.map((x) => x.changes[k])).size >= 3, `every ${k} option used`);
  assert.deepEqual(variations({}, ['a', 'b', 'c'], opts, 4), v, 'deterministic');
  const keys = v.map((x) => x.label);
  assert.equal(new Set(keys).size, 4, 'no duplicates');
  const flat = variations({}, ['a', 'b', 'c'], opts, 3, { spread: false });
  assert.deepEqual(flat.map((x) => x.label), ['a1 · b1 · c1', 'a1 · b1 · c2', 'a1 · b2 · c1']);
});

test('variations: edge cases', () => {
  assert.deepEqual(variations({}, [], {}, 5), []);
  assert.deepEqual(variations({}, ['a'], { a: [] }, 5), []);
  assert.deepEqual(variations({}, ['a'], { a: ['x'] }, 0), []);
  assert.deepEqual(variations({}, ['a'], { a: ['x'] }, -1), []);
  assert.equal(variations({}, ['a', 'a', 'b'], { a: ['x', 'x', ' y ', ''], b: undefined }, 10).length, 2, 'dedupe keys/options, skip empty');
  assert.equal(countVariations(['a', 'b'], { a: ['1', '2'], b: ['1', '2', '3'] }), 6);
  assert.equal(countVariations([], {}), 0);
  assert.equal(countVariations(['z'], { z: [] }), 0);
  const big = variations({}, ['a', 'b', 'c', 'd'], { a: ['1', '2', '3', '4', '5'], b: ['1', '2', '3', '4', '5'], c: ['1', '2', '3', '4', '5'], d: ['1', '2', '3', '4', '5'] }, 12);
  assert.equal(big.length, 12);
  for (const k of ['a', 'b', 'c', 'd']) assert.equal(new Set(big.map((x) => x.changes[k])).size, 5, k);
});

// ---------------------------------------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------------------------------------

test('templateVariables / templateFields', () => {
  assert.deepEqual(templateVariables('Write {{count|6}} about {{Topic}} and {{topic}} with {{style}}'), [
    { key: 'count', name: 'count', default: '6' },
    { key: 'topic', name: 'Topic', default: null },
    { key: 'style', name: 'style', default: null },
  ]);
  assert.deepEqual(templateVariables(''), []);
  const f = templateFields({ template: '{{a|1}} {{extra_thing}}', fields: [{ key: 'a', label: 'A' }] });
  assert.deepEqual(
    f.map((x) => [x.key, x.label, x.default]),
    [
      ['a', 'A', '1'],
      ['extra-thing', 'Extra thing', null],
    ],
  );
});

test('fillTemplate: values, defaults, bible context and missing variables', () => {
  const bible = { characters: [{ id: 'c', name: 'Mara', description: 'silver hair' }], style: 'noir' };
  const r = fillTemplate('Write {{count|6}} prompts about {{topic}} with {{character}}. {{style}}', { topic: 'a heist', character: '@Mara' }, { bible });
  assert.equal(r.text, 'Write 6 prompts about a heist with Mara (silver hair). noir');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unknown, []);
  const m = fillTemplate('About {{topic}} in {{style}}', {}, { bible: {} });
  assert.deepEqual(m.missing, ['topic', 'style']);
  assert.equal(m.text, 'About {{topic}} in');
  assert.deepEqual(fillTemplate({ template: '{{x}}' }, { x: '  ' }).missing, ['x']);
});

test('every built-in template is well formed and fills cleanly with sample values', () => {
  const ids = new Set();
  for (const t of BUILTIN_TEMPLATES) {
    assert.ok(t.id && !ids.has(t.id), t.id);
    ids.add(t.id);
    assert.ok(t.name && t.description && t.template, t.id);
    const values = {};
    for (const f of templateFields(t)) values[f.key] = f.default || 'sample';
    const r = fillTemplate(t, values, { bible: { style: 'cinematic' } });
    assert.deepEqual(r.missing, [], t.id);
    assert.ok(!/\{\{|\}\}/.test(r.text), `${t.id}: ${r.text}`);
  }
  const custom = createTemplate({ name: '  Mine ', template: 'x {{y}}' });
  assert.match(custom.id, /^tpl_/);
  assert.equal(custom.name, 'Mine');
});

// ---------------------------------------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------------------------------------

test('snippets: create, upsert, remove, filter, tags', () => {
  const a = L.createSnippet({ title: 'Look', text: 'cinematic, 35mm', tags: 'style, #Film, film' });
  assert.deepEqual(a.tags, ['style', 'film']);
  // Tags are comma / # separated: spaces inside a tag are kept.
  assert.deepEqual(L.parseTags('film noir, house style'), ['film noir', 'house style']);
  assert.deepEqual(L.parseTags('#mood #Film   Noir; look\nfinal'), ['mood', 'film noir', 'look', 'final']);
  assert.deepEqual(L.parseTags(''), []);
  const b = L.createSnippet({ text: 'no text no watermarks no logos please' });
  assert.equal(b.title, 'no text no watermarks no…');
  assert.equal(L.createSnippet({}).title, 'Untitled snippet');
  let list = L.upsertSnippet([], a);
  list = L.upsertSnippet(list, b);
  assert.deepEqual(list.map((s) => s.id), [b.id, a.id]);
  list = L.upsertSnippet(list, { ...a, text: 'changed', tags: 'x' });
  assert.equal(list[1].text, 'changed');
  assert.deepEqual(list[1].tags, ['x']);
  assert.deepEqual(L.filterSnippets(list, { search: 'CHANGED' }).map((s) => s.id), [a.id]);
  assert.deepEqual(L.filterSnippets(list, { search: 'no logos' }).map((s) => s.id), [b.id]);
  assert.deepEqual(L.filterSnippets(list, { tag: 'x' }).map((s) => s.id), [a.id]);
  assert.equal(L.filterSnippets(list, {}).length, 2);
  assert.deepEqual(L.allTags([{ tags: ['b', 'a'] }, { tags: ['b'] }]), [
    { tag: 'b', count: 2 },
    { tag: 'a', count: 1 },
  ]);
  assert.equal(L.removeSnippet(list, a.id).length, 1);
  assert.equal(L.snippetToken({ title: 'No Text!' }), 'no-text');
  assert.deepEqual(L.parseTags(['A', 'a', ' #b ']), ['a', 'b']);
  assert.ok(L.STARTER_SNIPPETS.length >= 4);
});

test('insertAt adds spacing only where needed', () => {
  assert.deepEqual(L.insertAt('A dog', 'running', 5), { text: 'A dog running', cursor: 13 });
  assert.deepEqual(L.insertAt('A dog', 'big', 2), { text: 'A big dog', cursor: 5 });
  assert.deepEqual(L.insertAt('', 'x'), { text: 'x', cursor: 1 });
  assert.deepEqual(L.insertAt('A dog.', ', fast', 5), { text: 'A dog, fast.', cursor: 11 });
  assert.deepEqual(L.insertAt('A cat', 'dog', 2, 5), { text: 'A dog', cursor: 5 });
  assert.deepEqual(L.insertAt('(x)', 'y', 1), { text: '(y x)', cursor: 2 });
});

test('bible: add / update / remove entries, style & notes, mentions', () => {
  let p = M.createProject('t');
  const r = L.addBibleEntry(p, 'characters', { name: '  Mara  ', description: 'silver hair' });
  p = r.project;
  assert.equal(L.getBible(p).characters[0].name, 'Mara');
  p = L.addBibleEntry(p, 'locations', { name: 'Neon Alley' }).project;
  assert.equal(L.addBibleEntry(p, 'bogus', {}).id, null);
  const same = L.updateBibleEntry(p, 'characters', r.id, { description: 'silver hair' });
  assert.equal(same, p);
  p = L.updateBibleEntry(p, 'characters', r.id, { description: 'red jacket', id: 'hack' });
  assert.equal(L.getBible(p).characters[0].description, 'red jacket');
  assert.equal(L.getBible(p).characters[0].id, r.id);
  p = L.setBibleText(p, 'style', 'noir');
  assert.equal(L.setBibleText(p, 'style', 'noir'), p);
  assert.equal(L.setBibleText(p, 'bogus', 'x'), p);
  assert.equal(L.getBible(p).style, 'noir');
  assert.equal(L.uniqueBibleName(p, 'Mara'), 'Mara 2');
  assert.equal(L.uniqueBibleName(p, 'Jonah'), 'Jonah');
  assert.equal(L.mentionFor({ name: 'Neon Alley' }), '@Neon Alley');
  assert.deepEqual(L.mentionedEntries(p, '@mara walks into {{neon_alley}}').map((e) => e.name), ['Mara', 'Neon Alley']);
  assert.deepEqual(L.mentionedEntries(p, 'nobody'), []);
  p = L.removeBibleEntry(p, 'characters', r.id);
  assert.equal(L.getBible(p).characters.length, 0);
  assert.equal(L.removeBibleEntry(p, 'characters', 'ghost'), p);
  assert.deepEqual(L.getBible({}), { characters: [], locations: [], style: '', notes: '' });
});

test('custom chips', () => {
  const c = L.createCustomPreset('lighting', 'purple, rim light');
  assert.equal(c.group, 'lighting');
  assert.equal(c.text, 'purple rim light', 'commas removed so chips can toggle');
  let list = L.addCustomPreset([], c);
  list = L.addCustomPreset(list, L.createCustomPreset('lighting', 'Purple rim light'));
  assert.equal(list.length, 1, 'duplicates ignored');
  assert.equal(L.addCustomPreset(list, { group: 'x', text: '' }).length, 1);
  assert.equal(L.removeCustomPreset(list, c.id).length, 0);
  assert.equal(L.createCustomPreset('style', 'an extremely long custom style description here').label.endsWith('…'), true);
});

// ---------------------------------------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------------------------------------

test('presets: every builder field has chips; chip texts never contain commas; recipes use known fields', () => {
  for (const f of BUILDER_FIELDS) {
    const items = presetItems(f.key);
    assert.ok(items.length >= 8, `${f.key} has chips`);
    for (const it of items) {
      assert.ok(it.label && it.text, `${f.key}: ${JSON.stringify(it)}`);
      assert.ok(!it.text.includes(','), `${f.key}: "${it.text}" has a comma`);
    }
    assert.equal(new Set(items.map((i) => i.text.toLowerCase())).size, items.length, `${f.key} duplicates`);
  }
  assert.equal(Object.keys(PRESETS).length, BUILDER_FIELDS.length);
  const keys = new Set(BUILDER_FIELDS.map((f) => f.key));
  for (const r of RECIPES) {
    for (const k of Object.keys(r.fields)) assert.ok(keys.has(k), `${r.id}.${k}`);
    assert.ok(composePrompt(r.fields).length > 10);
  }
  const groups = presetGroupsFor('mood', [{ id: '1', group: 'mood', label: 'Mine', text: 'feral' }, { id: '2', group: 'style', text: 'x' }, null]);
  assert.equal(groups[groups.length - 1].group, 'Mine');
  assert.equal(groups[groups.length - 1].items[0].text, 'feral');
  assert.ok(presetTexts('mood', [{ id: '1', group: 'mood', text: 'feral' }]).includes('feral'));
  assert.deepEqual(presetItems('nope'), []);
  assert.ok(DURATION_OPTIONS.includes(6));
  assert.deepEqual(SHOT_MODES.map((m) => m.id), ['video', 'animate', 'image']);
});

// ---------------------------------------------------------------------------------------------------------
// queue runner
// ---------------------------------------------------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
}

test('queue runner: sends in order, waits for results, honours delays', async () => {
  const log = [];
  const sleeps = [];
  const runner = createQueueRunner({
    send: async (id) => log.push(`send:${id}`),
    waitForResult: async (id, { since, timeoutMs }) => {
      log.push(`wait:${id}:${typeof since}:${timeoutMs}`);
      return id === 'b' ? 'timeout' : 'done';
    },
    sleep: async (ms) => sleeps.push(ms),
  });
  await runner.start(['a', 'b', 'c'], { delayMs: 50, timeoutMs: 5000 });
  assert.deepEqual(log, ['send:a', 'wait:a:number:5000', 'send:b', 'wait:b:number:5000', 'send:c', 'wait:c:number:5000']);
  assert.deepEqual(sleeps, [50, 50], 'no delay after the last shot');
  const st = runner.getState();
  assert.equal(st.status, 'done');
  assert.deepEqual(st.items.map((i) => i.status), ['done', 'timeout', 'done']);
  assert.deepEqual(queueProgress(st), { done: 3, total: 3, failed: 1, current: null });
});

test('queue runner: no waiting when disabled; empty run finishes immediately', async () => {
  const sent = [];
  const runner = createQueueRunner({ send: async (id) => sent.push(id), waitForResult: async () => assert.fail('should not wait'), sleep: async () => {} });
  await runner.start(['x', 'y'], { waitForGeneration: false, delayMs: 0 });
  assert.deepEqual(sent, ['x', 'y']);
  await runner.start([]);
  assert.equal(runner.getState().status, 'done');
  assert.equal(runner.reset(), true);
  assert.equal(runner.getState().status, 'idle');
});

test('queue runner: pause between steps, resume, stop skips the rest', async () => {
  const gates = {};
  const open = {};
  for (const id of ['a', 'b']) gates[id] = new Promise((r) => (open[id] = r));
  const sent = [];
  const states = [];
  const runner = createQueueRunner({
    send: async (id) => {
      sent.push(id);
      if (gates[id]) await gates[id];
    },
    sleep: async () => {},
    onChange: (s) => states.push(s.status),
  });
  const done = runner.start(['a', 'b', 'c', 'd'], { waitForGeneration: false });
  await tick();
  assert.equal(runner.pause(), true);
  assert.equal(runner.pause(), false, 'already paused');
  open.a();
  await tick();
  await tick();
  assert.deepEqual(sent, ['a'], 'b not sent while paused');
  assert.equal(runner.getState().items[0].status, 'done');
  assert.equal(runner.resume(), true);
  await until(() => sent.length === 2);
  assert.equal(runner.getState().items[1].status, 'sending');
  assert.equal(runner.stop(), true);
  open.b();
  await done;
  await tick();
  const st = runner.getState();
  assert.equal(st.status, 'stopped');
  assert.deepEqual(st.items.map((i) => i.status), ['done', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual(sent, ['a', 'b'], 'nothing sent after stop');
  assert.ok(states.includes('paused'));
  assert.equal(runner.resume(), false);
  assert.equal(runner.stop(), false);
});

test('queue runner: stop aborts a pending wait immediately', async () => {
  const runner = createQueueRunner({
    send: async () => {},
    waitForResult: (id, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve('done'))),
  });
  const p = runner.start(['a', 'b'], { delayMs: 0 });
  await until(() => runner.getState().items[0].status === 'waiting');
  runner.stop();
  await p;
  assert.deepEqual(runner.getState().items.map((i) => i.status), ['skipped', 'skipped']);
});

test('queue runner: send errors are recorded; consecutive failures stop the run', async () => {
  const runner = createQueueRunner({
    send: async (id) => {
      if (id !== 'ok') throw new Error(`boom ${id}`);
    },
    sleep: async () => {},
  });
  await runner.start(['e1', 'ok', 'e2', 'e3', 'e4', 'never'], { waitForGeneration: false });
  const st = runner.getState();
  assert.equal(st.status, 'stopped');
  assert.match(st.error, new RegExp(`${MAX_CONSECUTIVE_ERRORS} failed`));
  assert.deepEqual(st.items.map((i) => i.status), ['error', 'done', 'error', 'error', 'error', 'queued']);
  assert.equal(st.items[0].error, 'boom e1');
});

test('abortableSleep resolves on abort', async () => {
  const c = new AbortController();
  const t0 = Date.now();
  const p = abortableSleep(5000, c.signal);
  c.abort();
  await p;
  assert.ok(Date.now() - t0 < 1000);
  await abortableSleep(0);
});

test('variationPrompt: a hand-written prompt is kept; varied phrases replace their old value or are appended', () => {
  // Hand-written prompt + a Quick look that was never composed: the prompt survives, the look is not injected.
  const shot = { prompt: 'A paper boat sailing down a rainy neon street, @Mara watching from a window', fields: { style: 'film noir', lighting: 'low-key lighting with deep shadows', mood: 'mysterious' } };
  const v = variations(shot.fields, ['camera'], { camera: ['dolly in', 'whip pan'] });
  assert.deepEqual(v.map((x) => variationPrompt(shot, x)), [
    { prompt: 'A paper boat sailing down a rainy neon street, @Mara watching from a window. Dolly in.', base: 'prompt' },
    { prompt: 'A paper boat sailing down a rainy neon street, @Mara watching from a window. Whip pan.', base: 'prompt' },
  ]);
  // A field value that appears in the prompt is replaced in place (sentence starts stay capitalised).
  const edited = { prompt: 'Wide shot of a lone rider cresting a dune. Slow dolly-in. Golden hour lighting. Dust trails behind.', fields: { shot: 'Wide shot', subject: 'a lone rider', action: 'cresting a dune', camera: 'slow dolly-in', lighting: 'golden hour' } };
  const [e] = variations(edited.fields, ['shot', 'camera', 'lighting'], { shot: ['Close-up'], camera: ['whip pan'], lighting: ['soft window light'] });
  assert.deepEqual(variationPrompt(edited, e), { prompt: 'Close-up of a lone rider cresting a dune. Whip pan. Soft window light. Dust trails behind.', base: 'prompt' });
  // Mid-sentence replacement keeps the case of the new value; tokens survive.
  const alley = { prompt: 'Extreme wide shot of @Neon Alley at night, rain falling, {{style}}', fields: { shot: 'Extreme wide shot', setting: '@Neon Alley at night', lighting: 'neon glow' } };
  const [a] = variations(alley.fields, ['shot', 'lighting'], { shot: ['Low-angle shot'], lighting: ['moonlight'] });
  assert.equal(variationPrompt(alley, a).prompt, 'Low-angle shot of @Neon Alley at night, rain falling, {{style}}. Moonlight.');
  // No builder fields: the varied phrases are appended.
  const plain = { prompt: 'Close-up of the rider’s eyes narrowing against the wind', fields: {} };
  assert.equal(variationPrompt(plain, variations({}, ['camera'], { camera: ['Dolly in'] })[0]).prompt, 'Close-up of the rider’s eyes narrowing against the wind. Dolly in.');
});

test('variationPrompt: a prompt composed from the fields (or an empty one) is recomposed', () => {
  const fields = { shot: 'Wide shot', subject: 'a lone rider', action: 'cresting a dune', lighting: 'golden hour', camera: 'slow dolly-in' };
  const shot = { prompt: composePrompt(fields), fields };
  assert.equal(shot.prompt, 'Wide shot of a lone rider cresting a dune. Slow dolly-in. Golden hour lighting.');
  const list = variations(fields, ['lighting'], { lighting: ['neon glow', 'soft window light'] });
  assert.deepEqual(list.map((x) => variationPrompt(shot, x)), [
    { prompt: 'Wide shot of a lone rider cresting a dune. Slow dolly-in. Neon glow.', base: 'fields' },
    { prompt: 'Wide shot of a lone rider cresting a dune. Slow dolly-in. Soft window light.', base: 'fields' },
  ]);
  // Case / spacing differences still count as "composed".
  assert.equal(variationPrompt({ ...shot, prompt: `  ${shot.prompt.toLowerCase()} ` }, list[0]).base, 'fields');
  assert.deepEqual(variationPrompt({ prompt: '', fields: {} }, variations({}, ['camera'], { camera: ['Orbit'] })[0]), { prompt: 'Orbit.', base: 'fields' });
  assert.deepEqual(variationPrompt(null, { fields: { mood: 'tense' }, changes: { mood: 'tense' } }), { prompt: 'Tense mood.', base: 'fields' });
});

test('“Continue from the last frame” works without a style guide and reads as sentences', () => {
  const cont = BUILTIN_TEMPLATES.find((t) => t.id === 'continue');
  const none = fillTemplate(cont, { next: 'she turns and runs toward the train' }, { bible: { style: '' } });
  assert.deepEqual(none.missing, []);
  assert.match(none.text, /from this exact frame: she turns and runs toward the train\. Keep the same/);
  assert.ok(none.text.endsWith('Visual style: identical to the previous shot.'), none.text);
  const styled = fillTemplate(cont, { next: 'she turns and runs.', style: 'noir, 35mm film' }, { bible: {} });
  assert.match(styled.text, /she turns and runs\. Keep/);
  assert.ok(styled.text.endsWith('Visual style: noir, 35mm film.'), styled.text);
  assert.ok(!/\.\.(?!\.)/.test(styled.text));
  // An ellipsis is kept; "?." loses the period.
  assert.match(fillTemplate('Then {{a}}. Why {{b}}.', { a: 'silence...', b: 'now?' }).text, /^Then silence\.\.\. Why now\?$/);
});
