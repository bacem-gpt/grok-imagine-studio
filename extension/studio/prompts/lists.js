// Prompt list import / export. Pure (no DOM).
//
// parsePromptList(text) understands what people (and Grok) paste:
//   * JSON arrays of strings or objects ({title, prompt, duration, notes} and common synonyms), or {shots|prompts|items: [...]}
//   * CSV / TSV / semicolon-separated text with a "prompt" column (quoted fields, escaped quotes, multi-line cells)
//   * Markdown tables (picks the prompt / description column)
//   * Numbered lists (1. 1) (1) #1), bullets (- * • –), "Shot 3:" / "Scene 2 -" labels, Markdown headings and
//     bold titles; blocks with "Prompt:" / "Title:" / "Duration:" / "Notes:" lines
//   * otherwise blank-line separated paragraphs, or one prompt per line
// Code fences (```json … ```) are unwrapped, list markers stripped, optional titles extracted, and chatty
// preamble/outro lines ("Here are 5 prompts:", "Let me know if…") dropped. Bold wrappers around labels and titles
// ("**Shot 1: Opening drift** — …", "1. **Shot 2 – Chase:** …") are explicit titles; timecodes after a label
// ("Shot 3 (6-12s): …") become durations.

import { collapseSpaces, stripMarkdown, unquote, cleanPhrase } from './text.js';

const MAX_ITEMS = 500;

const NUMBERED_RE = /^\s*(?:\(\d{1,3}\)|\d{1,3}[.)\]](?=\s)|\d{1,3}\s*[–—-](?=\s)|#\d{1,3}[.:)]?(?=\s))\s*/;
const BULLET_RE = /^\s*(?:[-*•–—+▪◦‣·]\s+(?:\[[ xX]\]\s+)?)/;
const HEADING_RE = /^\s*#{1,6}\s+/;
const LABEL_RE = /^\s*(?:\*\*|__)?\s*(shot|scene|clip|panel|frame|beat|part|segment|take|prompt)\s*(?:#|no\.?\s*)?(\d{1,3}[a-z]?)\b\s*(?:\*\*|__)?\s*(?:[:.)\]–—-]+\s*)?(?:\*\*|__)?/i;
const BOLD_LINE_RE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;
/** A bold run at the start of an item: "**Title** — prompt", "**Shot 1: Title:** prompt". */
const LEAD_BOLD_RE = /^(\*\*|__)(.+?)\1(?![*_])\s*(.*)$/;
/** Bold leads that are remarks rather than shots ("**Note:** …"). */
const NOT_SHOT_TITLE_RE = /^(notes?|tips?|important|warning|summary|overview|style|overall style|visual style|general notes?|format|reminder|p\.?s\.?)$/i;
const TIMECODE_RE = /^[([]\s*([^()[\]]{1,24}?)\s*[)\]]\s*/;
const TRAILING_TIMECODE_RE = /\s*[([]\s*([^()[\]]{1,24}?)\s*[)\]]\s*$/;
const FIELD_LINE_RE = /^\s*(?:[-•]\s+|\*\s+)?(?:\*{1,2}|_{1,2})?(prompt|video prompt|image prompt|text|description|visuals?|title|name|duration|length|notes?|camera|camera movement|lighting|sound|audio|music|style|mood|setting|location|action|subject|shot type|framing|lens|dialogue|voice ?over|sfx)(?:\*{1,2}|_{1,2})?\s*:\s*(?:\*{1,2}|_{1,2})?\s*(.*)$/i;
const CHATTY_RE = /^(here(?:'s| is| are)|sure\b|certainly|of course|absolutely|okay\b|ok\b|great\b|below (?:is|are)|i(?:'ve| have) (?:written|created|made|prepared)|these (?:prompts|shots)|let me know|feel free|would you like|do you want|(?:want|need) (?:more|me|another|any)|shall i|should i|hope (?:this|these)|i hope|you can (?:also|adjust|tweak)|want me to|if you(?:'d)? like|happy to|enjoy\b|note:|tip:)/i;

const PROMPT_KEYS = ['prompt', 'videoprompt', 'imageprompt', 'prompttext', 'text', 'description', 'content', 'visual', 'visuals', 'value'];
const TITLE_KEYS = ['title', 'name', 'label', 'heading', 'shottitle', 'scenetitle', 'caption'];
const DURATION_KEYS = ['duration', 'length', 'seconds', 'secs', 'sec', 'time'];
const NOTES_KEYS = ['notes', 'note', 'comment', 'comments'];

const normKey = (k) => String(k || '').toLowerCase().replace(/[^a-z]/g, '');

/** Parses "6", "6s", "6 sec", "6 seconds", "0:06", "1m 5s" into seconds (null when not a duration). */
export function parseDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]) || null;
  m = /^(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?)?\s*(?:long)?$/.exec(s);
  if (m && (m[1] || m[2])) {
    const total = Number(m[1] || 0) * 60 + Number(m[2] || 0);
    return total > 0 ? total : null;
  }
  m = /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/.exec(s);
  return m ? Number(m[1]) : null;
}

