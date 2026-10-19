// Unit tests for the pure grok.com content-script modules: records.js (URL rules, network record normalisation,
// DOM candidate factories), registry.js (DOM + network merging, keys, seenAt, pruning) and text.js (domToText).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  URL_RANK,
  postIdFromUrl,
  postIdFromPath,
  routeOf,
  isAllowedMediaUrl,
  toIso,
  normalizeNetRecord,
  videoCandidate,
  imageCandidate,
  adhocPageMedia,
  plausiblePrompt,
  cleanId,
  unwrapProxyUrl,
  isMediaAssetUrl,
} from '../../extension/content/records.js';
import { Registry, NAV_GRACE_MS, OLD_OFFSET_MS, FRESH_TOLERANCE_MS, GEN_WINDOW_MS } from '../../extension/content/registry.js';
import { domToText } from '../../extension/content/text.js';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const asset = (id, name) => `https://assets.grok.com/users/u-0001/generated/${id}/${name}`;

// -----------------------------------------------------------------------------------------------------------
// records.js
// -----------------------------------------------------------------------------------------------------------

test('postIdFromUrl: generated folders and public shares, never user ids or blobs', () => {
  assert.equal(postIdFromUrl(asset(ID1, 'generated_video.mp4?cache=1')), ID1);
  assert.equal(postIdFromUrl(asset(ID1.toUpperCase(), 'image.jpg')), ID1, 'UUIDs are lower-cased');
  assert.equal(postIdFromUrl(`https://imagine-public.x.ai/imagine-public/share-videos/${ID2}_thumbnail.jpg`), ID2);
  assert.equal(postIdFromUrl(`https://assets.grok.com/users/${ID2}/profile-picture.jpg`), null, 'a user uuid is not a post id');
  assert.equal(postIdFromUrl('blob:https://grok.com/' + ID1), null);
  assert.equal(postIdFromUrl(null), null);
  assert.equal(postIdFromPath(`/imagine/post/${ID1}`), ID1);
  assert.equal(postIdFromPath('/imagine'), null);
  assert.equal(cleanId(42), null);
  assert.equal(cleanId('abc def'), null);
  assert.equal(cleanId('post_123456'), 'post_123456');
});

test('routeOf maps grok.com paths to PageInfo routes', () => {
  assert.equal(routeOf('/imagine'), 'imagine');
  assert.equal(routeOf(`/imagine/post/${ID1}`), 'post');
  assert.equal(routeOf('/imagine/favorites'), 'favorites');
  assert.equal(routeOf('/imagine/saved'), 'favorites');
  assert.equal(routeOf('/c/abc'), 'chat');
  assert.equal(routeOf('/'), 'chat');
  assert.equal(routeOf('/settings'), 'other');
});

test('isAllowedMediaUrl: only Grok media hosts (https) and blobs of the page', () => {
  assert.ok(isAllowedMediaUrl(asset(ID1, 'generated_video.mp4')));
  assert.ok(isAllowedMediaUrl('https://imagine-public.x.ai/imagine-public/share-videos/x.mp4'));
  assert.ok(isAllowedMediaUrl('https://assets.grokusercontent.com/a/b.png'));
  assert.ok(isAllowedMediaUrl('blob:https://grok.com/1234'));
  assert.ok(!isAllowedMediaUrl('blob:https://evil.example/1234'));
  assert.ok(!isAllowedMediaUrl('http://assets.grok.com/a.mp4'), 'plain http rejected');
  assert.ok(!isAllowedMediaUrl('https://evil.example/users/x/generated/y/generated_video.mp4'));
  assert.ok(!isAllowedMediaUrl('https://assets.grok.com.evil.example/a.mp4'));
  assert.ok(!isAllowedMediaUrl('data:image/png;base64,AAAA'));
});

test('isMediaAssetUrl: grok.com UI hosts (cdn.grok.com) only count for generated / shared media paths', () => {
  assert.ok(isMediaAssetUrl(asset(ID1, 'generated_video.mp4')));
  assert.ok(isMediaAssetUrl('https://assets.grok.com/test/clip-cyan.webm'), 'asset host files');
  assert.ok(isMediaAssetUrl('https://imagine-public.x.ai/imagine-public/share-videos/abc.mp4'));
  assert.ok(isMediaAssetUrl('https://assets.grokusercontent.com/a/b.png'));
  assert.ok(isMediaAssetUrl('blob:https://grok.com/1234'));
  assert.ok(isMediaAssetUrl(`https://cdn.grok.com/users/u/generated/${ID1}/image.jpg`), 'generated path on any grok host');
  assert.ok(!isMediaAssetUrl('https://cdn.grok.com/images/imagine-hero-banner.png'), 'decorative CDN image');
  assert.ok(!isMediaAssetUrl('https://cdn.grok.com/videos/imagine-intro-loop.mp4'), 'looping UI video');
  assert.ok(!isMediaAssetUrl('https://grok.com/_next/static/media/bg.mp4'));
  assert.ok(!isMediaAssetUrl('https://assets.grok.com/users/x/profile-picture.jpg'));
  assert.ok(!isMediaAssetUrl('https://evil.example/users/x/generated/y/generated_video.mp4'));
  // The DOM and network filters agree with page-hook.js.
  assert.equal(imageCandidate({ src: 'https://cdn.grok.com/images/imagine-hero-banner.png', naturalWidth: 1200, naturalHeight: 400 }), null);
  assert.equal(videoCandidate({ src: 'https://cdn.grok.com/videos/imagine-intro-loop.mp4' }), null);
  assert.equal(normalizeNetRecord({ url: 'https://cdn.grok.com/images/x.png' }), null);
});

