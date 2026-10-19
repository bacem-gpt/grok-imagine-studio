// Prompt list import (parsePromptList) and export (exportPromptList).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePromptList, parsePromptListDetailed, exportPromptList, parseCsv, parseDuration, parseTimeSpan, FORMAT_LABELS } from '../../extension/studio/prompts/lists.js';

const prompts = (items) => items.map((i) => i.prompt);
const titles = (items) => items.map((i) => i.title);

test('numbered lists in every common style', () => {
  for (const text of ['1. A dog\n2. A cat\n3. A bird', '1) A dog\n2) A cat\n3) A bird', '(1) A dog\n(2) A cat\n(3) A bird', '#1 A dog\n#2 A cat\n#3 A bird', '1 - A dog\n2 - A cat\n3 - A bird']) {
    const r = parsePromptListDetailed(text);
    assert.equal(r.format, 'list', text);
    assert.deepEqual(prompts(r.items), ['A dog', 'A cat', 'A bird'], text);
  }
});

test('bullets, checkboxes and wrapped continuation lines', () => {
  assert.deepEqual(prompts(parsePromptList('- A dog\n* A cat\n• A bird\n– A fish\n+ A frog')), ['A dog', 'A cat', 'A bird', 'A fish', 'A frog']);
  assert.deepEqual(prompts(parsePromptList('- [ ] A dog\n- [x] A cat')), ['A dog', 'A cat']);
  assert.deepEqual(prompts(parsePromptList('1. A dog running\n   across the beach\n2. A cat')), ['A dog running across the beach', 'A cat']);
});

test('decimals and years are not list markers', () => {
  const items = parsePromptList('1.5 seconds of silence then a bang.\n2024 was the year of the dragon.');
  assert.deepEqual(prompts(items), ['1.5 seconds of silence then a bang.', '2024 was the year of the dragon.']);
});

test('Grok-style reply: preamble and outro dropped, bold titles extracted, shot terms kept in the prompt', () => {
  const text = `Here are 4 cinematic shot prompts for your sequence:

1. **The Arrival** — A lone rider crests a dune at dawn, dust trailing behind.
2. Close-up: the rider's eyes narrowing against the wind
3. Opening shot: A drone sweeps over the abandoned city
4. **Gates:** Wide shot of the rider entering the city gates, crowds parting.

Let me know if you want more variations!`;
  const items = parsePromptList(text);
  assert.equal(items.length, 4);
  assert.deepEqual(titles(items), ['The Arrival', '', '', 'Gates']);
  assert.equal(items[0].prompt, 'A lone rider crests a dune at dawn, dust trailing behind.');
  assert.equal(items[1].prompt, "Close-up: the rider's eyes narrowing against the wind");
  assert.equal(items[2].prompt, 'Opening shot: A drone sweeps over the abandoned city');
  assert.equal(items[3].prompt, 'Wide shot of the rider entering the city gates, crowds parting.');
});

test('colon and dash titles need short title-like heads', () => {
  const items = parsePromptList('1. Night Market: Vendors shout over sizzling woks\n2. A man walks - slowly - into the bar\n3. The Chase — Horses gallop through the canyon\n4. a quiet one: just rain');
  assert.deepEqual(titles(items), ['Night Market', '', 'The Chase', '']);
  assert.equal(items[1].prompt, 'A man walks - slowly - into the bar');
  assert.equal(items[3].prompt, 'a quiet one: just rain');
});

test('"Shot N:" / "Scene N -" labels with titles, field lines and durations', () => {
  const text = `Shot 1: The Arrival
Prompt: A lone rider crests the hill.
Camera: slow dolly-in
Duration: 6s
Notes: use the golden take

Scene 2 – Night Market: Vendors shout over sizzling woks while lanterns sway
Shot 3 - A quiet moment in the rain.
**Shot 4: Finale**
*Prompt:* The rider rides into the sunset.`;
  const items = parsePromptList(text);
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], { title: 'The Arrival', prompt: 'A lone rider crests the hill. Camera: slow dolly-in', duration: 6, notes: 'use the golden take' });
  assert.deepEqual(items[1], { title: 'Night Market', prompt: 'Vendors shout over sizzling woks while lanterns sway' });
  assert.deepEqual(items[2], { title: '', prompt: 'A quiet moment in the rain.' });
  assert.deepEqual(items[3], { title: 'Finale', prompt: 'The rider rides into the sunset.' });
});

