// Small pure text helpers shared by the prompt engine (composition, token expansion, list parsing, take matching).
// No DOM: importable from Node unit tests.

/** Collapses runs of whitespace (including newlines) into single spaces and trims. */
export function collapseSpaces(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cleans a builder phrase: collapses whitespace, strips leading list/punctuation noise and trailing separators or
 * periods (an ellipsis is kept). "  Wide shot. " -> "Wide shot".
 */
export function cleanPhrase(value) {
  let s = collapseSpaces(value).replace(/^[\s,;:.\-–—•*]+(?=\S)/, '');
  s = s.replace(/[\s,;:]+$/, '');
  if (!/(\.\.\.|…)$/.test(s)) s = s.replace(/\.+$/, '');
  return s.trim();
}

/** Upper-cases the first character when it is a lower-case letter (tokens such as @name / {{x}} are left alone). */
export function capitalizeFirst(value) {
  const s = String(value ?? '');
  const m = /^(["'“‘(\[]*)(\p{Ll})/u.exec(s);
  if (!m) return s;
  return m[1] + m[2].toUpperCase() + s.slice(m[0].length);
}

/** Ensures the text ends with terminal punctuation (adds a period). Empty stays empty. */
export function ensureSentence(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/[.!?…]["'”’)\]]*$/.test(s)) return s;
  if (/[:;,]$/.test(s)) return s.slice(0, -1) + '.';
  return s + '.';
}

/**
 * Canonical key for token names: lower-case, accents removed, every run of non letters/digits -> '-'.
 * "Captain Nova" / "captain_nova" / "Captain-Nova" all map to "captain-nova".
 */
export function tokenKey(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Splits a comma / semicolon / newline separated phrase list, ignoring separators inside quotes or brackets.
 * Arrays are accepted too (each entry is cleaned). Empty entries are dropped.
 */
export function splitPhrases(value) {
  if (Array.isArray(value)) return value.flatMap((v) => splitPhrases(v));
  const s = String(value ?? '');
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote || (quote === '“' && ch === '”')) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === '“') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n')) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(cleanPhrase).filter(Boolean);
}

const looseKey = (s) => collapseSpaces(s).toLowerCase().replace(/[.!?]+$/, '');

/** True when `phrase` is one of the entries of the phrase list `value` (case-insensitive). */
export function hasPhrase(value, phrase) {
  const k = looseKey(phrase);
  if (!k) return false;
  return splitPhrases(value).some((p) => looseKey(p) === k);
}

/** Adds `phrase` to (or removes it from) the comma-separated list `value`. Returns the new string. */
export function togglePhrase(value, phrase) {
  const parts = splitPhrases(value);
  const k = looseKey(phrase);
  if (!k) return parts.join(', ');
  const idx = parts.findIndex((p) => looseKey(p) === k);
  if (idx >= 0) parts.splice(idx, 1);
  else parts.push(cleanPhrase(phrase));
  return parts.join(', ');
}

/** Removes Markdown emphasis / inline code markers and wrapping quotes from a single line of text. */
export function stripMarkdown(value) {
  let s = String(value ?? '');
  s = s.replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
  s = s.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
  return s;
}

/** Removes one level of wrapping quotes ("…", “…”, '…') around the whole string. */
export function unquote(value) {
  const s = String(value ?? '').trim();
  const m = /^(["“'‘])([\s\S]*)(["”'’])$/.exec(s);
  if (!m) return s;
  const pairs = { '"': '"', '“': '”', "'": "'", '‘': '’' };
  if (pairs[m[1]] !== m[3] && !(m[1] === '"' && m[3] === '"')) return s;
  // Only unwrap when the inner text has no other quote of the same kind (avoid breaking "a" and "b").
  if (m[2].includes(m[1]) || m[2].includes(m[3])) return s;
  return m[2].trim();
}

const STOP_WORDS = new Set(
  'a an the of in on at to and or with by for from as into onto over under is are was were be been its it this that these those their his her very just then than there here while'.split(' '),
);

/** Lower-cased words of a text with punctuation removed (used for fuzzy prompt matching). */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Distinct content words of a text (stop words and 1-letter tokens dropped). */
export function contentWords(text) {
  const words = normalizeForMatch(text).split(' ').filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/** Word and character counts of a text. */
export function textStats(text) {
  const s = String(text ?? '');
  const words = s.trim() ? s.trim().split(/\s+/).length : 0;
  return { chars: s.length, words };
}

/** Removes duplicate values preserving the first occurrence. */
export const uniq = (list) => [...new Set(list)];