test('toIso accepts ISO strings, epoch seconds/ms and {seconds}', () => {
  assert.equal(toIso('2026-10-18T12:00:00Z'), '2026-10-18T12:00:00.000Z');
  assert.equal(toIso(1760788800), '2025-10-18T12:00:00.000Z');
  assert.equal(toIso(1760788800000), '2025-10-18T12:00:00.000Z');
  assert.equal(toIso('1760788800'), '2025-10-18T12:00:00.000Z');
  assert.equal(toIso({ seconds: 1760788800 }), '2025-10-18T12:00:00.000Z');
  assert.equal(toIso('not a date'), null);
  assert.equal(toIso(5), null, 'implausible years are dropped');
});

test('normalizeNetRecord: absolutizes, infers kind, derives video from thumbnails, rejects foreign hosts', () => {
  const r = normalizeNetRecord({
    kind: 'video',
    url: `users/u-0001/generated/${ID1}/generated_video.mp4`,
    hdUrl: asset(ID1, 'generated_video_hd.mp4'),
    thumbUrl: asset(ID1, 'preview_image.jpg'),
    postId: ID1,
    apiId: ID1,
    prompt: '  A red car  ',
    model: 'imagine-video-1.5',
    createdAt: '2026-10-18T12:00:00Z',
    width: 640,
    height: '360',
    duration: 4,
  });
  assert.deepEqual(r, {
    kind: 'video',
    url: asset(ID1, 'generated_video.mp4'),
    hdUrl: asset(ID1, 'generated_video_hd.mp4'),
    thumbUrl: asset(ID1, 'preview_image.jpg'),
    derived: false,
    postId: ID1,
    apiPostId: ID1,
    parentId: null,
    prompt: 'A red car',
    model: 'imagine-video-1.5',
    createdAt: '2026-10-18T12:00:00.000Z',
    width: 640,
    height: 360,
    duration: 4,
    live: false,
  });
  assert.equal(normalizeNetRecord({ kind: 'video', url: asset(ID1, 'generated_video.mp4'), live: true }).live, true);
  const thumbOnly = normalizeNetRecord({ thumbUrl: asset(ID2, 'preview_image.jpg') });
  assert.equal(thumbOnly.kind, 'video');
  assert.equal(thumbOnly.url, asset(ID2, 'generated_video.mp4'));
  assert.equal(thumbOnly.derived, true);
  assert.equal(thumbOnly.postId, ID2);
  assert.equal(thumbOnly.apiPostId, null, 'an id taken from the asset folder is not an API id');
  const image = normalizeNetRecord({ url: asset(ID2, 'image.jpg') });
  assert.equal(image.kind, 'image');
  assert.equal(image.thumbUrl, image.url, 'images are their own thumbnail');
  const hdOnly = normalizeNetRecord({ kind: 'video', hdUrl: asset(ID1, 'generated_video.mp4') });
  assert.equal(hdOnly.url, asset(ID1, 'generated_video.mp4'));
  assert.equal(hdOnly.hdUrl, null);
  assert.equal(normalizeNetRecord({ url: 'https://evil.example/x.mp4', kind: 'video' }), null);
  assert.equal(normalizeNetRecord({ url: 'https://assets.grok.com/users/x/profile-picture.jpg' }), null);
  assert.equal(normalizeNetRecord({ url: 'blob:https://grok.com/abc', kind: 'video' }), null);
  assert.equal(normalizeNetRecord({ url: asset(ID1, 'track.mp3') }), null, 'audio is not page media');
  assert.equal(normalizeNetRecord(null), null);
  assert.equal(normalizeNetRecord('x'), null);
});