test('Markdown headings with paragraphs below; nested field bullets', () => {
  const text = `# My storyboard

### Shot 1 — Arrival
A lone rider crests the hill.

### Shot 2
Horses gallop through the canyon.

1. **Opening – The Desert**
   - Prompt: Sand dunes ripple under a hot wind.
   - Lighting: harsh midday sun`;
  const items = parsePromptList(text);
  assert.deepEqual(
    items.map((i) => [i.title, i.prompt]),
    [
      ['Arrival', 'A lone rider crests the hill.'],
      ['', 'Horses gallop through the canyon.'],
      ['Opening – The Desert', 'Sand dunes ripple under a hot wind. Lighting: harsh midday sun'],
    ],
  );
});

test('a heading or bold line without body is itself the prompt', () => {
  assert.deepEqual(parsePromptList('## A storm rolls over the bay\n## Lightning hits the lighthouse'), [
    { title: '', prompt: 'A storm rolls over the bay' },
    { title: '', prompt: 'Lightning hits the lighthouse' },
  ]);
});

test('a single stray bullet inside prose is not a list', () => {
  const r = parsePromptListDetailed('A woman walks in the rain.\nA man runs.\n- extra note');
  assert.equal(r.format, 'lines');
  assert.equal(r.items.length, 3);
});

test('paragraph and line fallbacks; chatty lines removed', () => {
  const p = parsePromptListDetailed('Sure! Here you go:\n\nA fox in the snow,\nlooking up.\n\nA hawk circles above.\n\nHope this helps!');
  assert.equal(p.format, 'paragraphs');
  assert.deepEqual(prompts(p.items), ['A fox in the snow, looking up.', 'A hawk circles above.']);
  const l = parsePromptListDetailed('Prompts:\nA fox in the snow\nA hawk circles above');
  assert.equal(l.format, 'lines');
  assert.deepEqual(prompts(l.items), ['A fox in the snow', 'A hawk circles above']);
  const s = parsePromptListDetailed('  "A single quoted prompt."  ');
  assert.equal(s.format, 'single');
  assert.deepEqual(prompts(s.items), ['A single quoted prompt.']);
});

test('JSON: strings, objects with synonyms, wrappers, code fences', () => {
  assert.deepEqual(parsePromptList('["A dog", "A cat"]'), [
    { title: '', prompt: 'A dog' },
    { title: '', prompt: 'A cat' },
  ]);
  const objs = parsePromptList('[{"Title":"Arrival","Prompt":"A rider","duration":"6s","notes":"n"},{"name":"Chase","description":"Horses gallop"}]');
  assert.deepEqual(objs, [
    { title: 'Arrival', prompt: 'A rider', duration: 6, notes: 'n' },
    { title: 'Chase', prompt: 'Horses gallop' },
  ]);
  assert.deepEqual(prompts(parsePromptList('{"shots":[{"prompt":"x"},{"prompt":"y"}]}')), ['x', 'y']);
  assert.deepEqual(prompts(parsePromptList('Here:\n```json\n[{"title":"A","prompt":"x y z"},"plain"]\n```\nEnjoy')), ['x y z', 'plain']);
  // Objects without a prompt key: remaining text fields are joined.
  assert.deepEqual(prompts(parsePromptList('[{"shot":1,"subject":"a fox","action":"leaps"}]')), ['a fox. leaps']);
  assert.equal(parsePromptListDetailed('[not json').format !== 'json', true);
});

test('CSV / TSV with a prompt column, quotes and multi-line cells', () => {
  const r = parsePromptListDetailed('title,prompt,duration\nArrival,"A rider, at dawn",6\nChase,"Horses ""gallop""\nfast",10');
  assert.equal(r.format, 'csv');
  assert.deepEqual(r.items, [
    { title: 'Arrival', prompt: 'A rider, at dawn', duration: 6 },
    { title: 'Chase', prompt: 'Horses "gallop" fast', duration: 10 },
  ]);
  assert.deepEqual(prompts(parsePromptList('Prompt\tNotes\nA dog\tcute\nA cat\t')), ['A dog', 'A cat']);
  assert.deepEqual(prompts(parsePromptList('shot;prompt\n1;A dog\n2;A cat')), ['A dog', 'A cat']);
  // No prompt header -> not CSV.
  assert.notEqual(parsePromptListDetailed('a,b\nc,d').format, 'csv');
});

