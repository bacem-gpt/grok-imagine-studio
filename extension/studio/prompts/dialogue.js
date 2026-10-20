// Dialogue planner: a long dialogue split into parts that each fit one generated video (Grok Imagine clips are
// ~6–15 s), one shot per part, so every generated video is known to belong to its part of the dialogue and the
// takes assemble in dialogue order. Pure: no DOM; importable from Node unit tests.
//
// project.dialogue = {
//   parts: [{ id, text, shotId: string|null }],   text = the part's lines ("ALICE: Hello." one per line)
//   scene: string,                                  scene description put in front of every part's prompt
//   speakers: { [key]: { name, voice, mention } }  key = speakerKey(name); voice = "deep calm voice"…
//   settings: { clipSeconds, wps, format: 'says'|'script'|'quotes', continuity: boolean, phrases: string[] },
//   updatedAt }

import { uid } from '../core/utils.js';
import { collapseSpaces } from './text.js';
import { addPhrasesToPrompt } from './phrases.js';
import * as S from './shots.js';
import * as M from '../core/model.js';

export const DIALOGUE_FORMATS = [
  { id: 'says', label: 'Alice says: “…”' },
  { id: 'script', label: 'ALICE: “…”' },
  { id: 'quotes', label: 'Lines only (no names)' },
];
export const SPEEDS = [
  { id: 'slow', label: 'Slow', wps: 2 },
  { id: 'normal', label: 'Normal', wps: 2.5 },
  { id: 'fast', label: 'Fast', wps: 3.1 },
];
export const DEFAULT_SETTINGS = Object.freeze({ clipSeconds: 15, wps: 2.5, format: 'says', continuity: true, phrases: [] });
/** Seconds kept free in every clip (a breath before the first and after the last line). */
export const CLIP_MARGIN = 1;
const LINE_PAUSE = 0.35;
const SENTENCE_PAUSE = 0.2;
export const PART_SEPARATOR = '---';

const str = (v) => (v == null ? '' : String(v));

// ---------------------------------------------------------------------------------------------------------
// Access & mutation
// ---------------------------------------------------------------------------------------------------------

/** The project's dialogue with defaults filled in (never null). */
export function getDialogue(project) {
  const d = project?.dialogue && typeof project.dialogue === 'object' ? project.dialogue : {};
  const settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  settings.clipSeconds = Math.min(60, Math.max(2, Number(settings.clipSeconds) || DEFAULT_SETTINGS.clipSeconds));
  settings.wps = Math.min(6, Math.max(0.8, Number(settings.wps) || DEFAULT_SETTINGS.wps));
  if (!DIALOGUE_FORMATS.some((f) => f.id === settings.format)) settings.format = 'says';
  settings.phrases = Array.isArray(settings.phrases) ? settings.phrases.filter((x) => typeof x === 'string') : [];
  return {
    parts: Array.isArray(d.parts) ? d.parts.filter((x) => x && typeof x.id === 'string').map((x) => ({ id: x.id, text: str(x.text), shotId: x.shotId || null })) : [],
    scene: str(d.scene),
    speakers: d.speakers && typeof d.speakers === 'object' && !Array.isArray(d.speakers) ? d.speakers : {},
    settings,
    updatedAt: Number(d.updatedAt) || 0,
  };
}

/** Returns the project with dialogue = fn(current dialogue) (same project when nothing changed). */
export function updateDialogue(project, fn) {
  const cur = getDialogue(project);
  const next = fn(cur);
  if (!next || JSON.stringify({ ...next, updatedAt: 0 }) === JSON.stringify({ ...cur, updatedAt: 0 })) return project;
  return { ...project, dialogue: { ...next, updatedAt: Date.now() }, updatedAt: Date.now() };
}

export const setDialogueSettings = (project, patch) => updateDialogue(project, (d) => ({ ...d, settings: { ...d.settings, ...patch } }));
export const setScene = (project, scene) => updateDialogue(project, (d) => ({ ...d, scene: str(scene) }));

