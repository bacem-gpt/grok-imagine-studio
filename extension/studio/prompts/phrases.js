// Quick phrases: short reusable prompt fragments ("nobody speaks", "camera angle from top"…) that are toggled into a
// shot's prompt with one click, plus named phrase sets that add several at once. The user's phrases and sets are
// global (libraryStore.phrases / libraryStore.phraseSets) so they serve every project; PREPARED_PHRASES is the
// built-in library they can pick from. Pure: no DOM; importable from Node unit tests.
//
// Phrase    { id, text, category, auto: boolean (added to every new shot), createdAt }
// PhraseSet { id, name, texts: string[], createdAt }

import { uid } from '../core/utils.js';
import { collapseSpaces, capitalizeFirst } from './text.js';

export const PHRASE_CATEGORIES = [
  { id: 'dialogue', label: 'Dialogue & voice' },
  { id: 'angle', label: 'Camera angle' },
  { id: 'movement', label: 'Camera movement' },
  { id: 'framing', label: 'Framing' },
  { id: 'acting', label: 'Acting & people' },
  { id: 'continuity', label: 'Continuity' },
  { id: 'sound', label: 'Sound & music' },
  { id: 'look', label: 'Look & light' },
  { id: 'pace', label: 'Pace & timing' },
  { id: 'avoid', label: 'Quality & avoid' },
  { id: 'other', label: 'Other' },
];
export const CATEGORY_IDS = PHRASE_CATEGORIES.map((c) => c.id);
export const categoryLabel = (id) => PHRASE_CATEGORIES.find((c) => c.id === id)?.label || 'Other';

const p = (category, ...texts) => texts.map((text) => ({ category, text }));

/** Built-in phrase library (users add the ones they like to their own list). */
export const PREPARED_PHRASES = [
  ...p(
    'dialogue',
    'nobody speaks',
    'no dialogue, only ambient sound',
    'the character speaks directly to the camera',
    'the two characters talk to each other',
    'clear lip-synced speech',
    'the dialogue is spoken calmly',
    'the dialogue is shouted',
    'whispered dialogue',
    'off-screen narrator voice-over',
    'only the main character speaks',
    'speaks in English',
    'speaks in French',
    'speaks in Spanish',
    'speaks in Arabic',
    'the character stays silent and listens',
  ),
  ...p(
    'angle',
    'camera angle from top',
    'top-down overhead view',
    'low angle from below',
    'high angle looking down',
    'eye-level camera',
    "bird's-eye view",
    "worm's-eye view",
    'over-the-shoulder shot',
    'point-of-view shot',
    'side profile view',
    'dutch angle',
    'front view facing the camera',
    'view from behind the character',
  ),
  ...p(
    'movement',
    'static camera',
    'slow push-in',
    'slow pull-out',
    'slow pan from left to right',
    'tracking shot following the character',
    'handheld camera',
    'smooth steadicam',
    'orbit around the subject',
    'drone shot rising up',
    'crane shot descending',
    'slow zoom in on the face',
    'whip pan',
    'camera does not move',
  ),
  ...p(
    'framing',
    'close-up on the face',
    'extreme close-up',
    'medium shot',
    'wide shot',
    'full body shot',
    'two-shot with both characters in frame',
    'the subject is centered',
    'rule of thirds composition',
    'vertical 9:16 framing',
    'widescreen cinematic framing',
  ),
  ...p(
    'acting',
    'natural facial expressions',
    'subtle emotions',
    'the character smiles',
    'the character looks worried',
    'the character walks toward the camera',
    'the character turns around slowly',
    'natural hand gestures while talking',
    'eye contact with the camera',
    'no one else in the scene',
    'people in the background',
  ),
  ...p(
    'continuity',
    'same character as in the previous video',
    'same outfit and hairstyle as before',
    'same location as the previous shot',
    'continue from the last frame',
    'same lighting as the previous shot',
    'keep the face consistent',
    'the scene continues without a cut',
  ),
  ...p(
    'sound',
    'no music',
    'soft background music',
    'cinematic orchestral music',
    'ambient city sounds',
    'ambient nature sounds',
    'footsteps and room tone',
    'silence',
    'dramatic sound effects',
  ),
  ...p(
    'look',
    'cinematic look',
    'photorealistic',
    'golden hour light',
    'soft natural light',
    'night scene with neon lights',
    'warm colors',
    'cool blue tones',
    'shallow depth of field',
    'film grain',
    'black and white',
    'anime style',
    '3D animation style',
  ),
  ...p(
    'pace',
    'slow motion',
    'real-time speed',
    'the action lasts the whole clip',
    'slow and calm pacing',
    'fast-paced action',
    'one continuous shot',
    'ends on a still frame',
  ),
  ...p(
    'avoid',
    'no text on screen',
    'no subtitles',
    'no watermark',
    'no logos',
    'no camera shake',
    'no morphing or distortion',
    'stable anatomy, natural hands',
    'no sudden cuts',
    'high detail, sharp focus',
  ),
];