test('parseCsv edge cases', () => {
  assert.deepEqual(parseCsv('a,b\r\n"c,1","d""x"\n\n'), [
    ['a', 'b'],
    ['c,1', 'd"x'],
  ]);
  assert.deepEqual(parseCsv('a\tb', '\t'), [['a', 'b']]);
  assert.deepEqual(parseCsv(''), []);
});

test('Markdown tables pick the prompt column and ignore numeric shot columns', () => {
  const r = parsePromptListDetailed('| Shot | Title | Prompt | Duration |\n|---|:---|---:|---|\n| 1 | **Arrival** | A rider \\| at dawn | 6 s |\n| 2 | Chase | Horses gallop | |\n\nTrailing text');
  assert.equal(r.format, 'table');
  assert.deepEqual(r.items, [
    { title: 'Arrival', prompt: 'A rider | at dawn', duration: 6 },
    { title: 'Chase', prompt: 'Horses gallop' },
  ]);
  const noPrompt = parsePromptList('| # | Scene |\n|---|---|\n| 1 | A long description of a foggy harbour |\n| 2 | Ships leave at dawn |');
  assert.deepEqual(prompts(noPrompt), ['A long description of a foggy harbour', 'Ships leave at dawn']);
});

test('empty input and caps', () => {
  assert.deepEqual(parsePromptListDetailed(''), { items: [], format: 'empty' });
  assert.deepEqual(parsePromptListDetailed('   \n  '), { items: [], format: 'empty' });
  assert.deepEqual(parsePromptList(null), []);
  const many = Array.from({ length: 600 }, (_, i) => `${(i % 999) + 1}. prompt ${i}`).join('\n');
  assert.equal(parsePromptList(many).length, 500);
  assert.equal(FORMAT_LABELS.list, 'list');
});

test('parseDuration', () => {
  assert.equal(parseDuration('6'), 6);
  assert.equal(parseDuration('6s'), 6);
  assert.equal(parseDuration('6 seconds'), 6);
  assert.equal(parseDuration('0:06'), 6);
  assert.equal(parseDuration('1m 5s'), 65);
  assert.equal(parseDuration('about 10 sec long'), 10);
  assert.equal(parseDuration(4.5), 4.5);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(-3), null);
});

const SHOTS = [
  { title: 'Arrival', prompt: 'A rider, at dawn\nwith dust', duration: 6, status: 'sent', notes: '' },
  { title: '', prompt: 'Horses "gallop"', duration: 10, status: 'draft', notes: 'use take 2' },
];

test('exportPromptList: txt / md / csv / json shapes', () => {
  assert.equal(exportPromptList(SHOTS, 'txt'), '1. **Arrival** — A rider, at dawn with dust\n2. Horses "gallop"');
  const md = exportPromptList(SHOTS, 'md', { title: 'My film' });
  assert.ok(md.startsWith('# My film\n\n### 1. Arrival\n\nA rider, at dawn\nwith dust'));
  assert.ok(md.includes('*Duration: 6s · Status: sent*'));
  assert.ok(md.includes('### 2. Shot 2'));
  assert.ok(md.includes('> use take 2'));
  const csv = exportPromptList(SHOTS, 'csv');
  assert.equal(csv.split('\n')[0], 'shot,title,prompt,duration,notes,status');
  assert.equal(csv.split('\n')[2], '2,,"Horses ""gallop""",10,use take 2,draft');
  const json = JSON.parse(exportPromptList(SHOTS, 'json', { resolve: (s) => s.prompt.toUpperCase() }));
  assert.equal(json[0].expanded, 'A RIDER, AT DAWN\nWITH DUST');
  assert.equal(json[1].notes, 'use take 2');
  assert.equal(exportPromptList([], 'txt'), '');
  assert.equal(exportPromptList(null, 'json'), '[]');
});

test('exportPromptList uses the resolver (expanded prompts) for txt/md/csv', () => {
  const out = exportPromptList([{ title: '', prompt: '@Mara runs' }], 'txt', { resolve: () => 'Mara (a woman) runs' });
  assert.equal(out, '1. Mara (a woman) runs');
});