export const createPart = (text = '') => ({ id: uid('dlp'), text: str(text), shotId: null });

/** Replaces the text of a part. */
export const setPartText = (project, partId, text) => updateDialogue(project, (d) => ({ ...d, parts: d.parts.map((x) => (x.id === partId ? { ...x, text: str(text) } : x)) }));

/** Removes parts (their shots stay in the shot list). */
export const removeParts = (project, ids) => {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  return updateDialogue(project, (d) => ({ ...d, parts: d.parts.filter((x) => !set.has(x.id)) }));
};

/** Inserts an empty (or given) part after `afterId` (or at the end). Returns {project, id}. */
export function insertPart(project, afterId = null, text = '') {
  const part = createPart(text);
  const p = updateDialogue(project, (d) => {
    const parts = d.parts.slice();
    const i = afterId ? parts.findIndex((x) => x.id === afterId) : -1;
    parts.splice(i >= 0 ? i + 1 : parts.length, 0, part);
    return { ...d, parts };
  });
  return { project: p, id: part.id };
}

/** Merges a part with the next one (the next part's shot link is kept only if the first has none). */
export function mergeWithNext(project, partId) {
  return updateDialogue(project, (d) => {
    const i = d.parts.findIndex((x) => x.id === partId);
    if (i < 0 || i >= d.parts.length - 1) return d;
    const a = d.parts[i];
    const b = d.parts[i + 1];
    const parts = d.parts.slice();
    parts.splice(i, 2, { ...a, text: [a.text.trim(), b.text.trim()].filter(Boolean).join('\n'), shotId: a.shotId || b.shotId });
    return { ...d, parts };
  });
}

/**
 * Moves one line across a part boundary: 'first-up' = the part's first line goes to the end of the previous part,
 * 'last-down' = its last line goes to the start of the next part.
 */
export function moveLine(project, partId, how) {
  return updateDialogue(project, (d) => {
    const i = d.parts.findIndex((x) => x.id === partId);
    if (i < 0) return d;
    const lines = splitLines(d.parts[i].text);
    if (!lines.length) return d;
    const parts = d.parts.slice();
    if (how === 'first-up' && i > 0) {
      parts[i - 1] = { ...parts[i - 1], text: [...splitLines(parts[i - 1].text), lines[0]].join('\n') };
      parts[i] = { ...parts[i], text: lines.slice(1).join('\n') };
    } else if (how === 'last-down' && i < parts.length - 1) {
      parts[i + 1] = { ...parts[i + 1], text: [lines[lines.length - 1], ...splitLines(parts[i + 1].text)].join('\n') };
      parts[i] = { ...parts[i], text: lines.slice(0, -1).join('\n') };
    } else return d;
    return { ...d, parts: parts.filter((x) => x.text.trim() || x.shotId) };
  });
}

/** Splits a part in two before line `lineIndex`. Returns {project, id} (id of the new second part). */
export function splitPartAt(project, partId, lineIndex) {
  let newId = null;
  const p = updateDialogue(project, (d) => {
    const i = d.parts.findIndex((x) => x.id === partId);
    if (i < 0) return d;
    const lines = splitLines(d.parts[i].text);
    if (lineIndex <= 0 || lineIndex >= lines.length) return d;
    const second = createPart(lines.slice(lineIndex).join('\n'));
    newId = second.id;
    const parts = d.parts.slice();
    parts.splice(i, 1, { ...d.parts[i], text: lines.slice(0, lineIndex).join('\n') }, second);
    return { ...d, parts };
  });
  return { project: p, id: newId };
}

/** Sets a speaker's voice / @mention (key = speakerKey(name)). */
export function setSpeaker(project, name, patch) {
  const key = speakerKey(name);
  if (!key) return project;
  return updateDialogue(project, (d) => ({ ...d, speakers: { ...d.speakers, [key]: { name: collapseSpaces(name), voice: '', mention: '', ...(d.speakers[key] || {}), ...patch } } }));
}

