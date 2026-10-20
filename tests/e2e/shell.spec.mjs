// The studio shell and its cross-window plumbing: header layout at docked widths, toasts, the Panel layout menu, the
// toolbar button on a tab without a live content script, handshake tokens, page payload checks, and several studio
// windows sharing storage (cleanup, deleted sequences, settings, saves on close, auto-collect).
import { test } from '@playwright/test';
import { launch, openGrok, openStudio, studioFrame, openStudioTab, setDockMode, seedMedia, getProject, expect } from './harness.mjs';
import { POSTS, mediaPostList } from './fixtures-map.mjs';
import { GENERATED_POST } from './content-mock-api.mjs';

const POLL = { polling: 100, timeout: 30000 };

test('studio overlay opens inside grok.com under grok CSP and connects', async () => {
  const ctx = await launch();
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const frame = await openStudio(page);
    await expect(frame.locator('.app-tabs .tab')).toHaveCount(5);
    await frame.waitForFunction(() => window.__gis.bridge.connected, null, POLL);
    // Docked (half the window): the connection pill only repeats what the Clips tab shows, so it makes room.
    await expect(frame.locator('.conn-pill.is-on')).toHaveCount(1);
    await expect(frame.locator('.conn-pill.is-on')).toBeHidden();
    // tab switching
    await frame.locator('.app-tabs .tab', { hasText: 'Prompts' }).click();
    await expect(frame.locator('.view-prompts')).toBeVisible();
    // dock bottom then close
    await setDockMode(frame, 'bottom');
    await expect(page.locator('gis-studio-root .panel.bottom')).toBeVisible();
    await expect(frame.locator('.conn-pill.is-on')).toBeVisible(); // full width again
    await frame.locator('.dock-controls [title^="Hide studio"]').click();
    await expect(page.locator('gis-studio-root .panel')).toBeHidden();
    await expect(page.locator('gis-studio-root .launcher')).toBeVisible();
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('studio opens as a standalone tab', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await expect(studio.locator('.project-btn')).toContainText('My first sequence');
    // not connected: a labelled link, not a bare dot
    await expect(studio.locator('a.conn-pill.is-off')).toBeVisible();
    await expect(studio.locator('a.conn-pill.is-off')).toContainText('Grok');
  } finally {
    await ctx.close();
  }
});

/** What the header shows: visible tab names, whether it overflows, a few widths. */
const headerState = (target) =>
  target.evaluate(() => {
    const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    const header = document.querySelector('.app-header');
    const tabs = [...document.querySelectorAll('.app-tabs .tab')];
    return {
      width: innerWidth,
      names: tabs.map((t) => (visible(t.querySelector('.tab-label')) ? t.querySelector('.tab-label').textContent : null)),
      truncated: tabs.some((t) => t.querySelector('.tab-label').scrollWidth > t.querySelector('.tab-label').clientWidth + 1),
      overflow: header.scrollWidth > header.clientWidth + 1,
      rows: header.getBoundingClientRect().height > 60 ? 2 : 1,
      project: document.querySelector('.project-btn').getBoundingClientRect().width,
      exportLabel: visible(document.querySelector('.export-btn .btn-label')),
    };
  });

