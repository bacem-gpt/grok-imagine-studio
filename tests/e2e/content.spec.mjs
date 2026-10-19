// grok.com integration (extension/content/**) against the mock Grok pages in tests/fixtures/grok/:
// detection (DOM + network), hover toolbar, composer, chat helpers, context menus, standalone studio tab,
// dock persistence, SPA navigation, load-more / reveal, auto-collect, and "grok.com keeps working".
import { test } from '@playwright/test';
import { launch, openGrok, studioFrame, openStudioTab, expect } from './harness.mjs';
import { POSTS, mediaPostList, videoUrl, imageUrl, thumbUrl } from './fixtures-map.mjs';
import { GENERATED_POST, PAGE2_POSTS } from './content-mock-api.mjs';

const ID = Object.keys(POSTS);
const [RED, GREEN, BLUE, HD, IMAGE, VERTICAL] = ID;
const WITHOUT_GENERATED = () => mediaPostList(ID.filter((id) => id !== GENERATED_POST));
const POLL = { polling: 200, timeout: 30000 }; // interval polling: rAF never fires in a hidden iframe

/** The embedded studio frame once its bridge is connected (optionally opening the panel first). */
async function studio(page, { open = false } = {}) {
  if (open) await page.locator('gis-studio-root .launcher').click();
  const frame = await studioFrame(page, 30000);
  await frame.waitForFunction(() => window.__gis?.bridge?.connected && !!window.__gis.projectStore.get(), null, POLL);
  return frame;
}

const request = (target, type, payload = {}) => target.evaluate(([t, p]) => window.__gis.bridge.request(t, p, { timeout: 30000 }), [type, payload]);
const pageItems = (target) => target.evaluate(() => window.__gis.pageStore.get().items);
const binMedia = (target) => target.evaluate(() => Object.values(window.__gis.projectStore.get().media));

async function waitMediaReady(target, key) {
  await target.waitForFunction((k) => Object.values(window.__gis.projectStore.get().media).some((m) => m.pageKey === k && m.status === 'ready'), key, POLL);
}

/** Records studio-side bridge events and app events into window.__seen (inside the studio). */
async function recordEvents(frame) {
  await frame.evaluate(() => {
    window.__seen = [];
    for (const n of ['composer.submitted', 'page.navigated', 'page.media', 'ui.visibility']) window.__gis.bridge.on(n, (p) => window.__seen.push({ n, p }));
    for (const n of ['ingredient.fromPage', 'prompts.importText']) window.__gis.appState.appEvents.on(n, (p) => window.__seen.push({ n, p }));
  });
}
const seen = (frame, name) => frame.evaluate((n) => window.__seen.filter((e) => e.n === n).map((e) => e.p), name);

async function hoverOver(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await expect(page.locator('gis-studio-root .hb.show')).toBeVisible();
}

const shadowBtn = (page, act) => page.locator(`gis-studio-root .hb.show button[data-act="${act}"]`);
const card = (page, id, sel = 'video') => page.locator(`[data-post-id="${id}"] ${sel}`);

function watchPageErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('detects media from the DOM and Grok API responses, with prompts; skips avatars and moderated images', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    const errors = watchPageErrors(page);
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    // Launcher badge = videos not in the bin (5 API videos + 1 DOM-only clip), before the studio ever opened.
    await expect(page.locator('gis-studio-root .badge')).toHaveText('6');
    const frame = await studio(page, { open: true });
    await frame.waitForFunction(() => window.__gis.pageStore.get().items.length === 7, null, POLL);
    const items = await pageItems(frame);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    for (const id of [RED, GREEN, BLUE, HD, VERTICAL]) {
      const it = byKey[`video:${id}`];
      expect(it, id).toBeTruthy();
      expect(it).toMatchObject({ kind: 'video', url: videoUrl(id), thumbUrl: thumbUrl(id), postId: id, prompt: POSTS[id].prompt, model: 'imagine-video-1.5', source: 'both', pageUrl: `https://grok.com/imagine/post/${id}` });
      expect(it.createdAt).toBe('2026-10-18T12:00:00.000Z');
      // Already on the page when it loaded: not new, dated before the session (auto-collect never takes it).
      expect(it.fresh).toBe(false);
      expect(it.seenAt).toBeLessThan(Date.now() - 29 * 24 * 3600 * 1000);
      expect(it.aliases).toContain(`url:${videoUrl(id)}`);
    }
    expect(byKey[`video:${HD}`]).toMatchObject({ width: 1280, height: 720 });
    expect(byKey[`image:${IMAGE}`]).toMatchObject({ kind: 'image', url: imageUrl(IMAGE), prompt: POSTS[IMAGE].prompt, width: 1024, height: 1024, source: 'both' });
    // DOM-only clip (no API record): prompt from the card caption.
    expect(byKey['url:https://assets.grok.com/test/clip-cyan.webm']).toMatchObject({ kind: 'video', source: 'dom', prompt: 'Cyan light waves rolling over a glass floor, loop' });
    // Avatar (alt="pfp") and moderated image are not media.
    expect(items.some((i) => /thumb-red|still\.png/.test(i.url))).toBe(false);
    // Newest first = top of the feed first.
    expect(items[0].key).toBe(`video:${RED}`);
    const scan = await request(frame, 'page.scan');
    expect(scan.items.map((i) => i.key).sort()).toEqual(items.map((i) => i.key).sort());
    const info = await request(frame, 'page.info');
    expect(info).toMatchObject({ url: 'https://grok.com/imagine', route: 'imagine', composerFound: true });
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('hover toolbar: + Bin lands the clip in the studio before it was ever opened, then shows "In bin"', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    const errors = watchPageErrors(page);
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    expect(page.frames().some((f) => f.url().includes('/studio/studio.html'))).toBe(false);
    const red = card(page, RED);
    await hoverOver(page, red);
    await expect(page.locator('gis-studio-root .hb.show button')).toHaveCount(3); // Bin, Pick, Timeline (videos)
    await shadowBtn(page, 'bin').click();
    // The studio iframe is created hidden; a toast offers to open it.
    const toast = page.locator('gis-studio-root .toast', { hasText: 'Added to the Studio bin' });
    await expect(toast).toBeVisible();
    await expect(page.locator('gis-studio-root .panel')).toBeHidden();
    const frame = await studio(page);
    await waitMediaReady(frame, `video:${RED}`);
    const media = (await binMedia(frame)).find((m) => m.pageKey === `video:${RED}`);
    expect(media).toMatchObject({ kind: 'video', origin: 'grok', postId: RED, prompt: POSTS[RED].prompt, width: 640, height: 360 });
    // The page marks it and the badge counts one video less.
    await expect(page.locator('gis-studio-root .badge')).toHaveText('5');
    await expect(page.locator(`[data-post-id="${RED}"] video[data-gis-in-bin]`)).toHaveCount(1);
    await page.mouse.move(5, 300);
    await expect(page.locator('gis-studio-root .hb.show')).toHaveCount(0);
    await hoverOver(page, red);
    await expect(shadowBtn(page, 'bin')).toHaveClass(/in-bin/);
    await expect(shadowBtn(page, 'bin')).toContainText('In bin');

    // Pick and Timeline on other clips, Ingredient on the image post.
    await recordEvents(frame);
    await hoverOver(page, card(page, GREEN));
    await shadowBtn(page, 'pick').click();
    await hoverOver(page, card(page, BLUE));
    await shadowBtn(page, 'timeline').click();
    await waitMediaReady(frame, `video:${GREEN}`);
    await waitMediaReady(frame, `video:${BLUE}`);
    const p = await frame.evaluate(() => window.__gis.projectStore.get());
    const green = Object.values(p.media).find((m) => m.pageKey === `video:${GREEN}`);
    const blue = Object.values(p.media).find((m) => m.pageKey === `video:${BLUE}`);
    expect(green.flag).toBe('pick');
    expect(p.tracks.video.map((c) => c.mediaId)).toContain(blue.id);
    await hoverOver(page, card(page, IMAGE, 'img'));
    await expect(page.locator('gis-studio-root .hb.show button')).toHaveCount(4);
    await shadowBtn(page, 'ingredient').click();
    await frame.waitForFunction(() => window.__seen.some((e) => e.n === 'ingredient.fromPage'), null, POLL);
    const [ing] = await seen(frame, 'ingredient.fromPage');
    expect(ing.item).toMatchObject({ key: `image:${IMAGE}`, kind: 'image', url: imageUrl(IMAGE) });

    // The toast's Open action opens the panel.
    await hoverOver(page, card(page, HD));
    await shadowBtn(page, 'bin').click();
    await page.locator('gis-studio-root .toast .act').last().click();
    await expect(page.locator('gis-studio-root .panel')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('a clip already in the bin under an older key is shown as in the bin and reused, never imported twice', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const frame = await studio(page, { open: true });
    // A bin item from an older session, keyed by its URL (before Grok's API had named the post).
    const oldKey = `url:${videoUrl(GREEN)}`;
    await frame.evaluate(
      ([key, url]) => window.__gis.media.importPageItems([{ key, kind: 'video', url, altUrls: [], thumbUrl: null, postId: null, prompt: 'old session', pageUrl: 'https://grok.com/imagine' }]),
      [oldKey, videoUrl(GREEN)],
    );
    await waitMediaReady(frame, oldKey);
    await expect(page.locator(`[data-post-id="${GREEN}"] video[data-gis-in-bin]`)).toHaveCount(1);
    await page.locator('gis-studio-root .launcher').waitFor({ state: 'hidden' });
    await frame.evaluate(() => window.__gis.bridge.request('ui.setDock', { mode: 'right', size: 480 }));
    await hoverOver(page, card(page, GREEN));
    await expect(shadowBtn(page, 'bin')).toHaveClass(/in-bin/);
    await shadowBtn(page, 'timeline').click();
    await frame.waitForFunction(() => window.__gis.projectStore.get().tracks.video.length === 1, null, POLL);
    const p = await frame.evaluate(() => window.__gis.projectStore.get());
    expect(p.mediaOrder.length).toBe(1); // reused, not a second copy
    expect(p.tracks.video[0].mediaId).toBe(p.mediaOrder[0]);
  } finally {
    await ctx.close();
  }
});

test('hover toolbar never blocks the page: clicks outside its buttons reach grok.com', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const red = card(page, RED);
    await hoverOver(page, red);
    const box = await red.boundingBox();
    // Click the lower half of the card (the toolbar sits at the top-left): Grok's SPA link navigates.
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.8);
    await expect(page).toHaveURL(new RegExp(`/imagine/post/${RED}$`));
    await expect(page.locator('main > article video#hd-video')).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test('composer: insert / append / read in the contenteditable, the strict (paste-only) editor and textareas', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await studio(page, { open: true });
    const editor = page.locator('.query-bar [contenteditable="true"]');
    let res = await request(frame, 'composer.insert', { text: 'A neon koi fish', mode: 'replace' });
    expect(res).toMatchObject({ ok: true });
    await expect(editor).toHaveText('A neon koi fish');
    await expect(page.locator('.query-bar button[type="submit"]')).toBeEnabled(); // the page saw the input
    res = await request(frame, 'composer.insert', { text: 'swimming through clouds', mode: 'append' });
    expect(res.ok).toBe(true);
    await expect(editor).toHaveText('A neon koi fish swimming through clouds');
    expect(await request(frame, 'composer.read')).toEqual({ text: 'A neon koi fish swimming through clouds', found: true });
    res = await request(frame, 'composer.insert', { text: 'Replaced prompt', mode: 'replace' });
    await expect(editor).toHaveText('Replaced prompt');

    // An editor that ignores execCommand text insertion (only handles paste) still gets the text.
    await page.goto('https://grok.com/imagine?strict=1');
    const frame2 = await studio(page, { open: true });
    res = await request(frame2, 'composer.insert', { text: 'Pasted prompt text', mode: 'replace' });
    expect(res).toMatchObject({ ok: true, method: 'paste' });
    await expect(page.locator('.query-bar [contenteditable="true"]')).toHaveText('Pasted prompt text');
    expect(await page.evaluate(() => window.__mock.log.some((l) => l.startsWith('reverted-')))).toBe(true);
    res = await request(frame2, 'composer.insert', { text: 'with rain', mode: 'append' });
    expect(res).toMatchObject({ ok: true, method: 'paste' });
    await expect(page.locator('.query-bar [contenteditable="true"]')).toHaveText('Pasted prompt text with rain');

    // Post page: the "Make a video" textarea is preferred over any other box.
    await page.goto(`https://grok.com/imagine/post/${RED}`);
    const frame3 = await studio(page, { open: true });
    res = await request(frame3, 'composer.insert', { text: 'camera slowly orbits the car', mode: 'replace' });
    expect(res.ok).toBe(true);
    await expect(page.locator('textarea[aria-label="Make a video"]')).toHaveValue('camera slowly orbits the car');
    await expect(page.locator('button[aria-label="Make video"]')).toBeEnabled();
    res = await request(frame3, 'composer.insert', { text: 'at dusk', mode: 'append' });
    await expect(page.locator('textarea[aria-label="Make a video"]')).toHaveValue('camera slowly orbits the car at dusk');
    const submitted = await request(frame3, 'composer.submit');
    expect(submitted).toMatchObject({ ok: true, method: 'button' });
    expect(await page.evaluate(() => window.__mock.log)).toContain('make-video:camera slowly orbits the car at dusk');

    // Chat: textarea[aria-label="Ask Grok anything"].
    await page.goto('https://grok.com/c/mock-chat');
    const frame4 = await studio(page, { open: true });
    res = await request(frame4, 'composer.insert', { text: 'Write 5 prompts', mode: 'replace' });
    expect(res.ok).toBe(true);
    await expect(page.locator('textarea[aria-label="Ask Grok anything"]')).toHaveValue('Write 5 prompts');
    expect((await request(frame4, 'page.info')).route).toBe('chat');
  } finally {
    await ctx.close();
  }
});

