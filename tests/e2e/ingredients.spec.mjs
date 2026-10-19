// Ingredients tab (studio/ui/ingredients): imports (file chooser, paste, URL, app events, grok.com items, bin frames),
// image editor (crop 16:9 -> save as new, rotate -> overwrite), grid composer, library actions, IngredientPicker,
// attach to Grok from the embedded studio, and responsive screenshots.
import { test } from '@playwright/test';
import { launch, openGrok, openStudio, openStudioTab, seedMedia, getProject, fixture, expect } from './harness.mjs';
import { imageUrl } from './fixtures-map.mjs';

const ING = '/studio/ui/ingredients/actions.js';

const openTab = async (page) => {
  await page.locator('.app-tabs .tab[title^="Reference images"]').click();
  await expect(page.locator('.view-ingredients')).toBeVisible();
};

const library = (page) => page.evaluate(() => window.__gis.libraryStore.get().ingredients);

/** Adds fixture images to the library through the real import path (no UI). Returns ids in order. */
async function seedIngredients(page, files) {
  return page.evaluate(
    async ({ files, mod }) => {
      const A = await import(mod);
      const ids = [];
      for (const f of files) {
        const blob = await (await fetch(`https://assets.grok.com/test/${f.file}`)).blob();
        const [id] = await A.importImageBlobs([{ blob, name: f.name, origin: 'file', tags: f.tags || [] }], { announce: false, reveal: false });
        ids.push(id);
      }
      return ids;
    },
    { files, mod: ING },
  );
}

/** Decodes a stored ingredient image: {type, w, h, px: [[r, g, b] at each requested point]}. */
async function imageInfo(page, id, points = []) {
  return page.evaluate(
    async ({ id, points }) => {
      const blob = await window.__gis.db.getBlob(id);
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = points.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)));
      return { type: blob.type, w: bmp.width, h: bmp.height, px };
    },
    { id, points },
  );
}

const closeTo = (a, b, tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/**
 * Waits until Preact has run its after-paint effects. A freshly mounted kit NumberField re-syncs its text from its
 * value in one, so text typed before that would be overwritten (seen under load with two workers).
 */
const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
        setTimeout(resolve, 120); // rAF can be throttled; Preact then falls back to a 35 ms timer
      }),
  );

/** The readout of an Adjust slider in the image editor. */
const adjustReadout = (page, label) => page.locator('.ing-ws-panel .slider', { hasText: label }).locator('.slider-value');

test('file import, crop 16:9 -> save as new, rotate -> overwrite (with undo)', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await openTab(studio);
    await expect(studio.locator('.ing-empty')).toContainText('Build your reference library');

    // Import through the real file chooser.
    const [chooser] = await Promise.all([studio.waitForEvent('filechooser'), studio.locator('.ing-empty .btn', { hasText: 'Import images' }).click()]);
    await chooser.setFiles([fixture('media', 'still.jpg'), fixture('media', 'still.png')]);
    await expect(studio.locator('.ing-card')).toHaveCount(2);
    let lib = await library(studio);
    const jpg = lib.find((i) => i.width === 1024);
    const png = lib.find((i) => i.width === 800);
    expect(jpg).toMatchObject({ name: 'still', origin: 'file', mime: 'image/jpeg', height: 1024 });
    expect(png).toMatchObject({ name: 'still', origin: 'file', mime: 'image/png', height: 600 });

    // Crop the JPEG to 16:9 and save as a new ingredient.
    await studio.locator('.ing-card', { hasText: '1024×1024' }).dblclick();
    await expect(studio.locator('.ing-ws')).toBeVisible();
    await expect(studio.locator('.ing-stage-canvas')).toBeVisible();
    await studio.locator('.ing-aspect', { hasText: '16:9' }).click();
    await expect(studio.locator('.ing-crop-fields input').nth(2)).toHaveValue('1024'); // W
    await expect(studio.locator('.ing-crop-fields input').nth(3)).toHaveValue('576'); // H
    await expect(studio.locator('.ing-stage-badge')).toContainText('1024 × 576');
    await studio.locator('.ing-ws-header .btn', { hasText: 'Save as new' }).click();
    await expect.poll(async () => (await library(studio)).length).toBe(3);
    lib = await library(studio);
    const cropped = lib.find((i) => i.origin === 'edit');
    expect(cropped).toMatchObject({ name: 'still (edited)', width: 1024, height: 576, mime: 'image/jpeg' });
    const src = await imageInfo(studio, jpg.id, [[100, 224 + 100], [700, 224 + 400]]);
    const out = await imageInfo(studio, cropped.id, [[100, 100], [700, 400]]);
    expect([out.w, out.h]).toEqual([1024, 576]);
    expect(closeTo(out.px[0], src.px[0], 30) && closeTo(out.px[1], src.px[1], 30)).toBe(true); // same pixels, shifted by the crop

    // Escape with unsaved edits asks first (cancel keeps the editor); once the edits match what was saved it closes.
    await studio.keyboard.press('r');
    await studio.keyboard.press('Escape');
    await expect(studio.locator('.modal', { hasText: 'Discard changes?' })).toBeVisible();
    await studio.locator('.modal .btn', { hasText: 'Cancel' }).click();
    await expect(studio.locator('.ing-ws')).toBeVisible();
    await studio.keyboard.press('Shift+R'); // back to the saved 16:9 crop
    await expect(studio.locator('.ing-stage-badge')).toContainText('1024 × 576');
    await studio.keyboard.press('Escape');
    await expect(studio.locator('.ing-ws')).toBeHidden();
    await expect(studio.locator('.modal')).toHaveCount(0);

    // Rotate the PNG clockwise and overwrite the original.
    await studio.locator('.ing-card', { hasText: '800×600' }).click();
    await studio.keyboard.press('Enter');
    await expect(studio.locator('.ing-stage-canvas')).toBeVisible();
    const before = await imageInfo(studio, png.id, [[20, 600 - 1 - 10], [500, 600 - 1 - 300]]);
    await studio.keyboard.press('r');
    await expect(studio.locator('.ing-stage-badge')).toContainText('600 × 800');
    await studio.locator('.ing-ws-header .btn', { hasText: 'Overwrite' }).click();
    await expect(studio.locator('.toast', { hasText: 'Image updated' })).toBeVisible();
    await expect.poll(async () => (await library(studio)).find((i) => i.id === png.id).width).toBe(600);
    const rotated = await imageInfo(studio, png.id, [[10, 20], [300, 500]]);
    expect([rotated.w, rotated.h, rotated.type]).toEqual([600, 800, 'image/png']);
    // new(i, j) = old(j, H - 1 - i) for a clockwise quarter turn
    expect(closeTo(rotated.px[0], before.px[0], 4) && closeTo(rotated.px[1], before.px[1], 4)).toBe(true);
    await expect(studio.locator('.ing-ws-dims')).toContainText('600 × 800'); // editor reloaded the new image

    // Undo from the notification restores the original image.
    await studio.locator('.toast', { hasText: 'Image updated' }).locator('.toast-action').click();
    await expect.poll(async () => (await library(studio)).find((i) => i.id === png.id).width).toBe(800);
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('app events work before the tab is opened; paste, URL and grok.com imports', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    // 'ingredient.add' while the Ingredients tab has never been opened.
    await studio.evaluate(async () => {
      const blob = await (await fetch('https://assets.grok.com/test/thumb-red.jpg')).blob();
      window.__gis.appState.appEvents.emit('ingredient.add', { blob, name: 'From event', origin: 'frame', sourceUrl: null });
    });
    const toastAdd = studio.locator('.toast', { hasText: 'Added “From event” to Ingredients' });
    await expect(toastAdd).toBeVisible();
    expect((await library(studio))[0]).toMatchObject({ name: 'From event', origin: 'frame', width: 640, height: 360 });
    await toastAdd.locator('.toast-action', { hasText: 'Show' }).click();
    await expect(studio.locator('.view-ingredients')).toBeVisible();
    await expect(studio.locator('.ing-card.is-selected')).toContainText('From event');

    // 'ingredient.fromPage' with a grok.com PageMedia item, then again (de-duplicated by URL).
    const item = { key: 'image:55555555-5555-4555-8555-555555555555', kind: 'image', url: imageUrl('55555555-5555-4555-8555-555555555555'), altUrls: [], thumbUrl: null, prompt: 'A colorful test pattern poster', source: 'network', pageUrl: 'https://grok.com/imagine', seenAt: Date.now() };
    await studio.evaluate((it) => window.__gis.appState.appEvents.emit('ingredient.fromPage', { item: it }), item);
    await expect.poll(async () => (await library(studio)).filter((i) => i.origin === 'page').length).toBe(1);
    const fromPage = (await library(studio)).find((i) => i.origin === 'page');
    expect(fromPage).toMatchObject({ name: 'A colorful test pattern poster', prompt: 'A colorful test pattern poster', sourceUrl: item.url, width: 1024, height: 1024 });
    await studio.evaluate((it) => window.__gis.appState.appEvents.emit('ingredient.fromPage', { item: it }), item);
    await expect(studio.locator('.toast', { hasText: 'already in Ingredients' })).toBeVisible();
    expect((await library(studio)).filter((i) => i.origin === 'page').length).toBe(1);

    // Paste (Ctrl/⌘+V) of an image file anywhere in the tab.
    await studio.evaluate(async () => {
      const bytes = await (await fetch('https://assets.grok.com/test/still.png')).arrayBuffer();
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.querySelector('.ing-grid').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await library(studio)).filter((i) => i.origin === 'paste').length).toBe(1);
    const pasted = (await library(studio)).find((i) => i.origin === 'paste');
    expect(pasted.name).toMatch(/^Pasted image \d\d:\d\d$/);
    expect([pasted.width, pasted.height]).toEqual([800, 600]);

    // Typing in the search field: a text paste is left alone.
    await studio.locator('.ing-search input').fill('');
    await studio.locator('.ing-search input').focus();
    await studio.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'hello');
      document.querySelector('.ing-search input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await studio.waitForTimeout(300);
    expect((await library(studio)).length).toBe(3);

    // URL import through the Add menu and the prompt dialog.
    await studio.locator('[data-testid="ing-add"]').click();
    await studio.locator('.menu-item', { hasText: 'From URL' }).click();
    await studio.locator('.modal input.text-field').fill('https://assets.grok.com/test/thumb-hd.jpg');
    await studio.locator('.modal button[type="submit"]').click();
    await expect.poll(async () => (await library(studio)).filter((i) => i.origin === 'url').length).toBe(1);
    expect((await library(studio)).find((i) => i.origin === 'url')).toMatchObject({ name: 'thumb hd', sourceUrl: 'https://assets.grok.com/test/thumb-hd.jpg', width: 1280, height: 720 });

    // A URL that is not an image reports an error.
    await studio.locator('[data-testid="ing-add"]').click();
    await studio.locator('.menu-item', { hasText: 'From URL' }).click();
    await studio.locator('.modal input.text-field').fill('https://assets.grok.com/test/does-not-exist.png');
    await studio.locator('.modal button[type="submit"]').click();
    await expect(studio.locator('.toast-error', { hasText: 'Could not import the URL' })).toBeVisible();
    expect((await library(studio)).length).toBe(4);
  } finally {
    await ctx.close();
  }
});

