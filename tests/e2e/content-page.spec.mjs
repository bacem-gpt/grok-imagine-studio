// grok.com stays usable next to the studio and the content script stays light (extension/content/**):
// docked panels make room in the page (Grok's composer and Generate button stay reachable), the floating window opens
// clear of the composer, the panel never gets too narrow for its controls, the launcher keeps off the scrollbar, the
// hover toolbar respects sticky bars / clipping containers / the cards' own controls and follows in-place src
// switches, long discussions are scanned in linear time, MediaSource / page-blob videos are one clip with Grok's
// record, images are attached exactly once and only into the composer, and the page hook keeps fetch transparent.
import { test, chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, openGrok, studioFrame, openStudioTab, routeAssets, routeGrok, EXTENSION_DIR, expect } from './harness.mjs';
import { POSTS, videoUrl, thumbUrl } from './fixtures-map.mjs';
import { GENERATED_POST } from './content-mock-api.mjs';

const ID = Object.keys(POSTS);
const [RED, , BLUE] = ID;
const POLL = { polling: 200, timeout: 30000 };

async function studio(page, { open = false } = {}) {
  if (open) await page.locator('gis-studio-root .launcher').click();
  const frame = await studioFrame(page, 30000);
  await frame.waitForFunction(() => window.__gis?.bridge?.connected && !!window.__gis.projectStore.get(), null, POLL);
  return frame;
}
const request = (target, type, payload = {}) => target.evaluate(([t, p]) => window.__gis.bridge.request(t, p, { timeout: 30000 }), [type, payload]);
const box = async (locator) => locator.boundingBox();
const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];
/** What a click at the centre of a page element would hit: the element itself, or the studio over it. */
const hitAt = (page, b) => page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  return el?.localName === 'gis-studio-root' ? 'studio' : el?.closest('button')?.getAttribute('aria-label') || el?.localName || null;
}, centre(b));

