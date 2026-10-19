// grok.com integration across tabs and over time (extension/content/**): one studio serves every grok.com tab
// (user actions and auto-collect are relayed to the studio that already runs), auto-collect only takes new
// generations (not older posts loaded by infinite scroll, with clock-skew correction), and a studio that never
// starts is reported instead of silently swallowing "+ Bin".
import { test } from '@playwright/test';
import { launch, openGrok, studioFrame, expect } from './harness.mjs';
import { POSTS, mediaPostList } from './fixtures-map.mjs';
import { GENERATED_POST, PAGE2_POSTS } from './content-mock-api.mjs';

const ID = Object.keys(POSTS);
const [RED, GREEN, BLUE] = ID;
const WITHOUT_GENERATED = () => mediaPostList(ID.filter((id) => id !== GENERATED_POST));
const POLL = { polling: 200, timeout: 30000 }; // interval polling: rAF never fires in a hidden iframe

async function studio(page) {
  const frame = await studioFrame(page, 30000);
  await frame.waitForFunction(() => window.__gis?.bridge?.connected && !!window.__gis.projectStore.get(), null, POLL);
  return frame;
}
const hasStudioFrame = (page) => page.frames().some((f) => f.url().includes('/studio/studio.html'));
const binKeys = (frame) => frame.evaluate(() => Object.values(window.__gis.projectStore.get().media).map((m) => m.pageKey).sort());
const waitReady = (frame, key) =>
  frame.waitForFunction((k) => Object.values(window.__gis.projectStore.get().media).some((m) => m.pageKey === k && m.status === 'ready'), key, POLL);
const card = (page, id, sel = 'video') => page.locator(`[data-post-id="${id}"] ${sel}`);

async function addFromPage(page, id) {
  await page.bringToFront();
  const box = await card(page, id).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.locator('gis-studio-root .hb.show button[data-act="bin"]').click();
  await page.mouse.move(5, 300);
}

test('two grok.com tabs share one studio: "+ Bin" in a tab without one is relayed to the running studio', async () => {
  const ctx = await launch();
  try {
    const a = ctx.page;
    await openGrok(a, '/imagine');
    await expect(a.locator('#feed [role="listitem"]')).toHaveCount(8);
    const b = await ctx.context.newPage();
    await openGrok(b, '/imagine/favorites');
    await expect(b.locator('#feed [role="listitem"]')).toHaveCount(6);

    await addFromPage(a, RED); // first action anywhere: a hidden studio boots in tab A
    const fa = await studio(a);
    await waitReady(fa, `video:${RED}`);

    await addFromPage(b, GREEN); // tab B has no studio: the action goes to tab A's
    await expect(b.locator('gis-studio-root .toast', { hasText: 'Added to the Studio bin' })).toBeVisible();
    await waitReady(fa, `video:${GREEN}`);
    expect(hasStudioFrame(b)).toBe(false);
    // Tab B follows the bin through the shared state: marks and badge, also for what tab A added.
    await expect(b.locator(`[data-post-id="${GREEN}"] video[data-gis-in-bin]`)).toHaveCount(1);
    await expect(b.locator(`[data-post-id="${RED}"] video[data-gis-in-bin]`)).toHaveCount(1);
    await expect(b.locator('gis-studio-root .badge')).toHaveText('3');

    await addFromPage(a, BLUE);
    await waitReady(fa, `video:${BLUE}`);
    expect(await binKeys(fa)).toEqual([`video:${BLUE}`, `video:${GREEN}`, `video:${RED}`].sort());
    expect(hasStudioFrame(b)).toBe(false);

    // Reloading tab B keeps its "in bin" marks; opening the studio there shows the same bin.
    await b.reload();
    await b.locator('gis-studio-root').waitFor({ state: 'attached' });
    await expect(b.locator('[data-gis-in-bin]')).toHaveCount(3);
    await b.locator('gis-studio-root .launcher').click();
    const fb = await studio(b);
    await fb.waitForFunction((n) => Object.keys(window.__gis.projectStore.get().media).length === n, 3, POLL);
  } finally {
    await ctx.close();
  }
});

