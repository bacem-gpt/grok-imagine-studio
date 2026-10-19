// Prompt Builder composition: structured fields -> natural, well punctuated prompt text for AI video (Grok Imagine).
//
// Fields are grouped into sentences:
//   scene  shot type + subject + action + setting   "Wide shot of a lone rider crossing the dunes at dusk."
//   camera camera movement, lens, motion, timing     "Slow dolly-in, 35mm lens, gentle motion."
//   light  lighting                                   "Golden hour sunlight."
//   look   style, mood, colour palette               "Cinematic, melancholic mood, teal and orange color palette."
//   audio  sound                                     "Sound: wind howling."
//   extra  free text                                 "No text or watermarks."
// `order` decides the order of the groups (by the first key of each group) and of the keys inside the non-scene
// groups. The scene sentence always reads shot -> subject -> action -> setting so the grammar stays natural.
// {{tokens}} and @Mentions pass through untouched (they are expanded later by tokens.js).

import { cleanPhrase, collapseSpaces, splitPhrases, capitalizeFirst, ensureSentence, uniq } from './text.js';

/** Builder fields in display order. `group` decides which sentence a field lands in. */
export const BUILDER_FIELDS = [
  { key: 'subject', label: 'Subject', group: 'scene', section: 'Scene', placeholder: 'who or what — e.g. @Mara, a courier in a rain-soaked red jacket' },
  { key: 'action', label: 'Action', group: 'scene', section: 'Scene', placeholder: 'what happens — e.g. sprinting across a rooftop' },
  { key: 'setting', label: 'Setting', group: 'scene', section: 'Scene', placeholder: 'where / when — e.g. in a neon-lit Tokyo alley at night' },
  { key: 'shot', label: 'Shot type', group: 'scene', section: 'Camera', placeholder: 'e.g. Wide shot' },
  { key: 'camera', label: 'Camera move', group: 'camera', section: 'Camera', placeholder: 'e.g. slow dolly-in' },
  { key: 'lens', label: 'Lens & focus', group: 'camera', section: 'Camera', placeholder: 'e.g. 35mm lens, shallow depth of field' },
  { key: 'motion', label: 'Motion', group: 'camera', section: 'Camera', placeholder: 'e.g. gentle natural movement, hair blowing in the wind' },
  { key: 'timing', label: 'Timing', group: 'camera', section: 'Camera', placeholder: 'e.g. slow motion, one continuous take' },
  { key: 'lighting', label: 'Lighting', group: 'light', section: 'Look', placeholder: 'e.g. golden hour backlight' },
  { key: 'style', label: 'Style', group: 'look', section: 'Look', placeholder: 'e.g. cinematic, photorealistic' },
  { key: 'mood', label: 'Mood', group: 'look', section: 'Look', placeholder: 'e.g. tense, suspenseful' },
  { key: 'palette', label: 'Colour palette', group: 'look', section: 'Look', placeholder: 'e.g. teal and orange' },
  { key: 'audio', label: 'Sound', group: 'audio', section: 'Sound & extras', placeholder: 'e.g. heavy rain, distant sirens, low synth drone' },
  { key: 'extra', label: 'Extra', group: 'extra', section: 'Sound & extras', placeholder: 'anything else — e.g. no text or watermarks' },
];

export const FIELD_KEYS = BUILDER_FIELDS.map((f) => f.key);
const FIELD_BY_KEY = Object.fromEntries(BUILDER_FIELDS.map((f) => [f.key, f]));

/** Default composition order (scene first). */
export const DEFAULT_ORDER = ['shot', 'subject', 'action', 'setting', 'camera', 'lens', 'motion', 'timing', 'lighting', 'style', 'mood', 'palette', 'audio', 'extra'];

/** Order presets offered by the builder. */
export const ORDER_PRESETS = [
  { id: 'scene', label: 'Scene first', order: DEFAULT_ORDER },
  { id: 'style', label: 'Style first', order: ['style', 'mood', 'palette', 'shot', 'subject', 'action', 'setting', 'camera', 'lens', 'motion', 'timing', 'lighting', 'audio', 'extra'] },
  { id: 'camera', label: 'Camera first', order: ['camera', 'lens', 'motion', 'timing', 'shot', 'subject', 'action', 'setting', 'lighting', 'style', 'mood', 'palette', 'audio', 'extra'] },
];

/** Fields whose values are phrase lists (normalised and de-duplicated); the others are free text. */
const LIST_FIELDS = new Set(['shot', 'camera', 'lens', 'motion', 'timing', 'lighting', 'style', 'mood', 'palette', 'audio']);

