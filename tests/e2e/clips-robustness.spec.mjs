// Clips tab robustness (extension/studio/ui/media/**): review mode when items leave the project, where review starts
// and what its summary claims, clips added while still downloading, failed items, rename, IN/OUT marks as undoable
// project data, BinCompact's menu and trim badge, double-click safety, Escape in time fields, frame-grab toasts and
// the layouts of the docked monitor at mid widths and in short views.
import { test } from '@playwright/test';
import { launch, openStudioTab, seedMedia, getProject, fixture, expect } from './harness.mjs';

const near = (a, b, eps = 0.06) => Math.abs(a - b) <= eps;
const cardIds = (page) => page.$$eval('.bin-grid .bin-card', (els) => els.map((e) => e.dataset.mediaId));
const card = (page, id) => page.locator(`.bin-card[data-media-id="${id}"]`);
const media = (page, id) => page.evaluate((mid) => window.__gis.projectStore.get().media[mid] || null, id);
const ui = (page) => page.evaluate(() => window.__gis.uiStore.get());
const undoLabel = (page) => page.evaluate(() => window.__gis.projectStore.undoLabel());
const textSelection = (page) => page.evaluate(() => String(window.getSelection()).length);
const appErrors = (ctx) => ctx.consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e));

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

const watchPageErrors = (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  return errors;
};

