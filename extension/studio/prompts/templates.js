// Meta-prompt templates: texts the user sends to Grok *chat* to generate material (shot lists, character sheets,
// continuations, storyboards). Templates use {{variable|default}} placeholders plus the usual @Bible mentions and
// {{style}}. Pure: no DOM.

import { expandTokens } from './tokens.js';
import { tokenKey, collapseSpaces } from './text.js';
import { uid } from '../core/utils.js';

/** Variables the UI fills automatically from context (current shot, bible) when left empty. */
export const CONTEXT_VARIABLES = ['prompt', 'style', 'character', 'location'];

/**
 * Built-in templates. `fields` gives labels / hints for variables; any other {{variable}} in the text is detected
 * automatically. `attach` tells the UI what to attach before sending ('reference' = shot reference images).
 */
export const BUILTIN_TEMPLATES = [
  {
    id: 'shot-list',
    name: 'Shot list from a topic',
    category: 'Plan',
    description: 'Ask Grok for a numbered list of cinematic shot prompts you can import as shots.',
    template:
      'Write {{count|6}} cinematic shot prompts for a short video sequence about {{topic}}. ' +
      'Keep {{character|the main character}} visually consistent in every shot (same face, hair, clothes and colours). ' +
      'Visual style: {{style|cinematic, photorealistic}}. ' +
      'Each prompt must describe the subject, the action, the setting, the shot type, the camera movement, the lighting and the sound in one or two sentences, ' +
      'written for an AI video generator that makes {{duration|6}}-second clips. ' +
      'Reply with a numbered list only, one prompt per line, no titles and no commentary.',
    fields: [
      { key: 'topic', label: 'Topic / story', placeholder: 'a courier racing through a flooded cyberpunk city', multiline: true },
      { key: 'count', label: 'Number of shots', placeholder: '6' },
      { key: 'character', label: 'Character to keep consistent', placeholder: '@Mara or a description' },
      { key: 'style', label: 'Style', placeholder: 'cinematic, photorealistic' },
      { key: 'duration', label: 'Clip length (s)', placeholder: '6' },
    ],
  },
  {
    id: 'storyboard',
    name: 'Story → storyboard',
    category: 'Plan',
    description: 'Turn a story or script into titled shots ("Shot N: Title — prompt"), ready to import.',
    template:
      'Turn this story into a storyboard of {{count|8}} shots for a {{total|60}}-second video. ' +
      'For each shot give a short title and a detailed visual prompt for an AI video generator (subject, action, setting, shot type, camera movement, lighting, mood and sound). ' +
      'Keep characters and locations consistent from shot to shot. Style: {{style|cinematic}}. ' +
      'Format every line exactly as: Shot N: Title — prompt\n\nStory:\n{{story}}',
    fields: [
      { key: 'story', label: 'Story / script', placeholder: 'Paste your story, script or outline…', multiline: true },
      { key: 'count', label: 'Number of shots', placeholder: '8' },
      { key: 'total', label: 'Total length (s)', placeholder: '60' },
      { key: 'style', label: 'Style', placeholder: 'cinematic' },
    ],
  },
  {
    id: 'continue',
    name: 'Continue from the last frame',
    category: 'Shot',
    description: 'Attach the last frame of a clip (Clips → "Last frame → Grok"), then send this to continue the shot seamlessly.',
    template:
      'The attached image is the last frame of the previous shot. Continue the action seamlessly from this exact frame: {{next}}. ' +
      'Keep the same character, wardrobe, setting, lighting, colour grade and camera style so the cut is invisible. ' +
      'Visual style: {{style|identical to the previous shot}}.',
    fields: [
      { key: 'next', label: 'What happens next', placeholder: 'she turns and runs toward the train as the doors close', multiline: true },
      { key: 'style', label: 'Style (optional)', placeholder: 'uses the bible style guide when it has one' },
    ],
  },
  {
    id: 'character-sheet',
    name: 'Reference image → character sheet',
    category: 'Reference',
    description: 'Attach a reference image; Grok describes the character as reusable text for your bible.',
    attach: 'reference',
    template:
      'Describe the person in the attached image as a reusable character sheet for AI image and video prompts. ' +
      'Cover apparent age, face shape, eyes, hair (style, length, colour), skin, build, clothing, accessories and distinctive features. ' +
      'Write it as ONE dense paragraph of comma-separated visual descriptors (no names, no story) that I can paste into every prompt to keep {{name|the character}} consistent.',
    fields: [{ key: 'name', label: 'Character name', placeholder: 'Mara' }],
  },
  {
    id: 'location-sheet',
    name: 'Reference image → location sheet',
    category: 'Reference',
    description: 'Describe a place as a reusable setting description (for @Location tokens).',
    attach: 'reference',
    template:
      'Describe the location in the attached image as a reusable setting description for AI video prompts: architecture or landscape, materials, scale, time of day, weather, lighting, colour palette and atmosphere. ' +
      'One dense paragraph of visual descriptors, no story. Call it {{name|the location}}.',
    fields: [{ key: 'name', label: 'Location name', placeholder: 'Neon Alley' }],
  },
  {
    id: 'improve',
    name: 'Improve a prompt',
    category: 'Refine',
    description: 'Ask Grok to rewrite the current shot prompt more vividly (camera, light, sound).',
    template:
      'Rewrite this AI video prompt to be more vivid and cinematic while keeping its meaning and subject. ' +
      'Add specific camera movement, lens, lighting and sound details, keep it under {{words|80}} words, and reply with the improved prompt only:\n\n{{prompt}}',
    fields: [
      { key: 'prompt', label: 'Prompt', placeholder: 'defaults to the selected shot', multiline: true },
      { key: 'words', label: 'Max words', placeholder: '80' },
    ],
  },
  {
    id: 'variations',
    name: 'Variations of a shot',
    category: 'Refine',
    description: 'Get alternative versions of the selected shot to generate several takes.',
    template:
      'Give me {{count|5}} distinct variations of this AI video prompt. Change {{vary|the camera angle, movement and lighting}} but keep the subject, action and setting identical. ' +
      'Numbered list, one full prompt per line, no commentary:\n\n{{prompt}}',
    fields: [
      { key: 'prompt', label: 'Prompt', placeholder: 'defaults to the selected shot', multiline: true },
      { key: 'count', label: 'How many', placeholder: '5' },
      { key: 'vary', label: 'What to vary', placeholder: 'the camera angle, movement and lighting' },
    ],
  },
  {
    id: 'music-video',
    name: 'Music video beats',
    category: 'Plan',
    description: 'Plan shots that cut on the beat of a song.',
    template:
      'Plan {{count|10}} shots for a music video. The song: {{song}}. Tempo: {{bpm|about 120}} BPM. ' +
      'Each shot should last {{duration|6}} seconds or less, cut on the beat and build energy toward the chorus. ' +
      'For each shot write one AI video prompt with subject, action, setting, camera movement and lighting. Style: {{style|music video, neon}}. Numbered list only.',
    fields: [
      { key: 'song', label: 'Song / vibe', placeholder: 'dreamy synth-pop about a summer night drive', multiline: true },
      { key: 'count', label: 'Number of shots', placeholder: '10' },
      { key: 'bpm', label: 'Tempo (BPM)', placeholder: '120' },
      { key: 'style', label: 'Style', placeholder: 'music video, neon' },
      { key: 'duration', label: 'Max shot length (s)', placeholder: '6' },
    ],
  },
  {
    id: 'dialogue',
    name: 'Dialogue scene',
    category: 'Plan',
    description: 'Shot/reverse-shot prompts with spoken lines (Grok Imagine can generate speech).',
    template:
      'Write {{count|4}} shot prompts for a short dialogue scene between {{characters}} about {{topic}}. ' +
      'Alternate shot / reverse shot and close-ups. In each prompt include the spoken line in quotes, the delivery (tone, emotion) and the ambient sound. ' +
      'Setting: {{setting|a quiet diner at night}}. Numbered list, one prompt per line.',
    fields: [
      { key: 'characters', label: 'Characters', placeholder: '@Mara and @Jonah' },
      { key: 'topic', label: 'What they talk about', placeholder: 'a secret she has been keeping' },
      { key: 'setting', label: 'Setting', placeholder: 'a quiet diner at night' },
      { key: 'count', label: 'Number of shots', placeholder: '4' },
    ],
  },
  {
    id: 'image-prompt',
    name: 'Reference image prompt',
    category: 'Reference',
    description: 'Write a text-to-image prompt for a clean character/prop reference (an ingredient).',
    template:
      'Write a detailed text-to-image prompt for a clean reference image of {{subject}}: full body, front view, neutral pose, plain light-grey background, soft even studio lighting, sharp focus, no text. ' +
      'Style: {{style|photorealistic}}. Reply with the prompt only.',
    fields: [
      { key: 'subject', label: 'Subject', placeholder: 'a courier in a red rain jacket with a cybernetic arm', multiline: true },
      { key: 'style', label: 'Style', placeholder: 'photorealistic' },
    ],
  },
];

