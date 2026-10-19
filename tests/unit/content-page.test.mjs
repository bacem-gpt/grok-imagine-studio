// Unit tests for the grok.com page-side helpers that keep Grok usable next to the studio and keep the content script
// cheap: overlay.js (room made in the page for a docked panel, floating window placement), composer.js (which upload
// fields take an image), registry.js (streams and blob-only media merged with Grok's records) and server.js
// (chrome.runtime broadcasts only while a standalone studio tab listens; no encoding pass without Blobs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    getURL: (p) => `chrome-extension://test/${p}`,
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage: async (msg) => {
      sent.push(msg);
      return undefined;
    },
  },
};
const { pagePushCss, floatSpot } = await import('../../extension/content/overlay.js');
const { acceptsImages, acceptsFile } = await import('../../extension/content/composer.js');
const { Registry } = await import('../../extension/content/registry.js');
const { URL_RANK, normalizeNetRecord, videoCandidate } = await import('../../extension/content/records.js');
const { Server, hasBlob } = await import('../../extension/content/server.js');
const { EVT } = await import('../../extension/shared/protocol.js');

const ID1 = '11111111-1111-4111-8111-111111111111';
const asset = (id, name) => `https://assets.grok.com/users/u-0001/generated/${id}/${name}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------------------------------------
// overlay.js
// -----------------------------------------------------------------------------------------------------------

test('pagePushCss: docked right, <body> becomes the page area beside the panel and contains fixed elements', () => {
  const css = pagePushCss('right', 720, { width: 1440, height: 900 });
  assert.match(css, /html > body \{ width: 720px !important; min-width: 0 !important; max-width: 720px !important; transform: translate\(0, 0\); \}/);
  assert.match(css, /html > body > \*, html > body > \* > \*, html > body > \* > \* > \* \{ max-width: 720px !important; \}/, 'app shells in vw units are capped');
  assert.doesNotMatch(css, /height/);
});

test('pagePushCss: docked bottom, the page keeps the height above the panel; a scrolling document only gets room to scroll', () => {
  const shell = pagePushCss('bottom', 495, { width: 1440, height: 900 });
  assert.match(shell, /html > body \{ height: 405px !important; min-height: 0 !important; max-height: 405px !important; transform: translate\(0, 0\); \}/);
  assert.match(shell, /\{ max-height: 405px !important; \}/, 'h-svh / 100vh shells are capped');
  const doc = pagePushCss('bottom', 495, { width: 1440, height: 900, appShell: false });
  assert.equal(doc, 'html > body { padding-bottom: 495px !important; }', 'no containing block or caps for a document that scrolls');
  assert.doesNotMatch(pagePushCss('right', 600, { width: 1280, height: 800, appShell: false }), /transform/, 'fixed elements stay put in a scrolling document');
  assert.equal(pagePushCss('float', 600, { width: 1280, height: 800 }), '');
  assert.equal(pagePushCss('max', 600, { width: 1280, height: 800 }), '');
});

test('floatSpot: the floating window opens clear of Grok\'s composer, preferring the whole box, else its button', () => {
  const box = { left: 372, top: 824, right: 1132, bottom: 882 }; // feed composer, bottom centre
  const key = { left: 1085, top: 835, right: 1121, bottom: 871 };
  const base = { fw: 760, fh: 520, vw: 1440, vh: 900 };
  // Default spot (bottom right) covers the composer: top right instead.
  assert.deepEqual(floatSpot({ ...base, x: 656, y: 356, avoid: { box, key } }), { x: 656, y: 24 });
  // The current spot is already clear: kept.
  assert.deepEqual(floatSpot({ ...base, x: 40, y: 30, avoid: { box, key } }), { x: 40, y: 30 });
  // A composer at the top (logged-out Imagine page): bottom right is fine.
  assert.deepEqual(floatSpot({ ...base, x: 656, y: 356, avoid: { box: { left: 372, top: 120, right: 1132, bottom: 240 }, key: null } }), { x: 656, y: 356 });
  // A small window where every corner overlaps the composer box: at least clear its submit button.
  const small = floatSpot({ fw: 600, fh: 500, vw: 800, vh: 640, x: 176, y: 116, avoid: { box: { left: 100, top: 300, right: 700, bottom: 360 }, key: { left: 650, top: 310, right: 690, bottom: 350 } } });
  assert.ok(small);
  assert.ok(small.x + 600 <= 650 || small.y + 500 <= 310 || small.y >= 350, `spot ${JSON.stringify(small)} clears the button`);
  assert.equal(floatSpot({ ...base, x: 1, y: 1, avoid: null }), null, 'nothing to avoid: keep the spot');
});

// -----------------------------------------------------------------------------------------------------------
// composer.js
// -----------------------------------------------------------------------------------------------------------

test('accept lists: MIME types, wildcards and image extensions take images; documents-only inputs do not', () => {
  for (const ok of ['', 'image/*', 'image/png, image/jpeg', '.png,.jpg,.jpeg,.webp,.gif', '.HEIC', '*/*', '.pdf, image/webp']) assert.equal(acceptsImages(ok), true, ok);
  for (const no of ['.pdf,.txt,.docx', 'application/pdf', 'video/*', 'audio/mpeg']) assert.equal(acceptsImages(no), false, no);
  const png = { type: 'image/png', name: 'ref.png' };
  assert.equal(acceptsFile('.png,.jpg', png), true, 'by extension');
  assert.equal(acceptsFile('.jpg,.jpeg', png), false);
  assert.equal(acceptsFile('image/*', png), true, 'by type wildcard');
  assert.equal(acceptsFile('image/jpeg', png), false);
  assert.equal(acceptsFile('IMAGE/PNG', png), true, 'case-insensitive');
  assert.equal(acceptsFile('', png), true);
  assert.equal(acceptsFile('video/*', { type: 'image/png', name: 'ref.png' }), false);
});

// -----------------------------------------------------------------------------------------------------------
// registry.js
// -----------------------------------------------------------------------------------------------------------

test('registry: a MediaSource video named by its post card merges with Grok\'s record; the stream URL is never offered', () => {
  const stream = 'blob:https://grok.com/mse-1';
  const reg = new Registry({ pageUrl: () => 'https://grok.com/imagine', unreadable: (u) => u === stream });
  const el = {};
  // What detect.js builds for a poster-less MediaSource video in a card linking to /imagine/post/<ID1>.
  reg.applyDom([{ kind: 'video', urls: [{ url: stream, rank: URL_RANK.blob }], thumbUrl: null, postId: ID1, blobOnly: true, mse: true, el }]);
  assert.deepEqual(
    reg.list().map((p) => [p.key, p.url, p.altUrls]),
    [[`video:${ID1}`, stream, []]],
    'before Grok\'s record: keyed by the post, the stream as its only URL',
  );
  reg.applyNet([normalizeNetRecord({ kind: 'video', url: asset(ID1, 'generated_video.mp4'), postId: ID1, apiId: ID1, prompt: 'red car' })]);
  const [pm] = reg.list();
  assert.equal(reg.size, 1, 'one clip, not two');
  assert.deepEqual([pm.key, pm.url, pm.altUrls, pm.source, pm.prompt], [`video:${ID1}`, asset(ID1, 'generated_video.mp4'), [], 'both', 'red car']);
  assert.equal(reg.keyForElement(el), `video:${ID1}`, 'the hover toolbar finds the merged clip');
});

test('registry: a page blob whose bytes came from a Grok media URL is the same clip as Grok\'s record', () => {
  const reg = new Registry({ pageUrl: () => 'https://grok.com/c/1' });
  reg.applyNet([normalizeNetRecord({ kind: 'video', url: asset(ID1, 'generated_video.mp4'), postId: ID1, apiId: ID1, live: true })]);
  // detect.js adds the source URL the hook reported for the blob (poster-less <video src="blob:…">).
  reg.applyDom([{ ...videoCandidate({ src: 'blob:https://grok.com/b-1', sources: [asset(ID1, 'generated_video.mp4')] }), el: {} }]);
  assert.deepEqual(
    reg.list().map((p) => [p.key, p.source, p.url]),
    [[`video:${ID1}`, 'both', asset(ID1, 'generated_video.mp4')]],
  );
});

// -----------------------------------------------------------------------------------------------------------
// server.js
// -----------------------------------------------------------------------------------------------------------

test('server: page events reach chrome.runtime only while a standalone studio tab talks to this tab', async () => {
  sent.length = 0;
  const s = new Server({ hasFrame: () => true });
  s.emit(EVT.PAGE_MEDIA, { items: [{ key: 'video:1' }] });
  s.emit(EVT.UI_VISIBILITY, { visible: true, mode: 'right' });
  await sleep(5);
  assert.equal(sent.length, 0, 'no standalone studio: no broadcast (it would wake the service worker)');
  assert.equal(s.queue.length, 2, 'the embedded studio still gets them');
  s.tabStudioSeenAt = Date.now(); // a studio tab sent a request
  const items = [{ key: 'video:1', url: asset(ID1, 'generated_video.mp4') }];
  s.emit(EVT.PAGE_MEDIA, { items });
  await sleep(5);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.items, items, 'no Blob inside: sent as is, without an encoding pass');
  s.emitRuntime(EVT.PAGE_ADD, { items: [{ blob: new Blob(['x'], { type: 'image/png' }) }] });
  await sleep(20);
  assert.match(sent[1].payload.items[0].blob.__blob, /^data:image\/png;base64,/, 'Blobs are still encoded');
  s.tabStudioSeenAt = Date.now() - 10 * 60 * 1000; // gone for minutes
  s.emit(EVT.PAGE_NAVIGATED, { url: 'x' });
  await sleep(5);
  assert.equal(sent.length, 2);
  s.destroy();
});

test('hasBlob finds Blobs at any depth', () => {
  assert.equal(hasBlob({ items: [{ a: 1 }, { b: [2, 3] }] }), false);
  assert.equal(hasBlob({ items: [{ a: 1 }, { b: [2, new Blob(['x'])] }] }), true);
  assert.equal(hasBlob(new Blob(['x'])), true);
  assert.equal(hasBlob(null), false);
  assert.equal(hasBlob('blob'), false);
});