/** Appends a noun to bare adjective lists ("melancholic" -> "melancholic mood") unless the text already has one. */
const SUFFIX_RULES = {
  lighting: {
    test: /\b(light|lights|lit|lighting|glow\w*|shadows?|sun\w*|neon|silhouett\w*|backlit|backlight\w*|candle\w*|lamps?|flash\w*|moon\w*|fire\w*|strobe\w*|haz[ey]|rays|chiaroscuro|illuminat\w*|spotlight\w*|lightning|headlights?|bioluminescen\w*|lanterns?|torch\w*)\b/i,
    suffix: ' lighting',
  },
  mood: { test: /\b(mood|moods|atmosphere\w*|feel|feeling|vibes?|tone|ambien[cs]e|energy|emotion\w*)\b/i, suffix: ' mood' },
  palette: {
    test: /\b(palette|colou?rs?|colou?red|tones?|toned|hues?|monochrom\w*|black[- ]and[- ]white|gr[ae]yscale|sepia|saturat\w*|desaturat\w*|duotone|contrast|technicolor|bleach\w*|pastels?|neutrals?)\b/i,
    suffix: ' color palette',
  },
  style: {
    test: /\b(style|styled|look|aesthetic|film|films|footage|render|renders|rendering|animation|photo|photos|photograph|photography|painting|illustration|cgi|documentary|art|artwork|vlog|commercial|ad|video|cartoon|claymation|comic|movie|blockbuster|trailer|sketch|drawing|print|detail|details|camcorder|vhs|tale|world)\b/i,
    suffix: ' style',
  },
};

const PREPOSITIONS = new Set(
  (
    'in on at inside outside under beneath below above over across through along near beside by amid amidst among within beyond behind between ' +
    'against around atop onto into from during underneath throughout toward towards past upon off aboard alongside while as where before after ' +
    'overlooking surrounded somewhere deep high far up down out next'
  ).split(' '),
);

const NOT_GERUNDS = new Set(['thing', 'king', 'ring', 'wing', 'sing', 'spring', 'string', 'sting', 'swing', 'bring', 'sling', 'something', 'nothing', 'everything', 'anything', 'morning', 'evening', 'ceiling', 'building', 'during', 'ping', 'ding', 'darling', 'sibling', 'duckling', 'ending', 'wedding', 'painting', 'clothing', 'lightning', 'king', 'viking', 'stocking', 'pudding']);