test('round trip: every export format parses back to the same titles and prompts', () => {
  const shots = [
    { title: 'Arrival', prompt: 'A rider crests the hill at dawn', duration: 6, status: 'sent' },
    { title: '', prompt: 'Horses gallop through a narrow canyon', duration: 10, notes: 'keep dust' },
    { title: 'The End', prompt: 'The rider rides into the sunset, credits roll', duration: 6 },
  ];
  for (const fmt of ['txt', 'md', 'csv', 'json']) {
    const items = parsePromptList(exportPromptList(shots, fmt));
    assert.deepEqual(
      items.map((i) => [i.title, i.prompt]),
      shots.map((s) => [s.title, s.prompt]),
      fmt,
    );
    if (fmt !== 'txt') assert.deepEqual(items.map((i) => i.duration), [6, 10, 6], fmt);
  }
});

test('chatty outro after a labelled item with a split title is dropped', () => {
  const items = parsePromptList("Here are 3 shots:\n\n1. **The Arrival** — A lone rider crests a dune.\n2. Close-up: eyes narrowing against the wind\n3. Shot 3: Gates — Wide shot of the rider entering the city gates.\n\nWant more?");
  assert.equal(items.length, 3);
  assert.deepEqual(items[2], { title: 'Gates', prompt: 'Wide shot of the rider entering the city gates.' });
  const labelled = parsePromptList('Shot 1 - A quiet moment in the rain.\nShot 2 - Thunder rolls over the hills.\n\nShall I write more?');
  assert.deepEqual(labelled.map((i) => i.prompt), ['A quiet moment in the rain.', 'Thunder rolls over the hills.']);
});

test('bold labels and titles from Grok / LLM replies leave no Markdown behind', () => {
  const cases = [
    ['**Shot 1: Opening drift** — a red sports car drifts around a neon-lit corner\n**Shot 2: Rooftop pursuit** — a figure sprints across wet rooftops', ['Opening drift', 'Rooftop pursuit']],
    ['**Shot 1: Opening drift:** a red sports car drifts around a neon-lit corner\n**Shot 2: Rooftop pursuit:** a figure sprints across wet rooftops', ['Opening drift', 'Rooftop pursuit']],
    ['1. **Shot 1 – Opening drift:** a red sports car drifts around a neon-lit corner\n2. **Shot 2 – Rooftop pursuit:** a figure sprints across wet rooftops', ['Opening drift', 'Rooftop pursuit']],
    ['**Shot 1: Opening drift**: a red sports car drifts around a neon-lit corner\n**Shot 2: Rooftop pursuit**: a figure sprints across wet rooftops', ['Opening drift', 'Rooftop pursuit']],
    ['- **Shot 1:** Opening drift — a red sports car drifts around a neon-lit corner\n- **Shot 2:** Rooftop pursuit — a figure sprints across wet rooftops', ['Opening drift', 'Rooftop pursuit']],
  ];
  for (const [text, want] of cases) {
    const items = parsePromptList(text);
    assert.deepEqual(titles(items), want, text);
    assert.deepEqual(prompts(items), ['a red sports car drifts around a neon-lit corner', 'a figure sprints across wet rooftops'], text);
    assert.ok(items.every((i) => !/[*_]{2}/.test(i.title + i.prompt)), text);
  }
});

test('bold numbered headings drop their list number; labelled bold headings their label', () => {
  const items = parsePromptList('**1. Opening Drift**\nA red sports car drifts around a neon-lit corner.\n\n**2. Rooftop Pursuit**\nA hooded figure sprints across wet rooftops.');
  assert.deepEqual(items, [
    { title: 'Opening Drift', prompt: 'A red sports car drifts around a neon-lit corner.' },
    { title: 'Rooftop Pursuit', prompt: 'A hooded figure sprints across wet rooftops.' },
  ]);
  const labelled = parsePromptList('**Shot 1 — The harbor**\nBoats rock in the swell.\n\n**Shot 2 (6-12s): The gulls**\nGulls lift off the pier.');
  assert.deepEqual(labelled, [
    { title: 'The harbor', prompt: 'Boats rock in the swell.' },
    { title: 'The gulls', prompt: 'Gulls lift off the pier.', duration: 6 },
  ]);
});