test('videoCandidate: HD over SD, poster-derived URL, route post id, blob ranks last', () => {
  const sd = videoCandidate({ src: asset(ID1, 'generated_video.mp4'), id: 'sd-video', poster: asset(ID1, 'preview_image.jpg') });
  assert.equal(sd.kind, 'video');
  assert.equal(sd.postId, ID1);
  assert.deepEqual(sd.urls, [{ url: asset(ID1, 'generated_video.mp4'), rank: URL_RANK.dom }], 'derived URL equal to src keeps the better rank');
  const hd = videoCandidate({ src: asset(ID1, 'generated_video_hd.mp4'), id: 'hd-video' });
  assert.equal(hd.urls[0].rank, URL_RANK.domHd);
  const blob = videoCandidate({ src: 'blob:https://grok.com/abc', poster: asset(ID2, 'preview_image.jpg') });
  assert.deepEqual(
    blob.urls.map((u) => u.rank),
    [URL_RANK.derived, URL_RANK.blob],
  );
  assert.equal(blob.postId, ID2);
  assert.equal(blob.blobOnly, false, 'the derived URL is fetchable');
  const bare = videoCandidate({ src: 'blob:https://grok.com/abc', id: 'hd-video', routePostId: ID1 });
  assert.equal(bare.blobOnly, true);
  assert.equal(bare.postId, ID1, 'detail page videos fall back to the route post id');
  assert.equal(videoCandidate({ src: 'https://grok.com/_next/static/media/bg.mp4' }), null, 'UI videos are ignored');
  assert.equal(videoCandidate({ src: 'blob:https://evil.example/x' }), null);
  assert.equal(videoCandidate({ src: asset(ID1, 'image.jpg') }), null, 'an image src is not a video');
  assert.equal(videoCandidate({}), null);
});

test('imageCandidate: generated images >= 160px, thumbnails become videos, avatars/moderated/blobs excluded', () => {
  const img = imageCandidate({ src: asset(ID1, 'image.jpg'), naturalWidth: 1024, naturalHeight: 1024 });
  assert.equal(img.kind, 'image');
  assert.equal(img.postId, ID1);
  assert.equal(img.thumbUrl, asset(ID1, 'image.jpg'));
  const thumb = imageCandidate({ src: asset(ID2, 'preview_image.jpg'), naturalWidth: 120, naturalHeight: 213, alt: 'Thumbnail 1' });
  assert.equal(thumb.kind, 'video');
  assert.equal(thumb.urls[0].url, asset(ID2, 'generated_video.mp4'));
  assert.equal(thumb.urls[0].rank, URL_RANK.derived);
  assert.equal(thumb.thumbUrl, asset(ID2, 'preview_image.jpg'));
  assert.equal(imageCandidate({ src: asset(ID1, 'image.jpg'), naturalWidth: 100, naturalHeight: 900 }), null, 'too small');
  assert.equal(imageCandidate({ src: asset(ID1, 'image.jpg'), alt: 'pfp', naturalWidth: 400, naturalHeight: 400 }), null);
  assert.equal(imageCandidate({ src: asset(ID1, 'image.jpg'), alt: 'Moderated', naturalWidth: 400, naturalHeight: 400 }), null);
  assert.equal(imageCandidate({ src: 'blob:https://grok.com/x', naturalWidth: 400, naturalHeight: 400 }), null);
  assert.equal(imageCandidate({ src: 'https://grok.com/images/logo.png', naturalWidth: 400, naturalHeight: 400 }), null);
  assert.equal(imageCandidate({ src: 'https://assets.grok.com/users/x/profile-picture.jpg', naturalWidth: 400, naturalHeight: 400 }), null);
  assert.equal(imageCandidate({ src: asset(ID1, 'preview_image.jpg'), naturalWidth: 20, naturalHeight: 20 }), null, 'tiny thumbnails ignored');
});

test('image-optimizer URLs are unwrapped to the original asset', () => {
  const inner = asset(ID1, 'preview_image.jpg');
  const next = `https://grok.com/_next/image?url=${encodeURIComponent(inner)}&w=640&q=75`;
  assert.equal(unwrapProxyUrl(next), inner);
  assert.equal(unwrapProxyUrl(`https://grok.com/cdn-cgi/image/width=400/${inner}`), inner);
  assert.equal(unwrapProxyUrl(inner), inner);
  assert.equal(unwrapProxyUrl('blob:https://grok.com/x'), 'blob:https://grok.com/x');
  const cand = imageCandidate({ src: next, naturalWidth: 640, naturalHeight: 360 });
  assert.equal(cand.kind, 'video', 'an optimized video thumbnail still stands for its video');
  assert.equal(cand.urls[0].url, asset(ID1, 'generated_video.mp4'));
  const v = videoCandidate({ src: 'blob:https://grok.com/b', poster: next });
  assert.equal(v.postId, ID1);
});

test('adhocPageMedia: context-menu targets become PageMedia (thumbnails -> video unless preferImage)', () => {
  const v = adhocPageMedia({ url: asset(ID1, 'preview_image.jpg'), kind: 'image', pageUrl: 'https://grok.com/imagine', now: 5 });
  assert.equal(v.kind, 'video');
  assert.equal(v.url, asset(ID1, 'generated_video.mp4'));
  assert.equal(v.thumbUrl, asset(ID1, 'preview_image.jpg'));
  assert.equal(v.key, `video:${ID1}`);
  assert.equal(v.seenAt, 5);
  const ing = adhocPageMedia({ url: asset(ID1, 'preview_image.jpg'), kind: 'image', preferImage: true, prompt: 'p' });
  assert.equal(ing.kind, 'image');
  assert.equal(ing.url, asset(ID1, 'preview_image.jpg'));
  assert.equal(ing.prompt, 'p');
  const ext = adhocPageMedia({ url: 'https://example.com/a.png', kind: 'image' });
  assert.equal(ext.key, 'url:https://example.com/a.png', 'explicit user actions accept any http(s) URL');
  assert.equal(adhocPageMedia({ url: 'javascript:alert(1)' }), null);
  assert.equal(adhocPageMedia({ url: 'https://example.com/page', kind: null }), null, 'unknown kind');
});