/** A short starter list offered on an empty phrase board. */
export const STARTER_PHRASES = [
  'nobody speaks',
  'the character speaks directly to the camera',
  'camera angle from top',
  'low angle from below',
  'close-up on the face',
  'static camera',
  'slow push-in',
  'same character as in the previous video',
  'continue from the last frame',
  'no music',
  'cinematic look',
  'no text on screen',
  'no subtitles',
].map((text) => PREPARED_PHRASES.find((x) => x.text === text));

/** Display/storage form of a phrase: one line, single spaces, no trailing sentence punctuation. */
export const cleanPhraseText = (text) =>
  collapseSpaces(String(text ?? '').replace(/[\r\n]+/g, ' '))
    .replace(/^[\s,.;:]+|[\s,.;:!?]+$/g, '')
    .trim();

const keyOf = (text) => cleanPhraseText(text).toLowerCase();

/** Creates a phrase record. */
export function createPhrase({ text = '', category = 'other', auto = false } = {}) {
  return { id: uid('phr'), text: cleanPhraseText(text), category: CATEGORY_IDS.includes(category) ? category : 'other', auto: !!auto, createdAt: Date.now() };
}

/** Index of the phrase with the same text (case-insensitive), or -1. */
export const findPhraseIndex = (list, text) => (Array.isArray(list) ? list : []).findIndex((x) => keyOf(x.text) === keyOf(text));

/**
 * Adds a phrase (or several) unless the same text exists already. Returns the new list (the same array when
 * nothing was added).
 */
export function addPhrases(list, partials) {
  const arr = Array.isArray(list) ? list : [];
  const next = arr.slice();
  for (const part of Array.isArray(partials) ? partials : [partials]) {
    const ph = part?.id && part.text ? part : createPhrase(part || {});
    if (!ph.text || findPhraseIndex(next, ph.text) >= 0) continue;
    next.push(ph);
  }
  return next.length === arr.length ? arr : next;
}

/** Patches a phrase by id (text is cleaned; a text that duplicates another phrase is refused). */
export function updatePhrase(list, id, patch) {
  const arr = Array.isArray(list) ? list : [];
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0 || !patch) return arr;
  const next = { ...arr[i], ...patch, id };
  if ('text' in patch) {
    next.text = cleanPhraseText(patch.text);
    if (!next.text) return arr;
    const dup = findPhraseIndex(arr, next.text);
    if (dup >= 0 && dup !== i) return arr;
  }
  if ('category' in patch && !CATEGORY_IDS.includes(next.category)) next.category = 'other';
  const copy = arr.slice();
  copy[i] = next;
  return copy;
}

export const removePhrase = (list, id) => (Array.isArray(list) ? list.filter((x) => x.id !== id) : []);