test('composer: attach an image, submit, Grok generates, the new clip is detected with its prompt', async () => {
  const ctx = await launch({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    const page = ctx.page;
    const errors = watchPageErrors(page);
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(7);
    const frame = await studio(page, { open: true });
    await recordEvents(frame);
    const attach = await frame.evaluate(async () => {
      const bytes = await (await fetch('https://assets.grok.com/test/still.png')).blob();
      const file = new File([bytes], 'reference.png', { type: 'image/png' });
      const res = await window.__gis.bridge.request('composer.attach', { blob: file, name: 'reference.png' });
      return { res, size: bytes.size };
    });
    expect(attach.res).toEqual({ ok: true, method: 'input', confirmed: true }); // the preview appeared
    const attached = await page.evaluate(() => window.__mock.attached);
    expect(attached).toEqual([{ name: 'reference.png', size: attach.size, type: 'image/png', method: 'input' }]);
    await expect(page.locator('.query-bar .att img')).toHaveCount(1);
    // An attachment preview (blob: image inside the composer) is never detected as page media.

    const prompt = 'A paper boat sailing down a rainy neon street';
    const res = await request(frame, 'composer.insert', { text: prompt, mode: 'replace', submit: true });
    expect(res).toMatchObject({ ok: true, submitted: true });
    await expect.poll(() => page.evaluate(() => window.__mock.submitted)).toEqual([prompt]);
    await frame.waitForFunction((t) => window.__seen.some((e) => e.n === 'composer.submitted' && e.p.text === t), prompt, POLL);
    // Mock generation: placeholder card, then the finished clip (streamed NDJSON with a relative video URL).
    await expect.poll(() => page.evaluate(() => window.__mock.generated), { timeout: 15000 }).toEqual([GENERATED_POST]);
    // The streamed record usually arrives before the card renders: wait for both to be merged.
    await frame.waitForFunction((id) => window.__gis.pageStore.get().items.some((i) => i.key === `video:${id}` && i.source === 'both'), GENERATED_POST, POLL);
    const gen = (await pageItems(frame)).find((i) => i.key === `video:${GENERATED_POST}`);
    expect(gen).toMatchObject({ url: videoUrl(GENERATED_POST), prompt, source: 'both', model: 'imagine-video-1.5', fresh: true });
    expect((await pageItems(frame))[0].key).toBe(`video:${GENERATED_POST}`); // newest first
    expect((await pageItems(frame)).some((i) => i.url?.startsWith('blob:'))).toBe(false);

    // A prompt typed and submitted by the user on grok.com is reported too (click left of the docked panel).
    await page.locator('.query-bar [contenteditable="true"]').click({ position: { x: 40, y: 12 } });
    await page.keyboard.type('typed by hand');
    await page.keyboard.press('Enter');
    await frame.waitForFunction(() => window.__seen.some((e) => e.n === 'composer.submitted' && e.p.text === 'typed by hand'), null, POLL);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('composer fallbacks: attach by paste, then by drop; submit with Enter when there is no submit button', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    const errors = watchPageErrors(page);
    const attach = (frame) =>
      frame.evaluate(async () => {
        const bytes = await (await fetch('https://assets.grok.com/test/still.png')).blob();
        return window.__gis.bridge.request('composer.attach', { blob: new File([bytes], 'ref.png', { type: 'image/png' }), name: 'ref.png' });
      });
    // No file input near the composer: the image is pasted into the editor.
    await openGrok(page, '/imagine?noinput');
    let frame = await studio(page, { open: true });
    expect(await attach(frame)).toEqual({ ok: true, method: 'paste', confirmed: true });
    expect((await page.evaluate(() => window.__mock.attached)).map((a) => [a.name, a.type, a.method])).toEqual([['ref.png', 'image/png', 'paste']]);
    // ...and an editor that ignores pasted files gets it dropped on the composer.
    await openGrok(page, '/imagine?noinput&nopaste');
    frame = await studio(page, { open: true });
    expect(await attach(frame)).toEqual({ ok: true, method: 'drop', confirmed: true });
    expect((await page.evaluate(() => window.__mock.attached)).map((a) => a.method)).toEqual(['drop']);
    // No submit button: Enter key events submit (and the submission is still reported).
    await openGrok(page, '/imagine?nosubmitbtn');
    frame = await studio(page, { open: true });
    await recordEvents(frame);
    const res = await request(frame, 'composer.insert', { text: 'A lantern floating up into the stars', mode: 'replace', submit: true });
    expect(res).toMatchObject({ ok: true, submitted: true });
    expect(await page.evaluate(() => window.__mock.submitted)).toEqual(['A lantern floating up into the stars']);
    expect(await request(frame, 'composer.submit')).toMatchObject({ ok: false, error: 'Nothing to submit' });
    await frame.waitForFunction(() => window.__seen.some((e) => e.n === 'composer.submitted'), null, POLL);
    const [sub] = await seen(frame, 'composer.submitted');
    expect(sub.text).toBe('A lantern floating up into the stars');
    expect(Math.abs(sub.at - Date.now())).toBeLessThan(30000); // submission time travels with the event
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('chat: latest reply text with the numbered prompts, page selection, streamed video with a page blob: URL', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    const errors = watchPageErrors(page);
    await openGrok(page, '/c/mock-chat');
    const frame = await studio(page, { open: true });
    const { text } = await request(frame, 'page.lastReply');
    expect(text).toBe(
      [
        'Here is the hero car, and four shots for the chase:',
        '',
        '1. Opening drift: a red sports car drifts around a neon-lit corner in the rain, low tracking shot',
        '2. Rooftop pursuit: police drones chase the car across wet rooftops, aerial dolly',
        '3. Tunnel burst: the car bursts out of a tunnel into a storm of neon signs, slow motion',
        '4. Final stop: the car skids to a halt at the edge of a glowing harbor, wide shot at dawn',
        '',
        'Want variations in a different style?',
      ].join('\n'),
    );
    // The generated image in the chat gets the user's request as prompt (no API record for it).
    await frame.waitForFunction((id) => window.__gis.pageStore.get().items.some((i) => i.key === `image:${id}`), IMAGE, POLL);
    const img = (await pageItems(frame)).find((i) => i.key === `image:${IMAGE}`);
    expect(img.prompt).toBe('Make an image of the hero car and give me 4 prompt ideas for a neon city chase');

    // Selection (page text and textarea selections).
    await page.evaluate(() => {
      const li = document.querySelectorAll('.response-content-markdown li')[1];
      const r = document.createRange();
      r.selectNodeContents(li);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    expect(await request(frame, 'page.selection')).toEqual({ text: 'Rooftop pursuit: police drones chase the car across wet rooftops, aerial dolly' });

    // Send a chat message: the streamed NDJSON reply carries a video; the page plays it from a blob: URL.
    const msg = 'Animate the hero car drifting at night';
    expect((await request(frame, 'composer.insert', { text: msg, mode: 'replace', submit: true })).submitted).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__mock.generated), { timeout: 15000 }).toEqual([GENERATED_POST]);
    await frame.waitForFunction((id) => window.__gis.pageStore.get().items.some((i) => i.key === `video:${id}` && i.source === 'both'), GENERATED_POST, POLL);
    const vid = (await pageItems(frame)).find((i) => i.key === `video:${GENERATED_POST}`);
    expect(vid.prompt).toBe(msg);
    expect(vid.url).toBe(videoUrl(GENERATED_POST));
    const blobUrl = await page.evaluate(() => document.querySelector('.chat video').src);
    expect(blobUrl).toMatch(/^blob:https:\/\/grok\.com\//);
    expect(vid.altUrls).toContain(blobUrl);
    const fetched = await frame.evaluate(async (u) => {
      const { blob } = await window.__gis.bridge.request('page.fetchMedia', { url: u });
      return { size: blob.size, type: blob.type };
    }, blobUrl);
    const expected = await page.evaluate(async () => (await (await fetch('https://assets.grok.com/test/clip-vertical.mp4')).blob()).size);
    expect(fetched).toEqual({ size: expected, type: 'video/mp4' });
    // The latest reply is now the streamed one.
    expect((await request(frame, 'page.lastReply')).text).toContain(`Here is your video: ${msg.slice(0, 40)}`);
    // Other chat markups (explicit role attributes instead of Grok's response rows) work too.
    await page.evaluate(() => {
      for (const row of document.querySelectorAll('.chat [id^="response-"]')) {
        row.setAttribute('data-message-author-role', row.classList.contains('items-end') ? 'user' : 'assistant');
        row.removeAttribute('id');
        row.className = '';
      }
      const last = document.querySelector('.chat [data-message-author-role="user"]');
      last.parentElement.append(last); // a user message is now the last row
    });
    expect((await request(frame, 'page.lastReply')).text).toContain(`Here is your video: ${msg.slice(0, 40)}`);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('context menu: add to bin / timeline, save image as ingredient, send selection to the prompt list', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const send = (msg) =>
      ctx.sw.evaluate(async (m) => {
        const [tab] = await chrome.tabs.query({ url: 'https://grok.com/*' });
        return chrome.tabs.sendMessage(tab.id, { gis: 'context', ...m });
      }, msg);
    expect(await send({ action: 'gis-add-media', srcUrl: videoUrl(GREEN), mediaType: 'video' })).toEqual({ ok: true });
    await expect(page.locator('gis-studio-root .toast', { hasText: 'Added to the Studio bin' })).toBeVisible();
    const frame = await studio(page);
    await waitMediaReady(frame, `video:${GREEN}`);
    await recordEvents(frame);
    // A right-click on a video poster/thumbnail resolves to the video.
    await send({ action: 'gis-add-timeline', srcUrl: thumbUrl(BLUE), mediaType: 'image' });
    await waitMediaReady(frame, `video:${BLUE}`);
    const p = await frame.evaluate(() => window.__gis.projectStore.get());
    const blue = Object.values(p.media).find((m) => m.pageKey === `video:${BLUE}`);
    expect(blue.prompt).toBe(POSTS[BLUE].prompt);
    expect(p.tracks.video.some((c) => c.mediaId === blue.id)).toBe(true);
    await send({ action: 'gis-add-ingredient', srcUrl: imageUrl(IMAGE), mediaType: 'image' });
    await frame.waitForFunction(() => window.__seen.some((e) => e.n === 'ingredient.fromPage'), null, POLL);
    expect((await seen(frame, 'ingredient.fromPage'))[0].item).toMatchObject({ key: `image:${IMAGE}`, kind: 'image', prompt: POSTS[IMAGE].prompt });
    // Selection text: the live selection keeps line breaks (Chrome's selectionText does not).
    await send({ action: 'gis-import-text', selectionText: '1. A 2. B' });
    await frame.waitForFunction(() => window.__seen.some((e) => e.n === 'prompts.importText'), null, POLL);
    expect((await seen(frame, 'prompts.importText'))[0].text).toBe('1. A 2. B');
    await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector('.tabs'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await send({ action: 'gis-import-text', selectionText: 'For you Favorites' });
    await frame.waitForFunction(() => window.__seen.filter((e) => e.n === 'prompts.importText').length === 2, null, POLL);
    expect((await seen(frame, 'prompts.importText'))[1].text).toMatch(/For you\s*Favorites/);
  } finally {
    await ctx.close();
  }
});

test('standalone studio tab talks to the grok.com tab (requests, blobs over runtime, hover actions)', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const tab = await openStudioTab(ctx);
    await tab.waitForFunction(() => window.__gis.bridge.connected && window.__gis.bridge.tabId != null, null, POLL);
    const info = await request(tab, 'page.info');
    expect(info).toMatchObject({ url: 'https://grok.com/imagine', route: 'imagine', composerFound: true });
    const scan = await request(tab, 'page.scan');
    expect(scan.items).toHaveLength(7);
    const blob = await tab.evaluate(async (u) => {
      const { blob } = await window.__gis.bridge.request('page.fetchMedia', { url: u });
      return { size: blob.size, type: blob.type, isBlob: blob instanceof Blob };
    }, imageUrl(IMAGE));
    expect(blob.isBlob).toBe(true);
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBeGreaterThan(10000);
    // A hover action is delivered to the studio tab (no hidden iframe is created on grok.com).
    await page.bringToFront();
    await hoverOver(page, card(page, RED));
    await shadowBtn(page, 'bin').click();
    await expect(page.locator('gis-studio-root .toast', { hasText: 'Added to the Studio bin' })).toBeVisible();
    await waitMediaReady(tab, `video:${RED}`);
    expect(page.frames().some((f) => f.url().includes('/studio/studio.html'))).toBe(false);
  } finally {
    await ctx.close();
  }
});

test('dock mode persists across reloads; UI toast and close requests', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    let frame = await studio(page, { open: true });
    expect(await request(frame, 'ui.setDock', { mode: 'bottom', size: 420 })).toEqual({ mode: 'bottom', size: 420 });
    await expect(page.locator('gis-studio-root .panel.bottom')).toBeVisible();
    expect(await request(frame, 'ui.toast', { message: 'Hello from the studio', kind: 'success' })).toEqual({ ok: true });
    await expect(page.locator('gis-studio-root .toast.success', { hasText: 'Hello from the studio' })).toBeVisible();
    await page.reload();
    await page.locator('gis-studio-root').waitFor({ state: 'attached' });
    await expect(page.locator('gis-studio-root .panel')).toBeHidden(); // never auto-opens
    frame = await studio(page, { open: true });
    await expect(page.locator('gis-studio-root .panel.bottom')).toBeVisible();
    expect(await request(frame, 'ui.getDock')).toEqual({ mode: 'bottom', size: 420, open: true });
    expect(await request(frame, 'ui.close')).toEqual({ ok: true });
    await expect(page.locator('gis-studio-root .panel')).toBeHidden();
    await expect(page.locator('gis-studio-root .launcher')).toBeVisible();

    // Floating window: it opens clear of Grok's composer (top right here); drag it by its bar; the spot the user
    // chose survives a reload (it is not moved off the composer again).
    await page.locator('gis-studio-root .launcher').click();
    expect(await request(frame, 'ui.setDock', { mode: 'float', size: 640 })).toEqual({ mode: 'float', size: 640 });
    const panel = page.locator('gis-studio-root .panel.float');
    await expect(panel).toBeVisible();
    const before = await panel.boundingBox();
    expect(Math.round(before.width)).toBe(640);
    expect(before.y + before.height).toBeLessThan((await page.locator('.query-bar').boundingBox()).y);
    const bar = page.locator('gis-studio-root .float-bar');
    const bb = await bar.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width / 2 - 300, bb.y + bb.height / 2 + 200, { steps: 6 });
    await page.mouse.up();
    const after = await panel.boundingBox();
    expect(Math.round(before.x - after.x)).toBe(300);
    expect(Math.round(after.y - before.y)).toBe(200);
    await page.reload();
    await page.locator('gis-studio-root').waitFor({ state: 'attached' });
    await studio(page, { open: true });
    const restored = await page.locator('gis-studio-root .panel.float').boundingBox();
    expect([Math.round(restored.x), Math.round(restored.y), Math.round(restored.width)]).toEqual([Math.round(after.x), Math.round(after.y), 640]);
  } finally {
    await ctx.close();
  }
});

test('SPA navigation: PAGE_NAVIGATED, old feed pruned, post page detected (HD preferred, variants, DOM prompt)', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const frame = await studio(page, { open: true });
    await recordEvents(frame);
    await page.mouse.move(5, 5);
    await page.locator(`[data-post-id="${RED}"] a.card-link`).click({ position: { x: 200, y: 150 } });
    await expect(page).toHaveURL(new RegExp(`/imagine/post/${RED}$`));
    await frame.waitForFunction(() => window.__gis.pageStore.get().info?.route === 'post', null, POLL);
    const nav = await seen(frame, 'page.navigated');
    expect(nav.at(-1)).toMatchObject({ url: `https://grok.com/imagine/post/${RED}`, route: 'post' });
    // After the prune delay only the post page media remain: main clip + 3 variant thumbnails.
    await frame.waitForFunction(() => window.__gis.pageStore.get().items.length === 4, null, POLL);
    const items = await pageItems(frame);
    const main = items.find((i) => i.key === `video:${RED}`);
    expect(main.url).toBe(`https://assets.grok.com/users/test-user-0000/generated/${RED}/generated_video_hd.mp4`);
    expect(main.altUrls).toContain(videoUrl(RED));
    expect(main.prompt).toBe(POSTS[RED].prompt);
    expect(items.map((i) => i.key).sort()).toEqual([`video:${BLUE}`, `video:${GREEN}`, `video:${HD}`, `video:${RED}`].sort());
    for (const v of items.filter((i) => i.key !== `video:${RED}`)) expect(v).toMatchObject({ thumbUrl: thumbUrl(v.postId), url: videoUrl(v.postId) });

    // A fresh post page (no API call at all): prompt from the page itself (og:description / article text).
    await page.goto(`https://grok.com/imagine/post/${HD}`);
    const frame2 = await studio(page, { open: true });
    await frame2.waitForFunction((id) => window.__gis.pageStore.get().items.some((i) => i.key === `video:${id}`), HD, POLL);
    const hd = (await pageItems(frame2)).find((i) => i.key === `video:${HD}`);
    expect(hd).toMatchObject({ prompt: POSTS[HD].prompt, source: 'dom', pageUrl: `https://grok.com/imagine/post/${HD}` });
    const variants = (await pageItems(frame2)).filter((i) => i.key !== `video:${HD}`);
    expect(variants.length).toBe(3);
    for (const v of variants) expect(v.thumbUrl).toMatch(/preview_image\.jpg$/);
  } finally {
    await ctx.close();
  }
});