/** True when the phrase starts with an -ing verb ("walking toward…"), i.e. it can follow "Wide shot of <subject>". */
export function startsWithGerund(phrase) {
  const first = (/^[\p{L}'-]+/u.exec(String(phrase || '').trim()) || [''])[0].toLowerCase();
  return first.length > 4 && first.endsWith('ing') && !NOT_GERUNDS.has(first);
}

function startsWithPreposition(phrase) {
  const first = (/^[\p{L}'-]+/u.exec(String(phrase || '').trim()) || [''])[0].toLowerCase();
  return PREPOSITIONS.has(first);
}

/** "A lone rider" -> "a lone rider" (only leading articles are lower-cased; names stay capitalised). */
function lowerArticle(phrase) {
  return phrase.replace(/^(A|An|The)\b(?=\s)/, (m) => m.toLowerCase());
}

/** Text of one field: phrase lists are cleaned, de-duplicated and comma-joined; free-text fields are cleaned. */
export function fieldText(key, value) {
  if (value == null) return '';
  if (LIST_FIELDS.has(key)) {
    const seen = new Set();
    const parts = [];
    for (const p of splitPhrases(value)) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      parts.push(p);
    }
    return parts.join(', ');
  }
  if (Array.isArray(value)) return value.map(cleanPhrase).filter(Boolean).join(', ');
  return cleanPhrase(value);
}

function withSuffix(key, text) {
  const rule = SUFFIX_RULES[key];
  if (!text || !rule || rule.test.test(text)) return text;
  // Phrases that are only tokens (e.g. "{{style}}") are left alone.
  if (/^(\{\{[^}]*\}\}|@[\p{L}\p{N}_-]+)$/u.test(text)) return text;
  return text + rule.suffix;
}

/**
 * A field value as composePrompt writes it inside its sentence: "golden hour" -> "golden hour lighting",
 * setting "a misty forest" -> "in a misty forest".
 */
export function fieldPhrase(key, value) {
  const text = fieldText(key, value);
  return key === 'setting' ? settingText(text) : withSuffix(key, text);
}

function audioSentence(text) {
  if (!text) return '';
  if (/^(sound|sounds|audio|music|musical|silence|silent|no\b|ambient|ambience|dialogue|voice|voices|narrat\w*|the sound|soundtrack|score|sfx|\{\{|@)/i.test(text)) return text;
  return `Sound: ${text}`;
}

/** A setting as it reads after the subject: "a misty forest" -> "in a misty forest" (prepositions / tokens kept). */
function settingText(setting) {
  if (setting && !startsWithPreposition(setting) && !/^[,(]/.test(setting) && !/^(\{\{|@)/.test(setting)) return `in ${setting}`;
  return setting;
}

/** Scene sentence(s) from shot type, subject, action and setting. Returns an array of sentences. */
function sceneSentences(f) {
  const shot = f.shot || '';
  let subject = f.subject || '';
  const action = f.action || '';
  let setting = settingText(f.setting || '');
  const tail = (s) => (setting ? `${s} ${setting}` : s);
  if (!shot) {
    const core = [subject, action].filter(Boolean).join(' ');
    return [core ? tail(core) : setting].filter(Boolean);
  }
  if (!subject && !action) return [shot, setting ? capitalizeFirst(setting) : ''].filter(Boolean);
  if (!subject) {
    // "Close-up. Hands kneading dough on a floured table."
    return [shot, capitalizeFirst(tail(action))];
  }
  subject = lowerArticle(subject);
  if (!action || startsWithGerund(action) || /^(who|that|with|while|as)\b/i.test(action)) {
    const joiner = /\bof$/i.test(shot) || /^of\b/i.test(subject) ? ' ' : ' of ';
    return [tail(shot + joiner + [subject, action].filter(Boolean).join(' '))];
  }
  // Finite verb ("walks into the bar"): keep the shot type as its own short sentence.
  return [shot, capitalizeFirst(tail(`${subject} ${action}`))];
}

/** Group id of a key (custom keys get their own group so they become separate sentences). */
const groupOf = (key) => FIELD_BY_KEY[key]?.group || `custom:${key}`;

/**
 * Composes structured builder fields into natural prompt text.
 * @param {Object<string, string|string[]>} fields  values keyed by BUILDER_FIELDS keys (custom keys allowed)
 * @param {string[]} [order]  composition order; keys missing from it are appended in DEFAULT_ORDER, then custom keys
 * @returns {string}
 */
export function composePrompt(fields = {}, order = DEFAULT_ORDER) {
  const src = fields && typeof fields === 'object' ? fields : {};
  const keys = uniq([
    ...(Array.isArray(order) ? order : []),
    ...DEFAULT_ORDER,
    ...Object.keys(src).filter((k) => !k.startsWith('_')),
  ]).filter((k) => typeof k === 'string' && !k.startsWith('_'));
  const text = {};
  for (const k of keys) text[k] = fieldText(k, src[k]);

  // Group keys by sentence, groups ordered by first appearance.
  const groups = new Map();
  for (const k of keys) {
    if (!text[k]) continue;
    const g = groupOf(k);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(k);
  }

  const sentences = [];
  for (const [g, gkeys] of groups) {
    if (g === 'scene') {
      sentences.push(...sceneSentences(text));
    } else if (g === 'audio') {
      sentences.push(audioSentence(gkeys.map((k) => text[k]).join(', ')));
    } else if (g === 'extra' || g.startsWith('custom:')) {
      for (const k of gkeys) sentences.push(text[k]);
    } else {
      sentences.push(gkeys.map((k) => withSuffix(k, text[k])).join(', '));
    }
  }
  return collapseSpaces(
    sentences
      .map((s) => collapseSpaces(s))
      .filter(Boolean)
      .map((s) => ensureSentence(capitalizeFirst(s)))
      .join(' '),
  )
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;])\1+/g, '$1');
}

/** True when at least one builder field has a value. */
export function hasFields(fields) {
  if (!fields || typeof fields !== 'object') return false;
  return Object.entries(fields).some(([k, v]) => !k.startsWith('_') && fieldText(k, v));
}

/** Returns a copy of `fields` without empty values (keeps the stored shape compact). */
export function compactFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (k.startsWith('_')) continue;
    const s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    if (s.trim()) out[k] = s;
  }
  return out;
}

/** Order preset by id (falls back to the default order). */
export const orderFor = (id) => (ORDER_PRESETS.find((o) => o.id === id) || ORDER_PRESETS[0]).order;