/** Evaluates an expression in the content script's isolated world (window.__gisContent lives there). */
async function contentWorld(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
  await cdp.send('Runtime.enable');
  return async (expression) => {
    for (let i = 0; i < 150; i++) {
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const ctx = [...contexts.values()].reverse().find((c) => c.auxData?.frameId === frameTree.frame.id && c.auxData?.type === 'isolated' && c.name === 'Imagine Studio for Grok');
      if (ctx) {
        const r = await cdp.send('Runtime.evaluate', { expression, contextId: ctx.id, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('content script world not found');
  };
}

async function hover(page, locator, dx = 0.5, dy = 0.5) {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width * dx, b.y + b.height * dy, { steps: 3 });
}

// ---------------------------------------------------------------------------------------------------------------

test('docked right or bottom the studio makes room: Grok\'s composer and Generate button stay reachable; closing gives the page back', async () => {
  const ctx = await launch({ viewport: { width: 1440, height: 900 } });
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const send = page.locator('.query-bar button[type="submit"]');
    const frame = await studio(page, { open: true });
    const panel = page.locator('gis-studio-root .panel');

    // Default: docked right at half the window. The feed and the composer re-fit to the page area beside it.
    await expect(panel).toHaveClass(/\bright\b/);
    let p = await box(panel);
    expect(Math.round(p.width)).toBe(720);
    await expect.poll(async () => hitAt(page, await box(send))).toBe('Submit');
    const bar = await box(page.locator('.query-bar'));
    expect(bar.x + bar.width).toBeLessThanOrEqual(p.x);
    for (const card of await page.locator('#feed [role="listitem"]').all()) {
      const b = await card.boundingBox();
      if (b) expect(b.x + b.width, 'no card runs under the panel').toBeLessThanOrEqual(p.x + 1);
    }

    // Docked bottom: the composer sits above the panel.
    await request(frame, 'ui.setDock', { mode: 'bottom' });
    await expect(panel).toHaveClass(/\bbottom\b/);
    p = await box(panel);
    await expect.poll(async () => hitAt(page, await box(send))).toBe('Submit');
    expect((await box(page.locator('.query-bar'))).y + (await box(page.locator('.query-bar'))).height).toBeLessThanOrEqual(p.y);

    // Floating: opens clear of the composer.
    await request(frame, 'ui.setDock', { mode: 'float' });
    await expect(panel).toHaveClass(/\bfloat\b/);
    p = await box(panel);
    const q = await box(page.locator('.query-bar'));
    expect(p.y + p.height <= q.y || p.y >= q.y + q.height || p.x + p.width <= q.x || p.x >= q.x + q.width, 'the floating window keeps off the composer').toBe(true);
    expect(await hitAt(page, await box(send))).toBe('Submit');

    // Closed: the page is exactly as before.
    await request(frame, 'ui.setDock', { mode: 'right' });
    await request(frame, 'ui.close');
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() => ({ w: document.body.getBoundingClientRect().width, t: getComputedStyle(document.body).transform }))).toEqual({ w: 1440, t: 'none' });
    expect(await hitAt(page, await box(send))).toBe('Submit');
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('docked right in a chat, Grok\'s reply wraps beside the panel; the panel never gets narrower than its controls', async () => {
  const ctx = await launch({ viewport: { width: 1280, height: 800 } });
  try {
    const page = ctx.page;
    await openGrok(page, '/c/abc');
    const frame = await studio(page, { open: true });
    const panel = page.locator('gis-studio-root .panel');
    const p = await box(panel);
    const reply = await box(page.locator('#response-0f1c2d .response-content-markdown'));
    expect(reply.x + reply.width).toBeLessThanOrEqual(p.x);
    expect(await hitAt(page, await box(page.locator('.query-bar button[type="submit"]')))).toBe('Send');
    // Dragging the edge far to the right stops at the studio's 480 px layout: Hide / Export stay on screen.
    const handle = await box(page.locator('gis-studio-root .panel .resizer'));
    await page.mouse.move(handle.x + 3, handle.y + 300);
    await page.mouse.down();
    await page.mouse.move(handle.x + 600, handle.y + 300, { steps: 8 });
    await page.mouse.up();
    const narrow = await box(panel);
    expect(Math.round(narrow.width)).toBe(480);
    await frame.waitForFunction(() => innerWidth === 480);
    const hide = await frame.locator('[title^="Hide studio"]').boundingBox(); // page coordinates
    expect(hide.x).toBeGreaterThanOrEqual(narrow.x);
    expect(hide.x + hide.width).toBeLessThanOrEqual(narrow.x + narrow.width);
    expect(await request(frame, 'ui.getDock')).toMatchObject({ mode: 'right', size: 480 });
  } finally {
    await ctx.close();
  }
});

test('the launcher keeps off the page\'s scrollbar', async () => {
  // Playwright hides scrollbars by default: this one keeps them.
  const dir = mkdtempSync(join(tmpdir(), 'gis-e2e-sb-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    await routeAssets(context, {});
    await routeGrok(context, {});
    const page = context.pages()[0] || (await context.newPage());
    for (const path of ['/imagine', '/c/abc']) {
      await openGrok(page, path);
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => {
        const main = document.querySelector('main.main');
        const bar = main.offsetWidth - main.clientWidth;
        const l = document.querySelector('gis-studio-root').shadowRoot.querySelector('.launcher').getBoundingClientRect();
        const m = main.getBoundingClientRect();
        return { bar, launcherRight: l.right, mainRight: m.right, hit: document.elementFromPoint(m.right - bar / 2, l.top + l.height / 2)?.localName };
      });
      expect(r.bar, `${path}: the feed has a real scrollbar`).toBeGreaterThan(0);
      expect(r.launcherRight).toBeLessThanOrEqual(r.mainRight - r.bar + 0.5);
      expect(r.hit, `${path}: grabbing the scrollbar beside the launcher reaches the page`).toBe('main');
    }
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hover toolbar: below sticky bars, inside clipping containers, clear of a card\'s top-left control', async () => {
  const ctx = await launch({ viewport: { width: 1280, height: 800 } });
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const toolbar = page.locator('gis-studio-root .hb.show');
    const video = page.locator(`[data-post-id="${RED}"] video`);

    // The card's top edge scrolled 30 px under the sticky top bar.
    const topbar = await box(page.locator('.topbar'));
    await page.evaluate(([id, under]) => {
      const main = document.querySelector('main.main');
      main.scrollTop += document.querySelector(`[data-post-id="${id}"] video`).getBoundingClientRect().top - under;
    }, [RED, topbar.y + topbar.height - 30]);
    await hover(page, video, 0.5, 0.8);
    await expect(toolbar).toBeVisible();
    await expect.poll(async () => (await box(toolbar)).y).toBeGreaterThanOrEqual(topbar.y + topbar.height);
    const forYou = await box(page.locator('.topbar a', { hasText: 'For you' }));
    expect(await hitAt(page, forYou)).toBe('a');
    await page.mouse.move(5, 5);
    await expect(toolbar).toHaveCount(0);

    // A horizontal carousel with its first image scrolled half out of view.
    await page.evaluate((thumbs) => {
      const car = document.createElement('div');
      car.id = 'car';
      car.style.cssText = 'display:flex;gap:8px;overflow-x:auto;width:520px;margin:20px 0 20px 200px;';
      for (const src of thumbs) {
        const img = document.createElement('img');
        img.src = src;
        img.style.cssText = 'width:300px;height:200px;flex:none;object-fit:cover';
        car.append(img);
      }
      document.querySelector('main.main').prepend(car);
      document.querySelector('main.main').scrollTop = 0;
    }, [thumbUrl(ID[0]), thumbUrl(ID[1]), thumbUrl(ID[2])]);
    await page.waitForFunction(() => [...document.querySelectorAll('#car img')].every((i) => i.complete && i.naturalWidth));
    await page.evaluate(() => (document.getElementById('car').scrollLeft = 250));
    const car = await box(page.locator('#car'));
    await page.waitForTimeout(700); // rescan
    await page.mouse.move(car.x + 25, car.y + 100, { steps: 3 });
    await expect(toolbar).toBeVisible();
    expect((await box(toolbar)).x).toBeGreaterThanOrEqual(car.x);
    await page.evaluate(() => document.getElementById('car').remove());
    await page.mouse.move(5, 5);
    await expect(toolbar).toHaveCount(0);

    // A "Select" checkbox in the card's top-left corner stays clickable.
    await page.evaluate((id) => {
      const sel = document.createElement('div');
      sel.id = 'sel';
      sel.setAttribute('role', 'checkbox');
      sel.setAttribute('aria-label', 'Select');
      sel.style.cssText = 'position:absolute;left:10px;top:10px;width:24px;height:24px;z-index:3;border:2px solid #fff;border-radius:6px';
      document.querySelector(`[data-post-id="${id}"]`).append(sel);
    }, RED);
    await video.scrollIntoViewIfNeeded();
    await hover(page, video, 0.6, 0.7);
    await expect(toolbar).toBeVisible();
    const sel = await box(page.locator('#sel'));
    const t = await box(toolbar);
    expect(t.y >= sel.y + sel.height || t.x >= sel.x + sel.width, 'toolbar clear of the checkbox').toBe(true);
    expect(await toolbar.locator('button').count()).toBe(3); // full toolbar, not squeezed to one button
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, centre(sel))).toBe('sel');
  } finally {
    await ctx.close();
  }
});

test('hover toolbar follows a video that switches to another clip in place: "+ Bin" adds the clip on screen', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, `/imagine/post/${RED}`);
    const hd = page.locator('#hd-video');
    await expect(hd).toBeVisible();
    await page.waitForTimeout(800);
    await hover(page, hd);
    const toolbar = page.locator('gis-studio-root .hb.show');
    await expect(toolbar).toBeVisible();
    // The variant switcher swaps the clip in the same element while the pointer rests on it.
    await page.evaluate(([poster, src]) => {
      const v = document.getElementById('hd-video');
      v.poster = poster;
      v.src = src;
    }, [thumbUrl(BLUE), videoUrl(BLUE)]);
    await page.locator('gis-studio-root .hb.show button[data-act="bin"]').click({ timeout: 15000 }); // right away: before the next scan
    const frame = await studio(page);
    await frame.waitForFunction(() => Object.values(window.__gis.projectStore.get().media).length > 0, null, POLL);
    expect(await frame.evaluate(() => Object.values(window.__gis.projectStore.get().media).map((m) => m.pageKey))).toEqual([`video:${BLUE}`]);
  } finally {
    await ctx.close();
  }
});

