// Service worker: toolbar action, keyboard command, context menus, opening the standalone studio tab, and the tokens
// that let an embedded studio frame tell the content script's handshake from one forged by a grok.com page script.

const GROK_RE = /^https:\/\/grok\.com\//;
const STUDIO_TAB_URL = chrome.runtime.getURL('studio/studio.html?mode=tab');
const STUDIO_PAGE = chrome.runtime.getURL('studio/studio.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    return undefined; // no live content script (tab opened before install, extension updated, or not grok.com)
  }
}

async function openStudioTab() {
  const [existing] = await chrome.tabs.query({ url: chrome.runtime.getURL('studio/studio.html*') });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  return chrome.tabs.create({ url: STUDIO_TAB_URL });
}

/** Toggles the studio in a grok.com tab; resolves false when no content script answered within `tries`. */
async function toggleInTab(tabId, tries = 1, interval = 100) {
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(interval);
    if ((await sendToTab(tabId, { gis: 'toggle' })) !== undefined) return true;
  }
  return false;
}

/**
 * Starts the content scripts in a grok.com tab that has none running (it predates the install, or the extension was
 * updated and the old copy retired itself) — in place, so nothing the user was doing on the page is lost.
 */
async function startContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // A retired copy from before an update may still sit in this isolated world and block loader.js.
        try {
          window.__gisContent?.destroy?.();
        } catch {
          /* already gone */
        }
        window.__gisContent = undefined;
        window.__gisLoaded = false;
      },
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page-hook.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/loader.js'] });
    return true;
  } catch (e) {
    console.warn('[gis] could not start the content script', e);
    return false;
  }
}

/** Last resort: reloading the tab is the user's call (it would drop an unsent prompt). */
async function offerReload(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.confirm('Imagine Studio needs to reload this grok.com tab to start.\n\nAnything not sent yet (a prompt you are typing) will be lost. Reload now?'),
    });
    if (res?.result) await chrome.tabs.reload(tabId);
  } catch {
    await openStudioTab(); // not even a prompt can be shown there: the studio in its own tab still works
  }
}

/** Toolbar button / Alt+Shift+S. */
async function onActionClicked(tab) {
  if (tab?.id != null && GROK_RE.test(tab.url || '')) {
    // A content script that is still starting gets a moment to register before it is treated as missing.
    if (await toggleInTab(tab.id, 3, 150)) return;
    if ((await startContentScript(tab.id)) && (await toggleInTab(tab.id, 40, 100))) return;
    await offerReload(tab.id);
    return;
  }
  await openStudioTab();
}

chrome.action.onClicked.addListener((tab) => {
  onActionClicked(tab).catch((e) => console.warn('[gis] toolbar action failed', e));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const grokOnly = ['https://grok.com/*'];
    chrome.contextMenus.create({ id: 'gis-add-media', title: 'Add to Imagine Studio bin', contexts: ['video', 'image'], documentUrlPatterns: grokOnly });
    chrome.contextMenus.create({ id: 'gis-add-timeline', title: 'Add to Imagine Studio timeline', contexts: ['video', 'image'], documentUrlPatterns: grokOnly });
    chrome.contextMenus.create({ id: 'gis-add-ingredient', title: 'Save image as Studio ingredient', contexts: ['image'], documentUrlPatterns: grokOnly });
    chrome.contextMenus.create({ id: 'gis-import-text', title: 'Send selected text to Studio prompt list', contexts: ['selection'], documentUrlPatterns: grokOnly });
    chrome.contextMenus.create({ id: 'gis-open-tab', title: 'Open Imagine Studio in a tab', contexts: ['action'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'gis-open-tab') {
    await openStudioTab();
    return;
  }
  if (tab?.id == null) return;
  await sendToTab(tab.id, {
    gis: 'context',
    action: info.menuItemId,
    srcUrl: info.srcUrl || null,
    mediaType: info.mediaType || null,
    selectionText: info.selectionText || null,
    pageUrl: info.pageUrl || null,
  });
});

// ---------------------------------------------------------------------------------------------------------
// Studio frame tokens (see HANDSHAKE in shared/protocol.js)
// ---------------------------------------------------------------------------------------------------------
// The content script asks for a token ({gis: 'studio-token'}) before it hands its MessagePort to the studio iframe
// and sends the token along; the studio frame checks it ({gis: 'studio-token-check', token}) before it trusts the
// port. Page scripts cannot send runtime messages, so they can neither obtain a token nor confirm a forged one.
// Tokens are bound to the tab and kept in chrome.storage.session (survives service-worker restarts, never written to
// disk, not readable by content scripts).

const TOKENS_KEY = 'gis:frameTokens'; // {[tabId]: [{token, at}]}
const TOKEN_TTL_MS = 24 * 3600 * 1000;
const TOKENS_PER_TAB = 4;
let tokenOps = Promise.resolve();
const serially = (fn) => (tokenOps = tokenOps.then(fn, fn)); // read-modify-write of the token table, one at a time

async function readTokens() {
  return (await chrome.storage.session.get(TOKENS_KEY))?.[TOKENS_KEY] || {};
}

function issueToken(sender) {
  return serially(async () => {
    if (sender.tab?.id == null || sender.frameId !== 0 || !GROK_RE.test(sender.url || '')) throw new Error('Tokens are for the grok.com page only');
    const token = crypto.randomUUID();
    const all = await readTokens();
    const now = Date.now();
    const kept = (all[sender.tab.id] || []).filter((t) => now - t.at < TOKEN_TTL_MS).slice(1 - TOKENS_PER_TAB);
    all[sender.tab.id] = [...kept, { token, at: now }];
    await chrome.storage.session.set({ [TOKENS_KEY]: all });
    return token;
  });
}

async function checkToken(sender, token) {
  if (typeof token !== 'string' || !token || sender.tab?.id == null || !(sender.url || '').startsWith(STUDIO_PAGE)) return false;
  await tokenOps.catch(() => {});
  const list = (await readTokens())[sender.tab.id] || [];
  return list.some((t) => t.token === token && Date.now() - t.at < TOKEN_TTL_MS);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  serially(async () => {
    const all = await readTokens();
    if (!all[tabId]) return;
    delete all[tabId];
    await chrome.storage.session.set({ [TOKENS_KEY]: all });
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || sender.id !== chrome.runtime.id) return false;
  if (msg.gis === 'open-tab') {
    openStudioTab().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.gis === 'studio-token') {
    issueToken(sender).then((token) => sendResponse({ ok: true, token }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.gis === 'studio-token-check') {
    checkToken(sender, msg.token).then((ok) => sendResponse({ ok }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

// Debug / test hook (DevTools of the service worker, E2E suite).
globalThis.__gisBackground = { onActionClicked, startContentScript };
