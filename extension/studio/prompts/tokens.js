// Token expansion for prompts and templates. Pure (no DOM).
//
//   {{name}}          variable / snippet / bible entry / built-in, looked up in this order:
//                       1. ctx.variables (template form values)
//                       2. built-ins: {{style}} -> bible.style (style guide), {{notes}} -> bible.notes
//                       3. snippets ("prepared texts") by title, e.g. {{cinematic-look}} or {{Cinematic look}}
//                       4. bible characters / locations by name
//   {{name|fallback}} uses `fallback` when the name is unknown or empty
//   @Name             bible character or location. Multi-word names match as typed ("@Captain Nova") or with
//                     _ / - instead of spaces ("@captain_nova"). The first mention expands to "Name (description)",
//                     later mentions to just "Name" (configurable with opts.describe: 'first' | 'all' | 'none').
//   \@ and \{{        escape a literal "@" / "{{".
// Unknown tokens stay in the text verbatim and are reported in `unknown`.

import { tokenKey, collapseSpaces } from './text.js';

const MAX_DEPTH = 4;
const VAR_RE = /\{\{\s*([^{}|]*?)\s*(?:\|([^{}]*))?\}\}/y;
const NAME_CHAR = /[\p{L}\p{N}_'’-]/u;
const MENTION_START = /[\p{L}\p{N}_]/u;
const BEFORE_MENTION_BLOCK = /[\p{L}\p{N}_.+\-@]/u; // "mail@host" is not a mention

/** Bible entries usable as @mentions: [{kind, id, name, description}] sorted by name length (longest first). */
export function bibleEntries(bible = {}) {
  const list = [];
  for (const kind of ['characters', 'locations']) {
    for (const e of Array.isArray(bible?.[kind]) ? bible[kind] : []) {
      const name = collapseSpaces(e?.name);
      if (!name) continue;
      list.push({ kind, id: e.id || tokenKey(name), name, description: collapseSpaces(e.description || '') });
    }
  }
  return list.sort((a, b) => b.name.length - a.name.length);
}

function buildContext(ctx = {}) {
  const variables = new Map();
  for (const [k, v] of Object.entries(ctx.variables || {})) variables.set(tokenKey(k), v);
  const snippets = new Map();
  for (const s of Array.isArray(ctx.snippets) ? ctx.snippets : []) {
    const key = tokenKey(s?.key || s?.title);
    if (key && !snippets.has(key)) snippets.set(key, s);
  }
  const entries = bibleEntries(ctx.bible);
  const byKey = new Map();
  for (const e of entries) if (!byKey.has(tokenKey(e.name))) byKey.set(tokenKey(e.name), e);
  return { variables, snippets, entries, byKey, bible: ctx.bible || {} };
}

/**
 * Finds the bible entry mentioned at text[start] (just after the "@"). Returns {entry, length} or null.
 * Tries every full name as typed (case-insensitive, longest first), then the "_"/"-" joined word form.
 */
function matchMention(text, start, c) {
  const lower = text.toLowerCase();
  for (const e of c.entries) {
    const n = e.name.toLowerCase();
    if (lower.startsWith(n, start)) {
      const next = text[start + n.length];
      if (!next || !/[\p{L}\p{N}_]/u.test(next)) return { entry: e, length: n.length };
    }
  }
  let end = start;
  while (end < text.length && NAME_CHAR.test(text[end])) end++;
  let word = text.slice(start, end);
  // Trailing possessive / punctuation is not part of the name.
  word = word.replace(/['’]s?$/i, '').replace(/[-']+$/, '');
  const e = c.byKey.get(tokenKey(word));
  if (e) return { entry: e, length: word.length };
  return word ? { entry: null, length: word.length, word } : null;
}

/** Scans `text` for tokens. Returns [{kind:'var'|'mention', raw, name, fallback, index, length}] (no lookups). */
export function findTokens(text) {
  const s = String(text ?? '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && (s[i + 1] === '@' || s.startsWith('{{', i + 1))) {
      i += s[i + 1] === '@' ? 1 : 2;
      continue;
    }
    if (ch === '{' && s[i + 1] === '{') {
      VAR_RE.lastIndex = i;
      const m = VAR_RE.exec(s);
      if (m && m[1]) {
        out.push({ kind: 'var', raw: m[0], name: m[1], fallback: m[2] ?? null, index: i, length: m[0].length });
        i += m[0].length - 1;
      }
      continue;
    }
    if (ch === '@' && MENTION_START.test(s[i + 1] || '') && (i === 0 || !BEFORE_MENTION_BLOCK.test(s[i - 1]))) {
      let end = i + 1;
      while (end < s.length && NAME_CHAR.test(s[end])) end++;
      const word = s.slice(i + 1, end).replace(/['’]s?$/i, '').replace(/[-']+$/, '');
      out.push({ kind: 'mention', raw: '@' + word, name: word, fallback: null, index: i, length: word.length + 1 });
      i += word.length;
    }
  }
  return out;
}

/**
 * Expands {{tokens}} and @mentions.
 * @param {string} text
 * @param {{bible?: object, snippets?: Array<{title:string,text:string}>, variables?: Object<string,string>}} [ctx]
 * @param {{describe?: 'first'|'all'|'none'}} [opts]
 * @returns {{text: string, unknown: string[], used: string[], empty: string[], segments: Array<{text:string, token?:string, kind?:string, status?:string}>}}
 *   `segments` reproduce the expanded text; token replacements carry the original token and a status
 *   ('ok' | 'unknown' | 'empty' | 'fallback') for highlighting.
 */
export function expandTokens(text, ctx = {}, opts = {}) {
  const c = buildContext(ctx);
  const describe = opts.describe || 'first';
  const unknown = new Set();
  const used = new Set();
  const empty = new Set();
  const described = new Set();

  const renderEntry = (e) => {
    used.add(e.name);
    const full = e.description && (describe === 'all' || (describe === 'first' && !described.has(e.id)));
    described.add(e.id);
    return full ? `${e.name} (${e.description})` : e.name;
  };

  // Resolves a {{name|fallback}} token. Returns {value, status} (value null = unknown).
  const resolveVar = (name, fallback, depth, stack) => {
    const key = tokenKey(name);
    const nested = (value, guard) => (depth < MAX_DEPTH ? expand(String(value), depth + 1, guard ? [...stack, guard] : stack).text : String(value));
    if (c.variables.has(key)) {
      const v = c.variables.get(key);
      const str = v == null ? '' : String(v);
      if (str.trim()) {
        used.add(name);
        return { value: nested(str, `var:${key}`), status: 'ok' };
      }
      if (fallback != null) return { value: nested(fallback), status: 'fallback' };
      empty.add(name);
      return { value: '', status: 'empty' };
    }
    if (key === 'style' || key === 'notes') {
      const v = String(c.bible?.[key] || '').trim();
      if (v) {
        used.add(name);
        return { value: stack.includes(`bible:${key}`) ? v : nested(v, `bible:${key}`), status: 'ok' };
      }
      if (fallback != null) return { value: nested(fallback), status: 'fallback' };
      empty.add(name);
      return { value: '', status: 'empty' };
    }
    if (c.snippets.has(key) && !stack.includes(`snip:${key}`)) {
      used.add(name);
      return { value: nested(c.snippets.get(key).text || '', `snip:${key}`), status: 'ok' };
    }
    if (c.byKey.has(key)) return { value: renderEntry(c.byKey.get(key)), status: 'ok' };
    if (fallback != null) return { value: nested(fallback), status: 'fallback' };
    return { value: null, status: 'unknown' };
  };

  function expand(input, depth, stack) {
    const s = String(input ?? '');
    const segments = [];
    let lit = '';
    const flush = () => {
      if (lit) segments.push({ text: lit });
      lit = '';
    };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && s[i + 1] === '@') {
        lit += '@';
        i += 1;
        continue;
      }
      if (ch === '\\' && s.startsWith('{{', i + 1)) {
        lit += '{{';
        i += 2;
        continue;
      }
      if (ch === '{' && s[i + 1] === '{') {
        VAR_RE.lastIndex = i;
        const m = VAR_RE.exec(s);
        if (m && m[1]) {
          const { value, status } = resolveVar(m[1], m[2] ?? null, depth, stack);
          flush();
          if (value == null) {
            unknown.add(`{{${m[1]}}}`);
            segments.push({ text: m[0], token: m[0], kind: 'var', status: 'unknown' });
          } else {
            segments.push({ text: value, token: m[0], kind: 'var', status });
          }
          i += m[0].length - 1;
          continue;
        }
      }
      if (ch === '@' && MENTION_START.test(s[i + 1] || '') && (i === 0 || !BEFORE_MENTION_BLOCK.test(s[i - 1]))) {
        const hit = matchMention(s, i + 1, c);
        if (hit) {
          flush();
          const raw = s.slice(i, i + 1 + hit.length);
          if (hit.entry) segments.push({ text: renderEntry(hit.entry), token: raw, kind: 'mention', status: 'ok' });
          else {
            unknown.add(raw);
            segments.push({ text: raw, token: raw, kind: 'mention', status: 'unknown' });
          }
          i += hit.length;
          continue;
        }
      }
      lit += ch;
    }
    flush();
    return { text: segments.map((x) => x.text).join(''), segments };
  }

  const res = expand(text, 0, []);
  let out = res.text;
  let segments = res.segments;
  if (empty.size) {
    // Empty replacements leave doubled spaces / dangling commas behind: tidy them. Tidying only deletes characters,
    // so the segments are re-cut to join to exactly the tidied text (the preview shows what is sent).
    const tidy = (t) =>
      t
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,.;:!?])/g, '$1')
        .replace(/([,;])(\s*[,;])+/g, '$1')
        .replace(/(^|[.!?]\s*)[,;]\s*/g, '$1')
        .replace(/[,;](\s*[.!?])/g, '$1')
        .trim();
    const tidied = tidy(out);
    if (tidied !== out) {
      out = tidied;
      segments = alignSegments(segments, tidied);
    }
  }
  return { text: out, unknown: [...unknown], used: [...used], empty: [...empty], segments };
}

/**
 * Re-cuts segments so their texts join to `target`, a subsequence of their joined text (characters were only
 * deleted). Token segments are kept even when empty (the preview marks them); empty literal segments are dropped.
 * Falls back to one literal segment if `target` is not a subsequence.
 */
function alignSegments(segments, target) {
  const out = [];
  let j = 0;
  for (const seg of segments) {
    let kept = '';
    for (let k = 0; k < seg.text.length; k++) {
      if (j < target.length && seg.text[k] === target[j]) {
        kept += seg.text[k];
        j++;
      }
    }
    if (kept || seg.token) out.push({ ...seg, text: kept });
  }
  return j === target.length ? out : [{ text: target }];
}

/** Convenience: unknown tokens of a text for the given context. */
export const unknownTokens = (text, ctx) => expandTokens(text, ctx).unknown;
