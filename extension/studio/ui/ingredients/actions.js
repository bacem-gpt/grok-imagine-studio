// Ingredients actions shared by the Ingredients tab and the IngredientPicker: imports (files, clipboard, URL,
// grok.com images, bin images / video frames), Grok/project actions and library edits. Every action reports its
// outcome with a toast. The app-event handlers at the bottom are registered when this module is imported (at boot,
// through app.js), so 'ingredient.fromPage' / 'ingredient.add' work even if the tab was never opened.
import {
  addIngredient,
  getIngredient,
  getIngredientBlob,
  updateIngredient,
  removeIngredients,
  attachIngredientsToGrok,
  ingredientFromPageItem,
} from '../../core/ingredients.js';
import { fetchMediaBlob, ensureHostPermission, retryMedia, getMediaBlob, grabFrame } from '../../core/media.js';
import * as M from '../../core/model.js';
import { db } from '../../core/db.js';
import { appEvents } from '../../core/app-state.js';
import { projectStore, uiStore, libraryStore } from '../../core/store.js';
import { bridge } from '../../core/bridge.js';
import { downloadBlob, copyImage, pluralize, formatTime, uid } from '../../core/utils.js';
import { toast, dismissToast, confirmDialog, promptDialog, pickFiles, showMenu } from '../kit.js';
import { normalizeImageBlob } from './render.js';
import { setIng, revealIds, withBusy, ingStore, canLeaveEditor } from './state.js';
import {
  isImageFile,
  baseName,
  pastedName,
  nameFromUrl,
  urlsFromText,
  parseTags,
  mergeTags,
  ingredientFilename,
  shotLabel,
  addIngredientsToShot,
  ingredientUsage,
  removeIngredientRefs,
  referencedIngredientIds,
} from './logic.js';

const errMsg = (e) => String(e?.message || e || 'Unknown error');
const nameOf = (id) => getIngredient(id)?.name || 'image';
const bySourceUrl = (url) => (url ? libraryStore.get().ingredients.find((i) => i.sourceUrl && i.sourceUrl === url) || null : null);

/** Switches the studio to the Ingredients tab and selects ids. */
export function showIngredients(ids = []) {
  uiStore.set((s) => (s.tab === 'ingredients' ? s : { ...s, tab: 'ingredients' }));
  if (ids.length) revealIds(ids);
}

/** Opens the image editor workspace for an ingredient (asks first if another image has unsaved edits). */
export async function openEditor(id, tab = 'edit') {
  if (!getIngredient(id)) return;
  const cur = ingStore.get().editorId;
  if (cur && cur !== id && !(await canLeaveEditor())) return;
  if (!getIngredient(id)) return;
  showIngredients();
  revealIds([id], { flash: false }); // selected (and visible) when the editor closes
  setIng({ editorId: id, editorTab: tab });
}

/** Opens the grid composer for 2..9 ingredients. */
export function openComposer(ids) {
  const list = ids.filter((id) => getIngredient(id));
  if (list.length < 2) {
    toast('Select at least 2 images to make a reference sheet', { kind: 'warn' });
    return;
  }
  if (list.length > 9) toast('A reference sheet holds up to 9 images: using the first 9', { kind: 'warn' });
  showIngredients();
  setIng({ composerIds: list.slice(0, 9) });
}

// ---------------------------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------------------------

/**
 * Adds image blobs to the library. entries: [{blob, name, origin, sourceUrl, prompt, tags, note}].
 * Options: reveal (select the new items), announce (success toast; 'show' adds a "Show" action), quiet (no toasts).
 * Returns the new ids (failed entries are skipped and reported).
 */
export async function importImageBlobs(entries, { reveal = true, announce = true, quiet = false } = {}) {
  return withBusy(async () => {
    const ids = [];
    const errors = [];
    for (const e of entries) {
      try {
        ids.push(await addImageEntry(e));
      } catch (err) {
        console.warn('[gis] ingredient import failed', err);
        errors.push(`${e.name || 'image'}: ${errMsg(err)}`);
      }
    }
    if (reveal && ids.length) revealIds(ids);
    if (!quiet) {
      if (errors.length) toast(ids.length ? `Added ${ids.length}, ${errors.length} failed. ${errors[0]}` : `Could not add the image. ${errors[0]}`, { kind: 'error', duration: 6000 });
      else if (announce && ids.length) announceAdded(ids, announce === 'show');
    }
    return ids;
  });
}

