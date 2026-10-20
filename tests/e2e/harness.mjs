// E2E harness: launches Chromium (Chrome for Testing) with the unpacked extension, serves mock grok.com pages
// and fake asset hosts through request routing (with grok.com's real CSP plus a test nonce).
import { chromium, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSTS, mediaPostList } from './fixtures-map.mjs';
import { grokMockApi } from './content-mock-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXTENSION_DIR = join(ROOT, 'extension');
export const FIXTURES = join(ROOT, 'tests', 'fixtures');
export const fixture = (...p) => join(FIXTURES, ...p);
export const TEST_NONCE = 'gis-test-nonce';

// grok.com's production CSP (Oct 2026), trimmed of third-party hosts, plus the test nonce.
export const GROK_CSP = [
  "default-src 'self'",
  `script-src 'self' 'nonce-${TEST_NONCE}' 'strict-dynamic' 'wasm-unsafe-eval' https://cdn.grok.com`,
  "worker-src 'self' blob: https://cdn.grok.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https: https://assets.grok.com https://assets.grokusercontent.com",
  "media-src 'self' blob: https://assets.grok.com https://assets.grokusercontent.com https://*.x.ai",
  "frame-src 'self' blob: data: https://assets.grok.com https://assets.grokusercontent.com",
  "object-src 'none'",
  "base-uri 'none'",
  "connect-src 'self' data: https://*.x.ai https://*.grok.com https://assets.grok.com https://assets.grokusercontent.com",
  'upgrade-insecure-requests',
].join('; ');

const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const CORS = { 'access-control-allow-origin': 'https://grok.com', 'access-control-allow-credentials': 'true', 'cache-control': 'no-store' };

function grokPageFor(pathname) {
  if (pathname.startsWith('/imagine/post/')) return 'post.html';
  if (pathname.startsWith('/imagine/favorites') || pathname.startsWith('/imagine/saved')) return 'favorites.html';
  if (pathname.startsWith('/imagine')) return 'imagine.html';
  if (pathname.startsWith('/c/') || pathname === '/') return 'chat.html';
  return 'imagine.html';
}

