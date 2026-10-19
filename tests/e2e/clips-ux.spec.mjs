// Clips tab (extension/studio/ui/media/**), fixes from the journey / UX / edge reviews: one bulk add keeps the strip's
// order (bin, Review, multi-select add), the review summary never adds a placed pick twice, "reveal in bin"
// ('bin.reveal') in BinCompact and the Clips bin, the always visible "+" on grok.com clips, the compact auto-add switch
// (off-limits while disconnected), the one-line "not connected" notice, Trim / Open in the selection bar, the
// "On timeline" chip, the bin as a single Tab stop, the "Import from a URL" dialog, Ingredients toasts, and the
// rendering shortcuts that keep big bins fast.
import { test } from '@playwright/test';
import { launch, openStudioTab, seedMedia, getProject, expect } from './harness.mjs';
import { POSTS, videoUrl, thumbUrl, imageUrl } from './fixtures-map.mjs';

const cardIds = (page) => page.$$eval('.bin-grid .bin-card', (els) => els.map((e) => e.dataset.mediaId));
const card = (page, id) => page.locator(`.bin-card[data-media-id="${id}"]`);
const media = (page, id) => page.evaluate((mid) => window.__gis.projectStore.get().media[mid] || null, id);
const ui = (page) => page.evaluate(() => window.__gis.uiStore.get());
const timelineMedia = (page) => page.evaluate(() => window.__gis.projectStore.get().tracks.video.map((c) => c.mediaId));
const appErrors = (ctx) => ctx.consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e));
const reveal = (page, id) => page.evaluate((mid) => window.__gis.appState.appEvents.emit('bin.reveal', { mediaId: mid }), id);
const focusedId = (page) => page.evaluate(() => document.activeElement?.closest('.bin-card')?.dataset.mediaId || null);

async function fakePageItems(page, { connected = true } = {}) {
  const items = Object.entries(POSTS).map(([id, p], i) => ({
    key: `${p.kind}:${id}`,
    kind: p.kind,
    url: p.kind === 'video' ? videoUrl(id) : imageUrl(id),
    altUrls: [],
    thumbUrl: thumbUrl(id),
    postId: id,
    prompt: p.prompt,
    model: null,
    createdAt: null,
    width: p.width,
    height: p.height,
    duration: p.duration || null,
    source: 'network',
    pageUrl: 'https://grok.com/imagine',
    seenAt: Date.now() - i * 1000,
  }));
  await page.evaluate(({ items, connected }) => window.__gis.pageStore.set((s) => ({ ...s, connected, info: { route: 'imagine', url: 'https://grok.com/imagine' }, items })), { items, connected });
  return items;
}

/** R, then End and → until the review summary shows (review mode registers its keys right after its first paint). */
async function toSummary(page) {
  await page.keyboard.press('r');
  const review = page.locator('.clips-review');
  await expect(review).toBeVisible();
  await expect(async () => {
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
    await expect(review.locator('.clips-review-done')).toBeVisible({ timeout: 300 });
  }).toPass({ timeout: 10000 });
}

async function allReady(page, n) {
  await page.waitForFunction(
    (count) => {
      const p = window.__gis.projectStore.get();
      return p.mediaOrder.length === count && p.mediaOrder.every((id) => p.media[id].status === 'ready');
    },
    n,
    { timeout: 60000 },
  );
}