test('bold leads without a list marker need a separator; remarks and inline emphasis are not titles', () => {
  const items = parsePromptList('**The Arrival** — A lone rider crests a dune at dawn.\n**The City** — A drone sweeps over the abandoned city.\n**Note:** keep the same rider in every shot.');
  assert.deepEqual(items, [
    { title: 'The Arrival', prompt: 'A lone rider crests a dune at dawn.' },
    // "**Note:** …" is not a shot: it becomes the notes of the shot above.
    { title: 'The City', prompt: 'A drone sweeps over the abandoned city.', notes: 'keep the same rider in every shot.' },
  ]);
  const emphasis = parsePromptList('1. **Close-up** of the rider’s eyes narrowing\n2. **Wide** view of the dunes at dawn');
  assert.deepEqual(emphasis, [
    { title: '', prompt: 'Close-up of the rider’s eyes narrowing' },
    { title: '', prompt: 'Wide view of the dunes at dawn' },
  ]);
});

test('timecodes after a label become durations, not titles', () => {
  const items = parsePromptList('Shot 1 (0-6s): A red car drifts around a corner\nShot 2 (6–12 s): A hooded figure sprints across rooftops\nShot 3 [0:12-0:20] Rain hammers the windshield\nShot 4: Finale (4s) — The car stops at the edge of the pier');
  assert.deepEqual(items, [
    { title: '', prompt: 'A red car drifts around a corner', duration: 6 },
    { title: '', prompt: 'A hooded figure sprints across rooftops', duration: 6 },
    { title: '', prompt: 'Rain hammers the windshield', duration: 8 },
    { title: 'Finale', prompt: 'The car stops at the edge of the pier', duration: 4 },
  ]);
  // A bracket that is not a time stays where it was.
  assert.equal(parsePromptList('Shot 1 (take 2): A red car drifts around a corner')[0].duration, undefined);
});

test('parseTimeSpan', () => {
  assert.equal(parseTimeSpan('0-6s'), 6);
  assert.equal(parseTimeSpan('6 – 12 sec'), 6);
  assert.equal(parseTimeSpan('0:05-0:12'), 7);
  assert.equal(parseTimeSpan('10 to 15 seconds'), 5);
  assert.equal(parseTimeSpan('6s'), 6);
  assert.equal(parseTimeSpan('0:08'), 8);
  assert.equal(parseTimeSpan('6'), null); // bare numbers are not durations
  assert.equal(parseTimeSpan('12-6s'), null);
  assert.equal(parseTimeSpan('take 2'), null);
  assert.equal(parseTimeSpan(''), null);
});

test('a "Prompt:" / "Title:" field on the opening line of an item', () => {
  assert.deepEqual(parsePromptList('1. Prompt: Mara: walks into the neon bar and orders a drink\n2. Prompt: Rain on the window'), [
    { title: '', prompt: 'Mara: walks into the neon bar and orders a drink' },
    { title: '', prompt: 'Rain on the window' },
  ]);
  assert.deepEqual(parsePromptList('1. Title: Arrival\n   Prompt: A rider crests the hill\n2. Title: Exit\n   Prompt: The rider leaves'), [
    { title: 'Arrival', prompt: 'A rider crests the hill' },
    { title: 'Exit', prompt: 'The rider leaves' },
  ]);
});

test('round trip with tricky titles and untitled "Name: …" prompts (txt / Copy all included)', () => {
  const shots = [
    { title: 'Opening shot', prompt: 'A quiet harbor at dawn with fishing boats', duration: 6 },
    { title: 'The hero arrives at the old station', prompt: 'A train pulls into a foggy station at night', duration: 6 },
    { title: '', prompt: 'Mara: walks slowly into the neon bar and orders a drink', duration: 6 },
    { title: '', prompt: 'The Chase — Horses gallop through the canyon', duration: 6 },
    { title: 'Night: the escape', prompt: 'Close-up: eyes narrowing against the wind', duration: 6 },
    { title: '', prompt: 'She whispers "run" and turns toward the door', duration: 6 },
  ];
  for (const fmt of ['txt', 'md', 'csv', 'json']) {
    const items = parsePromptList(exportPromptList(shots, fmt));
    assert.deepEqual(
      items.map((i) => [i.title, i.prompt]),
      shots.map((s) => [s.title, s.prompt]),
      fmt,
    );
  }
  assert.match(exportPromptList(shots, 'txt'), /^3\. Prompt: Mara: walks/m);
  assert.match(exportPromptList(shots, 'txt'), /^1\. \*\*Opening shot\*\* — A quiet harbor/m);
});