test('review mode survives items leaving the project: undo of their import, removal, a sequence switch', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const errors = watchPageErrors(page);
    const [red, green] = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4', 'clip-cyan.webm']);
    await page.keyboard.press('r');
    const review = page.locator('.clips-review');
    await expect(review.locator('.clips-review-count')).toHaveText('1 / 4');
    await expect(review.locator('.clips-review-name')).toHaveText('clip-cyan');

    // Ctrl+Z undoes the import of the newest clip: the one under the review cursor.
    expect(await undoLabel(page)).toBe('Import URL');
    await page.keyboard.press('Control+z');
    await expect(review.locator('.clips-review-count')).toHaveText('1 / 3');
    await expect(review.locator('.clips-review-name')).toHaveText('clip-blue');
    await expect(review.locator('.clips-review-film-item')).toHaveCount(3);

    // An item further along is removed: Next skips it.
    await page.evaluate((id) => window.__gis.projectStore.update((p) => window.__gis.model.removeMedia(p, [id]), { label: 'Remove' }), green);
    await page.keyboard.press('ArrowRight');
    await expect(review.locator('.clips-review-count')).toHaveText('2 / 2');
    await expect(review.locator('.clips-review-name')).toHaveText('clip-red');
    await page.keyboard.press('p');
    expect((await media(page, red)).flag).toBe('pick');

    // Another sequence: review closes itself and the app keeps working.
    await page.evaluate(() => window.__gis.appState.newProject('Other'));
    await expect(review).toHaveCount(0);
    await page.locator('.app-tabs .tab', { hasText: 'Edit' }).click();
    await expect(page.locator('.view-edit')).toBeVisible();
    await page.locator('.app-tabs .tab', { hasText: 'Clips' }).click();
    await expect(page.locator('.bin-panel .empty-title')).toHaveText('Your bin is empty');
    expect(errors).toEqual([]);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('review starts at the first item, "Review from here" starts at a card, and the summary counts what was seen', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4', 'still.jpg']);
    const order = await cardIds(page);
    const review = page.locator('.clips-review');
    const count = review.locator('.clips-review-count');

    // A stray selection on the last card doesn't make review skip the others.
    await card(page, order[3]).click();
    await page.keyboard.press('r');
    await expect(count).toHaveText('1 / 4');
    // Ctrl+A has nothing to select here: the browser must not select the page text either.
    await page.keyboard.press('Control+a');
    expect(await textSelection(page)).toBe(0);
    await page.keyboard.press('Escape');
    await expect(review).toHaveCount(0);

    await card(page, order[2]).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Review from here' }).click();
    await expect(count).toHaveText('3 / 4');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(review.locator('.clips-review-done-title')).toHaveText('Reviewed 2 of 4');
    await expect(review.locator('.clips-review-done-body')).toContainText('2 items not seen yet');
    await review.locator('button', { hasText: 'Review the 2 remaining' }).click();
    await expect(count).toHaveText('1 / 4');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await expect(review.locator('.clips-review-done-title')).toHaveText('Review complete');
    await expect(review.locator('.clips-review-done-body')).toContainText('You picked 0 of 4 items');
    await page.keyboard.press('Escape');
    await expect(review).toHaveCount(0);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('clips added while still downloading get their real length; failed items stay off the timeline', async () => {
  const ctx = await launch();
  try {
    // Hold this download until the clip is on the timeline (local fixtures download too fast otherwise).
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    await ctx.context.route('https://assets.grok.com/slow/clip-hd.mp4', async (route) => {
      await gate;
      await route.fulfill({ status: 200, path: fixture('media', 'clip-hd.mp4'), headers: { 'content-type': 'video/mp4', 'access-control-allow-origin': '*' } });
    });
    const page = await openStudioTab(ctx);
    const id = await page.evaluate(async () => {
      const ids = await window.__gis.media.importPageItems([
        { key: 'video:slow', kind: 'video', url: 'https://assets.grok.com/slow/clip-hd.mp4', altUrls: [], thumbUrl: null, postId: null, prompt: 'A purple nebula swirling, slow orbit', duration: null, seenAt: Date.now(), pageUrl: 'https://grok.com/imagine' },
      ]);
      return ids[0];
    });
    await card(page, id).click();
    await page.keyboard.press('e');
    let p = await getProject(page);
    expect(p.tracks.video.map((c) => [c.mediaId, c.in, c.out])).toEqual([[id, 0, 3]]); // stand-in length
    await expect(page.locator('.toast').last()).toContainText('still downloading');
    // A second copy is trimmed by hand while it downloads: that trim is kept.
    await page.keyboard.press('e');
    await page.evaluate(() => {
      const { projectStore, model } = window.__gis;
      const c = projectStore.get().tracks.video[1];
      projectStore.update((q) => model.updateClip(q, c.id, { out: 2 }), { label: 'Trim clip' });
    });
    release();
    await expect.poll(async () => (await media(page, id)).status, { timeout: 30000 }).toBe('ready');
    await expect.poll(async () => (await getProject(page)).tracks.video.map((c) => c.out)).toEqual([6, 2]);
    // Undo of the trim gives the untrimmed clip back at its real length; redo the trim.
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await getProject(page)).tracks.video.map((c) => c.out)).toEqual([6, 6]);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await getProject(page)).tracks.video.map((c) => c.out)).toEqual([6, 2]);

    // A failed download can't go on the timeline.
    const brokenId = await page.evaluate(async () => {
      try {
        await window.__gis.media.importUrl('https://assets.grok.com/test/missing-clip.mp4');
      } catch {
        /* expected */
      }
      return Object.values(window.__gis.projectStore.get().media).find((m) => m.sourceUrl?.includes('missing-clip')).id;
    });
    await card(page, brokenId).dblclick();
    await expect(page.locator('.src-stage-status.is-error')).toBeVisible();
    for (const label of ['Add to timeline', 'Insert at playhead', 'Add as audio']) await expect(page.locator('.src-actions button', { hasText: label })).toBeDisabled();
    await page.keyboard.press('e');
    await expect(page.locator('.toast-warn').last()).toContainText('failed to download');
    expect((await getProject(page)).tracks.video).toHaveLength(2);
    // With a good item selected too, the good one is added and the failed one skipped with a note.
    await card(page, id).click({ modifiers: ['Control'] });
    await page.keyboard.press('e');
    await expect(page.locator('.toast-warn').last()).toContainText('skipped 1 item that failed to download');
    p = await getProject(page);
    expect(p.tracks.video.map((c) => c.mediaId)).toEqual([id, id, id]);
    expect(p.tracks.video[2].out).toBe(6);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('rename: the name becomes the card title with the prompt below; BinCompact and "Name" sort follow it; empty shows the prompt again', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red, green] = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4']);
    const prompt = 'A red sports car drifting through neon rain, cinematic tracking shot';
    await setMeta(page, [red, green], [
      { prompt, name: 'A red sports car drifting through neon rain, ci…', origin: 'grok' },
      { prompt: 'Zebra crossing at night', name: 'Zebra crossing at night', origin: 'grok' },
    ]);
    const title = (id) => card(page, id).locator('.bin-card-title');
    await expect(title(red)).toHaveText(prompt); // Grok clips show their prompt
    await expect(card(page, red).locator('.bin-card-sub')).toHaveCount(0);

    await card(page, red).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Rename' }).click();
    await expect(page.locator('.modal input.text-field')).toHaveValue('');
    await page.locator('.modal input.text-field').fill('HERO SHOT');
    await page.locator('.modal button[type="submit"]').click();
    await expect(title(red)).toHaveText('HERO SHOT');
    await expect(card(page, red).locator('.bin-card-sub')).toHaveText(prompt);
    expect(await undoLabel(page)).toBe('Rename');

    // "Name A–Z" sorts by the titles on screen: "HERO SHOT" < "Zebra crossing at night".
    await page.locator('.bin-toolbar select').nth(3).selectOption('name');
    expect(await cardIds(page)).toEqual([red, green]);
    await page.keyboard.press('Control+z');
    await expect(title(red)).toHaveText(prompt);
    expect(await cardIds(page)).toEqual([red, green]); // "A red…" < "Zebra…"
    await page.keyboard.press('Control+Shift+z');
    await expect(title(red)).toHaveText('HERO SHOT');

    // BinCompact in the Edit tab shows the name too.
    await page.locator('.app-tabs .tab', { hasText: 'Edit' }).click();
    await expect(page.locator(`.bin-compact-item[data-media-id="${red}"] .bin-compact-name`)).toHaveText('HERO SHOT');
    await page.locator('.app-tabs .tab', { hasText: 'Clips' }).click();

    // An empty name goes back to the prompt.
    await card(page, red).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Rename' }).click();
    await expect(page.locator('.modal input.text-field')).toHaveValue('HERO SHOT');
    await page.locator('.modal input.text-field').fill('');
    await page.locator('.modal button[type="submit"]').click();
    await expect(title(red)).toHaveText(prompt);
    await expect(card(page, red).locator('.bin-card-sub')).toHaveCount(0);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('BinCompact: the menu opens the source monitor in the Clips tab; trim badge, "+" with marks, double-click safety, clearing marks', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red, green] = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4']);
    await setMeta(page, [green], [{ marks: { in: 0.5, out: 2 } }]);
    await page.locator('.app-tabs .tab', { hasText: 'Edit' }).click();
    const item = (id) => page.locator(`.bin-compact-item[data-media-id="${id}"]`);
    await expect(item(green).locator('.bin-compact-trim')).toBeVisible();
    await expect(item(red).locator('.bin-compact-trim')).toHaveCount(0);

    // "+" adds the marked range; double-clicking "+" adds once and stays in the Edit tab.
    await item(green).hover();
    await item(green).locator('.bin-compact-add').click();
    let p = await getProject(page);
    expect(p.tracks.video.map((c) => [c.in, c.out])).toEqual([[0.5, 2]]);
    await item(red).hover();
    await item(red).locator('.bin-compact-add').dblclick();
    p = await getProject(page);
    expect(p.tracks.video.map((c) => c.mediaId)).toEqual([green, red]);
    expect((await ui(page)).tab).toBe('edit');

    await item(green).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Clear IN/OUT marks' }).click();
    await expect(item(green).locator('.bin-compact-trim')).toHaveCount(0);
    expect((await media(page, green)).marks).toBe(null);

    await item(green).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Open in source monitor' }).click();
    await expect.poll(async () => (await ui(page)).tab).toBe('clips');
    await expect(page.locator('.src-monitor .src-title-name')).toHaveText('clip-green');
    expect((await ui(page)).binSelection).toEqual([green]);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('IN/OUT marks live on the item and are undoable (one step per handle drag); Escape in a time field keeps the monitor open', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [blue] = await seedMedia(page, ['clip-blue.mp4']);
    await card(page, blue).dblclick();
    await seekMonitor(page, 1.0);
    await page.keyboard.press('i');
    await seekMonitor(page, 3.0);
    await page.keyboard.press('o');
    const out = 3 + 1 / 30;
    const m = await media(page, blue);
    expect(near(m.marks.in, 1, 0.04) && near(m.marks.out, out, 0.04), JSON.stringify(m.marks)).toBe(true);
    expect(await undoLabel(page)).toBe('Mark OUT');
    await page.keyboard.press('Control+z');
    let s = await ui(page);
    expect(s.sourceOut).toBe(null);
    expect(near(s.sourceIn, 1, 0.04)).toBe(true);
    await expect(card(page, blue).locator('.bin-card-trim')).toBeVisible();
    await page.keyboard.press('Control+Shift+z');
    expect(near((await ui(page)).sourceOut, out, 0.04)).toBe(true);

    // A handle drag is a single undo step.
    const bar = await page.locator('.src-monitor .src-scrub').boundingBox();
    const handle = await page.locator('.src-monitor .src-scrub-handle.is-out').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width * 0.85, bar.y + bar.height / 2, { steps: 8 });
    await page.mouse.up();
    expect((await ui(page)).sourceOut).toBeGreaterThan(4);
    expect(await undoLabel(page)).toBe('Trim OUT');
    await page.keyboard.press('Control+z');
    expect(near((await ui(page)).sourceOut, out, 0.04)).toBe(true);

    // Escape in the IN field restores it and leaves the monitor open; Enter applies a typed time.
    const inField = page.locator('.src-mark-field').first();
    await inField.click();
    await inField.fill('0:02');
    await page.keyboard.press('Escape');
    await expect(page.locator('.src-monitor')).toBeVisible();
    await expect(inField).toHaveValue('0:01.00');
    await expect(inField).not.toBeFocused();
    expect(near((await ui(page)).sourceIn, 1, 0.04)).toBe(true);
    await inField.click();
    await inField.fill('0:02');
    await page.keyboard.press('Enter');
    expect(near((await ui(page)).sourceIn, 2, 1e-6)).toBe(true);
    expect(await undoLabel(page)).toBe('Set IN');
    // The marks are project data: they are saved and exported with the sequence.
    expect((await getProject(page)).media[blue].marks.in).toBe(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('.src-monitor')).toHaveCount(0);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('dragging bin cards: the drop bar appends them; holding over the Edit tab opens it so they can be dropped on the timeline', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const errors = watchPageErrors(page);
    await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4', 'clip-blue.mp4']);
    const order = await cardIds(page);
    await card(page, order[0]).click();
    await card(page, order[2]).click({ modifiers: ['Control'] });
    const center = async (loc) => {
      const b = await loc.boundingBox();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    // Everything the drag needs is measured up front: no locator calls while the (emulated) drag is in flight.
    const selected = await center(card(page, order[2]).locator('.bin-card-media'));
    const unselected = await center(card(page, order[1]).locator('.bin-card-media'));
    const editTab = await center(page.locator('.app-tabs .tab', { hasText: 'Edit' }));
    const rectOf = (sel) =>
      page.evaluate((s) => {
        const r = document.querySelector(s)?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      }, sel);
    // A hovering hand: small moves with short pauses keep dragover events coming.
    const hover = async (p, n) => {
      for (let i = 0; i < n; i++) {
        await page.mouse.move(p.x + (i % 2 ? 1 : -1), p.y, { steps: 1 });
        await page.waitForTimeout(60);
      }
    };
    const startDrag = async (p) => {
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x + 24, p.y + 24, { steps: 4 });
      await hover({ x: p.x + 24, y: p.y + 24 }, 2);
    };

    // 1. The selection, dropped on the bar: appended in display order.
    await startDrag(selected);
    expect(await page.evaluate(() => document.querySelector('.bin-dropbar')?.textContent || '')).toContain('Drop to add 2 items to the end of the timeline');
    const bar = await rectOf('.bin-dropbar');
    await page.mouse.move(bar.x + bar.w / 2, bar.y + bar.h / 2, { steps: 6 });
    await hover({ x: bar.x + bar.w / 2, y: bar.y + bar.h / 2 }, 2);
    expect(await page.evaluate(() => !!document.querySelector('.bin-dropbar.is-over'))).toBe(true);
    await page.mouse.up();
    await expect.poll(async () => (await getProject(page)).tracks.video.map((c) => c.mediaId)).toEqual([order[0], order[2]]);
    await expect(page.locator('.bin-dropbar')).toHaveCount(0);
    await expect(page.locator('.bin-selbar')).toBeVisible();

    // 2. An unselected card drags alone; held over the Edit tab it opens the timeline, dropped at its start.
    await startDrag(unselected);
    await page.mouse.move(editTab.x, editTab.y, { steps: 8 });
    const states = [];
    for (let i = 0; i < 14 && !states.includes('edit'); i++) {
      await hover(editTab, 1);
      states.push(await page.evaluate(() => (document.querySelector('.app-tabs .clips-spring') ? 'spring' : window.__gis.uiStore.get().tab)));
    }
    expect(states[0]).toBe('spring'); // highlighted while held
    expect(states).toContain('edit');
    let row = null;
    for (let i = 0; i < 20 && !row; i++) {
      await hover(editTab, 1);
      row = await rectOf('.tl-row.tl-row-video');
    }
    expect(row).not.toBeNull();
    const target = { x: row.x + 96, y: row.y + row.h / 2 }; // just after the track header: before the first clip
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await hover(target, 3);
    await page.mouse.up();
    await expect.poll(async () => (await getProject(page)).tracks.video.map((c) => c.mediaId)).toEqual([order[1], order[0], order[2]]);
    expect((await ui(page)).tab).toBe('edit');
    expect(errors).toEqual([]);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('card buttons run once on double-click and never open the monitor; Ctrl+A on an empty filtered bin is consumed', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [, green] = await seedMedia(page, ['clip-red.mp4', 'clip-green.mp4']);
    const c = card(page, green);
    await c.hover();
    await c.locator('.bin-card-hover [title^="Add to timeline"]').dblclick();
    expect((await getProject(page)).tracks.video.map((x) => x.mediaId)).toEqual([green]);
    expect((await ui(page)).sourceMediaId).toBe(null);

    const search = page.locator('.bin-search input');
    await search.fill('zzz');
    await expect(page.locator('.bin-panel .empty-title')).toHaveText('Nothing matches');
    await search.evaluate((el) => el.blur());
    await page.keyboard.press('Control+a');
    expect(await textSelection(page)).toBe(0);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('frames: "Attach to Grok" while disconnected shows a single toast; images copied to Ingredients keep their own name', async () => {
  const ctx = await launch();
  try {
    const page = await openStudioTab(ctx);
    const [red, still] = await seedMedia(page, ['clip-red.mp4', 'still.jpg']);
    await page.evaluate(() => {
      window.__ingredientNames = [];
      window.__gis.appState.appEvents.on('ingredient.add', (e) => window.__ingredientNames.push(e.name));
    });
    await card(page, red).dblclick();
    await seekMonitor(page, 1);
    await page.locator('.src-actions button', { hasText: 'Grab frame' }).click();
    await page.locator('.clips-frame-action[data-action="grok"]').click();
    await expect(page.locator('.toast')).toHaveCount(1);
    await expect(page.locator('.toast')).toContainText('Open grok.com');
    await expect(page.locator('.clips-frame-action[data-action="grok"]')).not.toHaveClass(/is-done/);
    await page.locator('.clips-frame-modal button', { hasText: 'Done' }).click();
    await page.keyboard.press('Escape');

    await card(page, still).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Copy to Ingredients' }).click();
    await expect.poll(() => page.evaluate(() => window.__ingredientNames)).toEqual(['still']);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('layout: the docked monitor keeps its volume slider at mid widths; a short view folds the page strip and keeps the monitor actions in view', async () => {
  const ctx = await launch({ viewport: { width: 800, height: 800 } });
  try {
    const page = await openStudioTab(ctx);
    const [red] = await seedMedia(page, ['clip-red.mp4']);
    await card(page, red).dblclick();
    await page.waitForFunction(() => document.querySelector('.src-monitor .src-video')?.readyState >= 1);
    const fits = () =>
      page.evaluate(() => {
        const mon = document.querySelector('.src-monitor').getBoundingClientRect();
        const vol = document.querySelector('.src-volume-range').getBoundingClientRect();
        const add = document.querySelector('.src-actions .btn-primary').getBoundingClientRect();
        const marks = document.querySelector('.src-marks').getBoundingClientRect();
        return {
          volume: vol.width > 40 && vol.left >= mon.left && vol.right <= mon.right + 0.5,
          actions: add.bottom <= mon.bottom + 0.5 && marks.bottom <= mon.bottom + 0.5,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
    for (const width of [800, 760, 960, 1100, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(async () => (await fits()).volume, { message: `volume slider inside the monitor at ${width}px` }).toBe(true);
      expect((await fits()).overflow).toBe(false);
    }

    // Short (the studio docked at the bottom of grok.com): strip folded, actions in view, no "dock below".
    await page.setViewportSize({ width: 1440, height: 495 });
    await expect(page.locator('.clips-page')).toHaveClass(/is-collapsed/);
    await expect.poll(async () => (await fits()).actions).toBe(true);
    await expect(page.locator('.src-head [title^="Dock the monitor below"]')).toHaveCount(0);
    await page.locator('.clips-page-toggle').click();
    await expect(page.locator('.clips-page')).not.toHaveClass(/is-collapsed/);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.clips-page')).not.toHaveClass(/is-collapsed/);
    await expect(page.locator('.src-head [title^="Dock the monitor below"]')).toHaveCount(1);
    expect(appErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});