/** Moves a phrase to `toIndex` (its final position, clamped). */
export function movePhrase(list, id, toIndex) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const from = arr.findIndex((x) => x.id === id);
  if (from < 0) return arr;
  const [item] = arr.splice(from, 1);
  arr.splice(Math.max(0, Math.min(arr.length, toIndex)), 0, item);
  return arr;
}

/** Phrases grouped by category in PHRASE_CATEGORIES order (empty categories left out): [{id, label, items}]. */
export function groupPhrases(list) {
  const arr = Array.isArray(list) ? list : [];
  return PHRASE_CATEGORIES.map((c) => ({ ...c, items: arr.filter((x) => (CATEGORY_IDS.includes(x.category) ? x.category : 'other') === c.id) })).filter((g) => g.items.length);
}

// ---------------------------------------------------------------------------------------------------------
// Phrases inside a free-text prompt
// ---------------------------------------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '\\p{L}\\p{N}';

function phraseRegex(phrase) {
  const words = cleanPhraseText(phrase).split(' ').filter(Boolean).map(escapeRe);
  if (!words.length) return null;
  // Whole words, any case, any run of spaces between them.
  return new RegExp(`(^|[^${WORD}])(${words.join('\\s+')})(?![${WORD}])`, 'iu');
}

/** True when the prompt contains the phrase (whole words, case-insensitive). */
export function promptHasPhrase(prompt, phrase) {
  const re = phraseRegex(phrase);
  return !!re && re.test(String(prompt ?? ''));
}

/** Cleans up the separators left behind after removing a phrase. */
export function tidyPrompt(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]+/g, ' ')
        .replace(/\s+([.,;!?])/g, '$1')
        .replace(/([,;])(\s*[,;.])+/g, (m, a) => (m.includes('.') ? '.' : a))
        .replace(/\.(\s*\.)+/g, '.')
        .replace(/^[\s,;.]+/, '')
        .replace(/[\s,;]+$/, '')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes every occurrence of the phrase (and the separator that followed it) from the prompt. */
export function removePhraseFromPrompt(prompt, phrase) {
  const re = phraseRegex(phrase);
  let s = String(prompt ?? '');
  if (!re) return s;
  for (let guard = 0; guard < 20; guard++) {
    const m = re.exec(s);
    if (!m) break;
    const start = m.index + m[1].length;
    let end = start + m[2].length;
    while (end < s.length && /[.,;!?]/.test(s[end])) end++;
    s = s.slice(0, start) + s.slice(end);
  }
  return tidyPrompt(s);
}

/**
 * Appends a phrase to the prompt. join 'sentence': "…sunset. Nobody speaks." ; 'comma': "…sunset, nobody speaks".
 * Returns the prompt unchanged when it already contains the phrase.
 */