test('header keeps the tab names readable at docked widths', async () => {
  const ctx = await launch({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const frame = await openStudio(page);
    await frame.evaluate(() => window.__gis.projectStore.update((p) => window.__gis.model.renameProject(p, 'A sequence with a rather long name')));
    const setPanelWidth = async (w) => {
      await page.evaluate((px) => {
        document.querySelector('gis-studio-root').shadowRoot.querySelector('.panel').style.width = `${px}px`;
      }, w);
      await frame.waitForFunction((px) => innerWidth === px, w);
    };
    const ALL = ['Clips', 'Edit', 'Prompts', 'Dialogue', 'Ingredients'];
    // Default right dock = half of a 1440 / 1366 px window: every tab is named, the sequence name gives way.
    for (const w of [720, 683]) {
      await setPanelWidth(w);
      const st = await headerState(frame);
      expect(st, `${w}px`).toMatchObject({ names: ALL, truncated: false, overflow: false, rows: 1, exportLabel: true });
      expect(st.project).toBeGreaterThanOrEqual(72);
    }
    // Narrower: the active tab keeps its name.
    await setPanelWidth(620);
    await frame.locator('.app-tabs .tab[data-tab="edit"]').click();
    expect(await headerState(frame)).toMatchObject({ names: [null, 'Edit', null, null, null], overflow: false, rows: 1 });
    // Phone-like widths: the tabs get a row of their own, with their names; Export keeps its label.
    for (const w of [480, 380]) {
      await setPanelWidth(w);
      const st = await headerState(frame);
      expect(st, `${w}px`).toMatchObject({ names: ALL, overflow: false, rows: 2, exportLabel: true });
      expect(st.project).toBeGreaterThanOrEqual(72);
    }
  } finally {
    await ctx.close();
  }
});

test('the Panel layout menu marks the current dock mode, and toasts stay clear of the bottom bars', async () => {
  const ctx = await launch({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const frame = await openStudio(page);
    await frame.locator('.dock-compact [title="Panel layout"]').click();
    const current = frame.locator('.menu .menu-item.is-checked');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText('Dock right');
    await expect(current).toHaveAttribute('aria-checked', 'true');
    await expect(current.locator('.menu-check')).toBeVisible();
    await expect(frame.locator('.menu .menu-item', { hasText: 'Dock bottom' })).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');

    // Toasts: under the header (the bottom of every view holds its action bar).
    await frame.evaluate(async () => {
      const kit = await import(chrome.runtime.getURL('studio/ui/kit.js'));
      kit.toast('First message', { duration: 0 });
      kit.notConnectedToast('send this prompt', { copyText: 'A lighthouse in a storm' });
    });
    const toasts = frame.locator('.toast');
    await expect(toasts).toHaveCount(2);
    const geo = await frame.evaluate(() => {
      const rects = [...document.querySelectorAll('.toast')].map((t) => t.getBoundingClientRect());
      const header = document.querySelector('.app-header').getBoundingClientRect();
      return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)), headerBottom: header.bottom, height: innerHeight };
    });
    expect(geo.top).toBeGreaterThanOrEqual(geo.headerBottom);
    expect(geo.bottom).toBeLessThan(geo.height / 2);
    // The shared "not connected" message: one wording, one action label, Copy when there is text to keep.
    const warn = frame.locator('.toast.toast-warn');
    await expect(warn).toContainText('Not connected to grok.com — open Grok Imagine to send this prompt.');
    await expect(warn.locator('.toast-action')).toHaveText(['Open Grok Imagine', 'Copy']);
  } finally {
    await ctx.close();
  }
});