// ---------------------------------------------------------------------------------------------------------
// Parsing & timing
// ---------------------------------------------------------------------------------------------------------

export const speakerKey = (name) => collapseSpaces(name).toLowerCase();

/** Non-empty lines of a text (trimmed). */
export const splitLines = (text) =>
  str(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== PART_SEPARATOR);

// "ALICE: Hello", "Dr. Smith : …", "Alice (whispering): …", "أليس: …". The name is short and has no sentence end.
const SPEAKER_RE = /^([^\s:："“”«»()[\].!?][^:："“”«»\n]{0,38}?)\s*(\([^)]{1,40}\))?\s*[:：]\s+(.+)$/u;

/**
 * Parses one dialogue line: {speaker, direction, text}. speaker = null for narration / stage directions;
 * direction = a parenthetical such as "(whispering)"; a line that is only "(…)" or "[…]" is a direction.
 */
export function parseLine(line) {
  const l = collapseSpaces(line);
  if (/^[([].*[)\]]$/.test(l)) return { speaker: null, direction: l.slice(1, -1).trim(), text: '' };
  const m = SPEAKER_RE.exec(l);
  if (m && m[1].trim().split(/\s+/).length <= 3 && !/^https?$/i.test(m[1].trim())) {
    return { speaker: m[1].trim().replace(/^[-*•]\s*/, ''), direction: m[2] ? m[2].slice(1, -1).trim() : '', text: unquoteLine(m[3]) };
  }
  return { speaker: null, direction: '', text: unquoteLine(l.replace(/^[-*•]\s+/, '')) };
}

const unquoteLine = (t) => {
  const s = t.trim();
  const m = /^["“«](.*)["”»]$/.exec(s);
  return (m ? m[1] : s).trim();
};

/** Parsed lines of a part (or any text). */
export const parseLines = (text) => splitLines(text).map(parseLine);

/** Distinct speakers of a text, in order of appearance. */
export function speakersOf(text) {
  const seen = new Map();
  for (const l of parseLines(text)) if (l.speaker && !seen.has(speakerKey(l.speaker))) seen.set(speakerKey(l.speaker), l.speaker);
  return [...seen.values()];
}

let segmenter;
/** Spoken words in a text (ICU word segmentation, so CJK / Thai count per word too). */
export function countWords(text) {
  const s = str(text);
  if (!s.trim()) return 0;
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    } catch {
      segmenter = null;
    }
  }
  if (!segmenter) return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  let n = 0;
  for (const seg of segmenter.segment(s)) if (seg.isWordLike) n++;
  return n;
}

/** Estimated speaking time (seconds) of one parsed line. */
function lineSeconds(line, wps) {
  if (!line.text) return line.direction ? 0.6 : 0;
  const sentences = (line.text.match(/[.!?…。！？]+/g) || []).length;
  return countWords(line.text) / wps + Math.max(0, sentences - 1) * SENTENCE_PAUSE;
}

/** Estimated speaking time (seconds) of a text of dialogue lines at `wps` words per second. */
export function estimateSeconds(text, { wps = DEFAULT_SETTINGS.wps } = {}) {
  const lines = parseLines(text);
  if (!lines.length) return 0;
  return lines.reduce((s, l) => s + lineSeconds(l, wps), 0) + (lines.length - 1) * LINE_PAUSE;
}

/** Speaking time available in one clip. */
export const partCapacity = (settings) => Math.max(1, (settings?.clipSeconds || DEFAULT_SETTINGS.clipSeconds) - CLIP_MARGIN);

/** 'ok' | 'tight' (≥ 90 % of the capacity) | 'over' for a part. */
export function fitLevel(text, settings) {
  const est = estimateSeconds(text, settings);
  const cap = partCapacity(settings);
  return est > cap + 0.05 ? 'over' : est >= cap * 0.9 ? 'tight' : 'ok';
}

// ---------------------------------------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------------------------------------

const lineText = (l) => (l.speaker ? `${l.speaker}${l.direction ? ` (${l.direction})` : ''}: ${l.text}` : l.direction && !l.text ? `(${l.direction})` : l.text);