function makeItem({ title = '', prompt = '', duration = null, notes = '' } = {}) {
  const item = { title: cleanTitle(title), prompt: cleanPrompt(prompt) };
  const d = parseDuration(duration);
  if (d) item.duration = d;
  const n = collapseSpaces(notes);
  if (n) item.notes = n;
  return item;
}

/** Removes Markdown left over after pairing (a stray "**" from a bold run split by a separator). */
const stripStrayMarkup = (s) => String(s ?? '').replace(/\*{2,}|_{2,}/g, '');

function cleanTitle(t) {
  return cleanPhrase(stripStrayMarkup(stripMarkdown(unquote(collapseSpaces(t))))).replace(/^["“'‘]|["”'’]$/g, '');
}

function cleanPrompt(p) {
  return unquote(collapseSpaces(stripStrayMarkup(stripMarkdown(String(p ?? '')))).replace(/^:\s*/, ''));
}

const toSeconds = (v) => {
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number(v);
};

/** Seconds of a time span ("0-6s", "6–12 sec", "0:00-0:06") or a duration with a unit ("6s", "0:06"); else null. */
export function parseTimeSpan(text) {
  const t = collapseSpaces(text).toLowerCase();
  if (!t || /^\d+(\.\d+)?$/.test(t)) return null; // a bare number is not a duration
  const UNIT = '(?:\\s*(?:s|sec|secs|seconds?))?';
  const NUM = '(\\d+(?::\\d{1,2})?(?:\\.\\d+)?)';
  const range = new RegExp(`^${NUM}${UNIT}\\s*(?:-|–|—|to)\\s*${NUM}${UNIT}$`).exec(t);
  if (range) {
    const a = toSeconds(range[1]);
    const b = toSeconds(range[2]);
    return b > a ? Math.round((b - a) * 100) / 100 : null;
  }
  return /^\d/.test(t) ? parseDuration(t) : null;
}

/** Takes a leading "(0-6s)" / "[6s]" timecode off a head. Returns {duration, rest} or null. */
function takeTimecode(s) {
  const m = TIMECODE_RE.exec(s);
  const duration = m ? parseTimeSpan(m[1]) : null;
  return duration ? { duration, rest: s.slice(m[0].length) } : null;
}

/** Takes a trailing "(0-6s)" timecode off a title. Returns {duration, rest} or null. */
function takeTrailingTimecode(s) {
  const m = TRAILING_TIMECODE_RE.exec(s);
  const duration = m ? parseTimeSpan(m[1]) : null;
  return duration ? { duration, rest: s.slice(0, m.index) } : null;
}

/**
 * Parses the inside of a heading / bold run: drops a leading list number ("1. "), a "Shot N" label, a timecode
 * and separators. Returns {text, label, duration}.
 */
function parseHead(raw) {
  let s = collapseSpaces(raw).replace(NUMBERED_RE, '');
  let label = false;
  let duration = null;
  const lm = LABEL_RE.exec(s);
  if (lm && lm.index === 0) {
    label = true;
    s = s.slice(lm[0].length);
  }
  const tc = takeTimecode(s);
  if (tc) {
    duration = tc.duration;
    s = tc.rest;
  }
  s = s.replace(/^[:.–—-]+\s*/, '').replace(/\s*[:–—-]+$/, '');
  const tail = takeTrailingTimecode(s);
  if (tail) {
    duration = duration || tail.duration;
    s = tail.rest;
  }
  return { text: s.trim(), label, duration };
}

/** Pulls the content out of Markdown code fences (```lang … ```). Returns the joined fenced text or null. */
function fencedContent(text) {
  const blocks = [...text.matchAll(/```[\w-]*[ \t]*\n?([\s\S]*?)```/g)].map((m) => m[1].trim()).filter(Boolean);
  return blocks.length ? blocks.join('\n\n') : null;
}

// ---------------------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------------------

function fromJsonValue(data) {
  let list = data;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    const key = Object.keys(list).find((k) => ['shots', 'prompts', 'items', 'scenes', 'storyboard', 'list', 'data'].includes(normKey(k)) && Array.isArray(list[k]));
    if (key) list = list[key];
    else if (Object.values(list).every((v) => typeof v === 'string')) list = Object.values(list);
    else list = [list];
  }
  if (!Array.isArray(list)) return null;
  const items = [];
  for (const entry of list) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      items.push(makeItem({ prompt: String(entry) }));
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const keys = Object.keys(entry);
    const pick = (cands) => keys.find((k) => cands.includes(normKey(k)) && entry[k] != null && entry[k] !== '');
    const pk = pick(PROMPT_KEYS);
    const tk = pick(TITLE_KEYS);
    const dk = pick(DURATION_KEYS);
    const nk = pick(NOTES_KEYS);
    let prompt = pk ? entry[pk] : '';
    if (Array.isArray(prompt)) prompt = prompt.join(' ');
    if (!pk) {
      // No prompt-like key: join the remaining text values ("camera", "action", …) into one prompt.
      const skip = new Set([tk, dk, nk, ...keys.filter((k) => ['id', 'shot', 'scene', 'number', 'index', 'n'].includes(normKey(k)))]);
      prompt = keys
        .filter((k) => !skip.has(k) && typeof entry[k] === 'string' && entry[k].trim())
        .map((k) => cleanPhrase(entry[k]))
        .join('. ');
    }
    items.push(makeItem({ title: tk ? String(entry[tk]) : '', prompt: String(prompt ?? ''), duration: dk ? entry[dk] : null, notes: nk ? String(entry[nk]) : '' }));
  }
  return items;
}

