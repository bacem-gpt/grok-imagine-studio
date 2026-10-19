// Clips tab (extension/studio/ui/media/**): bin filters / sort / search, flags & ratings, multi-select + add to
// timeline order, source monitor marks -> clip in/out, frame grabs, review mode keyboard flow, BinCompact drag
// payload, removal + undo, the "On grok.com" strip (faked page items) and the narrow sheet layout.
import { test } from '@playwright/test';
import { launch, openGrok, openStudio, openStudioTab, seedMedia, getProject, expect } from './harness.mjs';
import { POSTS, videoUrl, thumbUrl, imageUrl } from './fixtures-map.mjs';

const near = (a, b, eps = 0.06) => Math.abs(a - b) <= eps;
const cardIds = (page) => page.$$eval('.bin-grid .bin-card', (els) => els.map((e) => e.dataset.mediaId));
const card = (page, id) => page.locator(`.bin-card[data-media-id="${id}"]`);
const media = (page, id) => page.evaluate((mid) => window.__gis.projectStore.get().media[mid] || null, id);
const ui = (page) => page.evaluate(() => window.__gis.uiStore.get());
const timelineMedia = (page) => page.evaluate(() => window.__gis.projectStore.get().tracks.video.map((c) => c.mediaId));
const appErrors = (ctx) => ctx.consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e));

/** Names and prompts make search / sort deterministic. */
async function setMeta(page, ids, metas) {
  await page.evaluate(
    ({ ids, metas }) => {
      const { projectStore, model } = window.__gis;
      projectStore.update((p) => {
        let q = p;
        ids.forEach((id, i) => (q = model.updateMedia(q, id, metas[i])));
        return q;
      });
    },
    { ids, metas },
  );
}

async function seekMonitor(page, t) {
  await page.waitForFunction(() => document.querySelector('.src-monitor .src-video')?.readyState >= 1);
  await page.evaluate(
    (time) =>
      new Promise((resolve) => {
        const v = document.querySelector('.src-monitor .src-video');
        v.addEventListener('seeked', () => resolve(), { once: true });
        v.currentTime = time;
      }),
    t,
  );
}

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