test('plausiblePrompt rejects generic site texts', () => {
  assert.equal(plausiblePrompt('  A red car  drifting '), 'A red car drifting');
  assert.equal(plausiblePrompt('Grok Imagine'), null);
  assert.equal(plausiblePrompt('Thumbnail 2'), null);
  assert.equal(plausiblePrompt('Generated image'), null);
  assert.equal(plausiblePrompt('Grok is an AI assistant by xAI'), null);
  assert.equal(plausiblePrompt('short'), null);
  assert.equal(plausiblePrompt('x'.repeat(5000)), null);
});

// -----------------------------------------------------------------------------------------------------------
// registry.js
// -----------------------------------------------------------------------------------------------------------

function clockRegistry(start = 1_000_000) {
  let t = start;
  const reg = new Registry({ now: () => t, pageUrl: () => 'https://grok.com/imagine' });
  return { reg, tick: (ms = 1000) => (t += ms), now: () => t };
}

/** Post-like UUID made of one repeated hex digit. */
const pid = (d) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
// Network records as page-hook.js sends them for API posts (the id comes from the record itself: apiId).
const netVideo = (id, extra = {}) =>
  normalizeNetRecord({ kind: 'video', url: asset(id, 'generated_video.mp4'), thumbUrl: asset(id, 'preview_image.jpg'), postId: id, apiId: id, prompt: `prompt ${id.slice(0, 4)}`, model: 'imagine-video-1.5', createdAt: '2026-10-18T12:00:00Z', ...extra });
const domVideo = (id, el, extra = {}) => ({ ...videoCandidate({ src: asset(id, 'generated_video.mp4'), poster: asset(id, 'preview_image.jpg') }), el, ...extra });
const keys = (reg) => reg.list().map((p) => p.key);

test('registry merges DOM and network records into one PageMedia with prompt and metadata', () => {
  const { reg } = clockRegistry();
  const el = { tag: 'video' };
  assert.equal(reg.applyDom([domVideo(ID1, el, { width: 640, height: 360, duration: 4.0004 })]), true);
  assert.equal(reg.applyNet([netVideo(ID1)]), true);
  const [pm] = reg.list();
  assert.equal(reg.size, 1);
  assert.deepEqual(
    { key: pm.key, kind: pm.kind, url: pm.url, prompt: pm.prompt, model: pm.model, source: pm.source, width: pm.width, duration: pm.duration, createdAt: pm.createdAt, postId: pm.postId },
    { key: `video:${ID1}`, kind: 'video', url: asset(ID1, 'generated_video.mp4'), prompt: 'prompt 1111', model: 'imagine-video-1.5', source: 'both', width: 640, duration: 4, createdAt: '2026-10-18T12:00:00.000Z', postId: ID1 },
  );
  assert.ok(pm.aliases.includes(`url:${asset(ID1, 'generated_video.mp4')}`), 'URL keys of the same media are aliases');
  assert.equal(reg.keyForElement(el), `video:${ID1}`);
  assert.deepEqual(reg.elementsFor(`video:${ID1}`), [el]);
  assert.equal(reg.applyNet([netVideo(ID1)]), false, 'same data again: no change');
  assert.equal(reg.applyDom([domVideo(ID1, el, { width: 640, height: 360, duration: 4.0004 })]), false, 'identical DOM snapshot: no change');
});

test('registry: HD network URL wins, DOM URL and blob become alternates in rank order', () => {
  const { reg } = clockRegistry();
  const el = {};
  reg.applyDom([{ ...videoCandidate({ src: 'blob:https://grok.com/b1', poster: asset(ID1, 'preview_image.jpg') }), el }]);
  reg.applyNet([netVideo(ID1, { hdUrl: asset(ID1, 'generated_video_hd.mp4') })]);
  const pm = reg.get(`video:${ID1}`);
  assert.equal(pm.url, asset(ID1, 'generated_video_hd.mp4'));
  assert.deepEqual(pm.altUrls, [asset(ID1, 'generated_video.mp4'), 'blob:https://grok.com/b1']);
  assert.equal(pm.source, 'both');
  assert.ok(!pm.aliases.some((a) => a.includes('blob:')), 'page blob URLs never become alias keys');
});