/** Breaks one over-long line into pieces that each fit `cap` (sentences, then clauses, then words). */
function breakLine(line, cap, wps) {
  const pieces = [];
  const sentences = line.text.match(/[^.!?…。！？]+[.!?…。！？]*["”»]?\s*/g) || [line.text];
  const push = (t) => pieces.push({ ...line, text: t.trim() });
  let cur = '';
  const fits = (t) => lineSeconds({ text: t }, wps) <= cap;
  const addChunk = (chunk) => {
    const next = cur ? `${cur} ${chunk.trim()}` : chunk.trim();
    if (!cur || fits(next)) cur = next;
    else {
      push(cur);
      cur = chunk.trim();
    }
  };
  for (const sentence of sentences) {
    if (fits(sentence)) {
      addChunk(sentence);
      continue;
    }
    // A single sentence longer than a clip: by clause, then by words.
    for (const clause of sentence.split(/(?<=[,;:，、；])\s*/)) {
      if (fits(clause)) {
        addChunk(clause);
        continue;
      }
      const words = clause.split(/\s+/).filter(Boolean);
      let step = Math.max(1, Math.floor(cap * wps * 0.95));
      for (let i = 0; i < words.length; i += step) addChunk(words.slice(i, i + step).join(' '));
    }
  }
  if (cur) push(cur);
  // Continuation pieces keep the speaker; a direction belongs to the first piece only.
  return pieces.map((x, i) => (i ? { ...x, direction: '' } : x));
}

/**
 * Splits a dialogue into parts that each fit one clip (settings.clipSeconds minus a breath at each end).
 * Whole lines are kept together when they fit; longer lines break at sentences, then clauses, then words.
 * Existing "---" separator lines force a break. Returns the parts' texts.
 */
export function splitDialogue(script, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const cap = partCapacity(s);
  const out = [];
  for (const block of str(script).split(/^\s*-{3,}\s*$/m)) {
    let cur = [];
    let used = 0;
    const flush = () => {
      if (cur.length) out.push(cur.map(lineText).join('\n'));
      cur = [];
      used = 0;
    };
    for (const raw of splitLines(block)) {
      const parsed = parseLine(raw);
      const pieces = lineSeconds(parsed, s.wps) > cap ? breakLine(parsed, cap, s.wps) : [parsed];
      for (const piece of pieces) {
        const cost = lineSeconds(piece, s.wps) + (cur.length ? LINE_PAUSE : 0);
        if (cur.length && used + cost > cap + 1e-6) flush();
        cur.push(piece);
        used += cur.length > 1 ? cost : lineSeconds(piece, s.wps);
      }
    }
    flush();
  }
  return out;
}

/** The whole dialogue as one text, parts separated by "---" lines. */
export const scriptFromParts = (parts) => (parts || []).map((x) => str(x.text).trim()).join(`\n\n${PART_SEPARATOR}\n\n`);

/**
 * Parts for new part texts, reusing the ids (and shot links) of existing parts: a part whose text is unchanged keeps
 * its id wherever it moved; the others take the remaining old ids in order.
 */
export function reconcileParts(oldParts, texts) {
  const old = (oldParts || []).slice();
  const used = new Set();
  const result = texts.map((text) => {
    const k = collapseSpaces(text);
    const same = old.find((x) => !used.has(x.id) && collapseSpaces(x.text) === k);
    if (same) used.add(same.id);
    return { text, part: same || null };
  });
  const spare = old.filter((x) => !used.has(x.id));
  return result.map(({ text, part }) => {
    if (part) return { ...part, text };
    const reuse = spare.shift();
    return reuse ? { ...reuse, text } : createPart(text);
  });
}

/** Re-splits the whole dialogue (or the given script) into parts that fit the clip length. */
export function autoSplit(project, script = null) {
  return updateDialogue(project, (d) => {
    const texts = splitDialogue(script ?? scriptFromParts(d.parts).replace(/^\s*-{3,}\s*$/gm, ''), d.settings);
    return { ...d, parts: reconcileParts(d.parts, texts) };
  });
}

/** Replaces the parts from a script where "---" lines separate the parts (as edited in the script view). */
export function setScript(project, script) {
  return updateDialogue(project, (d) => {
    const texts = str(script)
      .split(/^\s*-{3,}\s*$/m)
      .map((t) => splitLines(t).join('\n'))
      .filter(Boolean);
    return { ...d, parts: reconcileParts(d.parts, texts) };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Prompts & shots
// ---------------------------------------------------------------------------------------------------------

/** One line as written into a prompt. */
export function formatLine(line, { format = 'says', speakers = {} } = {}) {
  if (!line.text) return line.direction ? `(${line.direction})` : '';
  const quoted = `“${line.text}”`;
  if (!line.speaker || format === 'quotes') return line.speaker ? quoted : `Voice-over: ${quoted}`;
  const info = speakers[speakerKey(line.speaker)] || {};
  const who = info.mention ? info.mention : line.speaker;
  const how = [info.voice, line.direction].filter(Boolean).join(', ');
  if (format === 'script') return `${info.mention ? who : who.toUpperCase()}${how ? ` (${how})` : ''}: ${quoted}`;
  return `${who}${how ? ` (${how})` : ''} says: ${quoted}`;
}

/** The prompt for part `index`: scene, continuity note, the formatted lines, then the dialogue phrases. */
export function buildPartPrompt(dialogue, index) {
  const d = dialogue;
  const part = d.parts[index];
  if (!part) return '';
  const pieces = [];
  if (d.scene.trim()) pieces.push(d.scene.trim().replace(/([^.!?…])$/, '$1.'));
  if (d.settings.continuity && index > 0) pieces.push('The conversation continues from the previous video.');
  const lines = parseLines(part.text)
    .map((l) => formatLine(l, { format: d.settings.format, speakers: d.speakers }))
    .filter(Boolean);
  if (lines.length) pieces.push(lines.join(' '));
  return addPhrasesToPrompt(pieces.join(' '), d.settings.phrases);
}

/** "Part 3 · Alice & Bob" — the title of a part's shot. */
export function partTitle(part, index) {
  const sp = speakersOf(part?.text);
  const who = sp.length > 2 ? `${sp.slice(0, 2).join(', ')} +${sp.length - 2}` : sp.join(' & ');
  return `Part ${index + 1}${who ? ` · ${who}` : ''}`;
}

/** The part linked to a shot: {part, index} or null. */
export function partForShot(project, shotId) {
  if (!shotId) return null;
  const parts = getDialogue(project).parts;
  const index = parts.findIndex((x) => x.shotId === shotId);
  return index >= 0 ? { part: parts[index], index } : null;
}

/** The part a media item (a take) belongs to: {part, index, shot} or null. */
export function partForMedia(project, mediaId) {
  const shot = S.shotForMedia(project, mediaId);
  const hit = shot && partForShot(project, shot.id);
  return hit ? { ...hit, shot } : null;
}

/** Clears shot links whose shot no longer exists. Returns the same project when all links are valid. */
export function repairDialogue(project) {
  if (!project?.dialogue?.parts?.some((x) => x?.shotId && !S.findShot(project, x.shotId))) return project;
  return updateDialogue(project, (d) => ({ ...d, parts: d.parts.map((x) => (x.shotId && !S.findShot(project, x.shotId) ? { ...x, shotId: null } : x)) }));
}

/**
 * Creates a shot for every part that has none (title "Part N · speakers", prompt from buildPartPrompt, length =
 * the clip length), placed after the last existing part's shot or at the end of the shot list.
 * Returns {project, created: [shotId]}.
 */
export function createShotsForParts(project, { partIds = null } = {}) {
  let p = repairDialogue(project);
  const d = getDialogue(p);
  const only = partIds ? new Set(partIds) : null;
  const created = [];
  const links = new Map();
  d.parts.forEach((part, index) => {
    if (part.shotId || (only && !only.has(part.id)) || !part.text.trim()) return;
    // after the shot of the closest earlier part, so the shot list follows the dialogue
    let at;
    for (let k = index - 1; k >= 0; k--) {
      const sid = links.get(d.parts[k].id) || d.parts[k].shotId;
      const i = sid ? S.shotIndex(p, sid) : -1;
      if (i >= 0) {
        at = i + 1;
        break;
      }
    }
    const r = S.addShot(p, { title: partTitle(part, index), prompt: buildPartPrompt(d, index), duration: d.settings.clipSeconds, mode: 'video', notes: `Dialogue part ${index + 1}` }, at);
    p = r.project;
    created.push(r.id);
    links.set(part.id, r.id);
  });
  if (!created.length) return { project, created };
  p = updateDialogue(p, (dd) => ({ ...dd, parts: dd.parts.map((x) => (links.has(x.id) ? { ...x, shotId: links.get(x.id) } : x)) }));
  return { project: p, created };
}

/**
 * Rewrites the prompts (and titles) of linked shots from their parts. Shots already sent / generated / approved
 * are only updated when `includeSent`. Returns {project, updated: [shotId]}.
 */
export function syncShotPrompts(project, { includeSent = false, partIds = null } = {}) {
  const d = getDialogue(project);
  const only = partIds ? new Set(partIds) : null;
  let p = project;
  const updated = [];
  d.parts.forEach((part, index) => {
    if (!part.shotId || (only && !only.has(part.id))) return;
    const shot = S.findShot(p, part.shotId);
    if (!shot || (!includeSent && shot.status !== 'draft')) return;
    const prompt = buildPartPrompt(d, index);
    const title = partTitle(part, index);
    if (shot.prompt === prompt && shot.title === title) return;
    p = S.updateShot(p, shot.id, { prompt, title });
    updated.push(shot.id);
  });
  return { project: p, updated };
}

/** Shots of the parts, in dialogue order (parts without a shot are skipped). */
export const partShotIds = (project) =>
  getDialogue(project)
    .parts.map((x) => x.shotId)
    .filter((id) => id && S.findShot(project, id));

// ---------------------------------------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------------------------------------

/**
 * Subtitles for the parts whose take is on the main track: each part's lines spread over its clip in proportion to
 * their estimated speaking time, skipping half the clip margin at the start.
 * Returns [{start, duration, text, partId}] in timeline order.
 */
export function subtitlePlan(project, { withNames = true } = {}) {
  const d = getDialogue(project);
  const layout = M.layoutVideo(project.tracks.video);
  const out = [];
  d.parts.forEach((part) => {
    if (!part.shotId) return;
    const shot = S.findShot(project, part.shotId);
    if (!shot) return;
    const takes = new Set(S.validTakes(project, shot));
    const items = layout.filter((it) => takes.has(it.clip.mediaId));
    const lines = parseLines(part.text).filter((l) => l.text);
    if (!items.length || !lines.length) return;
    const costs = lines.map((l) => Math.max(0.4, lineSeconds(l, d.settings.wps)));
    const total = costs.reduce((a, b) => a + b, 0);
    for (const it of items) {
      const lead = Math.min(CLIP_MARGIN / 2, it.duration * 0.05);
      const span = Math.max(0.5, it.duration - lead * 2);
      // lines at their estimated pace; squeezed only when the speech is longer than the clip
      const need = total + LINE_PAUSE * (lines.length - 1);
      const scale = need > span ? span / need : 1;
      let t = it.start + lead;
      lines.forEach((l, i) => {
        const dur = Math.max(0.6, costs[i] * scale);
        out.push({ start: t, duration: Math.min(dur, Math.max(0.3, it.end - t)), text: withNames && l.speaker ? `${l.speaker}: ${l.text}` : l.text, partId: part.id });
        t += dur + (lines.length > 1 ? LINE_PAUSE * scale : 0);
      });
    }
  });
  return out.filter((x) => x.duration > 0.1).sort((a, b) => a.start - b.start);
}