const VAR_SCAN = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;

/**
 * Variables of a template text in order of first appearance: [{key, name, default}] (key = tokenKey(name)).
 * @param {string} template
 */
export function templateVariables(template) {
  const out = [];
  const seen = new Set();
  for (const m of String(template ?? '').matchAll(VAR_SCAN)) {
    const key = tokenKey(m[1]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name: m[1].trim(), default: m[2] != null ? m[2] : null });
  }
  return out;
}

/** Form fields for a template: declared fields first, then auto-detected variables (labelled from their names). */
export function templateFields(tpl) {
  const vars = templateVariables(tpl?.template);
  const declared = Array.isArray(tpl?.fields) ? tpl.fields : [];
  const byKey = new Map(declared.map((f) => [tokenKey(f.key), f]));
  const ordered = [];
  for (const f of declared) {
    const v = vars.find((x) => x.key === tokenKey(f.key));
    ordered.push({ ...f, key: tokenKey(f.key), default: v?.default ?? f.default ?? null });
  }
  for (const v of vars) {
    if (byKey.has(v.key)) continue;
    const label = v.name.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    ordered.push({ key: v.key, label, placeholder: v.default || '', default: v.default });
  }
  return ordered;
}

/**
 * Fills a template.
 * @param {string|{template:string}} template
 * @param {Object<string,string>} values   form values keyed by variable name
 * @param {{bible?: object, snippets?: Array}} [ctx]
 * @returns {{text: string, missing: string[], unknown: string[]}}  missing = variables with no value and no default
 */