test('auto-collect boots one hidden studio for all grok.com tabs; another tab relays its new generations to it', async () => {
  const ctx = await launch({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    await ctx.sw.evaluate(() => chrome.storage.local.set({ 'gis:ui': { autoCollect: true } }));
    const a = ctx.page;
    await openGrok(a, '/imagine');
    const fa = await studio(a); // created hidden for auto-collect
    await fa.waitForFunction(() => window.__gis.uiStore.get().autoCollect === true, null, POLL);
    await expect(a.locator('gis-studio-root .panel')).toBeHidden();

    const b = await ctx.context.newPage();
    await openGrok(b, '/imagine/favorites');
    await expect(b.locator('#feed [role="listitem"]')).toHaveCount(5);
    await b.waitForTimeout(5000); // past the decision (studio-tab probe, host election) and the settle window
    expect(hasStudioFrame(b)).toBe(false);
    expect(await binKeys(fa)).toEqual([]); // what was already on either page is not collected

    // A generation in tab B lands in tab A's studio.
    await b.bringToFront();
    await b.locator('.query-bar [contenteditable="true"]').click();
    await b.keyboard.type('A glass whale gliding over a desert');
    await b.keyboard.press('Enter');
    await expect.poll(() => b.evaluate(() => window.__mock.generated), { timeout: 15000 }).toEqual([GENERATED_POST]);
    await waitReady(fa, `video:${GENERATED_POST}`);
    expect(await binKeys(fa)).toEqual([`video:${GENERATED_POST}`]);
    const media = await fa.evaluate(() => Object.values(window.__gis.projectStore.get().media)[0]);
    expect(media.prompt).toBe('A glass whale gliding over a desert');
    expect(hasStudioFrame(b)).toBe(false);
    await expect(b.locator(`[data-post-id="${GENERATED_POST}"] video[data-gis-in-bin]`)).toHaveCount(1);
  } finally {
    await ctx.close();
  }
});

/** Opens the feed with auto-collect on, waits past the settle window, scrolls until page 2 is detected. */
async function scrollToPage2(ctx, path) {
  await ctx.sw.evaluate(() => chrome.storage.local.set({ 'gis:ui': { autoCollect: true } }));
  const page = ctx.page;
  await openGrok(page, path);
  const frame = await studio(page);
  await frame.waitForFunction(() => window.__gis.uiStore.get().autoCollect === true && window.__gis.pageStore.get().items.length >= 6, null, POLL);
  await page.waitForTimeout(5000);
  await page.evaluate(() => {
    const m = document.querySelector('main.main');
    m.scrollTop = m.scrollHeight;
  });
  await frame.waitForFunction((ids) => ids.every((id) => window.__gis.pageStore.get().items.some((i) => i.postId === id)), PAGE2_POSTS.map((p) => p.id), POLL);
  await page.waitForTimeout(1500); // a PAGE_MEDIA round and an auto-collect pass
  const items = await frame.evaluate((ids) => window.__gis.pageStore.get().items.filter((i) => ids.includes(i.postId)), PAGE2_POSTS.map((p) => p.id));
  return { page, frame, items };
}

test('auto-collect ignores older posts loaded by infinite scroll, even ones created minutes before the page opened', async () => {
  const ctx = await launch({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    const { page, frame, items } = await scrollToPage2(ctx, '/imagine?page2age=180');
    expect(items.map((i) => [i.key, i.fresh])).toEqual(PAGE2_POSTS.map((p) => [`video:${p.id}`, false]));
    expect(items.every((i) => i.seenAt < Date.now() - 29 * 24 * 3600 * 1000)).toBe(true);
    expect(await binKeys(frame)).toEqual([]);
    // A real new generation still is collected.
    await page.locator('.query-bar [contenteditable="true"]').click();
    await page.keyboard.type('A paper crane unfolding into a bird');
    await page.keyboard.press('Enter');
    await waitReady(frame, `video:${GENERATED_POST}`);
    expect(await binKeys(frame)).toEqual([`video:${GENERATED_POST}`]);
  } finally {
    await ctx.close();
  }
});

test('freshness uses the server clock: with the browser clock 5 min ahead, media created seconds ago still counts as new', async () => {
  // Probe of the skew correction: page 2 here holds posts created 5 s before the (mock) server's "now", and that
  // server clock runs 5 minutes behind the browser. Uncorrected, they would look 5 minutes old.
  const ctx = await launch({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    const { frame, items } = await scrollToPage2(ctx, '/imagine?page2age=5&skew=300');
    expect(items.map((i) => i.fresh)).toEqual([true, true]);
    await frame.waitForFunction((n) => Object.keys(window.__gis.projectStore.get().media).length === n, 2, POLL);
  } finally {
    await ctx.close();
  }
});

test('a studio that never starts: "+ Bin" is undone with an error, and Retry delivers once it can start', async () => {
  const ctx = await launch();
  try {
    // Break the studio's boot the way a real IndexedDB failure would (its open() rejects).
    await ctx.sw.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('grok-imagine-studio', 2);
          req.onsuccess = () => {
            req.result.close();
            resolve();
          };
          req.onerror = () => reject(String(req.error));
        }),
    );
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    await expect(page.locator('gis-studio-root .badge')).toHaveText('6');
    await addFromPage(page, RED);
    await expect(page.locator('gis-studio-root .toast.success', { hasText: 'Added to the Studio bin' })).toBeVisible();
    await expect(page.locator(`[data-post-id="${RED}"] video[data-gis-in-bin]`)).toHaveCount(1); // optimistic
    const error = page.locator('gis-studio-root .toast.error', { hasText: 'Imagine Studio did not start' });
    await expect(error).toBeVisible({ timeout: 30000 });
    await expect(error.locator('button.act')).toHaveText(['Retry', 'Open in a tab']);
    await expect(page.locator(`[data-post-id="${RED}"] video[data-gis-in-bin]`)).toHaveCount(0);
    await expect(page.locator('gis-studio-root .badge')).toHaveText('6');
    expect(hasStudioFrame(page)).toBe(false); // the broken frame is gone; the next action starts fresh

    await ctx.sw.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.deleteDatabase('grok-imagine-studio');
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
    );
    await error.locator('button.act', { hasText: 'Retry' }).click();
    const frame = await studio(page);
    await waitReady(frame, `video:${RED}`);
    await expect(page.locator(`[data-post-id="${RED}"] video[data-gis-in-bin]`)).toHaveCount(1);
    await expect(page.locator('gis-studio-root .badge')).toHaveText('5');
  } finally {
    await ctx.close();
  }
});