/** Serves a media fixture file honoring Range requests (video elements use them). */
async function fulfillFile(route, file, extraHeaders = {}) {
  if (!existsSync(file)) return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
  const body = readFileSync(file);
  const type = MIME[extname(file)] || 'application/octet-stream';
  const range = route.request().headers()['range'];
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      return route.fulfill({
        status: 206,
        headers: { ...CORS, ...extraHeaders, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` },
        body: body.subarray(start, end + 1),
      });
    }
  }
  return route.fulfill({ status: 200, headers: { ...CORS, ...extraHeaders, 'content-type': type, 'accept-ranges': 'bytes' }, body });
}

export async function routeAssets(context, { onAsset } = {}) {
  await context.route(/^https:\/\/(assets\.grok\.com|assets\.grokusercontent\.com|imagine-public\.x\.ai)\//, async (route) => {
    const url = new URL(route.request().url());
    onAsset?.(url.href);
    const m = url.pathname.match(/\/generated\/([0-9a-f-]{36})\/([^/]+)$/i);
    if (m) {
      const post = POSTS[m[1]];
      if (!post) return route.fulfill({ status: 404, headers: CORS, body: 'unknown post' });
      const name = m[2];
      if (name.startsWith('generated_video')) return fulfillFile(route, fixture('media', post.file));
      if (name.startsWith('preview_image')) return fulfillFile(route, fixture('media', post.thumb || post.file));
      if (name.startsWith('image')) return fulfillFile(route, fixture('media', post.file));
      return route.fulfill({ status: 404, headers: CORS, body: 'unknown asset' });
    }
    // Generic: https://assets.grok.com/test/<fixture file>
    const t = url.pathname.match(/^\/test\/(.+)$/);
    if (t) return fulfillFile(route, fixture('media', decodeURIComponent(t[1])));
    return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
  });
}

export async function routeGrok(context, { pages = {}, csp = GROK_CSP, apiPosts } = {}) {
  await context.route(/^https:\/\/grok\.com\//, async (route) => {
    const url = new URL(route.request().url());
    const mocked = grokMockApi(url, route.request()); // feed page 2 + streamed chat NDJSON (content mocks)
    if (mocked) return route.fulfill(mocked);
    if (url.pathname.startsWith('/rest/media/post/list')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(apiPosts ? apiPosts() : mediaPostList()) });
    }
    if (url.pathname.startsWith('/rest/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    if (url.pathname.startsWith('/fixtures/')) return fulfillFile(route, fixture('grok', url.pathname.slice('/fixtures/'.length)));
    const page = pages[url.pathname] || grokPageFor(url.pathname);
    const file = fixture('grok', page);
    const body = existsSync(file) ? readFileSync(file, 'utf8') : `<!doctype html><title>Grok</title><main><textarea aria-label="Ask Grok anything"></textarea></main>`;
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }, body });
  });
}

/**
 * Launches a persistent Chromium context with the extension loaded and mock routes installed.
 * Returns {context, extensionId, page, close}.
 */
export async function launch({ headless = !process.env.HEADED, viewport = { width: 1440, height: 900 }, grok = {}, assets = {}, args: extraArgs = [] } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'gis-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    viewport,
    // extraArgs: e.g. Chrome's fake microphone (--use-fake-device-for-media-stream --use-fake-ui-for-media-stream)
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`, '--autoplay-policy=no-user-gesture-required', ...extraArgs],
  });
  await routeAssets(context, assets);
  await routeGrok(context, grok);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const page = context.pages()[0] || (await context.newPage());
  const consoleErrors = [];
  const watch = (p) =>
    p.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`[${p.url().slice(0, 60)}] ${m.text()}`);
    });
  watch(page);
  context.on('page', watch);
  return {
    context,
    extensionId,
    page,
    consoleErrors,
    sw,
    studioUrl: (mode = 'tab') => `chrome-extension://${extensionId}/studio/studio.html?mode=${mode}`,
    async close() {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Navigates to a mock grok.com path and waits for the content script to mount its overlay. */
export async function openGrok(page, path = '/imagine') {
  await page.goto(`https://grok.com${path}`);
  await page.locator('gis-studio-root').waitFor({ state: 'attached', timeout: 15000 });
  return page;
}

/** Opens the embedded studio via the launcher and returns the studio Frame once the app has rendered. */
export async function openStudio(page) {
  const launcher = page.locator('gis-studio-root .launcher');
  if (await launcher.isVisible()) await launcher.click();
  const frame = await studioFrame(page);
  await frame.locator('.app-header').waitFor({ timeout: 20000 });
  return frame;
}

export async function studioFrame(page, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const f = page.frames().find((fr) => fr.url().includes('/studio/studio.html'));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  throw new Error('studio iframe not found');
}

/** Opens the studio as a standalone extension tab. */
export async function openStudioTab(ctx) {
  const page = await ctx.context.newPage();
  await page.goto(ctx.studioUrl('tab'));
  await page.locator('.app-header').waitFor({ timeout: 20000 });
  return page;
}

export { expect };

/**
 * Imports fixture media into the open studio project through the real import pipeline
 * (served from https://assets.grok.com/test/<file>). Works for the embedded frame or the standalone tab.
 * Returns the new media ids once all are 'ready'.
 */
export async function seedMedia(target, files, { timeout = 30000 } = {}) {
  const ids = await target.evaluate(async (names) => {
    const out = [];
    for (const n of names) out.push(await window.__gis.media.importUrl(`https://assets.grok.com/test/${n}`));
    return out;
  }, files);
  await waitForMediaReady(target, ids, timeout);
  return ids;
}

export async function waitForMediaReady(target, ids, timeout = 30000) {
  await target.waitForFunction(
    (wanted) => {
      const p = window.__gis.projectStore.get();
      return wanted.every((id) => p.media[id] && (p.media[id].status === 'ready' || p.media[id].status === 'error'));
    },
    ids,
    { timeout },
  );
  const bad = await target.evaluate((wanted) => wanted.filter((id) => window.__gis.projectStore.get().media[id].status !== 'ready').map((id) => window.__gis.projectStore.get().media[id].error), ids);
  if (bad.length) throw new Error('media failed to import: ' + bad.join('; '));
}

/** Current project snapshot from the studio. */
export const getProject = (target) => target.evaluate(() => window.__gis.projectStore.get());

const DOCK_LABELS = { right: 'Dock right', bottom: 'Dock bottom', float: 'Floating window', max: 'Full window' };
/** Switches the embedded studio's dock mode through its header (individual buttons when wide, the layout menu when narrow). */
export async function setDockMode(frame, mode) {
  const label = DOCK_LABELS[mode];
  const full = frame.locator(`.dock-full [title^="${label}"]`);
  if (await full.isVisible()) return full.click();
  await frame.locator('.dock-compact [title="Panel layout"]').click();
  await frame.locator('.menu .menu-item', { hasText: label }).click();
}