function tryJson(text) {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return fromJsonValue(JSON.parse(t));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------------------------------------

/** RFC 4180-style parser: quoted fields, doubled quotes, delimiters and newlines inside quotes. */
export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      quoted = true;
      field = '';
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function countOutsideQuotes(line, ch) {
  let n = 0;
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === ch && !q) n++;
  }
  return n;
}

function tryCsv(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delims = ['\t', ',', ';'].map((d) => ({ d, n: countOutsideQuotes(firstLine, d) })).filter((x) => x.n > 0);
  for (const { d } of delims.sort((a, b) => b.n - a.n)) {
    const rows = parseCsv(text, d);
    if (rows.length < 2) continue;
    const header = rows[0].map((h) => normKey(h));
    const pi = header.findIndex((h) => ['prompt', 'prompts', 'videoprompt', 'imageprompt', 'prompttext', 'text', 'description'].includes(h));
    if (pi < 0) continue;
    const ti = header.findIndex((h, i) => i !== pi && ['title', 'name', 'label', 'shottitle', 'scenetitle', 'heading'].includes(h));
    const di = header.findIndex((h) => DURATION_KEYS.includes(h));
    const ni = header.findIndex((h) => NOTES_KEYS.includes(h));
    const items = rows.slice(1).map((r) => makeItem({ prompt: r[pi] || '', title: ti >= 0 ? r[ti] : '', duration: di >= 0 ? r[di] : null, notes: ni >= 0 ? r[ni] : '' }));
    return items;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Markdown tables
// ---------------------------------------------------------------------------------------------------------

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function tryTable(text) {
  const lines = text.split(/\r?\n/);
  const sep = lines.findIndex((l, i) => i > 0 && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(l) && lines[i - 1].includes('|'));
  if (sep < 0) return null;
  const header = splitTableRow(lines[sep - 1]).map((h) => normKey(stripMarkdown(h)));
  const rows = [];
  for (let i = sep + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.includes('|')) {
      if (rows.length && !l.trim()) break;
      continue;
    }
    rows.push(splitTableRow(l));
  }
  if (!rows.length) return null;
  const find = (cands, not = -1) => {
    for (const c of cands) {
      const i = header.findIndex((h, idx) => idx !== not && (h === c || h.includes(c)));
      if (i >= 0) return i;
    }
    return -1;
  };
  let pi = find(['prompt', 'description', 'visual', 'text', 'content', 'action']);
  if (pi < 0) {
    // Longest average text column.
    let best = -1;
    let bestLen = -1;
    for (let c = 0; c < header.length; c++) {
      const avg = rows.reduce((s, r) => s + (r[c] || '').length, 0) / rows.length;
      if (avg > bestLen) {
        bestLen = avg;
        best = c;
      }
    }
    pi = best;
  }
  let ti = find(['title', 'name', 'scene', 'shot', 'beat'], pi);
  if (ti >= 0 && rows.every((r) => /^\s*#?\d*\s*$/.test(stripMarkdown(r[ti] || '')))) ti = -1; // numbers only
  const di = find(['duration', 'length', 'seconds', 'time'], pi);
  const ni = find(['notes', 'note', 'comment'], pi);
  return rows.map((r) => makeItem({ prompt: r[pi] || '', title: ti >= 0 ? r[ti] : '', duration: di >= 0 ? r[di] : null, notes: ni >= 0 ? r[ni] : '' }));
}

// ---------------------------------------------------------------------------------------------------------
// Lists, labels, headings, paragraphs
// ---------------------------------------------------------------------------------------------------------

const wordCount = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const isTitleCase = (s) =>
  s
    .split(/\s+/)
    .filter((w) => !/^(a|an|the|of|in|on|at|to|and|or|for|with|by|from|vs\.?)$/i.test(w))
    .every((w) => /^[\p{Lu}\p{N}"'“(]/u.test(w));

/** Leading phrases that describe the shot itself ("Close-up: …") belong to the prompt, not to a title. */
const SHOT_TERM_RE = /\b(shot|close-?ups?|wide|angle|view|pov|pan|zoom|tracking|dolly|aerial|establishing|insert|macro|drone|cam|camera|slow[- ]?mo(tion)?|time-?lapse|top-?down|overhead)\b/i;

/** Splits "Title: prompt" / "Title — prompt" / "**Title** prompt" into {title, prompt}. */
function splitTitle(rest, { labelled = false } = {}) {
  let m = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*[:.–—-]?\s*(.*)$/.exec(rest);
  if (m) return { title: m[1], prompt: m[2] };
  m = /^([^:]{1,70}):\s+(.+)$/.exec(rest);
  if (m && wordCount(m[1]) <= 6 && !/[.!?]/.test(m[1]) && !FIELD_LINE_RE.test(rest) && !SHOT_TERM_RE.test(m[1]) && wordCount(m[2]) >= 3) return { title: m[1], prompt: m[2] };
  m = /^(.{1,70}?)\s+[–—]\s+(.+)$/.exec(rest) || /^(.{1,70}?)\s+-\s+(.+)$/.exec(rest);
  if (m && wordCount(m[1]) <= 6 && !/[.!?,]/.test(m[1]) && !SHOT_TERM_RE.test(m[1]) && wordCount(m[2]) >= 3 && (labelled || isTitleCase(m[1]))) return { title: m[1], prompt: m[2] };
  return { title: '', prompt: rest };
}

/**
 * Classifies a line: returns {kind, rest, label, level, title?, explicitTitle?, duration?} when it opens a new item,
 * else null. `title` + `explicitTitle` come from bold markup; `rest` is the text after the marker / label / title.
 */
function startOf(line) {
  let m = BOLD_LINE_RE.exec(line);
  if (m && wordCount(m[1]) <= 12) {
    const head = parseHead(m[1]);
    return { kind: 'heading', rest: '', title: head.text, label: head.label, level: 0, bold: true, duration: head.duration };
  }
  let s = line;
  let kind = null;
  let level = 0;
  if (HEADING_RE.test(s)) {
    kind = 'heading';
    level = (/^\s*(#+)/.exec(s) || ['', '#'])[1].length;
    s = s.replace(HEADING_RE, '');
    s = s.replace(NUMBERED_RE, '');
  } else if (NUMBERED_RE.test(s)) {
    kind = 'numbered';
    s = s.replace(NUMBERED_RE, '');
  } else if (BULLET_RE.test(s) && !FIELD_LINE_RE.test(s)) {
    kind = 'bullet';
    s = s.replace(BULLET_RE, '');
  }
  s = s.trim();

  // A bold run right after the marker (or opening the line) is an explicit label / title.
  const lead = LEAD_BOLD_RE.exec(s);
  if (lead && wordCount(lead[2]) <= 14 && !FIELD_LINE_RE.test(s)) {
    const head = parseHead(lead[2]);
    const after = lead[3];
    const separated = /^[:.–—-]/.test(after) || /[:–—-]\s*$/.test(lead[2]);
    const rest = after.replace(/^[:.–—-]+\s*/, '').trim();
    const titleLike = separated && wordCount(head.text) <= 10 && !NOT_SHOT_TITLE_RE.test(head.text);
    if (head.label || kind || (titleLike && rest)) {
      const base = { kind: kind || (head.label ? 'label' : 'bold'), level, duration: head.duration };
      // Inline emphasis ("**Close-up** of the rider…") belongs to the prompt.
      if (!separated && !head.label && /^\p{Ll}/u.test(rest)) return { ...base, rest: `${head.text} ${rest}`.trim(), label: false };
      // A bold label alone ("**Shot 4:** Gates — Wide shot…"): a title may still follow in the rest.
      if (head.label && !head.text) return { ...base, rest, label: true };
      return { ...base, rest, title: head.text, label: head.label, explicitTitle: true };
    }
  }

  const lm = LABEL_RE.exec(s);
  if (lm && (kind || lm.index === 0)) {
    kind = kind || 'label';
    s = s.slice(lm[0].length);
    const tc = takeTimecode(s);
    if (tc) s = tc.rest.replace(/^[:.–—-]+\s*/, '');
    return { kind, rest: s.trim(), label: true, level, duration: tc?.duration ?? null };
  }
  if (!kind) return null;
  const tc = takeTimecode(s);
  if (tc) return { kind, rest: tc.rest.replace(/^[:.–—-]+\s*/, '').trim(), label: false, level, duration: tc.duration };
  return { kind, rest: s, label: false, level };
}

const PROMPT_FIELDS = new Set(['prompt', 'video prompt', 'image prompt', 'text', 'description', 'visual', 'visuals']);
const isMetaLine = (l) => FIELD_LINE_RE.test(l) || /^>\s?/.test(l);

function parseBlocks(text) {
  const lines = text.split(/\r?\n/);
  const starts = lines.map((l) => (l.trim() ? startOf(l) : null));
  const startCount = starts.filter(Boolean).length;
  const firstContent = lines.findIndex((l) => l.trim());
  // One stray marker in the middle of prose is not a list; a list needs 2+ items or must open the text.
  if (!(startCount >= 2 || (startCount === 1 && starts[firstContent]))) return null;

  // Each block: {title, head (text on the opening line), lines (continuation), label, kind}.
  const blocks = [];
  let cur = null;
  let blankSince = false;
  const push = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) {
      blankSince = true;
      continue;
    }
    const st = starts[i];
    if (st) {
      push();
      const field = st.rest ? FIELD_LINE_RE.exec(st.rest) : null;
      const fieldKey = field ? field[1].toLowerCase() : '';
      const base = { lines: [], kind: st.kind, label: st.label, level: st.level, duration: st.duration ?? null };
      if (st.explicitTitle) cur = { ...base, title: st.title, head: st.rest, bold: true, headIsPrompt: !!st.rest };
      else if (st.kind === 'heading' && st.title != null && !st.rest) cur = { ...base, title: st.title, head: '', bold: !!st.bold };
      else if (field && PROMPT_FIELDS.has(fieldKey)) cur = { ...base, title: '', head: field[2].trim(), headIsPrompt: true, promptField: true };
      else if (field && (fieldKey === 'title' || fieldKey === 'name')) cur = { ...base, title: field[2].trim(), head: '' };
      else if (st.kind === 'heading') cur = { ...base, title: '', head: st.rest, headIsTitle: true };
      else {
        const sp = splitTitle(st.rest, { labelled: st.label });
        // A labelled head ("Shot 2: …") is a prompt when a title was split off or it reads like a sentence.
        const headIsPrompt = !st.label || !!sp.title || wordCount(sp.prompt) > 10 || /[.!?]$/.test(sp.prompt);
        cur = { ...base, title: sp.title, head: sp.prompt, level: 0, headIsPrompt };
      }
      blankSince = false;
      continue;
    }
    // Continuation / orphan line.
    const line = raw.trim();
    if (!cur) continue; // preamble before the first item
    const hasBody = cur.lines.length > 0 || (cur.head && cur.headIsPrompt);
    if (blankSince && hasBody && !isMetaLine(line)) {
      // A paragraph after a blank line: keep it only if more items follow (it belongs to this one) and it isn't chit-chat.
      const moreItems = starts.slice(i + 1).some(Boolean);
      if (!moreItems || CHATTY_RE.test(line)) continue;
    }
    if (CHATTY_RE.test(line) && !isMetaLine(line) && !starts.slice(i + 1).some(Boolean) && hasBody) continue;
    cur.lines.push(line);
    blankSince = false;
  }
  push();

  // A leading document title ("# My storyboard", or a bold line above a numbered list) is not a shot.
  const first = blocks[0];
  const hasBody = (b) => b.lines.length > 0 || (b.head && (b.headIsPrompt || !b.headIsTitle));
  if (blocks.length > 1 && first.kind === 'heading' && !hasBody(first) && !first.label && blocks.slice(1).some(hasBody)) blocks.shift();

  return blocks.map((b) => {
    let title = b.title || '';
    const body = [];
    let promptField = !!b.promptField;
    let duration = b.duration ?? null;
    let notes = '';
    for (const l of b.lines) {
      if (/^>\s?/.test(l)) {
        const v = l.replace(/^>\s?/, '').trim();
        if (v) notes = notes ? `${notes} ${v}` : v;
        continue;
      }
      const fm = FIELD_LINE_RE.exec(l);
      if (fm) {
        const key = fm[1].toLowerCase();
        const val = fm[2].replace(/[*_]+\s*$/, '').trim();
        if (PROMPT_FIELDS.has(key)) {
          promptField = true;
          if (val) body.push(val);
        } else if (key === 'title' || key === 'name') title = val || title;
        else if (key === 'duration' || key === 'length') duration = val;
        else if (key === 'note' || key === 'notes') notes = notes ? `${notes} ${val}` : val;
        else if (val) body.push(`${fm[1].charAt(0).toUpperCase()}${fm[1].slice(1)}: ${val}`);
        continue;
      }
      body.push(l);
    }
    let head = b.head || '';
    // The opening line is a title when it's a heading / "Shot N: …" label (or the block has a Prompt: line) and the
    // prompt comes on the following lines.
    const shortHead = head && wordCount(head) <= 10 && !/[.!?]$/.test(head);
    if (!title && head && body.length && (b.headIsTitle || promptField || (b.label && shortHead))) {
      title = head;
      head = '';
    }
    let prompt = [head, ...body].filter(Boolean).join(' ');
    if (!prompt && title && !b.label) {
      // A heading / bold line with no body: the text itself is the prompt.
      prompt = title;
      title = '';
    }
    const tail = title ? takeTrailingTimecode(title) : null; // "Opening (0-6s)"
    if (tail) {
      title = tail.rest;
      duration = duration ?? tail.duration;
    }
    return makeItem({ title, prompt, duration, notes });
  });
}

function parseParagraphs(text) {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length > 1) {
    const kept = paras.filter((p, i) => !(CHATTY_RE.test(p) && (i === 0 || i === paras.length - 1)) && !(i === 0 && /:\s*$/.test(p) && wordCount(p) < 25));
    return { items: kept.map((p) => makeItem({ prompt: p.replace(/\s*\n\s*/g, ' ') })), format: 'paragraphs' };
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l, i, all) => !(CHATTY_RE.test(l) && (i === 0 || i === all.length - 1)) && !(i === 0 && all.length > 1 && /:\s*$/.test(l)));
  return { items: lines.map((l) => makeItem({ prompt: l })), format: lines.length > 1 ? 'lines' : 'single' };
}

/**
 * Parses pasted text into prompt items and reports the detected format.
 * @param {string} text
 * @returns {{items: Array<{title:string, prompt:string, duration?:number, notes?:string}>, format: 'json'|'csv'|'table'|'list'|'paragraphs'|'lines'|'single'|'empty'}}
 */
export function parsePromptListDetailed(text) {
  let src = String(text ?? '').replace(/ /g, ' ').replace(/\r\n?/g, '\n');
  if (!src.trim()) return { items: [], format: 'empty' };
  const fenced = fencedContent(src);
  if (fenced) {
    const inner = parsePromptListDetailed(fenced);
    if (inner.items.length) return inner;
    src = src.replace(/```[\w-]*/g, '');
  }
  const finish = (items, format) => ({ items: items.filter((it) => it.prompt).slice(0, MAX_ITEMS), format });
  const json = tryJson(src);
  if (json) return finish(json, 'json');
  const table = tryTable(src);
  if (table) return finish(table, 'table');
  const csv = tryCsv(src);
  if (csv) return finish(csv, 'csv');
  const blocks = parseBlocks(src);
  if (blocks && blocks.some((b) => b.prompt)) return finish(blocks, 'list');
  const p = parseParagraphs(src);
  return finish(p.items, p.format);
}

/**
 * Parses pasted text (numbered lists, bullets, "Shot 3:" labels, paragraphs, JSON, CSV, Markdown tables) into
 * prompt items [{title, prompt, duration?, notes?}].
 */
export const parsePromptList = (text) => parsePromptListDetailed(text).items;

/** Human label of a detected format. */
export const FORMAT_LABELS = {
  json: 'JSON',
  csv: 'CSV table',
  table: 'Markdown table',
  list: 'list',
  paragraphs: 'paragraphs',
  lines: 'one prompt per line',
  single: 'single prompt',
  empty: '—',
};

// ---------------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r;\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialises shots as a prompt list.
 * @param {Array<object>} shots  project shots
 * @param {'txt'|'md'|'json'|'csv'} format
 * @param {{resolve?: (shot) => string, title?: string}} [opts]  resolve: text to export for each shot (e.g. the
 *   token-expanded prompt; JSON keeps the raw prompt and adds `expanded` when it differs). title: document title (md).
 * @returns {string}
 */
export function exportPromptList(shots, format = 'txt', opts = {}) {
  const list = Array.isArray(shots) ? shots : [];
  const resolve = typeof opts.resolve === 'function' ? opts.resolve : (s) => s.prompt || '';
  const flat = (s) => collapseSpaces(s);
  switch (format) {
    case 'json':
      return JSON.stringify(
        list.map((s) => {
          const out = { title: s.title || '', prompt: s.prompt || '' };
          const expanded = resolve(s);
          if (expanded && expanded !== out.prompt) out.expanded = expanded;
          if (s.duration) out.duration = s.duration;
          if (s.mode) out.mode = s.mode;
          if (s.notes) out.notes = s.notes;
          if (s.status) out.status = s.status;
          return out;
        }),
        null,
        2,
      );
    case 'csv': {
      const head = ['shot', 'title', 'prompt', 'duration', 'notes', 'status'];
      const rows = list.map((s, i) => [i + 1, s.title || '', flat(resolve(s)), s.duration || '', flat(s.notes || ''), s.status || ''].map(csvCell).join(','));
      return [head.join(','), ...rows].join('\n');
    }
    case 'md': {
      const parts = [];
      if (opts.title) parts.push(`# ${opts.title}`, '');
      list.forEach((s, i) => {
        parts.push(`### ${i + 1}. ${s.title ? flat(s.title) : `Shot ${i + 1}`}`, '', resolve(s).trim() || '_(empty)_');
        const meta = [s.duration ? `Duration: ${s.duration}s` : '', s.status && s.status !== 'draft' ? `Status: ${s.status}` : ''].filter(Boolean).join(' · ');
        if (meta) parts.push('', `*${meta}*`);
        if (s.notes) parts.push('', `> ${flat(s.notes)}`);
        parts.push('');
      });
      return parts.join('\n').trim() + '\n';
    }
    case 'txt':
    default:
      // "1. **Title** — prompt" / "2. prompt": bold titles re-import exactly; an untitled prompt that would read as
      // "Title: prompt" (or another field) is written as "Prompt: …" so it comes back untitled.
      return list
        .map((s, i) => {
          const prompt = flat(resolve(s));
          const title = flat(stripStrayMarkup(s.title || ''));
          if (title) return `${i + 1}. **${title}** — ${prompt}`;
          return `${i + 1}. ${readsAsTitled(prompt) ? `Prompt: ${prompt}` : prompt}`;
        })
        .join('\n');
  }
}

/** True when a numbered line holding `prompt` would not parse back to exactly that untitled prompt. */
function readsAsTitled(prompt) {
  if (!prompt) return false;
  const items = parsePromptList(`1. ${prompt}`);
  return !(items.length === 1 && !items[0].title && items[0].prompt === cleanPrompt(prompt));
}