test('registry keys do not depend on arrival order: the API id wins, earlier keys become aliases', () => {
  // URLs without a /generated/<id>/ folder (CDN variants, test assets): DOM-first starts URL-keyed.
  const url = 'https://assets.grok.com/test/clip-blue.mp4?post=77777777';
  const api = '77777777-7777-4777-8777-777777777777';
  const net = normalizeNetRecord({ kind: 'video', url, postId: api, apiId: api, prompt: 'blue hour' });
  const dom = (el) => ({ ...videoCandidate({ src: url, poster: 'https://assets.grok.com/test/thumb-blue.jpg' }), el });
  const a = clockRegistry().reg;
  a.applyNet([net]);
  a.applyDom([dom({})]);
  const b = clockRegistry().reg;
  const el = {};
  b.applyDom([dom(el)]);
  assert.deepEqual(keys(b), [`url:${url}`], 'before the API record: URL key');
  b.applyNet([net]);
  for (const reg of [a, b]) {
    assert.equal(reg.size, 1, 'one entry, not two');
    assert.deepEqual(keys(reg), [`video:${api}`]);
    assert.equal(reg.list()[0].prompt, 'blue hour');
  }
  assert.ok(b.list()[0].aliases.includes(`url:${url}`), 'the earlier key is an alias');
  assert.ok(a.list()[0].aliases.includes(`url:${url}`), '... in both orders (it may be in a bin from another session)');
  assert.equal(b.get(`url:${url}`).key, `video:${api}`, 'lookups by the earlier key still work');
  assert.equal(b.has(`url:${url}`), true);
  assert.equal(b.keyForElement(el), `video:${api}`);
  assert.equal(b.findByUrl(url), `video:${api}`);
  // The API id differs from the asset folder id: the API id wins in both orders too.
  const folder = pid('a');
  const id = pid('b');
  const u2 = `https://assets.grok.com/users/u/generated/${folder}/generated_video.mp4`;
  const net2 = normalizeNetRecord({ kind: 'video', url: u2, postId: id, apiId: id });
  const c = clockRegistry().reg;
  c.applyNet([net2]);
  c.applyDom([{ ...videoCandidate({ src: u2 }), el: {} }]);
  const d = clockRegistry().reg;
  d.applyDom([{ ...videoCandidate({ src: u2 }), el: {} }]);
  assert.deepEqual(keys(d), [`video:${folder}`], 'folder id until the API names the post');
  d.applyNet([net2]);
  assert.deepEqual(keys(c), [`video:${id}`]);
  assert.deepEqual(keys(d), [`video:${id}`]);
  assert.ok(d.list()[0].aliases.includes(`video:${folder}`));
  assert.ok(c.list()[0].aliases.includes(`video:${folder}`));
});

test('registry: a DOM card that appears after its API record gets the API key right away (cached record)', () => {
  const { reg } = clockRegistry();
  const url = 'https://assets.grok.com/test/clip-green.mp4?post=88888888';
  const api = '88888888-8888-4888-8888-888888888888';
  reg.applyNet([normalizeNetRecord({ kind: 'video', url, postId: api, apiId: api, prompt: 'aurora' })]);
  reg.navigate(reg.now() + NAV_GRACE_MS * 3);
  reg.prune(); // gone from the list (network-only, old), but the record stays cached
  assert.equal(reg.size, 0);
  reg.applyDom([{ ...videoCandidate({ src: url }), el: {} }]);
  const [pm] = reg.list();
  assert.equal(pm.key, `video:${api}`);
  assert.equal(pm.prompt, 'aurora');
  assert.deepEqual(pm.aliases, [`url:${url}`], 'no intermediate URL key was ever handed out, only the natural alias');
});

test('registry: a record linking two entries merges them (no duplicate once Grok lists both URLs)', () => {
  const { reg } = clockRegistry();
  const api = pid('9');
  const sd = 'https://assets.grok.com/test/clip-red.mp4?q=sd';
  const hd = 'https://assets.grok.com/test/clip-red-hd.mp4';
  const el = {};
  reg.applyDom([{ ...videoCandidate({ src: sd }), el }]);
  reg.applyNet([normalizeNetRecord({ kind: 'video', url: hd, postId: api, apiId: api })]);
  assert.equal(reg.size, 2);
  reg.applyNet([normalizeNetRecord({ kind: 'video', url: sd, hdUrl: hd, postId: api, apiId: api, prompt: 'red' })]);
  assert.equal(reg.size, 1);
  const pm = reg.list()[0];
  assert.equal(pm.key, `video:${api}`);
  assert.equal(pm.url, hd);
  assert.deepEqual(pm.altUrls, [sd]);
  assert.equal(pm.source, 'both');
  assert.ok(pm.aliases.includes(`url:${sd}`));
  assert.equal(reg.keyForElement(el), `video:${api}`);
  reg.applyDom([{ ...videoCandidate({ src: sd }), el }]);
  assert.equal(reg.size, 1, 'the next DOM pass does not split it again');
});

test('registry: an image post and the video made from it share an id but stay separate items', () => {
  const { reg } = clockRegistry();
  reg.applyDom([
    { ...imageCandidate({ src: asset(ID1, 'image.jpg'), naturalWidth: 800, naturalHeight: 800 }), el: {} },
    { ...videoCandidate({ src: asset(ID1, 'generated_video.mp4'), poster: asset(ID1, 'image.jpg') }), el: {} },
  ]);
  assert.deepEqual(keys(reg).sort(), [`image:${ID1}`, `video:${ID1}`]);
});