test('load more scrolls the feed until Grok loads the next page; reveal scrolls to and flashes an item', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    await openGrok(page, '/imagine');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(8);
    const frame = await studio(page, { open: true });
    const scrollTop = () => page.evaluate(() => document.querySelector('main.main').scrollTop);
    expect(await scrollTop()).toBe(0);
    const res = await request(frame, 'page.loadMore', { steps: 2 });
    expect(res.added).toBe(2);
    expect(await scrollTop()).toBe(0); // the user's scroll position is restored
    const items = (await request(frame, 'page.scan')).items;
    for (const p of PAGE2_POSTS) {
      const it = items.find((i) => i.postId === p.id);
      // DOM card + API record merged; the API id names it although its URL has no /generated/<id>/ folder.
      expect(it, p.id).toMatchObject({ key: `video:${p.id}`, prompt: p.prompt, source: 'both', kind: 'video', fresh: false });
      // Older posts loaded at the bottom sort after the first page (never as "new").
      expect(items.indexOf(it)).toBeGreaterThan(items.findIndex((i) => i.key === `video:${RED}`));
    }
    // keepPosition: false leaves the feed scrolled where the new media is.
    await page.evaluate(() => {
      const spacer = document.createElement('div'); // more page to scroll through (not media)
      spacer.style.height = '2000px';
      document.querySelector('main.main').append(spacer);
    });
    await request(frame, 'page.loadMore', { steps: 1, keepPosition: false });
    expect(await scrollTop()).toBeGreaterThan(0);
    await page.evaluate(() => (document.querySelector('main.main').scrollTop = 0));
    // Reveal the first clip: it scrolls back into view and gets a highlight.
    expect(await request(frame, 'page.reveal', { key: `video:${RED}` })).toEqual({ ok: true });
    await expect(page.locator('gis-studio-root .flash')).toHaveCount(1);
    await expect(card(page, RED)).toBeInViewport();
    expect(await request(frame, 'page.reveal', { key: 'video:nope' })).toMatchObject({ ok: false });
  } finally {
    await ctx.close();
  }
});