test('toolbar button on a grok.com tab without a live content script starts it in place (no reload)', async () => {
  const ctx = await launch();
  try {
    const page = await openGrok(ctx.page, '/imagine');
    await page.locator('.query-bar [contenteditable="true"]').click();
    await page.keyboard.type('half-written prompt');
    // What an extension update leaves behind: the old content script retired itself, nothing answers in the tab.
    await ctx.sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://grok.com/*' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__gisContent.destroy() });
    });
    await expect(page.locator('gis-studio-root')).toHaveCount(0);
    const navigations = [];
    page.on('framenavigated', (f) => f === page.mainFrame() && navigations.push(f.url()));
    await ctx.sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://grok.com/*' });
      await globalThis.__gisBackground.onActionClicked(tab);
    });
    await expect(page.locator('gis-studio-root .panel')).toBeVisible({ timeout: 15000 });
    const frame = await studioFrame(page);
    await frame.waitForFunction(() => window.__gis?.bridge?.connected, null, POLL);
    expect(navigations).toEqual([]);
    expect(await page.evaluate(() => document.querySelector('.query-bar [contenteditable]').innerText)).toContain('half-written prompt');
    // the restarted content script works: it answers the next toolbar click (closes the panel)
    await ctx.sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://grok.com/*' });
      await globalThis.__gisBackground.onActionClicked(tab);
    });
    await expect(page.locator('gis-studio-root .panel')).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test('studio frames trust only handshakes the extension set up (tokens from the service worker)', async () => {
  const ctx = await launch();
  try {
    const page = await openGrok(ctx.page, '/imagine');
    const studioUrl = ctx.studioUrl('embedded');
    // A token-aware content script, simulated in the extension's isolated world: token, own iframe, handshake.
    const contentHandshake = () =>
      ctx.sw.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url: 'https://grok.com/*' });
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [url],
          func: async (src) => {
            const { token } = await chrome.runtime.sendMessage({ gis: 'studio-token' });
            const ifr = document.createElement('iframe');
            ifr.src = src;
            ifr.dataset.testStudio = '1';
            document.body.appendChild(ifr);
            await new Promise((r) => (ifr.onload = r));
            const ch = new MessageChannel();
            const acked = new Promise((resolve) => {
              ch.port1.onmessage = (e) => e.data?.name === 'gis:connected' && resolve(true);
              setTimeout(() => resolve(false), 20000);
            });
            ifr.contentWindow.postMessage({ type: 'gis:connect', version: 1, token }, new URL(src).origin, [ch.port2]);
            window.__testPort = ch.port1;
            return { token: !!token, acked: await acked };
          },
        });
        return res.result;
      }, studioUrl);
    expect(await contentHandshake()).toEqual({ token: true, acked: true });

    // A page script handing the same studio a port of its own: without a token, or with a made-up one.
    const forged = (token) =>
      page.evaluate(
        async ({ token }) => {
          const ifr = document.querySelector('iframe[data-test-studio]');
          const ch = new MessageChannel();
          const acked = new Promise((resolve) => {
            ch.port1.onmessage = (e) => e.data?.name === 'gis:connected' && resolve(true);
            setTimeout(() => resolve(false), 4000);
          });
          ifr.contentWindow.postMessage({ type: 'gis:connect', version: 1, ...(token ? { token } : {}) }, '*', [ch.port2]);
          return acked;
        },
        { token },
      );
    expect(await forged(null)).toBe(false);
    expect(await forged('00000000-0000-4000-8000-000000000000')).toBe(false);

    // A page script's own studio frame with a made-up token is never connected either.
    const ownFrame = await page.evaluate(async (src) => {
      const ifr = document.createElement('iframe');
      ifr.src = src;
      document.body.appendChild(ifr);
      await new Promise((r) => (ifr.onload = r));
      const ch = new MessageChannel();
      const acked = new Promise((resolve) => {
        ch.port1.onmessage = (e) => e.data?.name === 'gis:connected' && resolve(true);
        setTimeout(() => resolve(false), 8000);
      });
      ifr.contentWindow.postMessage({ type: 'gis:connect', version: 1, token: 'forged-token' }, new URL(src).origin, [ch.port2]);
      return acked;
    }, studioUrl);
    expect(ownFrame).toBe(false);
    // Tokens are not handed to anything but a grok.com top frame.
    const fromStudioTab = await (await openStudioTab(ctx)).evaluate(() => chrome.runtime.sendMessage({ gis: 'studio-token' }));
    expect(fromStudioTab.ok).toBe(false);
  } finally {
    await ctx.close();
  }
});