test('registry: network prompt overrides the DOM fallback; promptFn runs only while no prompt is known', () => {
  const { reg } = clockRegistry();
  let calls = 0;
  const el = {};
  const cand = () => domVideo(ID1, el, { promptFn: () => (calls++, 'dom caption text') });
  reg.applyDom([cand()]);
  assert.equal(reg.get(`video:${ID1}`).prompt, 'dom caption text');
  reg.applyDom([cand()]);
  assert.equal(calls, 1, 'not recomputed once a prompt is known');
  reg.applyNet([netVideo(ID1, { prompt: 'real prompt' })]);
  assert.equal(reg.get(`video:${ID1}`).prompt, 'real prompt');
  reg.applyDom([cand()]);
  assert.equal(reg.get(`video:${ID1}`).prompt, 'real prompt', 'DOM never overrides network');
  assert.equal(calls, 1);
});

test('registry: page order for media that was already there, and dating survives scrolling away and back', () => {
  const T0 = Date.parse('2026-10-19T12:00:00Z');
  const { reg, tick } = clockRegistry(T0);
  const e1 = {};
  const e2 = {};
  reg.applyDom([domVideo(ID1, e1), domVideo(ID2, e2)]);
  const first = reg.list();
  assert.deepEqual(first.map((p) => p.key), [`video:${ID1}`, `video:${ID2}`], 'top of the page first');
  assert.ok(first.every((p) => !p.fresh && p.seenAt < T0 - OLD_OFFSET_MS + 1000), 'no generation signal: not new');
  const seen1 = first[0].seenAt;
  tick(5000);
  const ID3 = pid('3');
  reg.applyNet([netVideo(ID3, { createdAt: new Date(T0 + 4000).toISOString() })]);
  assert.equal(reg.list()[0].key, `video:${ID3}`, 'created during the session: new, so first');
  // ID1 scrolls away (virtualized list) and comes back: same key, same seenAt
  reg.applyDom([domVideo(ID2, e2)]);
  assert.equal(reg.has(`video:${ID1}`), true, 'not dropped without navigation');
  assert.deepEqual(reg.elementsFor(`video:${ID1}`), []);
  tick(1000);
  reg.applyDom([domVideo(ID1, {}), domVideo(ID2, e2)]);
  assert.equal(reg.get(`video:${ID1}`).seenAt, seen1);
});

test('registry: prune after navigation drops what the new page does not show, keeps fresh network records', () => {
  const { reg, tick, now } = clockRegistry();
  const ID3 = pid('3');
  const ID4 = pid('4');
  reg.applyDom([domVideo(ID1, {}), domVideo(ID4, {})]);
  reg.applyNet([netVideo(ID2)]); // network-only on the old page
  tick(10_000);
  reg.applyNet([netVideo(ID3), netVideo(ID4)]); // just before the URL changes: data for the new page + a shown card
  tick(NAV_GRACE_MS - 500);
  const seen1 = reg.get(`video:${ID1}`).seenAt;
  reg.navigate(now());
  reg.applyDom([]); // new page rendered: the old cards are gone
  assert.equal(reg.prune(), 3, 'a card shown on the old page goes even if the API confirmed it recently');
  assert.deepEqual(keys(reg), [`video:${ID3}`]);
  // Coming back later restores the original dating, and the prompt from the network cache.
  reg.applyDom([domVideo(ID1, {}), domVideo(ID4, {})]);
  assert.equal(reg.get(`video:${ID1}`).seenAt, seen1);
  assert.equal(reg.get(`video:${ID4}`).prompt, 'prompt 4444');
  assert.equal(reg.get(`video:${ID4}`).source, 'both');
});

test('registry: findByUrl, network-only items, thumbnails and pageUrl', () => {
  const { reg } = clockRegistry();
  reg.applyNet([normalizeNetRecord({ thumbUrl: asset(ID2, 'preview_image.jpg') })]);
  const pm = reg.get(`video:${ID2}`);
  assert.equal(pm.source, 'network');
  assert.equal(pm.url, asset(ID2, 'generated_video.mp4'));
  assert.equal(pm.thumbUrl, asset(ID2, 'preview_image.jpg'));
  assert.equal(pm.pageUrl, 'https://grok.com/imagine');
  assert.equal(reg.findByUrl(asset(ID2, 'generated_video.mp4#t=2')), `video:${ID2}`);
  assert.equal(reg.findByUrl('https://assets.grok.com/none.mp4'), null);
  reg.applyDom([{ ...domVideo(ID2, {}), pageUrl: `https://grok.com/imagine/post/${ID2}`, pageUrlRank: 2 }]);
  assert.equal(reg.get(`video:${ID2}`).pageUrl, `https://grok.com/imagine/post/${ID2}`);
});