test('auto-collect: the studio boots hidden on grok.com and collects new generations', async () => {
  const ctx = await launch({ grok: { apiPosts: WITHOUT_GENERATED } });
  try {
    await ctx.sw.evaluate(() => chrome.storage.local.set({ 'gis:ui': { autoCollect: true } }));
    const page = ctx.page;
    await openGrok(page, '/imagine');
    const frame = await studio(page); // created without opening the panel
    await expect(page.locator('gis-studio-root .panel')).toBeHidden();
    await frame.waitForFunction(() => window.__gis.uiStore.get().autoCollect === true, null, POLL);
    await frame.waitForFunction(() => window.__gis.pageStore.get().items.length >= 6, null, POLL);
    // Clips that were already on the page are not collected...
    expect((await binMedia(frame)).length).toBe(0);
    // ...a new generation is.
    await page.locator('.query-bar [contenteditable="true"]').click();
    await page.keyboard.type('A glass whale gliding over a desert');
    await page.keyboard.press('Enter');
    await waitMediaReady(frame, `video:${GENERATED_POST}`);
    const media = await binMedia(frame);
    expect(media.map((m) => m.pageKey)).toEqual([`video:${GENERATED_POST}`]);
    expect(media[0].prompt).toBe('A glass whale gliding over a desert');
  } finally {
    await ctx.close();
  }
});

