// Prompt library operations: snippets ("prepared texts", global in libraryStore.snippets), the project bible
// (project.bible: characters, locations, style guide, notes) and custom builder chips (libraryStore.presets).
// Pure: array/object in, new array/object out.

import { uid } from '../core/utils.js';
import { collapseSpaces, tokenKey, normalizeForMatch } from './text.js';

// ---------------------------------------------------------------------------------------------------------
// Snippets: {id, title, text, tags: string[], createdAt, updatedAt}
// ---------------------------------------------------------------------------------------------------------

/**
 * Parses tags separated by commas, semicolons, new lines or #hashes ("film noir, house style #mood") into unique
 * lower-case tags; spaces inside a tag are kept ("film noir").
 */
export function parseTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n#]+/);
  const out = [];
  for (const raw of list) {
    const t = collapseSpaces(String(raw).replace(/^\s*#+/, '')).toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Creates a snippet record. */
export function createSnippet({ title = '', text = '', tags = [] } = {}) {
  const now = Date.now();
  const t = collapseSpaces(title);
  const body = String(text ?? '').trim();
  return { id: uid('snp'), title: t || deriveTitle(body), text: body, tags: parseTags(tags), createdAt: now, updatedAt: now };
}

/** Short title from the first words of a text ("Untitled snippet" when empty). */
export function deriveTitle(text, words = 5) {
  const w = collapseSpaces(text).split(' ').filter(Boolean);
  if (!w.length) return 'Untitled snippet';
  const t = w.slice(0, words).join(' ').replace(/[,.;:!?]+$/, '');
  return w.length > words ? `${t}…` : t;
}

/** Inserts or replaces (by id) a snippet; new snippets go first. */
export function upsertSnippet(list, snippet) {
  const arr = Array.isArray(list) ? list : [];
  const i = arr.findIndex((s) => s.id === snippet.id);
  if (i < 0) return [snippet, ...arr];
  const next = arr.slice();
  next[i] = { ...arr[i], ...snippet, tags: parseTags(snippet.tags ?? arr[i].tags), updatedAt: Date.now() };
  return next;
}

export const removeSnippet = (list, id) => (Array.isArray(list) ? list.filter((s) => s.id !== id) : []);

/** Token name used as {{name}} for a snippet. */
export const snippetToken = (snippet) => tokenKey(snippet?.title);

/** Filters snippets by free-text search (every word must match title, text or tags) and an optional tag. */
export function filterSnippets(list, { search = '', tag = '' } = {}) {
  const words = normalizeForMatch(search).split(' ').filter(Boolean);
  const wantTag = String(tag || '').toLowerCase();
  return (Array.isArray(list) ? list : []).filter((s) => {
    if (wantTag && !(s.tags || []).includes(wantTag)) return false;
    if (!words.length) return true;
    const hay = normalizeForMatch(`${s.title} ${s.text} ${(s.tags || []).join(' ')}`);
    return words.every((w) => hay.includes(w));
  });
}

/** All tags with usage counts, most used first then alphabetical: [{tag, count}]. */
export function allTags(list) {
  const counts = new Map();
  for (const s of Array.isArray(list) ? list : []) for (const t of s.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Inserts `insert` into `text` replacing [start, end); adds spacing so words don't run together. Returns {text, cursor}. */
export function insertAt(text, insert, start = null, end = null) {
  const s = String(text ?? '');
  const ins = String(insert ?? '');
  const a = start == null ? s.length : Math.max(0, Math.min(s.length, start));
  const b = end == null ? a : Math.max(a, Math.min(s.length, end));
  const before = s.slice(0, a);
  const after = s.slice(b);
  const lead = before && !/[\s(\["“]$/.test(before) && !/^[\s,.;:!?)]/.test(ins) ? ' ' : '';
  const trail = after && !/^[\s,.;:!?)\]”"]/.test(after) && !/\s$/.test(ins) ? ' ' : '';
  const out = before + lead + ins + trail + after;
  return { text: out, cursor: (before + lead + ins).length };
}

/** Starter prepared texts offered on an empty library. */
export const STARTER_SNIPPETS = [
  { title: 'No text', text: 'no text, no subtitles, no watermarks, no logos', tags: ['quality'] },
  { title: 'Consistency', text: 'keep the same character, face, hairstyle, outfit and colours as in the previous shots', tags: ['consistency'] },
  { title: 'Cinematic look', text: 'cinematic, shot on 35mm film, shallow depth of field, soft natural light, subtle film grain', tags: ['style'] },
  { title: 'Smooth motion', text: 'smooth realistic motion, no flicker, no morphing, stable anatomy', tags: ['quality'] },
  { title: 'Continue shot', text: 'continue seamlessly from the previous shot with the same lighting, framing and camera direction', tags: ['continuity'] },
  { title: 'Vertical', text: 'vertical 9:16 composition with the subject centered and room for captions', tags: ['format'] },
];

// ---------------------------------------------------------------------------------------------------------
// Bible: project.bible = {characters: [{id, name, description, ingredientIds}], locations: [...], style, notes}
// ---------------------------------------------------------------------------------------------------------

export const BIBLE_KINDS = ['characters', 'locations'];

const emptyBible = () => ({ characters: [], locations: [], style: '', notes: '' });

/** The project's bible with defaults filled in. */
export function getBible(project) {
  const b = project?.bible && typeof project.bible === 'object' ? project.bible : {};
  return {
    ...emptyBible(),
    ...b,
    characters: Array.isArray(b.characters) ? b.characters : [],
    locations: Array.isArray(b.locations) ? b.locations : [],
    style: typeof b.style === 'string' ? b.style : '',
    notes: typeof b.notes === 'string' ? b.notes : '',
  };
}

const withBible = (project, bible) => ({ ...project, bible, updatedAt: Date.now() });

/** Creates a bible entry {id, name, description, ingredientIds}. */
export function createBibleEntry({ name = '', description = '', ingredientIds = [] } = {}) {
  return { id: uid('bib'), name: collapseSpaces(name), description: String(description ?? '').trim(), ingredientIds: Array.isArray(ingredientIds) ? [...ingredientIds] : [] };
}

/** A name not used yet in the bible ("Character", "Character 2", …). */
export function uniqueBibleName(project, base) {
  const b = getBible(project);
  const taken = new Set([...b.characters, ...b.locations].map((e) => tokenKey(e.name)));
  if (!taken.has(tokenKey(base))) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(tokenKey(`${base} ${i}`))) return `${base} ${i}`;
  return `${base} ${Date.now()}`;
}

/** Adds an entry to bible[kind]. Returns {project, id}. */
export function addBibleEntry(project, kind, partial = {}) {
  if (!BIBLE_KINDS.includes(kind)) return { project, id: null };
  const b = getBible(project);
  const entry = createBibleEntry(partial);
  return { project: withBible(project, { ...b, [kind]: [...b[kind], entry] }), id: entry.id };
}

/** Patches an entry of bible[kind]. */
export function updateBibleEntry(project, kind, id, patch) {
  if (!BIBLE_KINDS.includes(kind)) return project;
  const b = getBible(project);
  const i = b[kind].findIndex((e) => e.id === id);
  if (i < 0) return project;
  const cur = b[kind][i];
  const next = { ...cur, ...patch, id: cur.id };
  if ('name' in (patch || {})) next.name = collapseSpaces(patch.name);
  if (Object.keys(next).every((k) => next[k] === cur[k])) return project;
  const list = b[kind].slice();
  list[i] = next;
  return withBible(project, { ...b, [kind]: list });
}

export function removeBibleEntry(project, kind, id) {
  if (!BIBLE_KINDS.includes(kind)) return project;
  const b = getBible(project);
  if (!b[kind].some((e) => e.id === id)) return project;
  return withBible(project, { ...b, [kind]: b[kind].filter((e) => e.id !== id) });
}

/** Sets bible.style or bible.notes. */
export function setBibleText(project, key, value) {
  if (key !== 'style' && key !== 'notes') return project;
  const b = getBible(project);
  const v = String(value ?? '');
  if (b[key] === v) return project;
  return withBible(project, { ...b, [key]: v });
}

/** "@Name" mention text for an entry (names with spaces work as typed). */
export const mentionFor = (entry) => `@${collapseSpaces(entry?.name)}`;

/** Bible entries whose @mention (or {{name}}) appears in a text. */
export function mentionedEntries(project, text) {
  const b = getBible(project);
  const lower = String(text ?? '').toLowerCase();
  const out = [];
  for (const kind of BIBLE_KINDS) {
    for (const e of b[kind]) {
      if (!e.name) continue;
      const n = e.name.toLowerCase();
      const k = tokenKey(e.name);
      if (lower.includes(`@${n}`) || lower.includes(`@${k}`) || lower.includes(`@${k.replace(/-/g, '_')}`) || new RegExp(`\\{\\{\\s*${k.replace(/-/g, '[-_ ]')}\\s*(\\|[^}]*)?\\}\\}`, 'i').test(text || '')) out.push({ kind, ...e });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Custom builder chips: libraryStore.presets = [{id, group: <field key>, label, text}]
// ---------------------------------------------------------------------------------------------------------

/** Creates a custom chip for a builder field. */
export function createCustomPreset(fieldKey, text, label = '') {
  const t = collapseSpaces(text).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const l = collapseSpaces(label) || (t.length > 28 ? `${t.slice(0, 27)}…` : t);
  return { id: uid('pst'), group: fieldKey, label: l, text: t };
}

/** Adds a custom chip unless the same text already exists for that field. */
export function addCustomPreset(list, preset) {
  const arr = Array.isArray(list) ? list : [];
  if (!preset?.text) return arr;
  if (arr.some((p) => p.group === preset.group && p.text.toLowerCase() === preset.text.toLowerCase())) return arr;
  return [...arr, preset];
}

export const removeCustomPreset = (list, id) => (Array.isArray(list) ? list.filter((p) => p.id !== id) : []);