test('registry settle window: media already on the page is ordered by page position and dated before the session', () => {
  const T0 = Date.parse('2026-10-19T12:00:00Z');
  const { reg, tick, now } = clockRegistry(T0);
  reg.beginSettle(4000);
  const ID3 = pid('3');
  // Grok's API answers before the content script scans the DOM; the DOM shows them plus a clip the API never listed.
  reg.applyNet([netVideo(ID2), netVideo(ID1)]);
  tick(300);
  const cyan = { ...videoCandidate({ src: 'https://assets.grok.com/test/clip-cyan.webm' }), el: {} };
  reg.applyDom([domVideo(ID1, {}), domVideo(ID2, {}), cyan]);
  const list = reg.list();
  assert.deepEqual(list.map((p) => p.key), [`video:${ID1}`, `video:${ID2}`, 'url:https://assets.grok.com/test/clip-cyan.webm'], 'page order, not arrival order');
  assert.ok(list.every((p) => p.seenAt < T0 - OLD_OFFSET_MS + 1000 && !p.fresh), 'dated before the session: auto-collect never takes them');
  // Even a createTime right at the session start does not make settle-window media new (it was on the page).
  reg.applyNet([netVideo(ID3, { createdAt: new Date(T0 - 1000).toISOString() })]);
  assert.equal(reg.get(`video:${ID3}`).fresh, false);
  // A streamed generation result is new even while settling.
  const ID4 = pid('4');
  reg.applyNet([netVideo(ID4, { live: true, createdAt: null })]);
  assert.equal(reg.get(`video:${ID4}`).fresh, true);
  assert.equal(reg.get(`video:${ID4}`).seenAt, now());
  assert.equal(reg.list()[0].key, `video:${ID4}`);
});

test('registry freshness: infinite scroll is old, recent createTimes and media after a submission are new', () => {
  const T0 = Date.parse('2026-10-19T12:00:00Z');
  const { reg, tick, now } = clockRegistry(T0);
  reg.beginSettle(4000);
  reg.applyDom([domVideo(ID1, {})]);
  tick(10_000); // settle window over
  const [ID3, ID4, ID5, ID6, ID7, ID8] = ['3', '4', '5', '6', '7', '8'].map(pid);
  // Infinite scroll loads posts created 3 minutes before the page was opened: old (the reviewer's repro).
  reg.applyNet([netVideo(ID3, { createdAt: new Date(T0 - 3 * 60_000).toISOString() })]);
  assert.equal(reg.get(`video:${ID3}`).fresh, false);
  assert.ok(reg.get(`video:${ID3}`).seenAt < T0 - OLD_OFFSET_MS + 1000);
  assert.ok(keys(reg).indexOf(`video:${ID3}`) > keys(reg).indexOf(`video:${ID1}`), 'found later, sorted after');
  // A createTime within the tolerance before the session (a generation finishing across a reload): new.
  reg.applyNet([netVideo(ID4, { createdAt: new Date(T0 - FRESH_TOLERANCE_MS + 30_000).toISOString() })]);
  assert.equal(reg.get(`video:${ID4}`).fresh, true);
  assert.equal(reg.get(`video:${ID4}`).seenAt, now());
  // Media without any createTime: old, unless it shows up soon after a prompt was submitted.
  reg.applyDom([domVideo(ID1, {}), domVideo(ID5, {})]);
  assert.equal(reg.get(`video:${ID5}`).fresh, false, 'no submission yet');
  reg.signalGeneration();
  tick(20_000);
  reg.applyDom([domVideo(ID1, {}), domVideo(ID5, {}), domVideo(ID6, {})]);
  assert.equal(reg.get(`video:${ID6}`).fresh, true, 'after a submission');
  assert.equal(reg.get(`video:${ID6}`).seenAt, now());
  assert.equal(reg.get(`video:${ID5}`).fresh, false, 'seen before the submission: stays old');
  tick(GEN_WINDOW_MS + 1);
  reg.applyDom([domVideo(ID1, {}), domVideo(ID7, {})]);
  assert.equal(reg.get(`video:${ID7}`).fresh, false, 'long after the submission');
  // A DOM card that looked new turns old when its API record (old createTime) arrives right after...
  reg.signalGeneration();
  reg.applyDom([domVideo(ID1, {}), domVideo(ID8, {})]);
  assert.equal(reg.get(`video:${ID8}`).fresh, true);
  tick(800);
  reg.applyNet([netVideo(ID8, { createdAt: '2026-10-17T09:00:00Z' })]);
  assert.equal(reg.get(`video:${ID8}`).fresh, false);
  // ...but an item reported as new for a while keeps that (the studio may have collected it already).
  tick(10_000);
  reg.applyNet([netVideo(ID6, { createdAt: '2026-10-17T09:00:00Z' })]);
  assert.equal(reg.get(`video:${ID6}`).fresh, true);
  // Old media that turns out to be a streamed generation result becomes new.
  reg.applyNet([netVideo(ID5, { live: true })]);
  assert.equal(reg.get(`video:${ID5}`).fresh, true);
});

