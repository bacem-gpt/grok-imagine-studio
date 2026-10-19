// Pure helpers for the Ingredients library: search / tag filter / sort, tag parsing, selection ranges, naming,
// MIME sniffing and clipboard text parsing. No DOM: unit-tested in tests/unit/ingredients.test.mjs.
import { slugify } from '../../../shared/grok-urls.js';

export const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'edited', label: 'Recently edited' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'largest', label: 'Largest (pixels)' },
  { value: 'size', label: 'File size' },
];

export const ORIGIN_LABELS = {
  file: 'File',
  page: 'Grok',
  frame: 'Frame',
  url: 'URL',
  paste: 'Pasted',
  edit: 'Edited',
  grid: 'Reference sheet',
  export: 'Export',
};

const norm = (s) => String(s || '').toLowerCase();

/** Text an ingredient is searchable by. */
export function searchText(ing) {
  return [ing.name, ing.note, ing.prompt, ...(ing.tags || []), ORIGIN_LABELS[ing.origin] || ing.origin].map(norm).join(' \u0001 ');
}

/**
 * Filters and sorts ingredients. search: whitespace-separated terms, all must match (name, tags, note, prompt, origin).
 * tags: every listed tag must be present (case-insensitive). Returns a new array.
 */
export function filterIngredients(list, { search = '', tags = [], sort = 'newest' } = {}) {
  const terms = norm(search).split(/\s+/).filter(Boolean);
  const wanted = tags.map(norm);
  const out = (list || []).filter((ing) => {
    if (wanted.length) {
      const have = new Set((ing.tags || []).map(norm));
      if (!wanted.every((t) => have.has(t))) return false;
    }
    if (terms.length) {
      const text = searchText(ing);
      if (!terms.every((t) => text.includes(t))) return false;
    }
    return true;
  });
  const by = {
    newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    edited: (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }),
    largest: (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
    size: (a, b) => (b.size || 0) - (a.size || 0),
  }[sort];
  if (by) out.sort((a, b) => by(a, b) || (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

/** All tags in use with counts, most used first: [{tag, count}]. Case variants are merged (first spelling wins). */
export function tagCounts(list) {
  const map = new Map();
  for (const ing of list || []) {
    for (const t of new Set((ing.tags || []).map((x) => String(x)))) {
      const k = norm(t);
      const cur = map.get(k);
      if (cur) cur.count++;
      else map.set(k, { tag: t, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** "hero, #Red car ;  style" -> ['hero', 'Red car', 'style'] (trimmed, de-duplicated case-insensitively, max 32 chars). */
export function parseTags(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/[,;\n]+/)) {
    const t = raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!t || seen.has(norm(t))) continue;
    seen.add(norm(t));
    out.push(t);
  }
  return out;
}

/** Union of tag lists, keeping order and the first spelling of each tag. */
export function mergeTags(...lists) {
  return parseTags(lists.flat().join(','));
}

/** Ids from anchor to target (inclusive) in display order; just [target] when the anchor is not visible. */
export function rangeSelect(orderedIds, anchorId, targetId) {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(targetId);
  if (b < 0) return [];
  if (a < 0) return [targetId];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return orderedIds.slice(lo, hi + 1);
}

/** Next focus index for arrow-key navigation in a grid with `cols` columns. */
export function moveFocusIndex(index, key, count, cols) {
  if (!count) return -1;
  if (index < 0) return 0;
  const c = Math.max(1, cols);
  let next = index;
  if (key === 'arrowleft') next = index - 1;
  else if (key === 'arrowright') next = index + 1;
  else if (key === 'arrowup') next = index - c;
  else if (key === 'arrowdown') next = index + c;
  else if (key === 'home') next = 0;
  else if (key === 'end') next = count - 1;
  if (next < 0 || next >= count) return key === 'arrowdown' && index < count - 1 ? count - 1 : index;
  return next;
}

/** Display name from an image URL: last path segment without extension, else the host. */
export function nameFromUrl(url) {
  const s = String(url || '').trim();
  if (s.startsWith('data:')) return 'Image from data URL';
  try {
    const u = new URL(s);
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    const base = seg.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim();
    if (base && !/^(image|preview_image|img|photo|file|download)$/i.test(base)) return base.slice(0, 60);
    return u.hostname.replace(/^www\./, '') || 'Image';
  } catch {
    return 'Image';
  }
}

/** Default name for a pasted image, e.g. "Pasted image 14:05". */
export function pastedName(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `Pasted image ${hh}:${mm}`;
}

/** Name for an edited copy: "Hero" -> "Hero (edited)" (no repeated suffixes). */
export function editedName(name) {
  const base = String(name || 'Image').replace(/\s*\(edited(?: \d+)?\)$/i, '').trim() || 'Image';
  return `${base} (edited)`;
}

/** File name without extension, used as the ingredient name. */
export const baseName = (fileName) => String(fileName || '').replace(/\.[^.]+$/, '').trim() || 'Image';

/** Image MIME type from the first bytes of a file, or null. */
export function sniffImageMime(bytes) {
  const b = bytes || [];
  const at = (i) => b[i] ?? -1;
  const ascii = (i, s) => [...s].every((ch, k) => at(i + k) === ch.charCodeAt(0));
  if (at(0) === 0x89 && ascii(1, 'PNG')) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM')) return 'image/bmp';
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif';
  if (at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0) return 'image/x-icon';
  const head = String.fromCharCode(...Array.from(b).slice(0, 64)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico)$/i;

/** Whether a File looks like an image (by MIME type or extension). */
export const isImageFile = (file) => !!file && ((file.type || '').startsWith('image/') || IMAGE_EXT_RE.test(file.name || ''));

/** File extension for an image MIME type. */
export function extForImageMime(mime) {
  const t = String(mime || '').split(';')[0].toLowerCase();
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/svg+xml': 'svg' }[t] || 'png';
}

/** Download file name for an ingredient. */
export function ingredientFilename(ing, mime = ing?.mime) {
  return `${slugify(ing?.name || 'reference', 60)}.${extForImageMime(mime)}`;
}

/** Output MIME for a saved edit: 'auto' keeps JPEG/WebP/PNG, everything else becomes PNG. */
export function outputMime(srcMime, choice = 'auto') {
  if (choice && choice !== 'auto') return choice;
  const t = String(srcMime || '').toLowerCase();
  if (t === 'image/jpeg' || t === 'image/webp' || t === 'image/png') return t;
  return 'image/png';
}

/** http(s)/data image URLs found in clipboard or drag text (uri-list, plain text or HTML <img src>). */
export function urlsFromText(text, html = '') {
  const out = [];
  const add = (u) => {
    const s = String(u || '').trim();
    if ((/^https?:\/\/\S+$/i.test(s) || /^data:image\//i.test(s)) && !out.includes(s)) out.push(s);
  };
  for (const m of String(html || '').matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) add(m[1].replace(/&amp;/g, '&'));
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('#')) continue; // uri-list comments
    add(line);
  }
  return out;
}

/** Short label for a shot in menus: "3. Neon chase" / "3. A red car drifting…". */
export function shotLabel(shot, index) {
  const raw = String(shot?.title || shot?.prompt || '').replace(/\s+/g, ' ').trim();
  const text = raw ? (raw.length > 42 ? raw.slice(0, 41) + '…' : raw) : 'Untitled shot';
  return `${index + 1}. ${text}`;
}

/**
 * Adds ingredient ids to a shot's ingredientIds (immutable; keeps order, no duplicates).
 * Returns the same project object when nothing changes.
 */
export function addIngredientsToShot(project, shotId, ids) {
  const shots = project?.shots || [];
  let changed = false;
  const next = shots.map((s) => {
    if (s.id !== shotId) return s;
    const cur = s.ingredientIds || [];
    const merged = [...cur, ...ids.filter((id) => !cur.includes(id))];
    if (merged.length === cur.length) return s;
    changed = true;
    return { ...s, ingredientIds: merged };
  });
  return changed ? { ...project, shots: next, updatedAt: Date.now() } : project;
}

const BIBLE_KINDS = ['characters', 'locations'];
const hasRef = (entry, set) => Array.isArray(entry?.ingredientIds) && entry.ingredientIds.some((id) => set.has(id));

/** How many shots and bible entries of a project reference any of `ids`: {shots, entries}. */
export function ingredientUsage(project, ids) {
  const set = ids instanceof Set ? ids : new Set(ids || []);
  const shots = (project?.shots || []).filter((s) => hasRef(s, set)).length;
  let entries = 0;
  for (const k of BIBLE_KINDS) entries += (project?.bible?.[k] || []).filter((e) => hasRef(e, set)).length;
  return { shots, entries };
}

/**
 * Removes ingredient ids from every shot's and bible entry's ingredientIds (immutable).
 * Returns the same project object when none of them is referenced.
 */
export function removeIngredientRefs(project, ids) {
  const set = ids instanceof Set ? ids : new Set(ids || []);
  if (!project || !set.size) return project;
  const strip = (list) => {
    let changed = false;
    const next = list.map((e) => {
      if (!hasRef(e, set)) return e;
      changed = true;
      return { ...e, ingredientIds: e.ingredientIds.filter((id) => !set.has(id)) };
    });
    return changed ? next : list;
  };
  let out = project;
  if (Array.isArray(project.shots)) {
    const shots = strip(project.shots);
    if (shots !== project.shots) out = { ...out, shots };
  }
  if (project.bible) {
    let bible = project.bible;
    for (const k of BIBLE_KINDS) {
      if (!Array.isArray(bible[k])) continue;
      const list = strip(bible[k]);
      if (list !== bible[k]) bible = { ...bible, [k]: list };
    }
    if (bible !== project.bible) out = { ...out, bible };
  }
  return out === project ? project : { ...out, updatedAt: Date.now() };
}

/** Ingredient ids referenced by a project's shots and bible entries (de-duplicated). */
export function referencedIngredientIds(project) {
  const ids = new Set();
  const add = (e) => Array.isArray(e?.ingredientIds) && e.ingredientIds.forEach((id) => typeof id === 'string' && id && ids.add(id));
  (project?.shots || []).forEach(add);
  for (const k of BIBLE_KINDS) (project?.bible?.[k] || []).forEach(add);
  return [...ids];
}
