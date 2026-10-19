// Ingredients (reference images) library API — global across projects, persisted in libraryStore (metadata) and
// IndexedDB `blobs`/`thumbs` (binaries, keyed by ingredient id). Shared by the Ingredients and Prompts tabs.
//
//   addIngredient(blob, {name, origin, sourceUrl, tags, note, prompt}) -> Promise<id>
//   getIngredient(id) -> metadata | null
//   getIngredientBlob(id) -> Promise<Blob|null>
//   getIngredientThumb(id) -> Promise<string|null>   (object URL, cached)
//   getIngredientUrl(id) -> Promise<string|null>     (object URL of the full image, cached)
//   updateIngredient(id, patch), replaceIngredientImage(id, blob), removeIngredients(ids)
//   attachIngredientsToGrok(ids) -> Promise<{ok, attached, errors, methods}>  (uploads into the grok.com composer)
//   ingredientFromPageItem(pageMedia) -> Promise<id>  (downloads a grok.com image into the library)

import { libraryStore } from './store.js';
import { db } from './db.js';
import { uid } from './utils.js';
import { bridge } from './bridge.js';
import { REQ } from '../../shared/protocol.js';
import { fetchMediaBlob } from './media.js';
import { cleanHttpUrl, isPageMediaUrl } from './page-input.js';
import { isGrokMediaHost } from '../../shared/grok-urls.js';

const thumbCache = new Map();
const urlCache = new Map();
const THUMB_MAX = 360;

/**
 * @typedef {Object} Ingredient
 * @property {string} id
 * @property {string} name
 * @property {'image'} kind
 * @property {string} mime
 * @property {number} width
 * @property {number} height
 * @property {number} size
 * @property {string[]} tags
 * @property {string} note
 * @property {string|null} prompt       prompt that generated it (grok images)
 * @property {'file'|'page'|'frame'|'url'|'paste'|'edit'|'grid'|'export'} origin
 * @property {string|null} sourceUrl
 * @property {number} createdAt
 * @property {number} updatedAt
 */

async function makeThumb(blob) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const dims = { width: bmp.width, height: bmp.height };
  bmp.close();
  return { thumb: await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 }), ...dims };
}

export async function addIngredient(blob, { name = 'Image', origin = 'file', sourceUrl = null, tags = [], note = '', prompt = null } = {}) {
  if (!blob || !(blob.type || '').startsWith('image/')) throw new Error('Ingredients must be images');
  const id = uid('ing');
  const { thumb, width, height } = await makeThumb(blob);
  await db.putBlob(id, blob);
  await db.putThumbs(id, { thumb, strip: null, stripCount: 0, peaks: null });
  const now = Date.now();
  // sourceUrl is shown as a link in the details: only http(s) links are kept.
  const item = { id, name, kind: 'image', mime: blob.type, width, height, size: blob.size, tags, note, prompt, origin, sourceUrl: cleanHttpUrl(sourceUrl), createdAt: now, updatedAt: now };
  libraryStore.set((s) => ({ ...s, ingredients: [item, ...s.ingredients] }));
  return id;
}

export const getIngredient = (id) => libraryStore.get().ingredients.find((i) => i.id === id) || null;

export const getIngredientBlob = async (id) => (await db.getBlob(id)) || null;

export async function getIngredientThumb(id) {
  if (!thumbCache.has(id)) {
    thumbCache.set(
      id,
      db.getThumbs(id).then((t) => (t?.thumb ? URL.createObjectURL(t.thumb) : null)),
    );
  }
  return thumbCache.get(id);
}

export async function getIngredientUrl(id) {
  if (!urlCache.has(id)) {
    urlCache.set(
      id,
      db.getBlob(id).then((b) => (b ? URL.createObjectURL(b) : null)),
    );
  }
  return urlCache.get(id);
}

export function updateIngredient(id, patch) {
  libraryStore.set((s) => ({ ...s, ingredients: s.ingredients.map((i) => (i.id === id ? { ...i, ...patch, updatedAt: Date.now() } : i)) }));
}

/** Overwrites the image of an existing ingredient (after editing). */
export async function replaceIngredientImage(id, blob) {
  const { thumb, width, height } = await makeThumb(blob);
  await db.putBlob(id, blob);
  await db.putThumbs(id, { thumb, strip: null, stripCount: 0, peaks: null });
  invalidateIngredientCache([id]);
  updateIngredient(id, { mime: blob.type, width, height, size: blob.size });
}

export async function removeIngredients(ids) {
  const set = new Set(ids);
  libraryStore.set((s) => ({ ...s, ingredients: s.ingredients.filter((i) => !set.has(i.id)) }));
  invalidateIngredientCache([...set]);
  for (const id of set) {
    await db.deleteBlob(id).catch(() => {});
    await db.deleteThumbs(id).catch(() => {});
  }
}

/** Drops (and revokes) cached object URLs, e.g. after another studio window replaced or deleted the image. */
export function invalidateIngredientCache(ids) {
  for (const id of ids) {
    for (const cache of [thumbCache, urlCache]) {
      const p = cache.get(id);
      if (p) p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
      cache.delete(id);
    }
  }
}

/** Uploads ingredient images into the grok.com composer (in order). */
export async function attachIngredientsToGrok(ids) {
  const errors = [];
  const methods = []; // how the content script attached them (e.g. 'file-input', 'drop'), for the UI
  let attached = 0;
  for (const id of ids) {
    const meta = getIngredient(id);
    const blob = await getIngredientBlob(id);
    if (!blob) {
      errors.push(`${meta?.name || id}: missing image`);
      continue;
    }
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const name = `${(meta?.name || 'reference').replace(/[^\w.-]+/g, '_').slice(0, 40)}.${ext}`;
    try {
      const res = await bridge.request(REQ.COMPOSER_ATTACH, { blob: new File([blob], name, { type: blob.type }), name }, { timeout: 30000 });
      if (res?.ok) attached++;
      else errors.push(`${meta?.name || id}: ${res?.error || 'not attached'}`);
      if (res?.ok && res.method && !methods.includes(res.method)) methods.push(res.method);
    } catch (e) {
      errors.push(`${meta?.name || id}: ${e.message || e}`);
    }
  }
  return { ok: attached > 0 && errors.length === 0, attached, errors, methods };
}

/**
 * Downloads a grok.com page image into the library (de-duplicated by source URL). Links to other sites (a context-menu
 * target) are fetched through the page, never with the extension's privileges.
 */
export async function ingredientFromPageItem(item) {
  const existing = libraryStore.get().ingredients.find((i) => i.sourceUrl && i.sourceUrl === item.url);
  if (existing) return existing.id;
  const urls = [item.url, ...(item.altUrls || []), item.thumbUrl].filter((u) => isPageMediaUrl(u, { userTarget: true }));
  if (!urls.length) throw new Error('This image has no usable link');
  const { blob } = await fetchMediaBlob(urls, { kindHint: 'image', extensionHost: isGrokMediaHost });
  const name = (item.prompt || 'Grok image').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Grok image';
  return addIngredient(blob, { name, origin: 'page', sourceUrl: item.url, prompt: item.prompt || null });
}