test('registry freshness corrects the clock skew measured from Date headers', () => {
  const T0 = Date.parse('2026-10-19T12:00:00Z');
  const { reg, tick, now } = clockRegistry(T0);
  tick(60_000);
  // The local clock runs 5 minutes ahead of Grok's servers: a post created 10 s ago (server time) looks 5 min old.
  const skew = 5 * 60_000;
  reg.applyNet([netVideo(ID1, { createdAt: new Date(now() - skew - 10_000).toISOString() })]);
  assert.equal(reg.get(`video:${ID1}`).fresh, false, 'uncorrected, it looks older than the session');
  assert.equal(reg.noteServerTime(now(), new Date(now() - skew).toUTCString()), true, 'the estimate changed the verdict');
  assert.equal(reg.get(`video:${ID1}`).fresh, true);
  assert.ok(Math.abs(reg.skew - skew) < 1000);
  // Later samples only lower the estimate (latency and cached responses only ever add to it).
  assert.equal(reg.noteServerTime(now(), new Date(now() - skew - 60_000).toUTCString()), false);
  assert.ok(Math.abs(reg.skew - skew) < 1000);
  assert.equal(reg.noteServerTime(now(), 'not a date'), false);
  assert.equal(reg.noteServerTime(now(), new Date(now() - 3 * 24 * 3600_000).toUTCString()), false, 'implausible skew ignored');
  // A server clock ahead of the local one: an old post stays old.
  const { reg: r2, tick: t2, now: n2 } = clockRegistry(T0);
  t2(60_000);
  r2.noteServerTime(n2(), new Date(n2() + 4 * 60_000).toUTCString());
  r2.applyNet([netVideo(ID2, { createdAt: new Date(n2() + 4 * 60_000 - 10 * 60_000).toISOString() })]);
  assert.equal(r2.get(`video:${ID2}`).fresh, false);
});

test('registry ignores malformed candidates and records', () => {
  const { reg } = clockRegistry();
  assert.equal(reg.applyDom([null, {}, { kind: 'audio', urls: [{ url: 'x', rank: 1 }] }, { kind: 'video', urls: [] }, { kind: 'video', urls: [null] }]), false);
  assert.equal(reg.applyNet([null, { kind: 'video' }, { kind: 'pdf', url: 'x' }]), false);
  assert.equal(reg.size, 0);
  assert.equal(reg.get('nope'), null);
  assert.deepEqual(reg.elementsFor('nope'), []);
});

// -----------------------------------------------------------------------------------------------------------
// text.js — domToText on a tiny fake DOM
// -----------------------------------------------------------------------------------------------------------

function el(tag, attrs, ...children) {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    hidden: !!attrs?.hidden,
    getAttribute: (n) => (attrs && n in attrs ? String(attrs[n]) : null),
    childNodes: children.map((c) => (typeof c === 'string' ? { nodeType: 3, nodeValue: c } : c)),
  };
}

test('domToText keeps paragraphs, numbers list items, skips UI chrome', () => {
  const root = el(
    'div',
    { class: 'response-content-markdown' },
    el('p', null, 'Here are   four shots:'),
    el('img', { alt: 'Generated image' }),
    el(
      'ol',
      null,
      el('li', null, el('p', null, el('strong', null, 'Opening drift'), ': a red car drifts in the rain')),
      el('li', null, 'Rooftop pursuit', el('br'), 'aerial dolly'),
      el('li', null, 'Tunnel burst'),
    ),
    el('ol', { start: '7' }, el('li', null, 'Seventh')),
    el('ul', null, el('li', null, 'bullet one'), el('li', null, 'bullet two')),
    el('p', null, 'Want variations?', el('button', null, 'Copy'), el('span', { 'aria-hidden': 'true' }, 'hidden'), el('span', { class: 'sr-only' }, 'screen reader')),
    el('div', { role: 'toolbar' }, el('span', null, 'Regenerate')),
    el('pre', null, 'line 1\n  line 2'),
    el('svg', null, 'svg text'),
  );
  assert.equal(
    domToText(root),
    [
      'Here are four shots:',
      '',
      '1. Opening drift: a red car drifts in the rain',
      '2. Rooftop pursuit',
      'aerial dolly',
      '3. Tunnel burst',
      '',
      '7. Seventh',
      '',
      '- bullet one',
      '- bullet two',
      '',
      'Want variations?',
      '',
      'line 1',
      '  line 2',
    ].join('\n'),
  );
  assert.equal(domToText(null), '');
  assert.equal(domToText(el('div', { hidden: true }, 'x')), '');
});

test('isMediaAssetUrl: Grok showcase catalogues (agent-skills, templates) are not page media', () => {
  // Seen live on the logged-out grok.com/imagine page (2026-10-19): 172 photo-edit "skill" thumbnails with prompts.
  assert.ok(!isMediaAssetUrl('https://imagine-public.x.ai/agent-skills/photo_edit/photo_edit_photo_enhance.jpg?v=3'));
  assert.ok(!isMediaAssetUrl('https://assets.grok.com/templates/x.jpg'));
  assert.ok(!isMediaAssetUrl('https://imagine-public.x.ai/static/hero.jpg'), 'imagine-public.x.ai: only shared/generated paths');
  assert.ok(isMediaAssetUrl('https://imagine-public.x.ai/imagine-public/share-images/abc.jpg'));
  assert.ok(isMediaAssetUrl('https://imagine-public.x.ai/imagine-public/share-videos/abc_thumbnail.jpg'));
});