/** Normalises one image entry ({blob, name, origin, …}) and adds it to the library. Throws on failure. */
async function addImageEntry(e) {
  const blob = await normalizeImageBlob(e.blob);
  return addIngredient(blob, {
    name: e.name || 'Image',
    origin: e.origin || 'file',
    sourceUrl: e.sourceUrl || null,
    prompt: e.prompt || null,
    tags: e.tags || [],
    note: e.note || '',
  });
}

function announceAdded(ids, withShow) {
  const msg = ids.length === 1 ? `Added “${nameOf(ids[0])}” to Ingredients` : `Added ${ids.length} images to Ingredients`;
  const onTab = uiStore.get().tab === 'ingredients';
  let action = null;
  if (withShow && !onTab) action = { label: 'Show', run: () => showIngredients(ids) };
  else if (onTab && ingStore.get().editorId && ids.length === 1) action = { label: 'Edit', run: () => openEditor(ids[0]) }; // added while editing another image
  toast(msg, { kind: 'success', action });
}

// Imports of one source URL that are still downloading. A second request for the same URL (a double click on
// grok.com's "Ingredient" button, the same link pasted twice) waits for the first instead of adding a duplicate.
const inflight = new Map(); // url -> Promise<id>

/** Runs job() unless an import of `url` is already running; returns {promise, shared}. */
function importOnce(url, job) {
  const running = inflight.get(url);
  if (running) return { promise: running, shared: true };
  const promise = job().finally(() => inflight.delete(url));
  inflight.set(url, promise);
  return { promise, shared: false };
}

/** Imports local image files (non-images are skipped with a warning). */
export async function importFiles(files, opts = {}) {
  const list = [...(files || [])];
  const images = list.filter(isImageFile);
  const skipped = list.length - images.length;
  if (skipped && !opts.quiet) toast(`Skipped ${pluralize(skipped, 'file')} that ${skipped === 1 ? 'is' : 'are'} not an image`, { kind: 'warn' });
  if (!images.length) return [];
  return importImageBlobs(
    images.map((f) => ({ blob: f, name: baseName(f.name), origin: opts.origin || 'file' })),
    opts,
  );
}

/** Opens the file picker and imports the chosen images. */
export async function pickAndImportFiles(opts = {}) {
  const files = await pickFiles({ accept: 'image/*,.svg,.avif,.webp', multiple: opts.multiple !== false });
  return files.length ? importFiles(files, opts) : [];
}

/** Image files contained in a DataTransfer (clipboard or drop). */
export function imageFilesFrom(dt) {
  if (!dt) return [];
  const files = [];
  for (const item of dt.items || []) {
    if (item.kind === 'file' && (item.type || '').startsWith('image/')) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) for (const f of dt.files || []) if (isImageFile(f)) files.push(f);
  return files;
}

/**
 * Imports images (or image URLs) from a paste/drop DataTransfer. Returns the new ids, or null when the data holds
 * nothing image-like (so the caller can let the default behaviour happen).
 */
export async function importFromDataTransfer(dt, { origin = 'paste', ...opts } = {}) {
  const files = imageFilesFrom(dt);
  if (files.length) {
    return importImageBlobs(
      files.map((f) => ({ blob: f, name: origin === 'paste' && /^image\.\w+$/i.test(f.name || 'image.png') ? pastedName() : baseName(f.name), origin })),
      opts,
    );
  }
  const urls = urlsFromText(dt.getData?.('text/uri-list') || dt.getData?.('text/plain') || '', dt.getData?.('text/html') || '');
  if (!urls.length) return null;
  const ids = [];
  for (const url of urls.slice(0, 12)) {
    const id = await importFromUrl(url, opts).catch(() => null);
    if (id) ids.push(id);
  }
  return ids;
}

/** "Paste" button: reads images (or an image URL) with the async Clipboard API. */
export async function pasteFromClipboard(opts = {}) {
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch {
    toast('The browser blocked clipboard access here. Press Ctrl+V (⌘V) in this panel instead.', { kind: 'warn', duration: 5000 });
    return [];
  }
  const entries = [];
  let text = '';
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) entries.push({ blob: await item.getType(type), name: pastedName(), origin: 'paste' });
    else if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
  }
  if (entries.length) return importImageBlobs(entries, opts);
  const [url] = urlsFromText(text);
  if (url) return [await importFromUrl(url, opts)].filter(Boolean);
  toast('No image on the clipboard. Copy an image (or an image URL) first.', { kind: 'warn' });
  return [];
}

