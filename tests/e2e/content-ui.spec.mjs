// grok.com on-page UI (extension/content/overlay.js, hover.js): toasts, dock geometry validation, the floating window
// on narrow screens, and the hover toolbar around page dialogs and the cards' own buttons.
import { test } from '@playwright/test';
import { launch, openGrok, studioFrame, expect } from './harness.mjs';
import { POSTS } from './fixtures-map.mjs';

const ID = Object.keys(POSTS);
const [RED, , , , IMAGE] = ID;
const POLL = { polling: 200, timeout: 30000 };

async function studio(page, { open = false } = {}) {
  if (open) await page.locator('gis-studio-root .launcher').click();
  const frame = await studioFrame(page, 30000);
  await frame.waitForFunction(() => window.__gis?.bridge?.connected && !!window.__gis.projectStore.get(), null, POLL);
  return frame;
}
const request = (target, type, payload = {}) => target.evaluate(([t, p]) => window.__gis.bridge.request(t, p, { timeout: 30000 }), [type, payload]);
const panelBox = (page) => page.locator('gis-studio-root .panel').boundingBox();

async function hover(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
}

test('toasts: "Open" toasts close when the studio opens; over a full-width panel toasts sit at the bottom', async () => {
  const ctx = await launch({ viewport: { width: 480, height: 900 } });
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    await hover(page, page.locator(`[data-post-id="${RED}"] video`));
    await page.locator('gis-studio-root .hb.show button[data-act="bin"]').click();
    const added = page.locator('gis-studio-root .toast', { hasText: 'Added to the Studio bin' });
    await expect(added).toBeVisible();
    await page.locator('gis-studio-root .launcher').click();
    await expect(added).toHaveCount(0); // its "Open" action is done
    const frame = await studio(page);
    await expect(page.locator('gis-studio-root .toasts')).toHaveClass(/covered/);
    await request(frame, 'ui.toast', { message: 'Hello from the studio', kind: 'info' });
    const toast = page.locator('gis-studio-root .toast', { hasText: 'Hello from the studio' });
    await expect(toast).toBeVisible();
    const box = await toast.boundingBox();
    expect(box.y + box.height).toBeGreaterThan(900 - 80); // bottom, clear of the studio header controls
    expect(Math.abs(box.x + box.width / 2 - 240)).toBeLessThan(4); // centred
    await request(frame, 'ui.close');
    await expect(page.locator('gis-studio-root .toasts')).not.toHaveClass(/covered/);
  } finally {
    await ctx.close();
  }
});

test('dock sizes are validated: tiny and huge sizes are clamped and the size actually used is reported', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await studio(page, { open: true });
    // Never narrower than the studio's 480 px layout (its header controls, Export and Close stay on screen).
    expect(await request(frame, 'ui.setDock', { mode: 'right', size: 10 })).toEqual({ mode: 'right', size: 480 });
    expect(Math.round((await panelBox(page)).width)).toBe(480);
    expect(await request(frame, 'ui.setDock', { mode: 'right', size: 5000 })).toEqual({ mode: 'right', size: 1440 });
    expect(Math.round((await panelBox(page)).width)).toBe(1440);
    expect(await request(frame, 'ui.setDock', { mode: 'bottom', size: 5 })).toEqual({ mode: 'bottom', size: 240 });
    expect(Math.round((await panelBox(page)).height)).toBe(240);
    expect(await request(frame, 'ui.setDock', { mode: 'float', size: 100 })).toEqual({ mode: 'float', size: 480 });
    expect(Math.round((await panelBox(page)).width)).toBe(480);
    expect(await request(frame, 'ui.getDock')).toEqual({ mode: 'float', size: 480, open: true });
    expect(await request(frame, 'ui.setDock', { mode: 'right', size: 'wide' })).toMatchObject({ mode: 'right' }); // ignored size
  } finally {
    await ctx.close();
  }
});

test('the floating window docks right at full width on narrow windows and floats again when there is room', async () => {
  const ctx = await launch({ viewport: { width: 480, height: 900 } });
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await studio(page, { open: true });
    expect(await request(frame, 'ui.setDock', { mode: 'float', size: 640 })).toEqual({ mode: 'float', size: 480, effectiveMode: 'right' });
    await expect(page.locator('gis-studio-root .panel')).toHaveClass(/\bright\b/);
    expect(Math.round((await panelBox(page)).width)).toBe(480);
    expect(await request(frame, 'ui.getDock')).toEqual({ mode: 'float', size: 480, effectiveMode: 'right', open: true });
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect(page.locator('gis-studio-root .panel')).toHaveClass(/\bfloat\b/);
    const box = await panelBox(page);
    expect(box.width).toBeGreaterThanOrEqual(480); // never narrower than the studio layout
    expect(box.x + box.width).toBeLessThanOrEqual(1200);
    expect((await request(frame, 'ui.getDock')).effectiveMode).toBeUndefined();
  } finally {
    await ctx.close();
  }
});

test('hover toolbar: nothing over media covered by a page dialog, and never over the card\'s own buttons', async () => {
  const ctx = await launch({ viewport: { width: 480, height: 900 } });
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const bar = page.locator('gis-studio-root .hb.show');
    // A Grok-style modal: dimmed full-screen backdrop and a dialog.
    await page.evaluate(() => {
      const back = document.createElement('div');
      back.id = 'test-backdrop';
      back.setAttribute('role', 'presentation');
      back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:50;display:flex;align-items:center;justify-content:center';
      const dlg = document.createElement('div');
      dlg.setAttribute('role', 'dialog');
      dlg.style.cssText = 'width:300px;height:200px;background:#1b1b22;border-radius:16px';
      back.append(dlg);
      document.body.append(back);
    });
    await hover(page, page.locator(`[data-post-id="${RED}"] video`));
    await page.waitForTimeout(400);
    await expect(bar).toHaveCount(0);
    await page.evaluate(() => document.getElementById('test-backdrop').remove());
    await page.mouse.move(5, 5);
    await hover(page, page.locator(`[data-post-id="${RED}"] video`));
    await expect(bar).toBeVisible();

    // The image card (with a favorite button in its top-right corner): the toolbar keeps clear of it.
    const img = page.locator(`[data-post-id="${IMAGE}"] img`);
    await hover(page, img);
    await expect(bar).toBeVisible();
    await expect(bar.locator('button')).toHaveCount(4); // Bin, Pick, Timeline, Ingredient: all reachable
    const b = await bar.boundingBox();
    const fav = await page.locator(`[data-post-id="${IMAGE}"] .card-fav`).boundingBox();
    const media = await img.boundingBox();
    expect(b.x + b.width).toBeLessThanOrEqual(fav.x);
    expect(b.width).toBeLessThanOrEqual(media.width * 0.75 + 1);
    // Clicking the favorite button still reaches the page, not the toolbar.
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.card-fav') != null, [fav.x + fav.width / 2, fav.y + fav.height / 2]);
    expect(hit).toBe(true);
  } finally {
    await ctx.close();
  }
});