test('bin: search, kind / flag / rating filters and every sort order', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    await expect(page.locator('.bin-panel .empty-title')).toHaveText('Your bin is empty');
    const [red, green, blue, still] = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4', 'still.jpg']);
    await setMeta(page, [red, green, blue, still], [
      { name: 'Car 10', prompt: 'A red sports car drifting through neon rain', rating: 3 },
      { name: 'Forest', prompt: 'A misty green forest at dawn', rating: 5, flag: 'pick' },
      { name: 'Car 2', prompt: 'Deep blue ocean waves crashing', flag: 'reject' },
      { name: 'Poster', prompt: null, tags: ['ocean'] },
    ]);
    await expect(page.locator('.bin-grid .bin-card')).toHaveCount(4);
    expect(await cardIds(page)).toEqual([still, blue, green, red]); // newest first

    const search = page.locator('.bin-search input');
    await search.fill('ocean');
    await expect(page.locator('.bin-grid .bin-card')).toHaveCount(2); // prompt + tag
    await search.fill('neon car');
    expect(await cardIds(page)).toEqual([red]);
    await expect(page.locator('.bin-status')).toContainText('showing 1');
    await search.fill('zebra');
    await expect(page.locator('.bin-panel .empty-title')).toHaveText('Nothing matches');
    await page.locator('.bin-panel .empty button', { hasText: 'Reset filters' }).click();
    await expect(page.locator('.bin-grid .bin-card')).toHaveCount(4);

    const selects = page.locator('.bin-toolbar select');
    await selects.nth(0).selectOption('image');
    expect(await cardIds(page)).toEqual([still]);
    await selects.nth(0).selectOption('all');
    await selects.nth(1).selectOption('pick');
    expect(await cardIds(page)).toEqual([green]);
    await selects.nth(1).selectOption('hide-rejected');
    expect(await cardIds(page)).toEqual([still, green, red]);
    await selects.nth(1).selectOption('all');
    await selects.nth(2).selectOption('3');
    expect(await cardIds(page)).toEqual([green, red]);
    await selects.nth(2).selectOption('0');

    await selects.nth(3).selectOption('duration');
    expect(await cardIds(page)).toEqual([blue, red, green, still]);
    await selects.nth(3).selectOption('rating');
    expect(await cardIds(page)).toEqual([green, red, still, blue]);
    await selects.nth(3).selectOption('name');
    expect(await cardIds(page)).toEqual([blue, red, green, still]); // "Car 2" < "Car 10" (natural)
    await selects.nth(3).selectOption('oldest');
    expect(await cardIds(page)).toEqual([red, green, blue, still]);
    // The filter lives in uiStore (persisted by the shell).
    expect((await ui(page)).binFilter).toMatchObject({ sort: 'oldest', kind: 'all', flag: 'all', minRating: 0 });
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('MediaThumb: hover-scrub picks the filmstrip cell, badges, loading and error + Retry states', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red, still] = await seedMedia(page, ['clip-red.mp4', 'still.jpg']);
    const thumb = card(page, red).locator('.clips-thumb');
    await expect(thumb.locator('.clips-thumb-dur')).toHaveText('4s');
    await expect(thumb.locator('.clips-thumb-kind.is-video')).toBeVisible();
    await expect(card(page, still).locator('.clips-thumb-kind.is-image')).toBeVisible();
    await expect(card(page, still).locator('.clips-thumb-dur')).toHaveCount(0);

    const box = await thumb.boundingBox();
    const stripAt = async (fx) => {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height / 2);
      await expect(thumb.locator('.clips-thumb-strip')).toBeVisible();
      return page.evaluate((id) => {
        const el = document.querySelector(`.bin-card[data-media-id="${id}"] .clips-thumb-strip`);
        return { pos: el.style.backgroundPosition, size: el.style.backgroundSize, bar: document.querySelector(`.bin-card[data-media-id="${id}"] .clips-thumb-scrubline`).style.width };
      }, red);
    };
    const left = await stripAt(0.02);
    expect(left.size).toBe('1000% 100%'); // 10 cells
    expect(left.pos.startsWith('0%')).toBe(true);
    const mid = await stripAt(0.55); // cell 5 of 0..9
    expect(parseFloat(mid.pos)).toBeCloseTo((5 / 9) * 100, 1);
    const right = await stripAt(0.98);
    expect(right.pos.startsWith('100%')).toBe(true);
    expect(parseFloat(right.bar)).toBeGreaterThan(90);
    await page.mouse.move(0, 0);
    await expect(thumb.locator('.clips-thumb-strip')).toHaveCount(0);

    // loading overlay
    const loadingId = await page.evaluate(() => {
      const { projectStore, model } = window.__gis;
      const m = model.createMediaItem({ kind: 'video', name: 'Busy', status: 'loading' });
      projectStore.update((p) => model.addMedia(p, m), { label: 'test' });
      return m.id;
    });
    await expect(card(page, loadingId).locator('.clips-thumb-status .spinner')).toBeVisible();

    // error overlay, Retry fixes it once the URL works again
    const brokenId = await page.evaluate(async () => {
      try {
        await window.__gis.media.importUrl('https://assets.grok.com/test/missing-clip.mp4');
      } catch {
        /* expected */
      }
      return Object.values(window.__gis.projectStore.get().media).find((m) => m.sourceUrl?.includes('missing-clip')).id;
    });
    const err = card(page, brokenId).locator('.clips-thumb-status.is-error');
    await expect(err).toContainText("Couldn't load");
    await page.evaluate((id) => window.__gis.projectStore.update((p) => window.__gis.model.updateMedia(p, id, { sourceUrl: 'https://assets.grok.com/test/clip-green.mp4' }), { history: false }), brokenId);
    await err.locator('.clips-thumb-retry').click();
    await expect.poll(async () => (await media(page, brokenId)).status, { timeout: 30000 }).toBe('ready');
    await expect(card(page, brokenId).locator('.clips-thumb-status')).toHaveCount(0);
    await expect(card(page, brokenId).locator('.clips-thumb-img')).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test('bin: pick / reject / rate with buttons and keys, bulk flags are one undo step', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [a, b, c] = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4']);
    await card(page, a).locator('.bin-flag.is-pick').click();
    expect((await media(page, a)).flag).toBe('pick');
    await expect(card(page, a)).toHaveClass(/is-pick/);
    await card(page, a).locator('.bin-flag.is-pick').click(); // toggles off
    expect((await media(page, a)).flag).toBe(null);
    await card(page, a).locator('.rating-star').nth(3).click();
    expect((await media(page, a)).rating).toBe(4);

    await card(page, b).click();
    await page.keyboard.press('x');
    expect((await media(page, b)).flag).toBe('reject');
    await expect(card(page, b)).toHaveClass(/is-reject/);
    await page.keyboard.press('u');
    expect((await media(page, b)).flag).toBe(null);
    await page.keyboard.press('3');
    expect((await media(page, b)).rating).toBe(3);
    await page.keyboard.press('0');
    expect((await media(page, b)).rating).toBe(0);

    // bulk: ctrl-click a second card, P picks both in one history step
    await card(page, c).click({ modifiers: ['Control'] });
    expect((await ui(page)).binSelection.sort()).toEqual([b, c].sort());
    await expect(page.locator('.bin-selbar-count')).toHaveText('2 selected');
    await page.keyboard.press('p');
    expect((await media(page, b)).flag).toBe('pick');
    expect((await media(page, c)).flag).toBe('pick');
    await page.keyboard.press('Control+z');
    expect((await media(page, b)).flag).toBe(null);
    expect((await media(page, c)).flag).toBe(null);
    // selection bar rate menu
    await page.locator('.bin-selbar [title="Rate (1–5)"]').click();
    await page.locator('.menu-item', { hasText: '★★★★★' }).click();
    expect((await media(page, b)).rating).toBe(5);
    expect((await media(page, c)).rating).toBe(5);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('bin: click / shift / ctrl selection, select all, keyboard nav, add to timeline in display order, drag payload', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4', 'clip-noaudio.mp4']);
    const order = await cardIds(page); // newest first: noaudio, blue, green, red
    await card(page, order[0]).click();
    await card(page, order[2]).click({ modifiers: ['Shift'] });
    expect((await ui(page)).binSelection).toEqual(order.slice(0, 3));
    await card(page, order[1]).click({ modifiers: ['Control'] });
    expect((await ui(page)).binSelection).toEqual([order[0], order[2]]);

    // drag payload = ordered selection; an unselected card drags alone
    const payload = (id) =>
      page.evaluate((mid) => {
        const dt = new DataTransfer();
        document.querySelector(`.bin-card[data-media-id="${mid}"]`).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return JSON.parse(dt.getData('application/x-gis-media'));
      }, id);
    expect(await payload(order[2])).toEqual([order[0], order[2]]);
    expect(await payload(order[3])).toEqual([order[3]]);

    // E appends the selection in display order (not click order)
    await card(page, order[2]).click();
    await card(page, order[0]).click({ modifiers: ['Control'] });
    await page.keyboard.press('e');
    expect(await timelineMedia(page)).toEqual([order[0], order[2]]);
    await expect(card(page, order[0]).locator('.clips-thumb-used')).toBeVisible();

    // select all + the selection bar's "Add to timeline"
    await page.keyboard.press('Control+a');
    expect((await ui(page)).binSelection).toEqual(order);
    await page.locator('.bin-selbar button', { hasText: /^Add/ }).click();
    expect(await timelineMedia(page)).toEqual([order[0], order[2], ...order]);

    // arrows move the selection; Escape clears it
    await card(page, order[0]).click();
    await page.keyboard.press('ArrowRight');
    expect((await ui(page)).binSelection).toEqual([order[1]]);
    await page.keyboard.press('Shift+ArrowRight');
    expect((await ui(page)).binSelection).toEqual([order[1], order[2]]);
    await page.keyboard.press('Escape');
    expect((await ui(page)).binSelection).toEqual([]);
    await expect(page.locator('.bin-selbar')).toHaveCount(0);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('source monitor: I/O marks, handle drag and insert at playhead become clip in/out on the timeline', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red, blue] = await seedMedia(page, ['clip-red.mp4', 'clip-blue.mp4']);
    await card(page, blue).dblclick();
    await expect(page.locator('.src-monitor')).toBeVisible();
    await expect(page.locator('.src-title-name')).toHaveText('clip-blue');
    expect((await ui(page)).sourceMediaId).toBe(blue);

    await seekMonitor(page, 1.0);
    await page.keyboard.press('i');
    await seekMonitor(page, 3.0);
    await page.keyboard.press('o');
    let s = await ui(page);
    expect(near(s.sourceIn, 1.0, 0.04), `in ${s.sourceIn}`).toBe(true);
    expect(near(s.sourceOut, 3.0 + 1 / 30, 0.04), `out ${s.sourceOut}`).toBe(true); // OUT includes the frame on screen
    await expect(card(page, blue).locator('.bin-card-trim')).toBeVisible();

    await page.locator('.src-actions button', { hasText: 'Add to timeline' }).click();
    let p = await getProject(page);
    expect(p.tracks.video).toHaveLength(1);
    expect(p.tracks.video[0].mediaId).toBe(blue);
    expect(near(p.tracks.video[0].in, s.sourceIn, 1e-6)).toBe(true);
    expect(near(p.tracks.video[0].out, s.sourceOut, 1e-6)).toBe(true);

    // drag the IN handle to the middle of the bar
    const bar = await page.locator('.src-monitor .src-scrub').boundingBox();
    const handle = await page.locator('.src-monitor .src-scrub-handle.is-in').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width * 0.3, bar.y + bar.height / 2, { steps: 6 });
    await page.mouse.up();
    s = await ui(page);
    expect(near(s.sourceIn, 1.5, 0.15), `dragged in ${s.sourceIn}`).toBe(true);

    // frame stepping
    await seekMonitor(page, 2.0);
    await page.keyboard.press('.');
    const t = await page.evaluate(() => document.querySelector('.src-monitor .src-video').currentTime);
    expect(near(t, 2 + 1 / 30, 0.01), `step ${t}`).toBe(true);

    // insert at playhead (playhead 0 -> before the first clip), with the current marks
    await page.evaluate(() => window.__gis.uiStore.set((st) => ({ ...st, playhead: 0 })));
    await page.keyboard.press('w');
    p = await getProject(page);
    expect(p.tracks.video.map((c) => c.mediaId)).toEqual([blue, blue]);
    expect(near(p.tracks.video[0].in, s.sourceIn, 1e-6)).toBe(true);

    // clear marks, then the whole clip is used
    await page.keyboard.press('Control+Shift+x');
    s = await ui(page);
    expect([s.sourceIn, s.sourceOut]).toEqual([null, null]);
    await page.keyboard.press('e');
    p = await getProject(page);
    expect(p.tracks.video[2]).toMatchObject({ mediaId: blue, in: 0 });
    expect(near(p.tracks.video[2].out, 5, 0.1)).toBe(true);

    // the sound as an audio clip at the playhead
    await page.locator('.src-actions button', { hasText: 'Add as audio' }).click();
    p = await getProject(page);
    expect(p.tracks.audio).toHaveLength(1);
    expect(p.tracks.audio[0].mediaId).toBe(blue);

    // next / previous follow the bin order; marks are remembered per clip
    await page.locator('.src-head [title^="Next clip"]').click();
    expect((await ui(page)).sourceMediaId).toBe(red);
    await seekMonitor(page, 0.5);
    await page.keyboard.press('i');
    await page.keyboard.press('ArrowLeft');
    s = await ui(page);
    expect(s.sourceMediaId).toBe(blue);
    expect(s.binSelection).toEqual([blue]);
    await page.keyboard.press('ArrowRight');
    expect(near((await ui(page)).sourceIn, 0.5, 0.04)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('.src-monitor')).toHaveCount(0);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('grab frame: add to bin as an image, save as ingredient, context-menu grab', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red] = await seedMedia(page, ['clip-red.mp4']);
    await page.evaluate(() => {
      window.__ingredientEvents = [];
      window.__gis.appState.appEvents.on('ingredient.add', (e) => window.__ingredientEvents.push({ type: e.blob?.type, size: e.blob?.size || 0, name: e.name, origin: e.origin }));
    });
    await card(page, red).dblclick();
    await seekMonitor(page, 1.0);
    await page.locator('.src-actions button', { hasText: 'Grab frame' }).click();
    await expect(page.locator('.clips-frame-modal')).toBeVisible();
    await expect(page.locator('.clips-frame-modal .modal-footer')).toContainText('640×360');
    await page.locator('.clips-frame-action[data-action="bin"]').click();
    await page.waitForFunction(() => Object.values(window.__gis.projectStore.get().media).some((m) => m.origin === 'frame' && m.status === 'ready'));
    const p = await getProject(page);
    expect(p.mediaOrder).toHaveLength(2);
    const img = Object.values(p.media).find((m) => m.origin === 'frame');
    expect(img).toMatchObject({ kind: 'image', width: 640, height: 360, status: 'ready' });
    expect(img.name).toContain('frame 0:01.00');
    await expect(page.locator('.clips-frame-action[data-action="bin"]')).toHaveClass(/is-done/);

    await page.locator('.clips-frame-action[data-action="ing"]').click();
    await expect.poll(() => page.evaluate(() => window.__ingredientEvents.length)).toBe(1);
    const ev = (await page.evaluate(() => window.__ingredientEvents))[0];
    expect(ev).toMatchObject({ type: 'image/png', origin: 'frame' });
    expect(ev.size).toBeGreaterThan(1000);
    await page.locator('.clips-frame-modal button', { hasText: 'Done' }).click();
    await expect(page.locator('.clips-frame-modal')).toHaveCount(0);

    // context menu: Grab frame -> Ingredients straight away
    await page.keyboard.press('Escape');
    await card(page, red).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Grab frame → Ingredients' }).click();
    await expect.poll(() => page.evaluate(() => window.__ingredientEvents.length)).toBe(2);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('review mode: keyboard triage, add with marks and advance, summary, exit selects the last item', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4', 'still.jpg']);
    const order = await cardIds(page);
    await page.locator('.bin-toolbar button', { hasText: 'Review' }).click();
    const review = page.locator('.clips-review');
    await expect(review).toBeVisible();
    await expect(review.locator('.clips-review-count')).toHaveText('1 / 4');

    await page.keyboard.press('p');
    expect((await media(page, order[0])).flag).toBe('pick');
    await expect(review.locator('.clips-review-stamp')).toContainText('Picked');
    await page.keyboard.press('ArrowRight');
    await expect(review.locator('.clips-review-count')).toHaveText('2 / 4');
    await page.keyboard.press('x');
    expect((await media(page, order[1])).flag).toBe('reject');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('4');
    expect((await media(page, order[2])).rating).toBe(4);

    // I/O at known times, then Enter adds the marked range and moves on
    await page.waitForFunction(() => document.querySelector('.clips-review .src-video')?.readyState >= 1);
    await page.keyboard.press('Space'); // pause the autoplay
    const seek = (t) =>
      page.evaluate(
        (time) =>
          new Promise((resolve) => {
            const v = document.querySelector('.clips-review .src-video');
            v.pause();
            v.addEventListener('seeked', () => resolve(), { once: true });
            v.currentTime = time;
          }),
        t,
      );
    await seek(0.5);
    await page.keyboard.press('i');
    await seek(1.5);
    await page.keyboard.press('o');
    await page.keyboard.press('Enter');
    await expect(review.locator('.clips-review-count')).toHaveText('4 / 4');
    const p = await getProject(page);
    expect(p.tracks.video).toHaveLength(1);
    expect(p.tracks.video[0].mediaId).toBe(order[2]);
    expect(near(p.tracks.video[0].in, 0.5, 0.04)).toBe(true);
    expect(near(p.tracks.video[0].out, 1.5 + 1 / 30, 0.04)).toBe(true);

    await page.keyboard.press('u');
    await page.keyboard.press('ArrowLeft');
    await expect(review.locator('.clips-review-count')).toHaveText('3 / 4');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight'); // past the end -> summary
    await expect(review.locator('.clips-review-done-title')).toHaveText('Review complete');
    await expect(review.locator('.clips-review-done-body')).toContainText('You picked 1 of 4 items');
    await page.keyboard.press('ArrowLeft');
    await expect(review.locator('.clips-review-count')).toHaveText('4 / 4');

    await page.keyboard.press('Escape');
    await expect(review).toHaveCount(0);
    expect((await ui(page)).binSelection).toEqual([order[3]]);
    // the hotkeys are back to the bin's
    await page.keyboard.press('p');
    expect((await media(page, order[3])).flag).toBe('pick');
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('BinCompact: drag payload, picked-only filter, "+" appends, double-click opens the source monitor', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red, green, blue] = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4']);
    await setMeta(page, [red], [{ flag: 'pick' }]);
    // Mount BinCompact on its own (the Edit tab hosts it in the app; this keeps the test independent of that layout).
    await page.locator('.app-tabs .tab', { hasText: 'Edit' }).click();
    await page.evaluate(async () => {
      const { html, render } = await import(chrome.runtime.getURL('vendor/preact-htm.mjs'));
      const { BinCompact } = await import(chrome.runtime.getURL('studio/ui/media/bin-compact.js'));
      const host = document.createElement('div');
      host.id = 'compact-host';
      host.style.cssText = 'position:fixed;left:0;top:50px;width:320px;height:500px;z-index:900';
      document.body.appendChild(host);
      render(html`<${BinCompact} />`, host);
    });
    const items = page.locator('#compact-host .bin-compact-item');
    await expect(items).toHaveCount(3);
    const ids = await page.$$eval('#compact-host .bin-compact-item', (els) => els.map((e) => e.dataset.mediaId));
    expect(ids).toEqual([blue, green, red]);

    const payload = (id) =>
      page.evaluate((mid) => {
        const dt = new DataTransfer();
        document.querySelector(`#compact-host .bin-compact-item[data-media-id="${mid}"]`).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return { types: [...dt.types], ids: JSON.parse(dt.getData('application/x-gis-media') || '[]') };
      }, id);
    expect(await payload(green)).toEqual({ types: ['application/x-gis-media'], ids: [green] });
    await items.nth(2).click();
    await items.nth(0).click({ modifiers: ['Control'] });
    expect((await payload(red)).ids).toEqual([blue, red]); // compact display order

    await page.locator('#compact-host [title="Show picked clips only"]').click();
    await expect(items).toHaveCount(1);
    await page.locator('#compact-host [title="Showing picked clips only"]').click();
    await expect(items).toHaveCount(3);

    await items.nth(1).hover();
    await items.nth(1).locator('.bin-compact-add').click();
    expect(await timelineMedia(page)).toEqual([green]);

    await items.nth(0).dblclick();
    await expect.poll(async () => (await ui(page)).tab).toBe('clips');
    expect((await ui(page)).sourceMediaId).toBe(blue);
    await expect(page.locator('.src-monitor .src-title-name')).toHaveText('clip-blue');
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('remove from bin asks for confirmation, takes timeline clips along, and undo restores everything', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red, green, blue] = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4']);
    await page.evaluate((ids) => window.__gis.projectStore.update((p) => window.__gis.model.appendMediaToTimeline(p, ids).project, { label: 'seed' }), [red, green]);
    await card(page, red).click();
    await card(page, green).click({ modifiers: ['Control'] });
    await page.keyboard.press('Delete');
    const dialog = page.locator('.modal');
    await expect(dialog).toContainText('Remove 2 items from the bin?');
    await expect(dialog).toContainText('2 clips');
    await dialog.locator('button', { hasText: 'Cancel' }).click();
    expect(Object.keys((await getProject(page)).media)).toHaveLength(3);

    // Enter confirms the dialog (the Clips hotkeys yield to it instead of opening the monitor)
    await page.keyboard.press('Delete');
    await expect(page.locator('.modal .btn-danger', { hasText: 'Remove' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.bin-grid .bin-card')).toHaveCount(1);
    await expect(page.locator('.src-monitor')).toHaveCount(0);
    let p = await getProject(page);
    expect(Object.keys(p.media)).toEqual([blue]);
    expect(p.tracks.video).toHaveLength(0);
    expect((await ui(page)).binSelection).toEqual([]);

    await page.keyboard.press('Control+z');
    await expect(page.locator('.bin-grid .bin-card')).toHaveCount(3);
    p = await getProject(page);
    expect(Object.keys(p.media).sort()).toEqual([red, green, blue].sort());
    expect(p.tracks.video.map((c) => c.mediaId)).toEqual([red, green]);
    // the restored items still play: their binaries were kept
    await card(page, red).dblclick();
    await page.waitForFunction(() => document.querySelector('.src-monitor .src-video')?.readyState >= 1);

    // context-menu removal of one item + toast undo
    await page.keyboard.press('Escape');
    await card(page, blue).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Remove from bin' }).click();
    await page.locator('.modal .btn-danger').click();
    await expect(page.locator('.bin-grid .bin-card')).toHaveCount(2);
    await page.locator('.toast .toast-action', { hasText: 'Undo' }).last().click();
    await expect(page.locator('.bin-grid .bin-card')).toHaveCount(3);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('"On grok.com" strip: empty states, add all videos, in-bin badges, add & pick, add selected', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    await expect(page.locator('.clips-page .empty-title')).toHaveText('Not connected to grok.com');
    await page.evaluate(() => window.__gis.pageStore.set((s) => ({ ...s, connected: true, items: [] })));
    await expect(page.locator('.clips-page .empty-title')).toHaveText('No generated media detected on this page');

    const items = await fakePageItems(page);
    const cards = page.locator('.clips-pcard');
    await expect(cards).toHaveCount(items.length);
    const videos = items.filter((i) => i.kind === 'video');
    const addAll = page.locator('.clips-page-head button', { hasText: 'Add all videos' });
    await expect(addAll).toContainText(`(${videos.length})`);
    await addAll.click();
    await expect(page.locator('.clips-pcard.is-inbin')).toHaveCount(videos.length);
    await expect(page.locator('.clips-pcard .clips-pcard-inbin').first()).toBeVisible();
    let p = await getProject(page);
    expect(p.mediaOrder.map((id) => p.media[id].pageKey).sort()).toEqual(videos.map((v) => v.key).sort());
    expect(Object.values(p.media).every((m) => m.origin === 'grok' && m.prompt)).toBe(true);
    await expect(addAll).toBeDisabled();

    // the image: hover action "Add to bin & pick"
    const image = items.find((i) => i.kind === 'image');
    const imgCard = page.locator(`.clips-pcard[data-key="${image.key}"]`);
    await imgCard.hover();
    await imgCard.locator('[title="Add to bin & pick"]').click();
    await expect(imgCard).toHaveClass(/is-inbin/);
    p = await getProject(page);
    const added = Object.values(p.media).find((m) => m.pageKey === image.key);
    expect(added).toMatchObject({ kind: 'image', flag: 'pick' });

    // "Not in bin" filter is now empty; double-click on an in-bin card opens it in the monitor
    await page.locator('.clips-page .segmented button', { hasText: 'Not in bin' }).click();
    await expect(page.locator('.clips-page-none')).toContainText('already in your bin');
    await page.locator('.clips-page .segmented button', { hasText: 'All' }).click();
    await cards.first().dblclick();
    await expect(page.locator('.src-monitor')).toBeVisible();

    // all downloads finish through the real pipeline
    await page.waitForFunction(() => Object.values(window.__gis.projectStore.get().media).every((m) => m.status === 'ready'), null, { timeout: 60000 });
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('embedded on grok.com: detected clips, add all, reveal, send prompt and last frame go back to the page', async () => {
  const ctx = await launch();
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const frame = await openStudio(page);
    await expect(frame.locator('.clips-page-conn.is-on')).toBeVisible();
    await expect(frame.locator('.clips-pcard').first()).toBeVisible({ timeout: 20000 });
    const detected = await frame.evaluate(() => window.__gis.pageStore.get().items.filter((i) => i.kind === 'video').length);
    expect(detected).toBeGreaterThan(1);

    // Add all videos -> downloaded through the real pipeline, badges flip to "In bin"
    await frame.locator('.clips-page-head button', { hasText: /videos/ }).click();
    await frame.waitForFunction((n) => {
      const p = window.__gis.projectStore.get();
      return p.mediaOrder.length >= n && p.mediaOrder.every((id) => p.media[id].status === 'ready');
    }, detected, { timeout: 60000 });
    await expect(frame.locator('.clips-pcard.is-inbin')).toHaveCount(detected);

    // Reveal on grok.com flashes the element on the page
    const firstCard = frame.locator('.clips-pcard').first();
    await firstCard.hover();
    await firstCard.locator('[title="Reveal on grok.com"]').click();
    await expect(page.locator('gis-studio-root .flash')).toHaveCount(1);
    await expect(frame.locator('.toast', { hasText: 'not on the current' })).toHaveCount(0);

    // "Send prompt to Grok" (one name in the monitor, its menu and the card menu) fills the composer;
    // Last frame -> Grok attaches a PNG
    const firstBin = frame.locator('.bin-card').first();
    const mediaId = await firstBin.getAttribute('data-media-id');
    const prompt = await frame.evaluate((id) => window.__gis.projectStore.get().media[id].prompt, mediaId);
    expect(prompt).toBeTruthy();
    await firstBin.click({ button: 'right' });
    await expect(frame.locator('.menu .menu-item', { hasText: 'Send prompt to Grok' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await firstBin.dblclick();
    await expect(frame.locator('.src-monitor')).toBeVisible();
    await frame.locator('.src-actions [title="More actions"]').click();
    await expect(frame.locator('.menu .menu-item', { hasText: 'Send prompt to Grok' })).toHaveCount(1);
    await expect(frame.locator('.menu .menu-item', { hasText: /Re-use/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    const send = frame.locator('.src-prompt-actions button', { hasText: 'Send prompt to Grok' });
    await expect(send).toHaveAttribute('title', "Put this prompt in Grok's prompt box to generate a new take");
    await send.click();
    await expect(page.locator('.query-bar [contenteditable="true"]')).toHaveText(prompt);
    await expect(frame.locator('.toast', { hasText: "Prompt inserted in Grok's prompt box" })).toBeVisible();
    await frame.locator('.src-actions .src-lastframe').click();
    await expect.poll(() => page.evaluate(() => window.__mock.attached.length), { timeout: 15000 }).toBe(1);
    const att = await page.evaluate(() => window.__mock.attached[0]);
    expect(att.type).toBe('image/png');
    expect(att.name).toMatch(/last-frame\.png$/);
    expect(att.size).toBeGreaterThan(1000);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('wide layout: monitor docks right or below, the splitter resizes it and the size is remembered', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red] = await seedMedia(page, ['clip-red.mp4']);
    await card(page, red).dblclick();
    const dock = page.locator('.clips-monitor-dock');
    await expect(dock).toBeVisible();
    await expect(page.locator('.clips-view')).toHaveClass(/clips-mon-right/);
    const before = await dock.boundingBox();
    const split = await page.locator('.clips-split').boundingBox();
    await page.mouse.move(split.x + split.width / 2, split.y + 200);
    await page.mouse.down();
    await page.mouse.move(split.x + split.width / 2 - 120, split.y + 200, { steps: 5 });
    await page.mouse.up();
    const after = await dock.boundingBox();
    expect(Math.round(after.width - before.width)).toBeGreaterThan(100);
    const sizes = () => page.evaluate(() => JSON.parse(localStorage.getItem('gis.clips.monitorSizes')));
    expect((await sizes()).right).toBe(Math.round(after.width));

    await page.locator('.src-head [title^="Dock the monitor below"]').click();
    await expect(page.locator('.clips-view')).toHaveClass(/clips-mon-bottom/);
    const bottom = await dock.boundingBox();
    expect(bottom.width).toBeGreaterThan(1400);
    // the height below is remembered separately from the width beside
    const hsplit = await page.locator('.clips-split').boundingBox();
    await page.mouse.move(hsplit.x + 300, hsplit.y + hsplit.height / 2);
    await page.mouse.down();
    await page.mouse.move(hsplit.x + 300, hsplit.y + hsplit.height / 2 + 80, { steps: 5 });
    await page.mouse.up();
    const lower = await dock.boundingBox();
    expect(Math.round(bottom.height - lower.height)).toBeGreaterThan(60);
    expect(await sizes()).toEqual({ right: Math.round(after.width), bottom: Math.round(lower.height) });
    await page.locator('.src-head [title^="Dock the monitor beside"]').click();
    await expect(page.locator('.clips-view')).toHaveClass(/clips-mon-right/);
    expect(Math.round((await dock.boundingBox()).width)).toBe(Math.round(after.width));
    // the bin keeps its own layout next to the monitor: no horizontal overflow anywhere
    expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('narrow (480 px): source monitor opens as a sheet, filters fold away, Escape closes', async () => {
  const ctx = await launch({ viewport: { width: 480, height: 860 } });
  try {
    const page = await openStudioTab(ctx);
    const [red] = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4']);
    await expect(page.locator('.clips-view')).toHaveClass(/is-narrow/);
    await expect(page.locator('.bin-toolbar select')).toHaveCount(0);
    await page.locator('.bin-toolbar [title="Filters & sort"]').click();
    await expect(page.locator('.bin-toolbar select')).toHaveCount(4);
    await card(page, red).click();
    await page.keyboard.press('Enter');
    await expect(page.locator('.clips-sheet .src-monitor')).toBeVisible();
    const box = await page.locator('.clips-sheet').boundingBox();
    expect(box.width).toBeGreaterThan(470);
    // nothing overflows horizontally
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.clips-sheet')).toHaveCount(0);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});