/**
 * Downloads an image URL into the library. Call it from a user gesture: the host permission prompt needs one.
 * Throws on failure after showing an error toast.
 */
export async function importFromUrl(url, opts = {}) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean) && !/^data:image\//i.test(clean)) {
    toast('Enter an http(s) image URL', { kind: 'error' });
    throw new Error('Enter an http(s) image URL');
  }
  const permission = clean.startsWith('data:') ? Promise.resolve(true) : ensureHostPermission(clean); // starts inside the gesture
  return withBusy(async () => {
    try {
      if (!(await permission)) throw new Error('Access to that site was not granted');
      const existing = bySourceUrl(clean);
      if (existing) {
        if (opts.reveal !== false) revealIds([existing.id]);
        if (!opts.quiet) toast(`“${existing.name}” is already in Ingredients`);
        return existing.id;
      }
      const sourceUrl = clean.startsWith('data:') ? null : clean;
      const { promise, shared } = importOnce(clean, async () => {
        const { blob } = await fetchMediaBlob([clean], { kindHint: 'image' });
        return addImageEntry({ blob, name: nameFromUrl(clean), origin: 'url', sourceUrl });
      });
      const id = await promise;
      if (opts.reveal !== false) revealIds([id]);
      if (!opts.quiet) {
        if (shared) toast(`“${nameOf(id)}” is already in Ingredients`);
        else announceAdded([id], opts.announce === 'show');
      }
      return id;
    } catch (e) {
      const msg = /unexpected content \(text\/html|Not an image \(text\/html/.test(errMsg(e)) ? 'that link opens a web page, not an image. Copy the image address instead.' : errMsg(e);
      if (!opts.quiet) toast(`Could not import the URL: ${msg}`, { kind: 'error', duration: 6000 });
      throw e;
    }
  });
}

/** Asks for a URL, then imports it. */
export async function promptImportUrl(opts = {}) {
  const url = await promptDialog({ title: 'Add image from URL', label: 'Image URL', placeholder: 'https://…/image.jpg', confirmLabel: 'Add' });
  if (!url) return [];
  try {
    return [await importFromUrl(url, opts)];
  } catch {
    return [];
  }
}

/** A PageMedia usable as an image ingredient: images as-is, videos through their poster frame (else null). */
export function asImageItem(item) {
  if (!item) return null;
  if (item.kind !== 'video') return item;
  return item.thumbUrl ? { ...item, kind: 'image', url: item.thumbUrl, altUrls: [] } : null;
}

/** Adds grok.com images (PageMedia) to the library (already-imported URLs resolve to the existing item). */
export async function importPageItems(items, opts = {}) {
  return withBusy(async () => {
    const ids = [];
    const errors = [];
    let existing = 0;
    for (const raw of items) {
      const item = asImageItem(raw);
      if (!item) {
        errors.push('this Grok video has no poster image. Add it to the bin and grab a frame instead.');
        continue;
      }
      try {
        const known = !!bySourceUrl(item.url);
        const { promise, shared } = importOnce(item.url, () => ingredientFromPageItem(item));
        const id = await promise;
        if (known || shared) existing++;
        ids.push(id);
      } catch (e) {
        console.warn('[gis] grok image import failed', e);
        errors.push(errMsg(e));
      }
    }
    if (opts.reveal !== false && ids.length) revealIds(ids);
    if (!opts.quiet) {
      if (errors.length) toast(`Could not add ${errors.length === items.length ? 'the Grok image' : `${errors.length} of ${items.length} images`}: ${errors[0]}`, { kind: 'error', duration: 6000 });
      else if (ids.length && existing === ids.length) toast(ids.length === 1 ? `“${nameOf(ids[0])}” is already in Ingredients` : 'These images are already in Ingredients', { action: opts.announce === 'show' && uiStore.get().tab !== 'ingredients' ? { label: 'Show', run: () => showIngredients(ids) } : null });
      else if (ids.length) announceAdded(ids, opts.announce === 'show');
    }
    return ids;
  });
}

/** Adds a bin image, or a frame of a bin video at `time` seconds, to the library. */
export async function importFromBin(mediaId, time = 0, opts = {}) {
  const media = projectStore.get()?.media[mediaId];
  if (!media) return null;
  return withBusy(async () => {
    try {
      let blob;
      let name = media.name;
      if (media.kind === 'image') {
        blob = await getMediaBlob(mediaId);
        if (!blob) throw new Error('The image is not downloaded yet');
      } else if (media.kind === 'video') {
        blob = await grabFrame(mediaId, time, { type: 'image/png' });
        name = `${media.name} @ ${formatTime(time)}`;
      } else {
        throw new Error('Audio has no images');
      }
      const [id] = await importImageBlobs([{ blob, name, origin: 'frame', sourceUrl: media.sourceUrl || null, prompt: media.prompt || null }], { ...opts, quiet: true });
      if (!id) throw new Error('Could not read the frame');
      if (!opts.quiet) announceAdded([id], false);
      return id;
    } catch (e) {
      toast(`Could not add from the bin: ${errMsg(e)}`, { kind: 'error' });
      return null;
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// Actions on ingredients
// ---------------------------------------------------------------------------------------------------------

const METHOD_LABELS = { 'file-input': 'upload field', input: 'upload field', drop: 'drag and drop', paste: 'paste', button: 'upload button' };

/** Attaches ingredients to the grok.com composer, in order. Returns the attach result (or null). */
export async function attachToGrok(ids) {
  const list = ids.filter((id) => getIngredient(id));
  if (!list.length) return null;
  if (!bridge.connected) {
    toast('Open grok.com to attach images to the Grok composer', { kind: 'warn', duration: 5000, action: { label: 'Open grok.com', run: () => window.open('https://grok.com/imagine', '_blank', 'noopener') } });
    return null;
  }
  const pending = toast(`Attaching ${pluralize(list.length, 'image')} to Grok…`, { duration: 0 });
  try {
    const res = await attachIngredientsToGrok(list);
    dismissToast(pending);
    const via = (res.methods || []).map((m) => METHOD_LABELS[m] || m).join(', ');
    if (res.ok) toast(`Attached ${pluralize(res.attached, 'image')} to Grok${via ? ` (via ${via})` : ''}`, { kind: 'success' });
    else if (res.attached) toast(`Attached ${res.attached} of ${list.length} to Grok. ${res.errors[0] || ''}`, { kind: 'warn', duration: 7000 });
    else toast(`Could not attach to Grok: ${res.errors[0] || 'the composer did not accept the image'}`, { kind: 'error', duration: 7000 });
    return res;
  } catch (e) {
    dismissToast(pending);
    toast(`Could not attach to Grok: ${errMsg(e)}`, { kind: 'error', duration: 7000 });
    return null;
  }
}

/**
 * Adds ingredients to the project bin as stills (media origin 'frame', kind image, with the ingredient's prompt and
 * tags); optionally appends them to the end of the timeline. The whole action is ONE undo step: the media items and
 * their clips are added in a single project update, then each image is processed (probe + thumbnails) in the
 * background from its stored copy. Returns the new media ids.
 */
export async function addToProject(ids, { toTimeline = false } = {}) {
  const list = ids.filter((id) => getIngredient(id));
  const projectId = projectStore.get()?.id;
  if (!list.length || !projectId) return [];
  return withBusy(async () => {
    const items = [];
    const errors = [];
    for (const id of list) {
      const ing = getIngredient(id);
      try {
        const blob = await getIngredientBlob(id);
        if (!blob) throw new Error('missing image');
        const media = M.createMediaItem({
          kind: 'image',
          name: ing.name,
          origin: 'frame',
          prompt: ing.prompt || null,
          tags: [...(ing.tags || [])],
          mime: blob.type,
          size: blob.size,
          width: ing.width,
          height: ing.height,
          status: 'loading',
        });
        await db.putBlob(media.id, blob); // processed from this copy (no source URL needed)
        items.push(media);
      } catch (e) {
        errors.push(`${ing?.name || id}: ${errMsg(e)}`);
      }
    }
    if (items.length && projectStore.get()?.id !== projectId) {
      toast('The sequence changed before the images were added. Try again.', { kind: 'warn' });
      return [];
    }
    const mediaIds = items.map((m) => m.id);
    let unprocessed = 0;
    if (items.length) {
      const what = pluralize(items.length, 'still');
      projectStore.update(
        (p) => {
          let q = p;
          for (const m of items) q = M.addMedia(q, m);
          if (toTimeline) q = M.appendMediaToTimeline(q, mediaIds).project;
          return q;
        },
        { label: toTimeline ? `Add ${what} to timeline` : `Add ${what} to bin` },
      );
      const results = await Promise.all(mediaIds.map((id) => retryMedia(id).catch(() => false)));
      results.forEach((ok, i) => {
        if (ok) return;
        unprocessed++;
        errors.push(`${items[i].name}: ${projectStore.get()?.media[items[i].id]?.error || 'could not be processed'}`);
      });
    }
    const added = items.length - unprocessed;
    if (errors.length) toast(`${added > 0 ? `Added ${added}, but ` : ''}${errors.length} failed: ${errors[0]}`, { kind: 'error', duration: 6000 });
    if (added > 0) {
      const what = pluralize(added, 'still');
      toast(toTimeline ? `Added ${what} to the end of the timeline` : `Added ${what} to the bin`, {
        kind: 'success',
        action: { label: toTimeline ? 'Open Edit' : 'Open Clips', run: () => uiStore.set((s) => ({ ...s, tab: toTimeline ? 'edit' : 'clips' })) },
      });
    }
    return mediaIds;
  });
}

/** Adds ingredient ids to a shot's references (one undo step). */
export function addToShot(ids, shotId) {
  const p = projectStore.get();
  const shot = p?.shots?.find((s) => s.id === shotId);
  if (!shot) return;
  const index = p.shots.indexOf(shot);
  const before = (shot.ingredientIds || []).length;
  const next = projectStore.update((q) => addIngredientsToShot(q, shotId, ids), { label: 'Add shot references' });
  const count = (next?.shots?.find((s) => s.id === shotId)?.ingredientIds || []).length - before;
  const added = next !== p && count > 0;
  toast(added ? `Added ${pluralize(count, 'reference')} to ${shotLabel(shot, index)}` : `Already used in ${shotLabel(shot, index)}`, {
    kind: added ? 'success' : 'info',
    action: { label: 'Open Prompts', run: () => uiStore.set((s) => ({ ...s, tab: 'prompts' })) },
  });
}

/** Creates a draft shot (Prompts tab shape) that uses these ingredients as references: an image → video shot. */
export function newShotWith(ids) {
  const now = Date.now();
  const shot = {
    id: uid('sht'),
    title: ids.length === 1 ? nameOf(ids[0]) : '',
    prompt: '',
    fields: {},
    ingredientIds: [...ids],
    duration: 6,
    mode: 'animate', // Prompts: "Image → video" (attach the references, describe the motion)
    notes: '',
    status: 'draft',
    takes: [],
    chosenTake: null,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    sentText: '',
  };
  projectStore.update((p) => ({ ...p, shots: [...(p.shots || []), shot], updatedAt: Date.now() }), { label: 'New shot' });
  const n = projectStore.get()?.shots?.length || 1;
  toast(`Created shot ${n} with ${pluralize(ids.length, 'reference')}`, { kind: 'success', action: { label: 'Open Prompts', run: () => uiStore.set((s) => ({ ...s, tab: 'prompts' })) } });
}

/** Menu listing the project's shots to add ingredients to. `at` is an event or {x, y}. */
export function openShotMenu(at, ids) {
  const shots = projectStore.get()?.shots || [];
  showMenu(at, [
    { header: ids.length > 1 ? `Use ${ids.length} images in shot` : 'Use in shot' },
    !shots.length && { label: 'No shots in this sequence yet', disabled: true },
    ...shots.map((s, i) => {
      const has = ids.every((id) => (s.ingredientIds || []).includes(id));
      return { label: shotLabel(s, i), icon: has ? 'check' : 'clapper', onClick: () => addToShot(ids, s.id) };
    }),
    '-',
    { label: 'New shot with these references', icon: 'plus', onClick: () => newShotWith(ids) },
  ]);
}

/** Copies one ingredient image to the clipboard (PNG). */
export async function copyIngredient(id) {
  try {
    const blob = await getIngredientBlob(id);
    if (!blob) throw new Error('missing image');
    await copyImage(blob);
    toast('Image copied to the clipboard', { kind: 'success' });
  } catch (e) {
    toast(`Could not copy the image: ${errMsg(e)}`, { kind: 'error' });
  }
}

/** Downloads ingredient images (one file each). */
export async function downloadIngredients(ids) {
  let n = 0;
  for (const id of ids) {
    const ing = getIngredient(id);
    try {
      const blob = await getIngredientBlob(id);
      if (!blob) throw new Error('missing image');
      await downloadBlob(blob, ingredientFilename(ing, blob.type));
      n++;
    } catch (e) {
      toast(`Could not download “${ing?.name || id}”: ${errMsg(e)}`, { kind: 'error' });
    }
  }
  if (n > 1) toast(`Downloading ${n} images`, { kind: 'success' });
}

/** "2 shots and 1 bible entry" for ingredientUsage() counts ('' when unused). */
function usageText({ shots, entries }) {
  const parts = [];
  if (shots) parts.push(pluralize(shots, 'shot'));
  if (entries) parts.push(entries === 1 ? '1 bible entry' : `${entries} bible entries`);
  return parts.join(' and ');
}

/** Deletes ingredients from the library (asks first). Returns true when deleted. */
export async function deleteIngredients(ids, { confirm = true } = {}) {
  const list = ids.filter((id) => getIngredient(id));
  if (!list.length) return false;
  if (confirm) {
    const used = usageText(ingredientUsage(projectStore.get(), list));
    const what = list.length > 1 ? `${list.length} images` : `“${nameOf(list[0])}”`;
    const loses = used ? ` ${used} in this sequence will lose ${list.length > 1 ? 'these references' : 'the reference'}.` : '';
    const ok = await confirmDialog({
      title: list.length > 1 ? `Delete ${list.length} images?` : 'Delete image?',
      message: `${what} will be removed from your Ingredients library (all sequences).${loses} This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return false;
  }
  try {
    await removeIngredients(list);
  } catch (e) {
    toast(`Could not delete: ${errMsg(e)}`, { kind: 'error' });
    return false;
  }
  forgetIngredients(list);
  const gone = new Set(list);
  setIng((s) => ({
    selection: s.selection.filter((x) => !gone.has(x)),
    focusId: gone.has(s.focusId) ? null : s.focusId,
    anchorId: gone.has(s.anchorId) ? null : s.anchorId,
    editorId: gone.has(s.editorId) ? null : s.editorId,
    composerIds: s.composerIds ? s.composerIds.filter((x) => !gone.has(x)) : null,
  }));
  toast(`Deleted ${pluralize(list.length, 'image')}`);
  return true;
}

/** Applies fn(ingredient) -> patch to several ingredients in one library update. */
export function updateIngredients(ids, fn) {
  const set = new Set(ids);
  const now = Date.now();
  libraryStore.set((s) => ({ ...s, ingredients: s.ingredients.map((i) => (set.has(i.id) ? { ...i, ...fn(i), updatedAt: now } : i)) }));
}

/** Asks for tags and adds them to every listed ingredient. */
export async function tagIngredients(ids) {
  const list = ids.filter((id) => getIngredient(id));
  if (!list.length) return;
  const text = await promptDialog({ title: list.length > 1 ? `Tag ${list.length} images` : `Tag “${nameOf(list[0])}”`, label: 'Tags to add, separated by commas', placeholder: 'character, hero, style', confirmLabel: 'Add tags' });
  const tags = parseTags(text);
  if (!tags.length) return;
  updateIngredients(list, (i) => ({ tags: mergeTags(i.tags || [], tags) }));
  toast(`Tagged ${pluralize(list.length, 'image')}: ${tags.join(', ')}`, { kind: 'success' });
}

/** Renames one ingredient (trimmed, never empty). */
export function renameIngredient(id, name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (clean && clean !== getIngredient(id)?.name) updateIngredient(id, { name: clean.slice(0, 120) });
}

/** Context menu for one or more ingredients. `at` is the mouse event (or {x, y}). */
export function openIngredientMenu(at, ids) {
  const list = ids.filter((id) => getIngredient(id));
  if (!list.length) return;
  const pos = at && 'clientX' in at ? { x: at.clientX, y: at.clientY } : at;
  const one = list.length === 1;
  showMenu(at, [
    { header: one ? nameOf(list[0]) : `${list.length} images` },
    one && { label: 'Open in editor', icon: 'crop', shortcut: 'enter', onClick: () => openEditor(list[0]) },
    one && { label: 'Details (name, tags, notes)…', icon: 'info', onClick: () => openEditor(list[0], 'details') },
    { label: 'Attach to Grok', icon: 'send', onClick: () => attachToGrok(list) },
    { label: 'Use in shot…', icon: 'clapper', onClick: () => setTimeout(() => openShotMenu(pos, list), 0) },
    { label: 'Add to timeline as still', icon: 'film', onClick: () => addToProject(list, { toTimeline: true }) },
    { label: 'Add to bin', icon: 'inbox', onClick: () => addToProject(list, { toTimeline: false }) },
    list.length >= 2 && { label: 'Make reference sheet…', icon: 'grid', shortcut: 'g', onClick: () => openComposer(list) },
    '-',
    one && { label: 'Copy image', icon: 'copy', shortcut: 'mod+c', onClick: () => copyIngredient(list[0]) },
    { label: one ? 'Download' : `Download ${list.length} images`, icon: 'download', onClick: () => downloadIngredients(list) },
    { label: 'Add tags…', icon: 'tag', onClick: () => tagIngredients(list) },
    '-',
    { label: one ? 'Delete' : `Delete ${list.length} images`, icon: 'trash', danger: true, shortcut: 'delete', onClick: () => deleteIngredients(list) },
  ]);
}

// ---------------------------------------------------------------------------------------------------------
// App events (registered at import time, see header)
// ---------------------------------------------------------------------------------------------------------

appEvents.on('ingredient.fromPage', ({ item } = {}) => {
  if (!item?.url) return;
  importPageItems([item], { announce: 'show', reveal: true });
});

// Payload {blob, name, origin, sourceUrl, prompt?, quiet?}. The handler confirms with a toast (with a "Show"
// action); pass quiet: true when the caller shows its own confirmation, and only failures are reported.
appEvents.on('ingredient.add', ({ blob, name, origin, sourceUrl, prompt, quiet = false } = {}) => {
  if (!(blob instanceof Blob)) return;
  importImageBlobs([{ blob, name: name || 'Image', origin: origin || 'frame', sourceUrl: sourceUrl || null, prompt: prompt || null }], { announce: quiet ? false : 'show', reveal: true });
});

// ---------------------------------------------------------------------------------------------------------
// References to deleted ingredients
// ---------------------------------------------------------------------------------------------------------
// Shots and bible entries reference ingredients by id. Once an ingredient is gone its id is dead for good (ids are
// never reused), so it is stripped from the open project, also when an undo/redo brings back an older snapshot that
// still lists it. These are consistency fixes, not edits: they bypass the undo history. Projects opened later are
// checked for references to images that no longer exist anywhere (deleted in an earlier session or another window).

const deadIds = new Set();

function stripDeadRefs() {
  if (deadIds.size) projectStore.update((p) => removeIngredientRefs(p, deadIds), { history: false });
}

/** Marks ingredient ids as deleted for good and removes them from the open project's shots and bible entries. */
export function forgetIngredients(ids) {
  for (const id of ids) deadIds.add(id);
  stripDeadRefs();
}

let stripQueued = false;
projectStore.subscribe((p) => {
  if (!p || !deadIds.size || stripQueued) return;
  stripQueued = true;
  queueMicrotask(() => {
    stripQueued = false;
    stripDeadRefs();
  });
});

async function dropDanglingRefs(projectId) {
  if (!libraryStore.get().loaded) return;
  const p = projectStore.get();
  if (!p || p.id !== projectId) return;
  const unknown = referencedIngredientIds(p).filter((id) => !getIngredient(id) && !deadIds.has(id));
  if (!unknown.length) return;
  const dead = [];
  // Only ids with no stored image either: those can never be attached (never drop a reference that still works).
  for (const id of unknown) if (!(await db.hasBlob(id).catch(() => true))) dead.push(id);
  const stillMissing = dead.filter((id) => !getIngredient(id));
  if (stillMissing.length && projectStore.get()?.id === projectId) forgetIngredients(stillMissing);
}

appEvents.on('project.loaded', ({ project } = {}) => {
  if (project?.id) dropDanglingRefs(project.id).catch((e) => console.warn('[gis] reference check failed', e));
});

/** Ids in the current selection that still exist (helper for components). */
export const liveSelection = () => ingStore.get().selection.filter((id) => getIngredient(id));