test('grid composer: 4 images in a 2×2 1024 sheet become a new ingredient', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await openTab(studio);
    const files = [
      { file: 'thumb-red.jpg', name: 'Red', tags: ['car'] },
      { file: 'thumb-green.jpg', name: 'Green', tags: ['forest'] },
      { file: 'thumb-blue.jpg', name: 'Blue' },
      { file: 'thumb-vertical.jpg', name: 'Orange' },
    ];
    const ids = await seedIngredients(studio, files);
    await expect(studio.locator('.ing-card')).toHaveCount(4);
    // Select in a chosen order: red, green, blue, orange (Ctrl/⌘-click), then open the composer with G.
    for (const [i, f] of files.entries()) await studio.locator('.ing-card', { hasText: f.name }).click(i ? { modifiers: ['ControlOrMeta'] } : {});
    await studio.keyboard.press('g');
    const modal = studio.locator('.ing-composer-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.ing-order-item')).toHaveCount(4);
    await modal.locator('.segmented button', { hasText: '2×2' }).click();
    await modal.locator('.field', { hasText: 'Output size' }).locator('select').selectOption('1024x1024');
    await expect(modal.locator('.ing-composer-size')).toHaveText('1024 × 1024px');
    await modal.locator('.field', { hasText: 'Labels' }).locator('select').selectOption('numbers');
    await expect(modal.locator('[data-testid="sheet-save"]')).toBeEnabled();
    await modal.locator('[data-testid="sheet-save"]').click();
    await expect(modal).toBeHidden();
    await expect.poll(async () => (await library(studio)).filter((i) => i.origin === 'grid').length).toBe(1);
    const sheet = (await library(studio)).find((i) => i.origin === 'grid');
    expect(sheet).toMatchObject({ width: 1024, height: 1024, mime: 'image/jpeg' });
    expect(sheet.name).toBe('Sheet: Red + Green + Blue +1');
    expect(sheet.tags).toEqual(['car', 'forest']);
    expect(sheet.prompt).toContain('1 = Red; 2 = Green; 3 = Blue; 4 = Orange');
    // Cells (gap 16, 488 px): sample each cell away from the number badge and the moving white box.
    const info = await imageInfo(studio, sheet.id, [[260, 470], [764, 470], [260, 974], [764, 974], [4, 4]]);
    expect([info.w, info.h]).toEqual([1024, 1024]);
    const [red, green, blue, orange, bg] = info.px;
    expect(red[0] > 180 && red[1] < 80 && red[2] < 80).toBe(true);
    expect(green[1] > 90 && green[0] < 60 && green[2] < 60).toBe(true);
    expect(blue[2] > 180 && blue[0] < 60 && blue[1] < 60).toBe(true);
    expect(orange[0] > 200 && orange[1] > 100 && orange[1] < 200 && orange[2] < 80).toBe(true);
    expect(closeTo(bg, [17, 17, 20], 10)).toBe(true); // default background
    await expect(studio.locator('.ing-card.is-selected')).toContainText('Sheet:');
    expect(ids.length).toBe(4);
  } finally {
    await ctx.close();
  }
});