test('one "Add all videos" keeps the strip order in the bin, in Review and in a multi-selection add, across millisecond ticks', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const items = await fakePageItems(page);
    await expect(page.locator('.clips-pcard')).toHaveCount(items.length);
    const strip = (await page.$$eval('.clips-pcard', (els) => els.map((e) => e.dataset.key))).filter((k) => k.startsWith('video:'));
    // A slow machine: every Date.now() in the studio lands on the next millisecond, so each item of the batch gets its
    // own addedAt (this scrambled "Newest first" before).
    await page.evaluate(() => {
      const real = Date.now.bind(Date);
      let last = 0;
      Date.now = () => (last = Math.max(real(), last + 1));
    });
    await page.locator('.clips-page-head button', { hasText: 'Add all videos' }).click();
    await allReady(page, strip.length);
    const p = await getProject(page);
    expect(new Set(p.mediaOrder.map((id) => p.media[id].addedAt)).size, 'addedAt differs inside the batch').toBeGreaterThan(1);
    const order = await cardIds(page);
    expect(order.map((id) => p.media[id].pageKey), 'bin (Newest first) = the strip').toEqual(strip);
    // "Oldest first" is the exact reverse.
    await page.evaluate(() => window.__gis.uiStore.set((s) => ({ ...s, binFilter: { ...s.binFilter, sort: 'oldest' } })));
    await expect.poll(() => cardIds(page)).toEqual(order.slice().reverse());
    await page.evaluate(() => window.__gis.uiStore.set((s) => ({ ...s, binFilter: { ...s.binFilter, sort: 'newest' } })));
    await expect.poll(() => cardIds(page)).toEqual(order);

    // Review walks the same order.
    await page.keyboard.press('r');
    const review = page.locator('.clips-review');
    for (const [i, id] of order.entries()) {
      await expect(review.locator('.clips-review-count')).toHaveText(`${i + 1} / ${order.length}`);
      await expect(review.locator('.clips-review-prompt-text')).toHaveText(p.media[id].prompt);
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Escape');
    await expect(review).toHaveCount(0);

    // A multi-selection is appended in the order the bin shows it, and the button says so.
    await card(page, order[2]).click();
    await card(page, order[0]).click({ modifiers: ['Control'] });
    await card(page, order[1]).click({ modifiers: ['Control'] });
    const add = page.locator('.bin-selbar .btn', { hasText: /^Add/ });
    await expect(add).toHaveAttribute('title', /in the order the bin shows them/);
    await add.click();
    expect(await timelineMedia(page)).toEqual(order.slice(0, 3));
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('review summary adds only the picks not on the timeline yet, says so, and is disabled when every pick is placed', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4']);
    const order = await cardIds(page);
    const review = page.locator('.clips-review');
    const addPicked = review.locator('.clips-review-add-picked');

    await page.keyboard.press('r');
    await expect(review.locator('.clips-review-count')).toHaveText('1 / 3');
    await page.keyboard.press('p');
    await page.keyboard.press('Enter'); // keeper: on the timeline, next
    await expect(review.locator('.clips-review-count')).toHaveText('2 / 3');
    await page.keyboard.press('p');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(review.locator('.clips-review-done-title')).toHaveText('Review complete');
    await expect(review.locator('.clips-review-done-body')).toContainText('You picked 2 of 3 items');
    await expect(review.locator('.clips-review-done-body')).toContainText('1 of them is already on the timeline');
    await expect(addPicked).toHaveText('Add 1 picked not on the timeline yet');
    await addPicked.click();
    await expect(review).toHaveCount(0);
    expect(await timelineMedia(page)).toEqual([order[0], order[1]]);

    // Again: both picks are placed now.
    await toSummary(page);
    await expect(review.locator('.clips-review-done-body')).toContainText('All of them are already on the timeline');
    await expect(addPicked).toHaveText('Every pick is on the timeline');
    await expect(addPicked).toBeDisabled();
    await page.keyboard.press('Escape');

    // A pick placed before the review counts too; one not placed yet is the only one added.
    await page.locator('.bin-status .bin-link', { hasText: 'Select all' }).click();
    await page.keyboard.press('p');
    await page.keyboard.press('Escape');
    await toSummary(page);
    await expect(addPicked).toHaveText('Add 1 picked not on the timeline yet');
    await addPicked.click();
    expect(await timelineMedia(page)).toEqual([order[0], order[1], order[2]]);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('reveal in bin: BinCompact clears the search / picked-only filter hiding the item, selects, scrolls to and flashes it; hidden bins are left alone', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const ids = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4', 'clip-noaudio.mp4', 'clip-cyan.webm', 'clip-hd.mp4', 'clip-vertical.mp4', 'still.jpg', 'still.png', 'music.mp3', 'voice.wav']);
    const [red, green] = ids;
    await page.evaluate((id) => window.__gis.projectStore.update((p) => window.__gis.model.updateMedia(p, id, { flag: 'pick' })), ids[5]);
    await page.evaluate(() => window.__gis.uiStore.set((s) => ({ ...s, binFilter: { ...s.binFilter, flag: 'pick' }, binSelection: [] })));
    await page.locator('.app-tabs .tab', { hasText: 'Edit' }).click();
    const compact = page.locator('.edit-bin .bin-compact');
    const search = compact.locator('.bin-compact-search input');
    await search.fill('blue');
    await compact.locator('[title="Show picked clips only"]').click();
    await expect(compact.locator(`.bin-compact-item[data-media-id="${red}"]`)).toHaveCount(0);

    await reveal(page, red);
    const item = compact.locator(`.bin-compact-item[data-media-id="${red}"]`);
    await expect(item).toHaveClass(/is-selected/);
    await expect(search).toHaveValue('');
    await expect(compact.locator('[title="Show picked clips only"]')).toBeVisible(); // picked-only switched off
    await expect(item.locator('.bin-compact-flash')).toHaveCount(1);
    await expect(item).toBeInViewport();
    // The Clips tab (hidden) keeps its own filter and selection.
    expect((await ui(page)).binFilter.flag).toBe('pick');
    expect((await ui(page)).binSelection).toEqual([]);

    // A bin panel that opens to show the item (the request comes first) still reveals it.
    await page.evaluate(() => window.__gis.uiStore.set((s) => ({ ...s, binOpen: false })));
    await expect(compact).toHaveCount(0);
    await reveal(page, green);
    await page.evaluate(() => window.__gis.uiStore.set((s) => ({ ...s, binOpen: true })));
    await expect(compact.locator(`.bin-compact-item[data-media-id="${green}"]`)).toHaveClass(/is-selected/);
    await expect(compact.locator(`.bin-compact-item[data-media-id="${green}"] .bin-compact-flash`)).toHaveCount(1);

    // In the Clips tab: only the criterion hiding the item is reset (the sort stays), the card is selected and flashed.
    await search.fill('cyan');
    await page.locator('.app-tabs .tab', { hasText: 'Clips' }).click();
    await page.evaluate(() => window.__gis.uiStore.set((s) => ({ ...s, binFilter: { ...s.binFilter, sort: 'name' } })));
    await expect(card(page, green)).toHaveCount(0);
    await reveal(page, green);
    await expect(card(page, green)).toHaveClass(/is-selected/);
    await expect(card(page, green).locator('.bin-card-flash')).toHaveCount(1);
    await expect(card(page, green)).toBeInViewport();
    expect((await ui(page)).binFilter).toMatchObject({ flag: 'all', sort: 'name' });
    expect((await ui(page)).binSelection).toEqual([green]);
    // ...and the Edit tab's BinCompact (mounted, hidden) did not touch its search.
    await expect(search).toHaveValue('cyan');
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('grok.com strip: "+" shown on clips not in the bin, a compact auto-add switch, both off-limits while disconnected; one-line notice above a used bin', async () => {
  const ctx = await launch({ viewport: { width: 720, height: 900 } });
  try {
    const page = await openStudioTab(ctx);
    const auto = page.locator('.clips-page-auto.is-compact .toggle');
    // Disconnected, empty bin: the full explanation; auto-add can't be switched on yet.
    await expect(page.locator('.clips-page .empty-title')).toHaveText('Not connected to grok.com');
    await expect(auto.locator('input')).toBeDisabled();
    await expect(auto).toHaveAttribute('title', /Connect to grok\.com first/);
    await expect(page.locator('[data-testid="bin-auto-on"]')).toHaveCount(0);

    const items = await fakePageItems(page);
    await expect(auto.locator('input')).toBeEnabled();
    // Every clip that is not in the bin shows its "+" without hovering.
    const plus = page.locator('.clips-pcard .clips-pcard-add');
    await expect(plus).toHaveCount(items.length);
    for (let i = 0; i < items.length; i++) await expect(plus.nth(i)).toBeVisible();
    // ...and it is the card's only Tab stop (the hover actions are reached with the mouse).
    await expect(page.locator('.clips-pcard-actions button:not([tabindex="-1"])')).toHaveCount(0);
    // The empty bin's "turn on auto-add" switches it on.
    await page.locator('[data-testid="bin-auto-on"]').click();
    expect((await ui(page)).autoCollect).toBe(true);
    await expect(page.locator('.toast', { hasText: 'added to the bin automatically' })).toBeVisible();
    await expect(auto.locator('input')).toBeChecked();
    await expect(page.locator('.bin-panel .empty-body')).toContainText('auto-add (on)');
    // The switch turns it off again.
    await auto.click();
    expect((await ui(page)).autoCollect).toBe(false);

    const first = page.locator(`.clips-pcard[data-key="${items[0].key}"]`);
    await first.locator('.clips-pcard-add').click();
    await expect(first).toHaveClass(/is-inbin/);
    await expect(first.locator('.clips-pcard-add')).toHaveCount(0);
    await allReady(page, 1);

    // Disconnected with a bin in use: one line with the way back, auto-add off-limits (menu too).
    await page.evaluate(() => window.__gis.pageStore.set((s) => ({ ...s, connected: false })));
    const banner = page.locator('.clips-page-banner');
    await expect(banner).toBeVisible();
    await expect(banner.locator('.btn', { hasText: 'Open Grok Imagine' })).toBeVisible();
    expect((await banner.boundingBox()).height).toBeLessThan(80);
    await expect(page.locator('.clips-page .empty')).toHaveCount(0);
    await expect(auto.locator('input')).toBeDisabled();
    await page.locator('.clips-page-head [title^="More"]').click();
    await expect(page.locator('.menu .menu-item', { hasText: 'Auto-add new videos' })).toBeDisabled();
    await expect(page.locator('.menu .menu-item', { hasText: 'Auto-add new images' })).toBeDisabled();
    await page.keyboard.press('Escape');
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('selection bar: Trim (Open for an image) opens the source monitor; the "On timeline" chip names the use and its count', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red, still] = await seedMedia(page, ['clip-red.mp4', 'still.jpg']);
    await card(page, red).click();
    const open = page.locator('.bin-selbar .bin-selbar-open');
    await expect(open).toHaveText('Trim');
    await open.click();
    await expect(page.locator(`.src-monitor[data-media-id="${red}"]`)).toBeVisible();
    await page.keyboard.press('Escape'); // closes the monitor
    await card(page, still).click();
    await expect(open).toHaveText('Open');
    await card(page, red).click({ modifiers: ['Control'] });
    await expect(open).toHaveCount(0); // several items: no single-item action

    await page.keyboard.press('Escape');
    await card(page, red).click();
    await page.keyboard.press('e');
    const chip = card(page, red).locator('.clips-thumb-used');
    await expect(chip.locator('.clips-thumb-used-label')).toHaveText('On timeline');
    await expect(chip.locator('.clips-thumb-used-n')).toBeHidden();
    await page.keyboard.press('e');
    await expect(chip.locator('.clips-thumb-used-n')).toHaveText('2×');
    await expect(chip).toHaveAttribute('title', 'On the timeline 2 times');
    await expect(card(page, still).locator('.clips-thumb-used')).toHaveCount(0);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('bin keyboard: the grid is a single Tab stop, arrows move focus with the selection, keys act on the focused card', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4', 'still.jpg']);
    const order = await cardIds(page);
    await expect(page.locator('.bin-grid [tabindex="0"]')).toHaveCount(1);
    await expect(page.locator('.bin-grid button:not([tabindex="-1"])')).toHaveCount(0); // in-card buttons: mouse, keys or menu

    await page.locator('.bin-search input').focus();
    let presses = 0;
    while (!(await focusedId(page)) && presses < 15) {
      await page.keyboard.press('Tab');
      presses++;
    }
    expect(await focusedId(page)).toBe(order[0]);
    expect(presses, 'Tab presses from the search to the bin').toBeLessThan(12);
    // Keys act on the focused card even before anything is selected.
    await page.keyboard.press('p');
    expect((await media(page, order[0])).flag).toBe('pick');
    await page.keyboard.press('ArrowRight');
    expect(await focusedId(page)).toBe(order[1]);
    expect((await ui(page)).binSelection).toEqual([order[1]]);
    await expect(page.locator('.bin-grid [tabindex="0"]')).toHaveAttribute('data-media-id', order[1]);
    // One Tab leaves the grid; Shift+Tab comes back to the same card.
    await page.keyboard.press('Tab');
    expect(await focusedId(page)).toBe(null);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.bin-grid'))).toBe(false);
    await page.keyboard.press('Shift+Tab');
    expect(await focusedId(page)).toBe(order[1]);
    await page.keyboard.press('Enter');
    await expect(page.locator(`.src-monitor[data-media-id="${order[1]}"]`)).toBeVisible();
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('import from a URL: a bad link keeps the dialog and the text; a failed download offers "Try again" and leaves no broken item', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    await page.locator('.bin-panel .empty .btn', { hasText: 'From a URL' }).click();
    const dialog = page.locator('.modal', { hasText: 'Import from a URL' });
    const input = dialog.locator('#clips-url-input');
    await expect(input).toBeFocused();
    await input.fill('not a url');
    await page.keyboard.press('Enter');
    await expect(dialog.locator('.clips-url-error')).toContainText('not a web link');
    await expect(input).toHaveValue('not a url');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await input.fill('assets.grok.com/test/clip-red.mp4');
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog.locator('.clips-url-error')).toContainText('start with https://');

    // A link that does not download: the dialog closed, the error offers "Try again", the bin stays clean.
    await input.fill('https://assets.grok.com/test/missing-file.mp4');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    const failed = page.locator('.toast', { hasText: 'Could not import that link' });
    await expect(failed).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await getProject(page)).mediaOrder.length).toBe(0);
    await failed.locator('.toast-action', { hasText: 'Try again' }).click();
    await expect(input).toHaveValue('https://assets.grok.com/test/missing-file.mp4');
    await expect(dialog.locator('.clips-url-error')).toBeVisible();

    await input.fill('https://assets.grok.com/test/clip-red.mp4');
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast', { hasText: 'Imported into the bin' })).toBeVisible({ timeout: 20000 });
    await allReady(page, 1);
    // Escape cancels without importing anything.
    await page.locator('.bin-toolbar button', { hasText: 'Import' }).click();
    await page.locator('.menu .menu-item', { hasText: 'From a URL' }).click();
    await page.keyboard.type('https://assets.grok.com/test/clip-green.mp4');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await getProject(page)).mediaOrder).toHaveLength(1);
  } finally {
    await ctx.close();
  }
});

test('frames to Ingredients: one confirmation (from Ingredients), and no success toast when the image cannot be added', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red] = await seedMedia(page, ['clip-red.mp4']);
    await card(page, red).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Grab frame → Ingredients' }).click();
    await expect(page.locator('.toast', { hasText: 'to Ingredients' })).toHaveCount(1);
    await expect(page.locator('.toast.toast-success')).toHaveCount(1);
    await expect(page.locator('.toast', { hasText: 'Saved to Ingredients' })).toHaveCount(0);
    await page.evaluate(() => document.querySelectorAll('.toast-close').forEach((b) => b.click()));

    await page.evaluate(async () => {
      const m = await import(chrome.runtime.getURL('studio/ui/media/actions.js'));
      m.saveAsIngredient(new Blob([new Uint8Array(200)], { type: 'image/png' }), { name: 'broken frame' });
    });
    await expect(page.locator('.toast.toast-error')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('.toast.toast-success')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test('big bins: cards and BinCompact rows skip off-screen rendering; per-card badges and buttons use no backdrop blur', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red] = await seedMedia(page, ['clip-red.mp4', 'still.jpg']);
    await page.evaluate((id) => window.__gis.projectStore.update((p) => window.__gis.model.appendMediaToTimeline(p, [id]).project), red);
    await card(page, red).hover();
    const styles = await page.evaluate(() => ({
      card: getComputedStyle(document.querySelector('.bin-card')).contentVisibility,
      blurred: [...document.querySelectorAll('.bin-grid *')].filter((el) => getComputedStyle(el).backdropFilter !== 'none').map((el) => el.className),
    }));
    expect(styles.card).toBe('auto');
    expect(styles.blurred).toEqual([]);
    await page.locator('.app-tabs .tab', { hasText: 'Edit' }).click();
    await expect(page.locator('.bin-compact-item').first()).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.bin-compact-item')).contentVisibility)).toBe('auto');
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});