test('a long discussion with hundreds of generated videos is scanned without freezing the page, each with its own prompt', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/c/abc');
    const world = await contentWorld(page);
    await world('!!window.__gisContent');
    const PAIRS = 400;
    await page.evaluate((n) => {
      window.__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask' });
      const id = (i) => `${(0x10000000 + i).toString(16)}-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < n; i++) {
        const u = document.createElement('div');
        u.id = `response-u${i}`;
        u.className = 'relative group flex flex-col w-full items-end';
        u.innerHTML = `<div class="message-bubble"><span class="whitespace-pre-wrap">Take ${i}: a lighthouse in a storm, waves crashing</span></div>`;
        const a = document.createElement('div');
        a.id = `response-a${i}`;
        a.className = 'relative group flex flex-col w-full items-start';
        a.innerHTML = `<div class="message-bubble"><div class="response-content-markdown"><p>Here it is</p><video muted preload="none" src="https://assets.grok.com/users/test-user-0000/generated/${id(i)}/generated_video.mp4"></video></div></div>`;
        frag.append(u, a);
      }
      document.querySelector('.chat').append(frag);
    }, PAIRS);
    // Every video, each with the prompt of the message before it.
    const stats = async () =>
      world(`(() => {
        const items = window.__gisContent.registry.list().filter((m) => m.kind === 'video' && /-cccc-/.test(m.key));
        const right = items.filter((m) => m.prompt === 'Take ' + (parseInt(m.key.slice(6, 14), 16) - 0x10000000) + ': a lighthouse in a storm, waves crashing');
        return { videos: items.length, right: right.length };
      })()`);
    await expect.poll(stats, { timeout: 20000 }).toEqual({ videos: PAIRS, right: PAIRS });
    const longest = Math.max(0, ...(await page.evaluate(() => window.__long)));
    expect(longest, 'no long freeze while the discussion is scanned').toBeLessThan(1000);
    // A full rescan of the discussion (prompts cached per element) stays cheap.
    const ms = await world('(() => { const t0 = performance.now(); window.__gisContent.detector.scanNow(); return performance.now() - t0; })()');
    expect(ms).toBeLessThan(250);
  } finally {
    await ctx.close();
  }
});

test('MediaSource and page-blob videos are one clip with Grok\'s record (badge, page list, "+ Bin")', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const world = await contentWorld(page);
    // Grok streams a feed card's clip through MediaSource (no poster, no file URL); another stream has no card at all.
    await page.evaluate((id) => {
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(new MediaSource());
      v.style.cssText = 'width:100%;height:220px;display:block;background:#333';
      const card = document.createElement('div');
      card.className = 'group/media-post-masonry-card relative card';
      card.dataset.testMse = '1';
      const a = document.createElement('a');
      a.className = 'card-link';
      a.href = `/imagine/post/${id}`;
      a.setAttribute('aria-label', 'Open post');
      card.append(v, a);
      const li = document.createElement('div');
      li.setAttribute('role', 'listitem');
      li.append(card);
      document.getElementById('feed').prepend(li);
      // Remove the regular card of the same post: only the stream shows it.
      document.querySelector(`[data-post-id="${id}"]`)?.closest('[role="listitem"]').remove();
      const loose = document.createElement('video');
      loose.src = URL.createObjectURL(new MediaSource());
      document.querySelector('main.main').append(loose);
    }, RED);
    // The streamed card's video is Grok's record of the post (the card names it).
    await expect.poll(() => world(`window.__gisContent.registry.keyForElement(document.querySelector('[data-test-mse] video'))`), POLL).toBe(`video:${RED}`);
    await expect
      .poll(() => world(`window.__gisContent.registry.list().filter((m) => m.kind === 'video').map((m) => [m.key, m.url, m.altUrls.length, m.source])`), POLL)
      .toContainEqual([`video:${RED}`, videoUrl(RED), 0, 'both']);
    expect(await world(`window.__gisContent.registry.list().some((m) => m.key.startsWith('url:blob:') || [m.url, ...m.altUrls].some((u) => u.startsWith('blob:')))`)).toBe(false);
    // "+ Bin" on the streamed card imports Grok's file.
    await hover(page, page.locator('[data-test-mse] video'));
    await page.locator('gis-studio-root .hb.show button[data-act="bin"]').click({ timeout: 15000 });
    const frame = await studio(page);
    await frame.waitForFunction((k) => Object.values(window.__gis.projectStore.get().media).some((m) => m.pageKey === k && m.status === 'ready'), `video:${RED}`, POLL);

    // Chat: a generated clip the page plays from a blob it downloaded (no poster) is the streamed record's clip.
    await openGrok(page, '/c/abc');
    const chat = await contentWorld(page);
    await page.evaluate(async ([gen, url]) => {
      await (await fetch('/rest/app-chat/conversations/abc/responses', { method: 'POST', body: JSON.stringify({ message: 'Animate the hero car', genId: gen }) })).text();
      const bytes = await (await fetch(url)).blob();
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(bytes);
      document.querySelector('#response-0f1c2d .response-content-markdown').append(v);
    }, [GENERATED_POST, videoUrl(GENERATED_POST)]);
    await expect.poll(() => chat(`window.__gisContent.registry.list().filter((m) => m.kind === 'video').map((m) => [m.key, m.source])`), POLL).toEqual([[`video:${GENERATED_POST}`, 'both']]);
    await expect(page.locator('gis-studio-root .launcher .badge')).toHaveText('1');
  } finally {
    await ctx.close();
  }
});

test('attach: an image goes in exactly once, only into Grok\'s prompt box', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    const attach = (frame) =>
      frame.evaluate(async () => {
        const bytes = await (await fetch('https://assets.grok.com/test/still.png')).blob();
        return window.__gis.bridge.request('composer.attach', { blob: new File([bytes], 'ref.png', { type: 'image/png' }), name: 'ref.png' });
      });
    // A chat-style composer whose paste handler takes the file without preventDefault(); the form also accepts drops.
    await openGrok(page, '/imagine?noinput&nopaste');
    let frame = await studio(page, { open: true });
    await page.evaluate(() => {
      window.__took = [];
      document.querySelector('.query-bar [contenteditable="true"]').addEventListener('paste', (e) => {
        for (const f of e.clipboardData.files) window.__took.push(f.name);
      });
      // Another uploader on the page, outside the prompt box: never used.
      const other = document.createElement('input');
      other.type = 'file';
      other.accept = 'image/*';
      other.id = 'other-upload';
      other.addEventListener('change', () => (window.__other = (window.__other || 0) + 1));
      document.querySelector('main.main').append(other);
    });
    expect(await attach(frame)).toMatchObject({ ok: true, method: 'paste' });
    expect(await page.evaluate(() => window.__took)).toEqual(['ref.png']);
    expect(await page.evaluate(() => window.__mock.attached.map((a) => a.method)), 'not dropped a second time').toEqual([]);
    expect(await page.evaluate(() => window.__other || 0)).toBe(0);

    // An upload field that lists extensions only (accept=".png,.jpg,…") takes the image.
    await openGrok(page, '/imagine');
    frame = await studio(page, { open: true });
    await page.evaluate(() => (document.querySelector('.query-bar input[type="file"]').accept = '.png,.jpg,.jpeg,.webp,.gif'));
    expect(await attach(frame)).toEqual({ ok: true, method: 'input', confirmed: true });
    expect(await page.evaluate(() => window.__mock.attached.map((a) => a.method))).toEqual(['input']);

    // No upload field, an editor that ignores pasted files: dropped on the prompt box (the outside uploader stays unused).
    await openGrok(page, '/imagine?noinput&nopaste');
    frame = await studio(page, { open: true });
    await page.evaluate(() => {
      const other = document.createElement('input');
      other.type = 'file';
      other.addEventListener('change', () => (window.__other = (window.__other || 0) + 1));
      document.querySelector('main.main').append(other);
    });
    expect(await attach(frame)).toEqual({ ok: true, method: 'drop', confirmed: true });
    expect(await page.evaluate(() => window.__mock.attached.map((a) => a.method))).toEqual(['drop']);
    expect(await page.evaluate(() => window.__other || 0)).toBe(0);
  } finally {
    await ctx.close();
  }
});

test('the page hook keeps fetch transparent: a rejected API call the page ignores is still reported to it', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await ctx.context.route(/refuse-me/, (route) => route.abort());
    await openGrok(page, '/imagine');
    const unhandled = await page.evaluate(async () => {
      const seen = [];
      window.addEventListener('unhandledrejection', (e) => seen.push(String(e.reason?.message || e.reason)));
      fetch('/rest/refuse-me'); // sniffed by the hook
      fetch('/fixtures/refuse-me'); // not sniffed
      await new Promise((r) => setTimeout(r, 1500));
      return seen;
    });
    expect(unhandled).toEqual(['Failed to fetch', 'Failed to fetch']);
  } finally {
    await ctx.close();
  }
});

test('page events reach chrome.runtime only while a standalone studio tab listens (the service worker can sleep)', async () => {
  const ctx = await launch();
  try {
    await ctx.sw.evaluate(() => {
      self.__evts = 0;
      chrome.runtime.onMessage.addListener((m) => {
        if (m?.gis === 'evt') self.__evts++;
      });
    });
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await studio(page, { open: true }); // UI_VISIBILITY, PAGE_MEDIA … for the embedded studio
    await openGrok(page, '/imagine/favorites'); // PAGE_NAVIGATED
    await page.waitForTimeout(1500);
    expect(await ctx.sw.evaluate(() => self.__evts)).toBe(0);
    // A standalone studio tab that targets this tab gets them.
    const tab = await openStudioTab(ctx);
    await tab.waitForFunction(() => window.__gis.bridge.connected && window.__gis.bridge.tabId != null, null, POLL);
    await page.bringToFront();
    await page.evaluate(() => document.querySelector('main.main').append(Object.assign(document.createElement('div'), { id: 'x' })));
    await openGrok(page, '/imagine');
    await expect.poll(() => ctx.sw.evaluate(() => self.__evts), POLL).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});