test('grok.com keeps working: no page errors, untouched API data, favorites page, user typing', async () => {
  const ctx = await launch();
  try {
    const page = ctx.page;
    const errors = watchPageErrors(page);
    for (const path of ['/imagine', '/imagine/favorites', `/imagine/post/${GREEN}`, '/c/mock-chat?stream=1']) {
      await openGrok(page, path);
      await page.waitForTimeout(1200);
      const mock = await page.evaluate(() => window.__mock);
      expect(mock.errors, path).toEqual([]);
      if (path.startsWith('/imagine') && !path.includes('/post/')) expect(mock.listPosts, path).toBe(6);
    }
    expect(await page.evaluate(() => window.__mock.generated)).toEqual([GENERATED_POST]); // streamed reply rendered
    await openGrok(page, '/imagine/favorites');
    await expect(page.locator('#feed [role="listitem"]')).toHaveCount(6);
    await expect(page.locator('gis-studio-root .badge')).toHaveText('5');
    await page.locator('.query-bar [contenteditable="true"]').click();
    await page.keyboard.type('hello grok');
    await expect(page.locator('.query-bar button[type="submit"]')).toBeEnabled();
    expect(errors).toEqual([]);
    expect(ctx.consoleErrors.filter((e) => !/favicon/.test(e))).toEqual([]);
  } finally {
    await ctx.close();
  }
});
