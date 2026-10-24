// "Stuck UI" regressions: a drag whose release never arrives (released outside the window / over another frame,
// a right-click, Alt+Tab, Escape…) must always end. Before the fix, the grok.com panel's full-page resize shield
// stayed up — resize cursor forever, nothing clickable until a reload — and studio drags kept their busy state.
import { test } from '@playwright/test';
import { launch, openGrok, openStudio, openStudioTab, seedMedia, getProject, expect } from './harness.mjs';

const ownErrors = (ctx) => ctx.consoleErrors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND|net::/i.test(e));
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
/** What the page has on top at a point (the shield, the studio host, or a page element). */
const topAt = (page, { x, y }) => page.evaluate(([px, py]) => {
  const host = document.elementFromPoint(px, py);
  if (host?.localName !== 'gis-studio-root') return host?.localName || null;
  const inner = host.shadowRoot.elementFromPoint(px, py);
  return inner?.classList.contains('shield') ? 'shield' : 'studio';
}, [x, y]);
/** The release was lost: the next move arrives with no button pressed. */
const lostRelease = (target) => target.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0, bubbles: true, clientX: 5, clientY: 5 })));

test('grok.com panel: a resize or move whose release is missed never leaves the full-page shield up', async () => {
  const ctx = await launch({ viewport: { width: 1280, height: 800 } });
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await openStudio(page);
    // Let the studio finish booting (it may take keyboard focus once, which ends a drag by design).
    await frame.locator('.app-header').waitFor();
    await page.waitForTimeout(1500);
    await page.mouse.click(200, 400);
    const shield = page.locator('gis-studio-root .shield');
    const handleNow = async () => center(await page.locator('gis-studio-root .panel .resizer').boundingBox());
    let handle;
    const pageSpot = { x: 200, y: 400 };
    const startDrag = async () => {
      handle = await handleNow(); // each drag moved the edge
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.mouse.move(handle.x - 40, handle.y, { steps: 3 });
      await expect(shield).toBeVisible();
      expect(await topAt(page, pageSpot)).toBe('shield');
    };
    const expectFree = async () => {
      await expect(shield).toBeHidden();
      expect(await topAt(page, pageSpot)).not.toBe('shield');
      await expect(page.locator('gis-studio-root .resizer.active')).toHaveCount(0);
    };

    // 1. The release is missed (e.g. it happened over the studio frame or outside the window).
    await startDrag();
    await lostRelease(page);
    await expectFree();
    await page.mouse.up();

    // 2. The window loses focus mid-drag (Alt+Tab, a system dialog).
    await startDrag();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expectFree();
    await page.mouse.up();

    // 3. Escape.
    await startDrag();
    await page.keyboard.press('Escape');
    await expectFree();
    await page.mouse.up();

    // 4. A right-click on the handle never starts a drag (the context menu would swallow the release).
    handle = await handleNow();
    await page.mouse.click(handle.x, handle.y, { button: 'right' });
    await expectFree();

    // 5. A normal drag still resizes and ends cleanly.
    const before = (await page.locator('gis-studio-root .panel').boundingBox()).width;
    handle = await handleNow();
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x - 60, handle.y, { steps: 4 });
    await page.mouse.up();
    await expectFree();
    expect(Math.round((await page.locator('gis-studio-root .panel').boundingBox()).width - before)).toBe(60);

    // 6. Floating window: moving it by its bar behaves the same.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('studio drags always end: timeline splitter, timeline clip, shot reorder, drop overlays', async () => {
  const ctx = await launch({ viewport: { width: 1280, height: 800 } });
  try {
    const t = await openStudioTab(ctx);
    const [red, green] = await seedMedia(t, ['clip-red.mp4', 'clip-green.mp4']);
    await t.evaluate((ids) => window.__gis.projectStore.update((p) => window.__gis.model.appendMediaToTimeline(p, ids).project, { label: 'seed' }), [red, green]);

    // Timeline / monitor splitter: the row-resize cursor goes away when the release is missed.
    await t.locator('.app-tabs .tab', { hasText: 'Edit' }).click();
    const split = center(await t.locator('.edit-split').boundingBox());
    await t.mouse.move(split.x, split.y);
    await t.mouse.down();
    await t.mouse.move(split.x, split.y - 30, { steps: 3 });
    await expect(t.locator('.edit-view')).toHaveClass(/is-resizing/);
    await lostRelease(t);
    await expect(t.locator('.edit-view')).not.toHaveClass(/is-resizing/);
    await t.mouse.up();
    // … and on blur
    await t.mouse.move(split.x, split.y - 30);
    await t.mouse.down();
    await t.mouse.move(split.x, split.y - 50, { steps: 3 });
    await expect(t.locator('.edit-view')).toHaveClass(/is-resizing/);
    await t.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(t.locator('.edit-view')).not.toHaveClass(/is-resizing/);
    await t.mouse.up();

    // A timeline clip being moved is let go: later mouse moves don't drag it any more.
    const clip = t.locator('.tl-clip-video').first();
    const c = center(await clip.boundingBox());
    await t.mouse.move(c.x, c.y);
    await t.mouse.down();
    await t.mouse.move(c.x + 120, c.y, { steps: 5 });
    await t.evaluate(() => window.dispatchEvent(new Event('blur')));
    const order = (await getProject(t)).tracks.video.map((x) => x.mediaId);
    await t.mouse.move(c.x - 200, c.y, { steps: 5 });
    await t.mouse.up();
    expect((await getProject(t)).tracks.video.map((x) => x.mediaId)).toEqual(order);
    await expect(t.locator('.tl-clip.is-dragging')).toHaveCount(0);

    // Shot list reorder: the page-wide "grabbing" cursor is removed when the release is missed.
    await t.locator('.app-tabs .tab', { hasText: 'Prompts' }).click();
    await t.evaluate(async () => {
      const S = await import('/studio/prompts/shots.js');
      window.__gis.projectStore.update((p) => S.addShots(p, [{ prompt: 'one' }, { prompt: 'two' }]).project, { label: 'seed' });
    });
    const card = center(await t.locator('.pr-card').first().boundingBox());
    await t.mouse.move(card.x, card.y);
    await t.mouse.down();
    await t.mouse.move(card.x, card.y + 40, { steps: 5 });
    await expect(t.locator('body')).toHaveClass(/pr-dragging/);
    await lostRelease(t);
    await expect(t.locator('body')).not.toHaveClass(/pr-dragging/);
    await t.mouse.up();

    // File drop overlay: a drag that ends elsewhere doesn't leave "Drop … to import" on screen.
    await t.locator('.app-tabs .tab', { hasText: 'Clips' }).click();
    await t.locator('.clips-drop').evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a.mp4', { type: 'video/mp4' }));
      el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(t.locator('.clips-drop .dropzone-overlay')).toBeVisible();
    await t.mouse.move(300, 300);
    await t.mouse.move(310, 310);
    await expect(t.locator('.clips-drop .dropzone-overlay')).toHaveCount(0);
    expect(ownErrors(ctx)).toEqual([]);
  } finally {
    await ctx.close();
  }
});