export function fillTemplate(template, values = {}, ctx = {}) {
  const text = typeof template === 'string' ? template : template?.template || '';
  const vals = {};
  for (const [k, v] of Object.entries(values || {})) {
    const s = v == null ? '' : String(v);
    if (s.trim()) vals[tokenKey(k)] = s.trim();
  }
  const missing = [];
  for (const v of templateVariables(text)) {
    if (vals[v.key] || v.default != null) continue;
    // Context fallbacks resolved by token expansion count as filled.
    if (v.key === 'style' && String(ctx.bible?.style || '').trim()) continue;
    if (v.key === 'notes' && String(ctx.bible?.notes || '').trim()) continue;
    const snippet = (ctx.snippets || []).some((s) => tokenKey(s?.title) === v.key);
    const entry = ['characters', 'locations'].some((kind) => (ctx.bible?.[kind] || []).some((e) => tokenKey(e?.name) === v.key));
    if (snippet || entry) continue;
    missing.push(v.name);
  }
  const res = expandTokens(text, { bible: ctx.bible, snippets: ctx.snippets, variables: vals });
  const unknown = res.unknown.filter((u) => !missing.some((m) => u === `{{${m}}}`));
  // A value that ends a sentence itself ("she runs." + ".") must not leave doubled punctuation (an ellipsis stays).
  const out = res.text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\.{4,}/g, '...')
    .replace(/(^|[^.])\.\.(?!\.)/g, '$1.')
    .replace(/([!?…])\.(?!\.)/g, '$1')
    .trim();
  return { text: out, missing, unknown };
}

/** Creates a user template record for libraryStore.templates. */
export function createTemplate({ id, name, template, fields = [] } = {}) {
  return {
    id: id || uid('tpl'),
    name: collapseSpaces(name) || 'My template',
    template: String(template ?? ''),
    fields: Array.isArray(fields) ? fields : [],
  };
}