test('library: search, tag filter, keyboard select all, delete with confirm, use in shot, add to timeline, bin frame', async () => {
  const ctx = await launch({ viewport: { width: 480, height: 860 } });
  try {
    const studio = await openStudioTab(ctx);
    await openTab(studio);
    await seedIngredients(studio, [
      { file: 'thumb-red.jpg', name: 'Red car', tags: ['vehicle'] },
      { file: 'thumb-green.jpg', name: 'Forest', tags: ['location'] },
      { file: 'thumb-blue.jpg', name: 'Ocean', tags: ['location'] },
    ]);
    await expect(studio.locator('.ing-card')).toHaveCount(3);

    // Search and tag filters.
    await studio.locator('.ing-search input').fill('ocean');
    await expect(studio.locator('.ing-card')).toHaveCount(1);
    await studio.locator('.ing-search input').fill('');
    await studio.locator('.ing-filterbar .chip', { hasText: 'location' }).click();
    await expect(studio.locator('.ing-card')).toHaveCount(2);
    await studio.locator('.ing-filterbar .chip', { hasText: 'All' }).click();
    await expect(studio.locator('.ing-card')).toHaveCount(3);

    // Keyboard: select all, Escape clears, Delete asks first (cancel keeps, confirm removes).
    await studio.locator('.ing-card', { hasText: 'Forest' }).click();
    await studio.keyboard.press('ControlOrMeta+a');
    await expect(studio.locator('.ing-selbar-count')).toHaveText('3 selected');
    await studio.keyboard.press('Escape');
    await expect(studio.locator('.ing-selbar')).toBeHidden();
    await studio.locator('.ing-card', { hasText: 'Forest' }).click();
    await studio.keyboard.press('Delete');
    await expect(studio.locator('.modal', { hasText: 'Delete image?' })).toBeVisible();
    await studio.locator('.modal .btn', { hasText: 'Cancel' }).click();
    expect((await library(studio)).length).toBe(3);
    await studio.keyboard.press('Delete');
    await studio.locator('.modal .btn', { hasText: 'Delete' }).click();
    await expect(studio.locator('.ing-card')).toHaveCount(2);
    expect((await library(studio)).map((i) => i.name).sort()).toEqual(['Ocean', 'Red car']);

    // Use in shot (context menu -> shot menu), one undo step.
    await studio.evaluate(() =>
      window.__gis.projectStore.update((p) => ({ ...p, shots: [{ id: 'sht_test', title: 'Opening shot', prompt: '', fields: {}, ingredientIds: [], duration: 6, mode: 'normal', notes: '', status: 'draft', takes: [], chosenTake: null, createdAt: Date.now() }] }), { label: 'seed shot' }),
    );
    await studio.locator('.ing-card', { hasText: 'Ocean' }).click({ button: 'right' });
    await studio.locator('.menu-item', { hasText: 'Use in shot' }).click();
    await studio.locator('.menu-item', { hasText: '1. Opening shot' }).click();
    const oceanId = (await library(studio)).find((i) => i.name === 'Ocean').id;
    await expect.poll(async () => (await getProject(studio)).shots[0].ingredientIds).toEqual([oceanId]);
    expect(await studio.evaluate(() => window.__gis.projectStore.undoLabel())).toBe('Add shot references');
    // "New shot with these references" creates a draft shot in the Prompts shape.
    await studio.locator('.ing-card', { hasText: 'Red car' }).click({ button: 'right' });
    await studio.locator('.menu-item', { hasText: 'Use in shot' }).click();
    await studio.locator('.menu-item', { hasText: 'New shot with these references' }).click();
    await expect.poll(async () => (await getProject(studio)).shots.length).toBe(2);
    expect((await getProject(studio)).shots[1]).toMatchObject({ title: 'Red car', status: 'draft', mode: 'animate', takes: [], chosenTake: null, sentAt: null });

    // Add to timeline as a still (bin item origin 'frame', kind image, clip on the main track) in ONE undo step.
    await studio.locator('.ing-card', { hasText: 'Ocean' }).click({ button: 'right' });
    await studio.locator('.menu-item', { hasText: 'Add to timeline as still' }).click();
    await expect.poll(async () => {
      const q = await getProject(studio);
      return q.tracks.video.length === 1 && q.media[q.tracks.video[0].mediaId]?.status;
    }).toBe('ready');
    const p = await getProject(studio);
    const still = p.media[p.tracks.video[0].mediaId];
    expect(still).toMatchObject({ kind: 'image', origin: 'frame', name: 'Ocean', status: 'ready', width: 640, height: 360, tags: ['location'] });
    expect(await studio.evaluate(() => window.__gis.projectStore.undoLabel())).toBe('Add 1 still to timeline');
    await studio.evaluate(() => window.__gis.projectStore.undo());
    let undone = await getProject(studio);
    expect([undone.tracks.video.length, undone.mediaOrder.length]).toEqual([0, 0]); // clip AND bin item gone
    await studio.evaluate(() => window.__gis.projectStore.redo());
    undone = await getProject(studio);
    expect(undone.media[undone.tracks.video[0]?.mediaId]).toMatchObject({ name: 'Ocean', status: 'ready' });

    // Attach without any grok.com tab: explains instead of failing silently.
    await studio.locator('.ing-card', { hasText: 'Ocean' }).click();
    await studio.locator('.ing-selbar [title="Attach to the Grok composer"]').click();
    await expect(studio.locator('.toast-warn', { hasText: 'Open grok.com to attach images' })).toBeVisible();

    // Frame of a bin video at a chosen time.
    await seedMedia(studio, ['clip-red.mp4']);
    await studio.locator('[data-testid="ing-add"]').click();
    await studio.locator('.menu-item', { hasText: 'From bin' }).click();
    const dialog = studio.locator('.modal', { hasText: 'Add from the bin' });
    await dialog.locator('.ing-bin-card', { hasText: 'clip-red' }).click();
    const timeField = dialog.locator('.ing-grab .time-field');
    await timeField.fill('1.5');
    await timeField.press('Enter');
    await expect(dialog.locator('[data-testid="grab-frame"]')).toContainText('0:01.50');
    await dialog.locator('[data-testid="grab-frame"]').click();
    await expect.poll(async () => (await library(studio)).filter((i) => i.origin === 'frame').length).toBe(1);
    const frame = (await library(studio)).find((i) => i.origin === 'frame');
    expect(frame).toMatchObject({ name: 'clip-red @ 0:01.50', width: 640, height: 360, mime: 'image/png' });
    const px = await imageInfo(studio, frame.id, [[10, 10]]);
    expect(px.px[0][0] > 200 && px.px[0][1] < 60).toBe(true);
    await expect(dialog.locator('.modal-footer')).toContainText('1 image added');
    await dialog.locator('.btn', { hasText: 'Done' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test('IngredientPicker: choose in order, quick search, remove, single mode', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    const ids = await seedIngredients(studio, [
      { file: 'thumb-red.jpg', name: 'Red car', tags: ['vehicle'] },
      { file: 'thumb-green.jpg', name: 'Forest' },
      { file: 'thumb-blue.jpg', name: 'Ocean' },
    ]);
    // Render two pickers outside the app (as the Prompts tab would embed them).
    await studio.evaluate(async () => {
      const { html, render, useState } = await import('/vendor/preact-htm.mjs');
      const { IngredientPicker } = await import('/studio/ui/ingredients/ingredient-picker.js');
      window.__picked = { multi: [], single: [] };
      const host = document.createElement('div');
      host.id = 'picker-host';
      host.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:50;display:flex;flex-direction:column;gap:12px;width:420px;padding:12px;background:#111;border:1px solid #333';
      document.body.appendChild(host);
      function Demo({ k, multiple }) {
        const [v, setV] = useState([]);
        return html`<div class=${`demo-${k}`}><${IngredientPicker} value=${v} multiple=${multiple} onChange=${(next) => { window.__picked[k] = next; setV(next); }} /></div>`;
      }
      render(html`<${Demo} k="multi" multiple=${true} /><${Demo} k="single" multiple=${false} />`, host);
    });
    const multi = studio.locator('#picker-host .demo-multi');
    await expect(multi.locator('[data-testid="ing-picker-add"]')).toContainText('Add reference images');
    await multi.locator('[data-testid="ing-picker-add"]').click();
    const dialog = studio.locator('.ing-picker-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.ing-pick-card')).toHaveCount(3);
    await dialog.locator('.ing-search input').fill('vehicle'); // tags are searchable
    await expect(dialog.locator('.ing-pick-card')).toHaveCount(1);
    await dialog.locator('.ing-search input').fill('');
    await dialog.locator('.ing-pick-card', { hasText: 'Ocean' }).click();
    await dialog.locator('.ing-pick-card', { hasText: 'Red car' }).click();
    // Selection order badges (cards are listed newest first: Ocean, Forest, Red car).
    await expect(dialog.locator('.ing-pick-card.is-selected .ing-pick-check')).toHaveText(['1', '2']);
    await expect(dialog.locator('.ing-pick-card.is-selected')).toHaveText([/Ocean/, /Red car/]);
    await dialog.locator('[data-testid="picker-done"]').click();
    await expect(dialog).toBeHidden();
    expect(await studio.evaluate(() => window.__picked.multi)).toEqual([ids[2], ids[0]]); // click order = attach order
    await expect(multi.locator('.ing-picker-chip')).toHaveCount(2);
    await expect(multi.locator('.ing-picker-num')).toHaveText(['1', '2']);
    await multi.locator('.ing-picker-chip').first().hover();
    await multi.locator('.ing-picker-chip').first().locator('.ing-picker-x').click();
    expect(await studio.evaluate(() => window.__picked.multi)).toEqual([ids[0]]);

    // Ctrl/⌘+V while the picker is open imports the image and selects it.
    await multi.locator('[data-testid="ing-picker-add"]').click();
    await expect(dialog).toBeVisible();
    await studio.evaluate(async () => {
      const bytes = await (await fetch('https://assets.grok.com/test/still.png')).arrayBuffer();
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.querySelector('.ing-picker-dialog').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(dialog.locator('.ing-pick-card')).toHaveCount(4);
    await expect(dialog.locator('.ing-pick-card.is-selected')).toHaveCount(2);
    await dialog.locator('[data-testid="picker-done"]').click();
    const afterPaste = await studio.evaluate(() => window.__picked.multi);
    expect(afterPaste.length).toBe(2);
    expect(afterPaste[0]).toBe(ids[0]);
    expect((await library(studio)).find((i) => i.id === afterPaste[1]).origin).toBe('paste');

    // Single mode: one click chooses and closes.
    const single = studio.locator('#picker-host .demo-single');
    await single.locator('[data-testid="ing-picker-add"]').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('.ing-pick-card', { hasText: 'Forest' }).click();
    await expect(dialog).toBeHidden();
    expect(await studio.evaluate(() => window.__picked.single)).toEqual([ids[1]]);
    await expect(single.locator('.ing-picker-chip')).toHaveCount(1);
    await expect(single.locator('[data-testid="ing-picker-add"]')).toBeVisible(); // can replace the choice

    // Deleted ingredients disappear from the chip row.
    await studio.evaluate(async (id) => (await import('/studio/core/ingredients.js')).removeIngredients([id]), ids[1]);
    await expect(single.locator('.ing-picker-chip')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test('attach to Grok from the studio docked on grok.com', async () => {
  const ctx = await launch();
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const frame = await openStudio(page);
    await openTab(frame);
    await seedIngredients(frame, [{ file: 'still.png', name: 'Hero ref' }]);
    // Make sure Grok's upload input exists (the mock page has one; older minimal pages get one added) and watch it.
    await page.evaluate(() => {
      window.__attachedFiles = [];
      let input = [...document.querySelectorAll('input[type=file]')].find((i) => (i.accept || '').includes('image'));
      if (input) return;
      input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.hidden = true;
      input.addEventListener('change', () => window.__attachedFiles.push(...[...input.files].map((f) => ({ name: f.name, type: f.type, size: f.size }))));
      (document.querySelector('.query-bar') || document.body).append(input);
    });
    await frame.evaluate(() => {
      const b = window.__gis.bridge;
      const orig = b.request.bind(b);
      window.__reqs = [];
      b.request = (type, payload, opts) => {
        window.__reqs.push({ type, name: payload?.name || null, isFile: payload?.blob instanceof File, fileType: payload?.blob?.type || null, size: payload?.blob?.size || 0 });
        return orig(type, payload, opts);
      };
    });
    await frame.locator('.ing-card', { hasText: 'Hero ref' }).click();
    await frame.locator('.ing-selbar [title="Attach to the Grok composer"]').click();
    await expect.poll(() => frame.evaluate(() => window.__reqs.filter((r) => r.type === 'composer.attach').length)).toBe(1);
    const req = await frame.evaluate(() => window.__reqs.find((r) => r.type === 'composer.attach'));
    expect(req).toMatchObject({ name: 'Hero_ref.png', isFile: true, fileType: 'image/png' });
    expect(req.size).toBeGreaterThan(1000);
    const ok = frame.locator('.toast-success', { hasText: 'Attached 1 image to Grok' });
    await expect(ok).toBeVisible({ timeout: 35000 });
    await expect(ok).toContainText('via upload field'); // the method reported by the content script
    const got = await page.evaluate(() => (window.__mock?.attached?.length ? window.__mock.attached : window.__attachedFiles));
    expect(got).toEqual([expect.objectContaining({ name: 'Hero_ref.png', type: 'image/png', size: req.size })]);
  } finally {
    await ctx.close();
  }
});

test('grok.com images: "From grok.com" dialog and the on-page Ingredient button', async () => {
  const ctx = await launch();
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const frame = await openStudio(page);
    await openTab(frame);
    const postId = '55555555-5555-4555-8555-555555555555';
    await expect.poll(() => frame.evaluate((id) => window.__gis.pageStore.get().items.some((i) => i.kind === 'image' && (i.postId === id || i.url.includes(id))), postId), { timeout: 20000 }).toBe(true);

    // On-page hover toolbar -> PAGE_INGREDIENT -> 'ingredient.fromPage' -> library.
    // (Grok's card link overlays the image: move the pointer there instead of a strict hover())
    const img = page.locator(`main img[src*="${postId}"]`).first();
    await img.scrollIntoViewIfNeeded({ timeout: 10000 });
    const ib = await img.boundingBox({ timeout: 10000 });
    await page.mouse.move(ib.x + ib.width * 0.3, ib.y + ib.height * 0.5, { steps: 4 });
    const btn = page.locator('gis-studio-root button[data-act="ingredient"]');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect.poll(async () => (await library(frame)).filter((i) => i.origin === 'page').length, { timeout: 20000 }).toBe(1);
    const fromHover = (await library(frame)).find((i) => i.origin === 'page');
    expect(fromHover).toMatchObject({ prompt: 'A colorful test pattern poster', width: 1024, height: 1024 });
    await expect(frame.locator('.ing-card.is-selected')).toContainText('A colorful test pattern poster');

    // The dialog lists the page's images and marks the one already imported.
    await frame.locator('[data-testid="ing-add"]').click();
    await frame.locator('.menu-item', { hasText: 'From grok.com' }).click();
    const dialog = frame.locator('.modal', { hasText: 'Images on grok.com' });
    const card = dialog.locator('.ing-pick-card', { hasText: 'A colorful test pattern poster' });
    await expect(card).toBeVisible();
    await expect(card.locator('.ing-pick-known')).toContainText('In library');
    await card.click();
    await dialog.locator('.btn', { hasText: 'Add 1 image' }).click();
    await expect(dialog).toBeHidden();
    await expect(frame.locator('.toast', { hasText: 'already in Ingredients' })).toBeVisible();
    expect((await library(frame)).filter((i) => i.origin === 'page').length).toBe(1);

    // Video posters: the poster frame of a generated video becomes an ingredient.
    await frame.locator('[data-testid="ing-add"]').click();
    await frame.locator('.menu-item', { hasText: 'From grok.com' }).click();
    await dialog.locator('.segmented button', { hasText: 'Video posters' }).click();
    const poster = dialog.locator('.ing-pick-card', { hasText: 'A red sports car' });
    await expect(poster).toContainText('Poster');
    await poster.click();
    await dialog.locator('.btn', { hasText: 'Add 1 image' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await library(frame)).filter((i) => i.origin === 'page').length).toBe(2);
    const fromPoster = (await library(frame)).find((i) => i.origin === 'page' && /preview_image/.test(i.sourceUrl || ''));
    expect(fromPoster).toMatchObject({ width: 640, height: 360 });
    expect(fromPoster.name).toContain('A red sports car');
  } finally {
    await ctx.close();
  }
});

test('editor: drag/resize/draw the crop, local undo, adjustments and resize presets are applied on save', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await openTab(studio);
    const [id] = await seedIngredients(studio, [{ file: 'still.jpg', name: 'Pattern' }]);
    await studio.locator('.ing-card', { hasText: 'Pattern' }).dblclick();
    await expect(studio.locator('.ing-stage-canvas')).toBeVisible();
    const field = (i) => studio.locator('.ing-crop-fields input').nth(i);
    await expect(field(2)).toHaveValue('1024');

    // Resize from the bottom-right handle (free aspect): the crop shrinks.
    const box = studio.locator('[data-testid="crop-box"]');
    let bb = await box.boundingBox();
    const se = studio.locator('.ing-crop-h.h-se');
    const sb = await se.boundingBox();
    await studio.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await studio.mouse.down();
    await studio.mouse.move(sb.x - bb.width * 0.25, sb.y - bb.height * 0.5, { steps: 6 });
    await studio.mouse.up();
    await expect(field(2)).not.toHaveValue('1024');
    const w1 = Number(await field(2).inputValue());
    const h1 = Number(await field(3).inputValue());
    expect(w1).toBeGreaterThan(700);
    expect(w1).toBeLessThan(800);
    expect(h1).toBeGreaterThan(470);
    expect(h1).toBeLessThan(560);
    expect([await field(0).inputValue(), await field(1).inputValue()]).toEqual(['0', '0']);

    // Move the box: size kept, position changes, clamped inside the image.
    bb = await box.boundingBox();
    await studio.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await studio.mouse.down();
    await studio.mouse.move(bb.x + bb.width / 2 + 2000, bb.y + bb.height / 2 + 2000, { steps: 6 });
    await studio.mouse.up();
    await expect(field(0)).toHaveValue(String(1024 - w1));
    await expect(field(1)).toHaveValue(String(1024 - h1));
    await expect(field(2)).toHaveValue(String(w1));

    // Local undo (Ctrl/⌘+Z) steps back through the gestures, redo re-applies.
    await studio.keyboard.press('ControlOrMeta+z');
    await expect(field(0)).toHaveValue('0');
    await expect(field(2)).toHaveValue(String(w1));
    await studio.keyboard.press('ControlOrMeta+z');
    await expect(field(2)).toHaveValue('1024');
    await studio.keyboard.press('ControlOrMeta+Shift+z');
    await expect(field(2)).toHaveValue(String(w1));
    expect(await studio.evaluate(() => window.__gis.projectStore.canUndo())).toBe(false); // the project history was not touched

    // Draw a new 1:1 crop by dragging on the image outside the box.
    await studio.locator('.ing-aspect', { hasText: '1:1' }).click();
    await studio.locator('.ing-crop-fields input').nth(2).fill('400');
    await studio.locator('.ing-crop-fields input').nth(2).press('Enter');
    await expect(field(3)).toHaveValue('400');
    const canvas = await studio.locator('.ing-stage-canvas').boundingBox();
    const k = canvas.width / 1024;
    // (the 400 px box sits at the top-left corner: start well outside it)
    await studio.mouse.move(canvas.x + 600 * k, canvas.y + 600 * k);
    await studio.mouse.down();
    await studio.mouse.move(canvas.x + 900 * k, canvas.y + 800 * k, { steps: 6 });
    await studio.mouse.up();
    await expect(field(0)).not.toHaveValue('0');
    const wd = Number(await field(2).inputValue());
    expect(Math.abs(wd - Number(await field(3).inputValue()))).toBeLessThanOrEqual(1); // still 1:1
    expect(Math.abs(wd - 300)).toBeLessThanOrEqual(4);
    expect(Math.abs(Number(await field(0).inputValue()) - 600)).toBeLessThanOrEqual(3);
    expect(Math.abs(Number(await field(1).inputValue()) - 600)).toBeLessThanOrEqual(3);

    // Mono look + 512 px long side, saved as a new image: grey pixels at the expected size.
    await studio.locator('.ing-looks .chip', { hasText: 'Mono' }).click();
    await expect(studio.locator('.ing-looks .chip.is-active')).toHaveText('Mono');
    await expect(adjustReadout(studio, 'Saturation')).toHaveText('0%');
    await expect(adjustReadout(studio, 'Contrast')).toHaveText('120%');
    await expect(adjustReadout(studio, 'Brightness')).toHaveText('100%');
    await studio.locator('.ing-ws-panel .section', { hasText: 'Resize' }).locator('select').selectOption('long-512');
    await expect(studio.locator('.ing-stage-badge')).toContainText('512 × 512');
    await studio.locator('.ing-ws-header .btn', { hasText: 'Save as new' }).click();
    await expect.poll(async () => (await library(studio)).length).toBe(2);
    const edited = (await library(studio)).find((i) => i.id !== id);
    expect([edited.width, edited.height]).toEqual([512, 512]);
    const info = await imageInfo(studio, edited.id, [[50, 50], [256, 256], [400, 120]]);
    for (const [r, g, b] of info.px) expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(8);

    // 1280x720 preset locks the crop to 16:9.
    await studio.locator('.ing-ws-panel .section', { hasText: 'Resize' }).locator('select').selectOption('1280x720');
    await expect(studio.locator('.ing-aspect.is-active')).toHaveText('16:9');
    await expect(studio.locator('.ing-stage-badge')).toContainText('1280 × 720');
  } finally {
    await ctx.close();
  }
});

test('async clipboard copy + paste button, file drop, arrow keys, bulk tags, picker paste', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await ctx.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openTab(studio);
    await seedIngredients(studio, [
      { file: 'thumb-red.jpg', name: 'Red' },
      { file: 'thumb-green.jpg', name: 'Green' },
    ]);
    // Arrow keys move the cursor; Enter opens the focused image.
    await studio.locator('.ing-card', { hasText: 'Green' }).click();
    await studio.keyboard.press('ArrowRight');
    await expect(studio.locator('.ing-card.is-selected')).toHaveText(/Red/);
    await studio.keyboard.press('ArrowLeft');
    await expect(studio.locator('.ing-card.is-selected')).toHaveText(/Green/);

    // Copy the image (Ctrl/⌘+C) then paste it back through the Add menu's clipboard button.
    await studio.keyboard.press('ControlOrMeta+c');
    await expect(studio.locator('.toast', { hasText: 'Image copied to the clipboard' })).toBeVisible();
    await studio.locator('[data-testid="ing-add"]').click();
    await studio.locator('.menu-item', { hasText: 'Paste from clipboard' }).click();
    await expect.poll(async () => (await library(studio)).filter((i) => i.origin === 'paste').length).toBe(1);
    expect((await library(studio)).find((i) => i.origin === 'paste')).toMatchObject({ width: 640, height: 360, mime: 'image/png' });

    // Drop an image file onto the library.
    await studio.evaluate(async () => {
      const bytes = await (await fetch('https://assets.grok.com/test/still.png')).arrayBuffer();
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped-ref.png', { type: 'image/png' }));
      const el = document.querySelector('.ing-drop');
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await library(studio)).filter((i) => i.name === 'dropped-ref').length).toBe(1);

    // Bulk tags for the whole selection.
    await studio.locator('.ing-grid').focus();
    await studio.keyboard.press('ControlOrMeta+a');
    await studio.locator('.ing-inspector .btn, .ing-inspector .icon-btn').filter({ has: studio.locator('svg') }).first().waitFor();
    await studio.locator('.ing-inspector [title="Add tags…"]').click();
    await studio.locator('.modal input.text-field').fill('moodboard, #Act 1');
    await studio.locator('.modal button[type="submit"]').click();
    await expect.poll(async () => (await library(studio)).every((i) => i.tags.includes('moodboard') && i.tags.includes('Act 1'))).toBe(true);
    await expect(studio.locator('.ing-filterbar .chip', { hasText: 'moodboard' })).toContainText('4');
  } finally {
    await ctx.close();
  }
});

test('menus own their keys; filtered-out images leave the selection; Ctrl+C copies selected text; no duplicate imports', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await ctx.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openTab(studio);
    await seedIngredients(studio, [
      { file: 'thumb-red.jpg', name: 'Red' },
      { file: 'thumb-green.jpg', name: 'Green' },
      { file: 'thumb-blue.jpg', name: 'Blue' },
    ]);
    const selected = async () => (await studio.locator('.ing-card.is-selected .ing-card-name').allTextContents()).sort();

    // An open context menu takes Escape / arrows / Delete: the selection behind it is untouched.
    await studio.locator('.ing-card', { hasText: 'Red' }).click();
    await studio.locator('.ing-card', { hasText: 'Green' }).click({ modifiers: ['ControlOrMeta'] });
    await studio.locator('.ing-card', { hasText: 'Green' }).click({ button: 'right' });
    await expect(studio.locator('.menu')).toBeVisible();
    await studio.keyboard.press('ArrowRight');
    await studio.keyboard.press('Delete');
    await expect(studio.locator('.modal')).toHaveCount(0);
    expect(await selected()).toEqual(['Green', 'Red']);
    await studio.keyboard.press('Escape');
    await expect(studio.locator('.menu')).toHaveCount(0);
    expect(await selected()).toEqual(['Green', 'Red']);
    await studio.keyboard.press('Escape'); // with the menu gone, Escape clears the selection
    expect(await selected()).toEqual([]);

    // Images hidden by the search leave the selection, so Delete only counts what you can see.
    await studio.locator('.ing-card', { hasText: 'Red' }).click();
    await studio.locator('.ing-search input').fill('green');
    await expect(studio.locator('.ing-card')).toHaveCount(1);
    await studio.locator('.ing-card', { hasText: 'Green' }).click({ modifiers: ['ControlOrMeta'] });
    expect(await selected()).toEqual(['Green']);
    await studio.keyboard.press('Delete');
    await expect(studio.locator('.modal .modal-title')).toHaveText('Delete image?');
    await expect(studio.locator('.modal')).toContainText('“Green”');
    await studio.locator('.modal .btn', { hasText: 'Cancel' }).click();
    await studio.locator('.ing-search input').fill('');
    await expect(studio.locator('.ing-card')).toHaveCount(3);
    expect(await selected()).toEqual(['Green']);

    // Ctrl/⌘+C with text selected in the inspector copies the text, not the image.
    await studio.locator('.ing-card', { hasText: 'Blue' }).click();
    await studio.evaluate(() => {
      const row = [...document.querySelectorAll('.ing-inspector .ing-info-row')].find((r) => r.textContent.includes('Size'));
      const range = document.createRange();
      range.selectNodeContents(row.querySelector('.ing-info-v'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await studio.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => studio.evaluate(() => navigator.clipboard.readText())).toContain('× 360 px');
    await expect(studio.locator('.toast', { hasText: 'Image copied' })).toHaveCount(0);
    await studio.evaluate(() => getSelection().removeAllRanges());
    await studio.locator('.ing-grid').focus();
    await studio.keyboard.press('ControlOrMeta+c');
    await expect(studio.locator('.toast', { hasText: 'Image copied to the clipboard' })).toBeVisible();

    // Two quick requests for one grok.com image (a double click on the page's button) add it once.
    const item = { key: 'image:dupe', kind: 'image', url: 'https://assets.grok.com/test/thumb-hd.jpg', altUrls: [], thumbUrl: null, prompt: 'Nebula poster', source: 'network', pageUrl: 'https://grok.com/imagine', seenAt: Date.now() };
    await studio.evaluate((it) => {
      const bus = window.__gis.appState.appEvents;
      bus.emit('ingredient.fromPage', { item: it });
      bus.emit('ingredient.fromPage', { item: it });
    }, item);
    await expect(studio.locator('.toast', { hasText: '“Nebula poster” is already in Ingredients' })).toBeVisible();
    await expect.poll(async () => (await library(studio)).filter((i) => i.sourceUrl === item.url).length).toBe(1);
    // ...and so do two concurrent imports of one URL.
    const url = 'https://assets.grok.com/test/thumb-vertical.jpg';
    const urlIds = await studio.evaluate(async ({ mod, url }) => {
      const A = await import(mod);
      return Promise.all([A.importFromUrl(url, { quiet: true }), A.importFromUrl(url, { quiet: true })]);
    }, { mod: ING, url });
    expect(urlIds[0]).toBe(urlIds[1]);
    expect((await library(studio)).filter((i) => i.sourceUrl === url).length).toBe(1);

    // 'ingredient.add' with quiet: true (the sender shows its own confirmation) adds silently; 'export' has a label.
    await studio.evaluate(async () => {
      const blob = await (await fetch('https://assets.grok.com/test/thumb-red.jpg')).blob();
      window.__gis.appState.appEvents.emit('ingredient.add', { blob, name: 'Exported frame', origin: 'export', sourceUrl: null, quiet: true });
    });
    await expect.poll(async () => (await library(studio)).some((i) => i.name === 'Exported frame')).toBe(true);
    await expect(studio.locator('.toast', { hasText: 'Exported frame' })).toHaveCount(0);
    await studio.locator('.ing-card', { hasText: 'Exported frame' }).click();
    await expect(studio.locator('.ing-inspector .ing-info-row', { hasText: 'Source' })).toContainText('Export');
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('deleted images leave shots and bible entries (also after undo and in other sequences); "Use in shot" counts', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await openTab(studio);
    const [red, green, blue] = await seedIngredients(studio, [
      { file: 'thumb-red.jpg', name: 'Red' },
      { file: 'thumb-green.jpg', name: 'Green' },
      { file: 'thumb-blue.jpg', name: 'Blue' },
    ]);
    await studio.evaluate(
      ({ red, green }) =>
        window.__gis.projectStore.update(
          (p) => ({
            ...p,
            shots: [{ id: 'sht_a', title: 'Opening', prompt: 'A red car', fields: {}, ingredientIds: [red, green], duration: 6, mode: 'video', notes: '', status: 'draft', takes: [], chosenTake: null, createdAt: Date.now() }],
            bible: { ...p.bible, characters: [{ id: 'bib_hero', name: 'Hero', description: '', ingredientIds: [red] }] },
          }),
          { label: 'seed refs' },
        ),
      { red, green },
    );

    // Use in shot with one new and one existing reference: the toast counts only the new one.
    await studio.locator('.ing-card', { hasText: 'Green' }).click();
    await studio.locator('.ing-card', { hasText: 'Blue' }).click({ modifiers: ['ControlOrMeta'] });
    await studio.locator('.ing-card', { hasText: 'Blue' }).click({ button: 'right' });
    await studio.locator('.menu-item', { hasText: 'Use in shot' }).click();
    await studio.locator('.menu-item', { hasText: '1. Opening' }).click();
    await expect(studio.locator('.toast', { hasText: 'Added 1 reference to 1. Opening' })).toBeVisible();
    expect((await getProject(studio)).shots[0].ingredientIds).toEqual([red, green, blue]);

    // Delete Red: the confirmation says what loses the reference, and the id leaves the shot and the bible entry.
    await studio.locator('.ing-card', { hasText: 'Red' }).click();
    await studio.keyboard.press('Delete');
    const dialog = studio.locator('.modal', { hasText: 'Delete image?' });
    await expect(dialog).toContainText('1 shot and 1 bible entry in this sequence will lose the reference');
    await dialog.locator('.btn', { hasText: 'Delete' }).click();
    await expect(studio.locator('.ing-card')).toHaveCount(2);
    await expect.poll(async () => (await getProject(studio)).shots[0].ingredientIds).toEqual([green, blue]);
    let p = await getProject(studio);
    expect(p.bible.characters[0].ingredientIds).toEqual([]);
    expect(await studio.evaluate(() => window.__gis.projectStore.undoLabel())).toBe('Add shot references'); // not an undo step

    // Undo goes back to a snapshot that still listed Red: the dead id is dropped again; redo is intact.
    await studio.evaluate(() => window.__gis.projectStore.undo());
    await expect.poll(async () => (await getProject(studio)).shots[0].ingredientIds).toEqual([green]);
    expect((await getProject(studio)).bible.characters[0].ingredientIds).toEqual([]);
    await studio.evaluate(() => window.__gis.projectStore.redo());
    await expect.poll(async () => (await getProject(studio)).shots[0].ingredientIds).toEqual([green, blue]);
    // Every remaining reference has its image (the Prompts tab's batch send attaches them all).
    const missing = await studio.evaluate(async () => {
      const q = window.__gis.projectStore.get();
      const ids = [...q.shots.flatMap((s) => s.ingredientIds), ...q.bible.characters.flatMap((c) => c.ingredientIds)];
      const out = [];
      for (const id of ids) if (!(await window.__gis.db.getBlob(id))) out.push(id);
      return out;
    });
    expect(missing).toEqual([]);

    // A sequence opened later drops references to images that no longer exist anywhere (and keeps the others).
    await studio.evaluate(async ({ green }) => {
      const { model, db, appState } = window.__gis;
      const other = { ...model.createProject('Older sequence'), shots: [{ id: 'sht_old', title: 'Old', prompt: 'x', fields: {}, ingredientIds: ['ing_deleted_long_ago', green], duration: 6, mode: 'video', notes: '', status: 'draft', takes: [], chosenTake: null, createdAt: 1 }] };
      await db.putProject(other);
      await appState.openProject(other.id);
    }, { green });
    await expect.poll(async () => (await getProject(studio)).shots[0]?.ingredientIds).toEqual([green]);
    p = await getProject(studio);
    expect(p.name).toBe('Older sequence');
    expect(await studio.evaluate(() => window.__gis.projectStore.canUndo())).toBe(false);
  } finally {
    await ctx.close();
  }
});

test('editor: ratio-locked corners shrink, fields show the value used, no-op edits are not undo steps, sliders keep their keys, paste/drop while editing', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await openTab(studio);
    await seedIngredients(studio, [{ file: 'still.jpg', name: 'Pattern' }]);
    await studio.locator('.ing-card', { hasText: 'Pattern' }).dblclick();
    await expect(studio.locator('.ing-stage-canvas')).toBeVisible();
    const field = (i) => studio.locator('.ing-crop-fields input').nth(i);
    const values = () => Promise.all([0, 1, 2, 3].map(async (i) => Number(await field(i).inputValue())));
    const undoBtn = studio.locator('.ing-ws-actions [title^="Undo image edit"]');

    // X typed past the edge shows the value actually used; nudging against the edge changes nothing: no undo step.
    await field(0).fill('100');
    await field(0).press('Enter');
    await expect(field(0)).toHaveValue('0');
    await studio.keyboard.press('ArrowLeft');
    await studio.keyboard.press('ArrowUp');
    await expect(undoBtn).toBeDisabled();

    // 16:9 crop: a corner dragged straight in (along one axis) shrinks it, ratio and opposite corner kept.
    await studio.locator('.ing-aspect', { hasText: '16:9' }).click();
    await expect(field(3)).toHaveValue('576');
    const drag = async (handle, dx, dy) => {
      const hb = await studio.locator(`.ing-crop-h.h-${handle}`).boundingBox();
      const x = hb.x + hb.width / 2;
      const y = hb.y + hb.height / 2;
      await studio.mouse.move(x, y);
      await studio.mouse.down();
      await studio.mouse.move(x + dx, y + dy, { steps: 8 });
      await studio.mouse.up();
    };
    const box = await studio.locator('[data-testid="crop-box"]').boundingBox();
    await drag('se', -box.width * 0.25, 0);
    let [x, y, w, h] = await values();
    expect([x, y]).toEqual([0, 224]);
    expect(w).toBeGreaterThan(700);
    expect(w).toBeLessThan(900);
    expect(Math.abs(h - (w * 9) / 16)).toBeLessThanOrEqual(1.5);
    const w1 = w;
    await drag('se', 0, -box.height * 0.2);
    [x, y, w, h] = await values();
    expect([x, y]).toEqual([0, 224]);
    expect(w).toBeLessThan(w1 - 40);
    await drag('nw', box.width * 0.1, 0);
    const [x3, y3, w3, h3] = await values();
    expect(w3).toBeLessThan(w - 20);
    expect(Math.abs(x3 + w3 - (x + w))).toBeLessThanOrEqual(1); // bottom-right corner anchored
    expect(Math.abs(y3 + h3 - (y + h))).toBeLessThanOrEqual(1);
    await expect(undoBtn).toBeEnabled();

    // Adjustments read like the Edit tab's clip looks: % of the original, 100% = untouched.
    for (const label of ['Brightness', 'Contrast', 'Saturation']) await expect(adjustReadout(studio, label)).toHaveText('100%');
    await expect(adjustReadout(studio, 'Warmth')).toHaveText('0');
    await expect(adjustReadout(studio, 'Sharpen')).toHaveText('0%');

    // A focused slider keeps its keys: arrows change the value, letters don't fire tools.
    const flipH = studio.locator('.ing-stage-tools [title^="Flip horizontal"]');
    const brightness = studio.locator('.ing-ws-panel .slider', { hasText: 'Brightness' }).locator('input[type=range]');
    await brightness.focus();
    await studio.keyboard.press('ArrowRight');
    await studio.keyboard.press('ArrowRight');
    await expect(brightness).toHaveValue('102');
    await expect(adjustReadout(studio, 'Brightness')).toHaveText('102%');
    // Double-clicking the label resets to 100%.
    await studio.locator('.ing-ws-panel .slider', { hasText: 'Brightness' }).locator('.slider-label').dblclick();
    await expect(adjustReadout(studio, 'Brightness')).toHaveText('100%');
    await brightness.focus();
    await studio.keyboard.press('h');
    await expect(flipH).not.toHaveAttribute('aria-pressed', 'true');
    await studio.evaluate(() => document.activeElement.blur());
    await studio.keyboard.press('h');
    await expect(flipH).toHaveAttribute('aria-pressed', 'true');

    // Custom output size: the width drives the height through the (16:9) crop; fields show the size used.
    await studio.locator('.ing-ws-panel .section', { hasText: 'Resize' }).locator('select').selectOption('custom');
    const outW = studio.locator('.ing-custom-size input').first();
    await settle(studio); // the size fields just mounted
    await outW.fill('400');
    await outW.press('Enter');
    await expect(studio.locator('.ing-stage-badge')).toContainText(/400 × 22[4-6]/);
    await expect(outW).toHaveValue('400');
    await settle(studio); // the field remounts after each commit (it shows the value used)
    await outW.fill('99999');
    await outW.press('Enter');
    await expect(outW).toHaveValue('8192'); // capped

    // Paste while editing imports the image; the editor stays open.
    const before = (await library(studio)).length;
    await studio.evaluate(async () => {
      const bytes = await (await fetch('https://assets.grok.com/test/still.png')).arrayBuffer();
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.querySelector('.ing-stage').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await library(studio)).length).toBe(before + 1);
    await expect(studio.locator('.ing-ws-name')).toHaveText('Pattern');
    // A file dropped on the editor is imported too, and the toast offers to edit it.
    await studio.evaluate(async () => {
      const bytes = await (await fetch('https://assets.grok.com/test/thumb-red.jpg')).arrayBuffer();
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped-on-editor.jpg', { type: 'image/jpeg' }));
      const el = document.querySelector('.ing-stage');
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await library(studio)).some((i) => i.name === 'dropped-on-editor')).toBe(true);
    const added = studio.locator('.toast', { hasText: 'Added “dropped-on-editor” to Ingredients' });
    await expect(added.locator('.toast-action', { hasText: 'Edit' })).toBeVisible();
    // Switching to it with unsaved edits asks first.
    await added.locator('.toast-action').click();
    await expect(studio.locator('.modal', { hasText: 'Discard changes?' })).toBeVisible();
    await studio.locator('.modal .btn', { hasText: 'Discard' }).click();
    await expect(studio.locator('.ing-ws-name')).toHaveText('dropped-on-editor');
    await expect(studio.locator('.ing-stage-badge')).toContainText('640 × 360');
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('downloads (library, edited image, reference sheet) and the editor\'s Copy deliver the right pixels and file names', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await ctx.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openTab(studio);
    await seedIngredients(studio, [
      { file: 'still.jpg', name: 'Hero poster' },
      { file: 'thumb-hd.jpg', name: 'Purple nebula' },
    ]);
    // Record what chrome.downloads receives (decoded, before the object URL is revoked).
    await studio.evaluate(() => {
      window.__downloads = [];
      chrome.downloads.download = async ({ url, filename }) => {
        const blob = await (await fetch(url)).blob();
        const bmp = await createImageBitmap(blob);
        window.__downloads.push({ filename, type: blob.type, w: bmp.width, h: bmp.height });
        bmp.close();
        return window.__downloads.length;
      };
    });
    const downloads = () => studio.evaluate(() => window.__downloads);

    await studio.locator('.ing-card', { hasText: 'Hero poster' }).click({ button: 'right' });
    await studio.locator('.menu-item', { hasText: 'Download' }).click();
    await expect.poll(downloads).toEqual([{ filename: 'hero-poster.jpg', type: 'image/jpeg', w: 1024, h: 1024 }]);

    // The editor downloads and copies the edited result.
    await studio.locator('.ing-card', { hasText: 'Hero poster' }).dblclick();
    await expect(studio.locator('.ing-stage-canvas')).toBeVisible();
    await studio.locator('.ing-aspect', { hasText: '16:9' }).click();
    await studio.locator('.ing-ws-header [title="Download the edited image"]').click();
    await expect.poll(async () => (await downloads())[1]).toEqual({ filename: 'hero-poster.jpg', type: 'image/jpeg', w: 1024, h: 576 });
    await studio.locator('.ing-ws-header [title="Copy the edited image"]').click();
    await expect(studio.locator('.toast', { hasText: 'Image copied to the clipboard' })).toBeVisible();
    const copied = await studio.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const blob = await item.getType('image/png');
      const bmp = await createImageBitmap(blob);
      return [bmp.width, bmp.height];
    });
    expect(copied).toEqual([1024, 576]);
    await studio.keyboard.press('Escape');
    await studio.locator('.modal .btn', { hasText: 'Discard' }).click();
    await expect(studio.locator('.ing-ws')).toBeHidden();

    // The reference sheet downloads at its output size.
    await studio.locator('.ing-card', { hasText: 'Hero poster' }).click();
    await studio.locator('.ing-card', { hasText: 'Purple nebula' }).click({ modifiers: ['ControlOrMeta'] });
    await studio.keyboard.press('g');
    const modal = studio.locator('.ing-composer-modal');
    await modal.locator('.field', { hasText: 'Output size' }).locator('select').selectOption('1280x720');
    await expect(modal.locator('.btn', { hasText: 'Download' })).toBeEnabled();
    await modal.locator('.btn', { hasText: 'Download' }).click();
    await expect.poll(async () => (await downloads())[2]).toEqual({ filename: 'reference-sheet-2.jpg', type: 'image/jpeg', w: 1280, h: 720 });
    await expect(modal).toBeVisible(); // downloading keeps the composer open
  } finally {
    await ctx.close();
  }
});

for (const width of [480, 1440]) {
  test(`renders cleanly at ${width}px (library, inspector/selection bar, editor)`, async ({}, testInfo) => {
    const ctx = await launch({ viewport: { width, height: 860 } });
    try {
      const studio = await openStudioTab(ctx);
      await openTab(studio);
      await seedIngredients(studio, [
        { file: 'still.jpg', name: 'Hero poster', tags: ['character', 'hero'] },
        { file: 'thumb-hd.jpg', name: 'Purple nebula', tags: ['location'] },
        { file: 'thumb-vertical.jpg', name: 'Desert road', tags: ['location'] },
        { file: 'still.png', name: 'Gradient', tags: ['style'] },
      ]);
      await studio.locator('.ing-card', { hasText: 'Hero poster' }).click();
      if (width >= 960) await expect(studio.locator('.ing-inspector .ing-details')).toBeVisible();
      else {
        // Narrow selection bar: secondary actions are icons, the primary action keeps its label (like Clips).
        const bar = studio.locator('.ing-selbar');
        await expect(bar).toBeVisible();
        await expect(bar.locator('.btn-primary')).toHaveText('Attach');
        await expect(bar.locator('.btn-label')).toHaveCount(1);
        await expect(bar.locator('.icon-btn[title="Use in shot"]')).toBeVisible();
        for (const n of [1, 2]) {
          if (n === 2) await studio.locator('.ing-card', { hasText: 'Desert road' }).click({ modifiers: ['ControlOrMeta'] });
          await expect(studio.locator('.ing-selbar-count')).toHaveText(`${n} selected`);
          const r = await bar.boundingBox();
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.x + r.width).toBeLessThanOrEqual(width);
          expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        }
        await studio.locator('.ing-card', { hasText: 'Hero poster' }).click();
      }
      const noOverflow = () => studio.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.ing-toolbar').scrollWidth <= document.querySelector('.ing-toolbar').clientWidth + 1);
      expect(await noOverflow()).toBe(true);
      await studio.screenshot({ path: testInfo.outputPath(`ingredients-library-${width}.png`) });
      // One undo/redo pair at a time: the header's (sequence) in the library, the editor's (image edits) while editing.
      const headerUndo = studio.locator('.app-header .header-actions [title^="Undo"]');
      const headerRedo = studio.locator('.app-header .header-actions [title^="Redo"]');
      await expect(headerUndo).toBeVisible();
      await studio.keyboard.press('Enter');
      await expect(studio.locator('.ing-stage-canvas')).toBeVisible();
      await expect(studio.locator('.ing-ws-header .btn', { hasText: 'Save as new' })).toBeVisible();
      await expect(studio.locator('.ing-ws-actions [title^="Undo image edit"]')).toBeVisible();
      await expect(headerUndo).toBeHidden();
      await expect(headerRedo).toBeHidden();
      expect(await studio.evaluate(() => document.querySelector('.ing-ws-header').scrollWidth <= document.querySelector('.ing-ws-header').clientWidth + 1)).toBe(true);
      await studio.screenshot({ path: testInfo.outputPath(`ingredients-editor-${width}.png`) });
      // Another tab (the editor stays open behind it) shows the sequence undo/redo again.
      await studio.locator('.app-tabs .tab[title^="Timeline editor"]').click();
      await expect(studio.locator('.view-edit')).toBeVisible();
      await expect(headerUndo).toBeVisible();
      await expect(headerRedo).toBeVisible();
      await openTab(studio);
      await expect(studio.locator('.ing-ws')).toBeVisible();
      await expect(headerUndo).toBeHidden();
      if (width < 760) {
        // The narrow header's "More" menu takes Escape; the editor stays open.
        await studio.locator('.ing-ws-header [title="More"]').click();
        await expect(studio.locator('.menu')).toBeVisible();
        await studio.keyboard.press('Escape');
        await expect(studio.locator('.menu')).toHaveCount(0);
        await expect(studio.locator('.ing-ws')).toBeVisible();
        // Each side-panel tab opens at the top.
        await studio.evaluate(() => {
          const b = document.querySelector('.ing-ws-panel-body');
          b.scrollTop = b.scrollHeight;
        });
        await studio.locator('.ing-ws-tabs .tab', { hasText: 'Details' }).click();
        await expect(studio.locator('.ing-ws-details')).toBeVisible();
        expect(await studio.evaluate(() => document.querySelector('.ing-ws-panel-body').scrollTop)).toBe(0);
        await studio.screenshot({ path: testInfo.outputPath(`ingredients-details-${width}.png`) });
        await studio.locator('.ing-ws-tabs .tab', { hasText: 'Edit' }).click();
      }
      await studio.keyboard.press('Escape');
      await expect(studio.locator('.ing-ws')).toBeHidden();
    } finally {
      await ctx.close();
    }
  });
}
