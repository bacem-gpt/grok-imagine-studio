// Variations generator: cartesian combinations of builder field options. Pure.
//
// variations(baseFields, varyKeys, optionsByKey, limit) returns up to `limit` combinations. When the full product
// fits, it is returned in nested-loop order (first key varies slowest). When it doesn't, a deterministic, diverse
// subset is picked (every option of every key is used as evenly as possible) and returned in product order.
// Pass {spread: false} for a plain truncation of the product instead.
//
// variationPrompt(shot, variation, order) writes the prompt of one variation: a prompt composed from the builder
// fields is recomposed with the varied values; a hand-written prompt is kept and only the varied phrases change.

import { cleanPhrase, uniq, collapseSpaces, splitPhrases, capitalizeFirst, ensureSentence } from './text.js';
import { composePrompt, fieldText, fieldPhrase } from './compose.js';

const MAX_SCAN = 200_000;

function optionLists(varyKeys, optionsByKey) {
  const keys = [];
  const lists = [];
  for (const k of uniq(Array.isArray(varyKeys) ? varyKeys : [])) {
    const opts = uniq(
      (Array.isArray(optionsByKey?.[k]) ? optionsByKey[k] : [])
        .map((o) => cleanPhrase(o))
        .filter(Boolean),
    );
    if (!opts.length) continue;
    keys.push(k);
    lists.push(opts);
  }
  return { keys, lists };
}

/** Number of combinations (product of option counts of the keys that have options; 0 when none). */
export function countVariations(varyKeys, optionsByKey) {
  const { lists } = optionLists(varyKeys, optionsByKey);
  if (!lists.length) return 0;
  return lists.reduce((n, l) => n * l.length, 1);
}

/** Combination #index of the product (mixed radix, last key fastest) as option indices. */
function decode(index, lists) {
  const out = new Array(lists.length);
  let rem = index;
  for (let i = lists.length - 1; i >= 0; i--) {
    out[i] = rem % lists[i].length;
    rem = Math.floor(rem / lists[i].length);
  }
  return out;
}

/** Greedy coverage: repeatedly takes the combination whose options were used the least so far. */
function diverseIndices(lists, total, n) {
  const usage = lists.map((l) => new Array(l.length).fill(0));
  const chosen = new Set();
  const picks = [];
  const scan = Math.min(total, MAX_SCAN);
  for (let k = 0; k < n; k++) {
    let best = -1;
    let bestScore = Infinity;
    for (let idx = 0; idx < scan; idx++) {
      if (chosen.has(idx)) continue;
      const d = decode(idx, lists);
      let score = 0;
      for (let j = 0; j < d.length; j++) score += usage[j][d[j]];
      if (score < bestScore) {
        bestScore = score;
        best = idx;
        if (score === 0) break;
      }
    }
    if (best < 0) break;
    chosen.add(best);
    picks.push(best);
    decode(best, lists).forEach((o, j) => usage[j][o]++);
  }
  return picks.sort((a, b) => a - b);
}

/**
 * Cartesian combinations of field options.
 * @param {Object<string,string>} baseFields  fields every variation starts from
 * @param {string[]} varyKeys                 field keys to vary (keys without options are ignored)
 * @param {Object<string,string[]>} optionsByKey
 * @param {number} [limit=24]
 * @param {{spread?: boolean}} [opts]
 * @returns {Array<{fields: Object<string,string>, changes: Object<string,string>, label: string}>}
 */
export function variations(baseFields = {}, varyKeys = [], optionsByKey = {}, limit = 24, { spread = true } = {}) {
  const { keys, lists } = optionLists(varyKeys, optionsByKey);
  const cap = Math.floor(Number(limit));
  if (!keys.length || !(cap > 0)) return [];
  const total = lists.reduce((n, l) => n * l.length, 1);
  const n = Math.min(total, cap);
  const indices = n === total || !spread ? Array.from({ length: n }, (_, i) => i) : diverseIndices(lists, total, n);
  return indices.map((idx) => {
    const d = decode(idx, lists);
    const changes = {};
    keys.forEach((k, j) => {
      changes[k] = lists[j][d[j]];
    });
    return { fields: { ...(baseFields || {}), ...changes }, changes, label: keys.map((k) => changes[k]).join(' · ') };
  });
}

const sameText = (a, b) => collapseSpaces(a).toLowerCase() === collapseSpaces(b).toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces the first case-insensitive, whole-word occurrence of `from` in `text` with `to` (capitalised when it opens
 * a sentence). Returns null when `from` does not occur.
 */
function replacePhrase(text, from, to) {
  if (!from || !to) return null;
  const m = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(from)})(?![\\p{L}\\p{N}])`, 'iu').exec(text);
  if (!m) return null;
  const start = m.index + m[1].length;
  const sentenceStart = /(^|[.!?]["'”’)\]]*\s+)$/.test(text.slice(0, start));
  return text.slice(0, start) + (sentenceStart ? capitalizeFirst(to) : to) + text.slice(start + m[2].length);
}

/**
 * Prompt text for one variation of a shot.
 *   - empty prompt, or a prompt that is exactly what the builder composes from the shot's fields: recomposed from
 *     the variation's fields (base 'fields');
 *   - hand-written prompt: kept as written; each varied field replaces its old value where the prompt contains it,
 *     and varied fields not found in the prompt are appended as composed sentences (base 'prompt').
 * Builder fields that never made it into a hand-written prompt (e.g. a Quick look that was not composed) stay out.
 * @param {{prompt?: string, fields?: Object<string,string>}} shot
 * @param {{fields: Object<string,string>, changes: Object<string,string>}} variation  an entry of variations()
 * @param {string[]} [order]  composition order (compose.js)
 * @returns {{prompt: string, base: 'fields'|'prompt'}}
 */
export function variationPrompt(shot, variation, order) {
  const fields = shot?.fields || {};
  const own = String(shot?.prompt ?? '').trim();
  const composed = composePrompt(fields, order);
  if (!own || (composed && sameText(own, composed))) return { prompt: composePrompt(variation?.fields || {}, order), base: 'fields' };
  let text = own;
  const rest = {};
  for (const [key, value] of Object.entries(variation?.changes || {})) {
    const old = fields[key];
    const attempts = old
      ? [
          [fieldPhrase(key, old), fieldPhrase(key, value)],
          [fieldText(key, old), fieldText(key, value)],
          ...splitPhrases(old).map((p) => [p, fieldText(key, value)]),
        ]
      : [];
    let replaced = null;
    for (const [from, to] of attempts) {
      replaced = replacePhrase(text, from, to);
      if (replaced != null) break;
    }
    if (replaced != null) text = replaced;
    else rest[key] = value;
  }
  const extra = composePrompt(rest, order);
  return { prompt: extra ? `${ensureSentence(text)} ${extra}` : text, base: 'prompt' };
}