test('page payloads are checked before they reach the bin, the library or a fetch', async () => {
  const requested = [];
  const ctx = await launch({ assets: { onAsset: (u) => requested.push(u) } });
  try {
    const studio = await openStudioTab(ctx);
    await ctx.context.route('https://console.x.ai/**', (route) => {
      requested.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'video/mp4', body: 'secret' });
    });
    const res = await studio.evaluate(async () => {
      const { bridge, pageStore, projectStore, appState } = window.__gis;
      const good = { key: 'video:11111111-1111-4111-8111-111111111111', kind: 'video', url: 'https://assets.grok.com/users/test-user-0000/generated/11111111-1111-4111-8111-111111111111/generated_video.mp4', seenAt: 1 };
      const evil = { key: 'video:evil', kind: 'video', url: 'https://console.x.ai/v1/secret-export.mp4', seenAt: 1, pageUrl: 'javascript:alert(1)' };
      bridge.emitter.emit('page.media', { items: [good, evil, null, { key: 'x', kind: 'video', url: 'javascript:alert(1)' }] });
      bridge.emitter.emit('page.navigated', { url: 'https://evil.example/', title: 'x', route: 'admin' });
      const before = Object.keys(projectStore.get().media).length;
      bridge.emitter.emit('page.add', { items: [{ ...evil, key: 'video:evil2', url: 'javascript:alert(1)' }], flag: 'delete-everything', target: 'timeline' });
      let fromPage = null;
      const off = appState.appEvents.on('ingredient.fromPage', ({ item }) => (fromPage = item));
      bridge.emitter.emit('page.ingredient', { item: { key: 'i', kind: 'image', url: 'data:text/html,<script>1</script>' } });
      off();
      await new Promise((r) => setTimeout(r, 500));
      return {
        items: pageStore.get().items.map((i) => i.key),
        info: pageStore.get().info,
        added: Object.keys(projectStore.get().media).length - before,
        fromPage,
      };
    });
    expect(res.items).toEqual(['video:11111111-1111-4111-8111-111111111111']);
    expect(res.info).toMatchObject({ url: 'https://grok.com/', route: 'other' });
    expect(res.added).toBe(0);
    expect(res.fromPage).toBe(null);
    // A link to another site that the user explicitly added on grok.com is never fetched with the extension's
    // privileges (only through the page, which is not connected here).
    const id = await studio.evaluate(async () => {
      const { bridge, projectStore } = window.__gis;
      bridge.emitter.emit('page.add', { items: [{ key: 'url:https://console.x.ai/v1/secret-export.mp4', kind: 'video', url: 'https://console.x.ai/v1/secret-export.mp4', seenAt: 1 }] });
      await new Promise((r) => setTimeout(r, 1500));
      return Object.values(projectStore.get().media).find((m) => m.sourceUrl?.includes('console.x.ai'))?.id;
    });
    expect(id).toBeTruthy();
    expect(requested.filter((u) => u.includes('console.x.ai'))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

// --------------------------------------------------------------------------------------- several studio windows

test('storage cleanup never deletes a file another window can still undo back to', async () => {
  const ctx = await launch();
  try {
    // C imports a local file and closes; B then opens the sequence and removes the file from its bin.
    const c = await openStudioTab(ctx);
    const id = await c.evaluate(async () => {
      const bytes = await (await fetch('https://assets.grok.com/test/clip-green.mp4')).arrayBuffer();
      const [mid] = await window.__gis.media.importFiles([new File([bytes], 'local only.mp4', { type: 'video/mp4' })]);
      return mid;
    });
    await c.waitForFunction((mid) => window.__gis.projectStore.get().media[mid]?.status === 'ready', id, POLL);
    await c.waitForTimeout(800);
    await c.close({ runBeforeUnload: true });
    const b = await openStudioTab(ctx);
    const a = await openStudioTab(ctx);
    await b.waitForFunction((mid) => window.__gis.projectStore.get().media[mid]?.status === 'ready', id, POLL);
    await b.evaluate((mid) => window.__gis.projectStore.update((p) => window.__gis.model.removeMedia(p, [mid]), { label: 'Remove' }), id);
    await a.waitForFunction((mid) => !window.__gis.projectStore.get().media[mid], id, POLL); // B's save reached A
    // Only B's undo history still knows the file: an immediate cleanup in A must keep it.
    await a.evaluate(() => window.__gis.appState.runGarbageCollection({ graceMs: 0 }));
    expect(await a.evaluate((mid) => window.__gis.db.hasBlob(mid), id)).toBe(true);
    // Undo in B brings back a playable item.
    await b.evaluate(() => window.__gis.projectStore.undo());
    expect(await b.evaluate(async (mid) => !!(await window.__gis.media.getMediaBlob(mid)), id)).toBe(true);
    expect(await b.evaluate((mid) => window.__gis.projectStore.get().media[mid].status, id)).toBe('ready');
    // Once no window can bring it back, cleanup does delete what nothing references.
    await b.evaluate((mid) => window.__gis.projectStore.update((p) => window.__gis.model.removeMedia(p, [mid]), { label: 'Remove' }), id);
    await a.waitForFunction((mid) => !window.__gis.projectStore.get().media[mid], id, POLL);
    await b.close({ runBeforeUnload: true });
    await a.waitForFunction(async () => (await navigator.locks.query()).held.filter((l) => l.name.startsWith('gis-window:')).length === 1, null, POLL);
    const after = await a.evaluate(async (mid) => {
      const { appState, db } = window.__gis;
      const res2 = await appState.runGarbageCollection({ graceMs: 0 });
      return { res2, has: await db.hasBlob(mid) };
    }, id);
    expect(after.has).toBe(false);
    expect(after.res2.removed).toBeGreaterThanOrEqual(1);
  } finally {
    await ctx.close();
  }
});

test('storage cleanup waits for every open studio window: one that does not answer stops it', async () => {
  const ctx = await launch();
  try {
    const a = await openStudioTab(ctx);
    // A studio window that is open (holds its window lock) but never answers.
    await a.evaluate(() => {
      navigator.locks.request('gis-window:ghost', () => new Promise(() => {}));
    });
    const err = await a.evaluate(() =>
      window.__gis.appState.runGarbageCollection({ graceMs: 0 }).then(
        () => null,
        (e) => e.message,
      ),
    );
    expect(err).toContain('did not answer');
  } finally {
    await ctx.close();
  }
});

test('a sequence deleted in one window is not re-created by another, which can restore it', async () => {
  const ctx = await launch();
  try {
    // The file comes from a window that is closed by now (its own fresh-write protection is gone with it).
    const c = await openStudioTab(ctx);
    const [mid] = await seedMedia(c, ['clip-red.mp4']);
    const doomed = (await getProject(c)).id;
    await c.waitForTimeout(800);
    await c.close({ runBeforeUnload: true });
    const a = await openStudioTab(ctx);
    const b = await openStudioTab(ctx);
    expect((await getProject(a)).id).toBe(doomed);
    expect((await getProject(b)).id).toBe(doomed);
    await a.evaluate(() => window.__gis.appState.newProject('Somewhere else'));
    await a.evaluate((id) => window.__gis.appState.deleteProject(id), doomed);
    // B leaves the deleted sequence and offers it back.
    await b.waitForFunction((id) => window.__gis.projectStore.get().id !== id, doomed, POLL);
    const toast = b.locator('.toast', { hasText: 'was deleted in another window' });
    await expect(toast).toBeVisible();
    // Editing in B does not bring the deleted sequence back.
    await b.evaluate(() => window.__gis.projectStore.update((p) => window.__gis.model.renameProject(p, 'edited in B')));
    await b.waitForTimeout(1200);
    expect(await b.evaluate((id) => window.__gis.db.getProject(id), doomed)).toBeUndefined();
    // Its files survive an immediate cleanup in A while B can still restore it…
    await a.evaluate(() => window.__gis.appState.runGarbageCollection({ graceMs: 0 }));
    expect(await a.evaluate((id) => window.__gis.db.hasBlob(id), mid)).toBe(true);
    // …and Restore brings it back, playable.
    await toast.locator('.toast-action', { hasText: 'Restore' }).click();
    await b.waitForFunction((id) => window.__gis.projectStore.get().id === id, doomed, POLL);
    expect((await b.evaluate((id) => window.__gis.db.getProject(id), doomed))?.media?.[mid]).toBeTruthy();
    expect(await b.evaluate(async (id) => !!(await window.__gis.media.getMediaBlob(id)), mid)).toBe(true);
    await a.waitForFunction(async (id) => !!(await window.__gis.db.getProject(id)), doomed, POLL);
  } finally {
    await ctx.close();
  }
});

test('settings changed in one window take effect in the others and are not undone by them', async () => {
  const ctx = await launch();
  try {
    const a = await openStudioTab(ctx);
    const b = await openStudioTab(ctx);
    const setUi = (target, patch) => target.evaluate((p) => window.__gis.uiStore.set((s) => ({ ...s, ...p })), patch);
    await setUi(a, { autoCollect: true });
    await b.waitForFunction(() => window.__gis.uiStore.get().autoCollect === true, null, POLL);
    await setUi(b, { autoCollect: false });
    await a.waitForFunction(() => window.__gis.uiStore.get().autoCollect === false, null, POLL);
    // A's own view state (zoom, open tab) is saved without touching what B set.
    await setUi(a, { zoom: 123, tab: 'edit' });
    await a.waitForTimeout(1200);
    const stored = await a.evaluate(async () => (await chrome.storage.local.get('gis:ui'))['gis:ui']);
    expect(stored).toMatchObject({ autoCollect: false, zoom: 123, tab: 'edit' });
    expect(await b.evaluate(() => window.__gis.uiStore.get().tab)).not.toBe('edit'); // view state stays per window
  } finally {
    await ctx.close();
  }
});

test('library changes made right before the grok.com tab closes are saved', async () => {
  const ctx = await launch();
  try {
    let page = await openGrok(ctx.page, '/imagine');
    let frame = await openStudio(page);
    await frame.waitForFunction(() => window.__gis.libraryStore.get().loaded, null, POLL);
    await frame.evaluate(async () => {
      const { addIngredient } = await import(chrome.runtime.getURL('studio/core/ingredients.js'));
      const blob = await (await fetch('https://assets.grok.com/test/still.png')).blob();
      await addIngredient(blob, { name: 'Closing time', origin: 'file' });
      window.__gis.libraryStore.set((s) => ({ ...s, snippets: [...s.snippets, { id: 'sn-close', title: 'Last', text: 'typed last', tags: [] }] }));
    });
    await page.close({ runBeforeUnload: true });
    page = await openGrok(await ctx.context.newPage(), '/imagine');
    frame = await openStudio(page);
    await frame.waitForFunction(() => window.__gis.libraryStore.get().loaded, null, POLL);
    const lib = () =>
      frame.evaluate(() => {
        const l = window.__gis.libraryStore.get();
        return { ingredients: l.ingredients.map((i) => i.name), snippets: l.snippets.map((s) => s.id) };
      });
    // The closed tab's save (or its localStorage journal) may land just after the new studio booted.
    await expect.poll(lib, { timeout: 10000 }).toEqual({ ingredients: ['Closing time'], snippets: ['sn-close'] });
  } finally {
    await ctx.close();
  }
});

test('two studio windows on one grok.com tab import a new generation only once', async () => {
  const ctx = await launch({ grok: { apiPosts: () => mediaPostList(Object.keys(POSTS).filter((id) => id !== GENERATED_POST)) } });
  try {
    await ctx.sw.evaluate(() => chrome.storage.local.set({ 'gis:ui': { autoCollect: true } }));
    const page = await openGrok(ctx.page, '/imagine');
    const frame = await openStudio(page);
    await frame.waitForFunction(() => window.__gis.bridge.connected, null, POLL);
    const tab = await openStudioTab(ctx);
    await tab.waitForFunction(() => window.__gis.bridge.connected && window.__gis.bridge.tabId != null, null, POLL);
    await page.bringToFront();
    await page.locator('.query-bar [contenteditable="true"]').click({ position: { x: 40, y: 12 } });
    await page.keyboard.type('A copper fox running through snow');
    await page.keyboard.press('Enter');
    const key = `video:${GENERATED_POST}`;
    await frame.waitForFunction((k) => Object.values(window.__gis.projectStore.get().media).some((m) => m.pageKey === k && m.status === 'ready'), key, POLL);
    await page.waitForTimeout(4000); // both windows have reacted and saved
    const keysOf = (target) => target.evaluate(() => Object.values(window.__gis.projectStore.get().media).map((m) => m.pageKey));
    expect(await keysOf(frame)).toEqual([key]);
    expect(await keysOf(tab)).toEqual([key]);
    const stored = await tab.evaluate(async () => Object.values((await window.__gis.db.getProject(window.__gis.projectStore.get().id)).media).map((m) => m.pageKey));
    expect(stored).toEqual([key]);
  } finally {
    await ctx.close();
  }
});

test('a failing autosave is reported, shown in the header, and retried until it works', async () => {
  const ctx = await launch();
  try {
    const studio = await openStudioTab(ctx);
    await studio.evaluate(() => {
      const { db } = window.__gis;
      window.__realUpdate = db.updateProject;
      db.updateProject = () => Promise.reject(new Error('QuotaExceededError: disk full'));
    });
    await studio.evaluate(() => window.__gis.projectStore.update((p) => window.__gis.model.renameProject(p, 'Unsaved name')));
    await expect(studio.locator('.toast.toast-error', { hasText: "Couldn't save your changes" })).toBeVisible();
    await expect(studio.locator('.save-issue')).toBeVisible();
    await expect(studio.locator('.save-issue')).toHaveAttribute('title', /disk full/);
    // storage works again: the retry saves, the indicator goes away
    await studio.evaluate(() => (window.__gis.db.updateProject = window.__realUpdate));
    await expect(studio.locator('.toast.toast-success', { hasText: 'All changes saved' })).toBeVisible({ timeout: 15000 });
    await expect(studio.locator('.save-issue')).toHaveCount(0);
    expect((await studio.evaluate((id) => window.__gis.db.getProject(id), (await getProject(studio)).id)).name).toBe('Unsaved name');
  } finally {
    await ctx.close();
  }
});