export function addPhraseToPrompt(prompt, phrase, { join = 'sentence' } = {}) {
  const text = cleanPhraseText(phrase);
  const cur = String(prompt ?? '').replace(/\s+$/, '');
  if (!text || promptHasPhrase(cur, text)) return String(prompt ?? '');
  if (!cur.trim()) return join === 'sentence' ? `${capitalizeFirst(text)}.` : text;
  if (join === 'comma') return /[.!?]$/.test(cur) ? `${cur} ${capitalizeFirst(text)}` : `${cur.replace(/[,;:]$/, '')}, ${text}`;
  const base = /[.!?…"”)]$/.test(cur) ? cur : `${cur.replace(/[,;:]$/, '')}.`;
  return `${base} ${capitalizeFirst(text)}.`;
}

/** Adds the phrase when missing, removes it when present. */
export function togglePhraseInPrompt(prompt, phrase, opts) {
  return promptHasPhrase(prompt, phrase) ? removePhraseFromPrompt(prompt, phrase) : addPhraseToPrompt(prompt, phrase, opts);
}

/** Adds several phrases (missing ones only). */
export function addPhrasesToPrompt(prompt, phrases, opts) {
  return (phrases || []).reduce((acc, ph) => addPhraseToPrompt(acc, ph, opts), String(prompt ?? ''));
}

/** Removes several phrases. */
export function removePhrasesFromPrompt(prompt, phrases) {
  return (phrases || []).reduce((acc, ph) => removePhraseFromPrompt(acc, ph), String(prompt ?? ''));
}

/** The phrases (texts) of `list` that the prompt contains. */
export const activePhrases = (prompt, list) => (Array.isArray(list) ? list : []).filter((x) => promptHasPhrase(prompt, x.text)).map((x) => x.text);

/** The starting prompt of a new shot: every phrase marked `auto`. */
export const autoPhrasePrompt = (list, opts) => addPhrasesToPrompt('', (Array.isArray(list) ? list : []).filter((x) => x.auto).map((x) => x.text), opts);

// ---------------------------------------------------------------------------------------------------------
// Phrase sets
// ---------------------------------------------------------------------------------------------------------

/** Creates a named set of phrases (texts, deduplicated). */
export function createPhraseSet({ name = '', texts = [] } = {}) {
  const seen = new Set();
  const list = [];
  for (const t of texts || []) {
    const c = cleanPhraseText(t);
    if (c && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase());
      list.push(c);
    }
  }
  return { id: uid('pset'), name: collapseSpaces(name) || `Set of ${list.length}`, texts: list, createdAt: Date.now() };
}

/** True when the prompt contains every phrase of the set. */
export const setIsApplied = (prompt, set) => !!set?.texts?.length && set.texts.every((t) => promptHasPhrase(prompt, t));

/** Applies a set (adds its missing phrases) or, when it is fully applied, removes it. */
export function togglePhraseSet(prompt, set, opts) {
  if (!set?.texts?.length) return String(prompt ?? '');
  return setIsApplied(prompt, set) ? removePhrasesFromPrompt(prompt, set.texts) : addPhrasesToPrompt(prompt, set.texts, opts);
}

// ---------------------------------------------------------------------------------------------------------
// Import / export (plain text: one phrase per line, "# Category" headings)
// ---------------------------------------------------------------------------------------------------------

/** Text export of phrases grouped by category. */
export function exportPhrasesText(list) {
  return groupPhrases(list)
    .map((g) => [`# ${g.label}`, ...g.items.map((x) => `${x.auto ? '* ' : ''}${x.text}`)].join('\n'))
    .join('\n\n');
}

/**
 * Parses phrases from text: one per line; "# Heading" lines set the category
 * (matched against the category labels / ids, else 'other'); a leading "* " marks an auto phrase; bullets and
 * numbering are stripped. Also accepts a JSON array of strings or {text, category}.
 */
export function parsePhrasesText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  if (/^[[{]/.test(raw)) {
    try {
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : Array.isArray(data?.phrases) ? data.phrases : [];
      return arr
        .map((x) => (typeof x === 'string' ? { text: x, category: 'other' } : { text: x?.text, category: x?.category, auto: !!x?.auto }))
        .map((x) => ({ ...x, text: cleanPhraseText(x.text), category: CATEGORY_IDS.includes(x.category) ? x.category : 'other' }))
        .filter((x) => x.text);
    } catch {
      /* not JSON: read as text */
    }
  }
  const out = [];
  let category = 'other';
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const head = /^#{1,6}\s*(.+)$/.exec(l);
    if (head) {
      const name = head[1].trim().toLowerCase();
      category = PHRASE_CATEGORIES.find((c) => c.id === name || c.label.toLowerCase() === name || c.label.toLowerCase().startsWith(name))?.id || 'other';
      continue;
    }
    let body = l.replace(/^(?:[-•–]\s+|\d+[.)]\s+)/, '');
    let auto = false;
    if (/^\*\s+/.test(body)) {
      auto = true;
      body = body.replace(/^\*\s+/, '');
    }
    const t = cleanPhraseText(body);
    if (t) out.push({ text: t, category, auto });
  }
  return out;
}
