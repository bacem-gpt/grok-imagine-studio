// What the grok.com page side sends the studio is validated before use (core/page-input.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePageMedia, sanitizePageMediaList, sanitizePageInfo, sanitizeText, sanitizeFlag, sanitizeDockMode, sanitizeMediaUrls, isPageMediaUrl, cleanHttpUrl } from '../../extension/studio/core/page-input.js';

const VIDEO = 'https://assets.grok.com/users/u1/generated/11111111-1111-4111-8111-111111111111/generated_video.mp4';
const item = (extra = {}) => ({
  key: 'video:11111111-1111-4111-8111-111111111111',
  kind: 'video',
  url: VIDEO,
  altUrls: [],
  thumbUrl: null,
  postId: '11111111-1111-4111-8111-111111111111',
  prompt: 'A red car',
  source: 'network',
  pageUrl: 'https://grok.com/imagine',
  seenAt: 5,
  fresh: true,
  aliases: ['url:x'],
  ...extra,
});

test('page media: Grok media hosts and grok.com blob: URLs only (detected media)', () => {
  assert.deepEqual(sanitizePageMedia(item()), { ...item(), model: null, createdAt: null, width: null, height: null, duration: null });
  for (const url of ['https://console.x.ai/v1/secret-export.mp4', 'https://evil.example/a.mp4', 'http://assets.grok.com/a.mp4', 'javascript:alert(1)', 'blob:https://evil.example/1', 'data:video/mp4;base64,AAAA', '']) {
    assert.equal(sanitizePageMedia(item({ url })), null, url);
  }
  assert.ok(sanitizePageMedia(item({ url: 'blob:https://grok.com/123-456' })));
  assert.ok(sanitizePageMedia(item({ url: 'https://imagine-public.x.ai/imagine-public/share-videos/a.mp4' })));
  const mixed = sanitizePageMedia(item({ altUrls: ['https://evil.example/b.mp4', 'https://assets.grokusercontent.com/b.mp4', 7], thumbUrl: 'https://evil.example/t.jpg' }));
  assert.deepEqual(mixed.altUrls, ['https://assets.grokusercontent.com/b.mp4']);
  assert.equal(mixed.thumbUrl, null);
  // kinds, keys, strings
  assert.equal(sanitizePageMedia(item({ kind: 'audio' })), null);
  assert.equal(sanitizePageMedia(item({ key: '' })), null);
  assert.equal(sanitizePageMedia(item({ prompt: 'x'.repeat(20000) })).prompt.length, 8000);
  assert.equal(sanitizePageMedia(item({ pageUrl: 'javascript:alert(1)' })).pageUrl, '');
  assert.equal(sanitizePageMedia(item({ width: -4, duration: Infinity })).width, null);
  assert.equal(sanitizePageMedia(null), null);
  // small extra fields from a newer content script survive, objects do not
  const extra = sanitizePageMedia(item({ index: 3, label: 'x', nested: { a: 1 } }));
  assert.equal(extra.index, 3);
  assert.equal(extra.nested, undefined);
});

test('page media: an explicit user target may be any http(s) link', () => {
  const other = item({ url: 'https://cdn.example.org/pic.jpg', kind: 'image' });
  assert.equal(sanitizePageMedia(other), null);
  assert.ok(sanitizePageMedia(other, { userTarget: true }));
  assert.equal(sanitizePageMedia(item({ url: 'javascript:alert(1)' }), { userTarget: true }), null);
  assert.equal(sanitizePageMedia(item({ url: 'file:///etc/passwd' }), { userTarget: true }), null);
  assert.ok(isPageMediaUrl('https://assets.grok.com/x.jpg'));
  assert.ok(!isPageMediaUrl('https://x.ai.evil.example/x.jpg'));
  assert.equal(sanitizePageMediaList([item(), { kind: 'video' }, 'junk', item({ key: 'k2' })]).length, 2);
  assert.equal(sanitizePageMediaList('nope').length, 0);
  assert.equal(sanitizePageMediaList(Array.from({ length: 10 }, (_, i) => item({ key: `k${i}` })), {}, 3).length, 3);
});

test('page info, text, flags, dock modes', () => {
  assert.deepEqual(sanitizePageInfo({ url: 'https://grok.com/imagine', title: 'Grok', route: 'imagine', composerFound: true }), { url: 'https://grok.com/imagine', title: 'Grok', route: 'imagine', composerFound: true });
  assert.deepEqual(sanitizePageInfo({ url: 'https://evil.example/', title: 7, route: 'admin', composerFound: 'yes' }), { url: 'https://grok.com/', title: '', route: 'other', composerFound: false });
  assert.equal(sanitizePageInfo(null), null);
  assert.equal(sanitizeText('abc'), 'abc');
  assert.equal(sanitizeText({ text: 1 }), '');
  assert.equal(sanitizeText('x'.repeat(10), 4), 'xxxx');
  assert.equal(sanitizeFlag('pick'), 'pick');
  assert.equal(sanitizeFlag('delete-all'), null);
  assert.equal(sanitizeDockMode('float'), 'float');
  assert.equal(sanitizeDockMode('fullscreen'), null);
});

test('imported project files: only http(s) (and inline data:) media links survive', () => {
  const m = sanitizeMediaUrls({ id: 'm', sourceUrl: 'javascript:alert(1)', altUrls: ['https://a/x.mp4', 'file:///x', null], pageUrl: 'data:text/html,hi' });
  assert.equal(m.sourceUrl, null);
  assert.deepEqual(m.altUrls, ['https://a/x.mp4']);
  assert.equal(m.pageUrl, null);
  assert.equal(sanitizeMediaUrls({ sourceUrl: 'data:audio/wav;base64,AAA' }).sourceUrl, 'data:audio/wav;base64,AAA');
  assert.equal(cleanHttpUrl('https://grok.com/imagine'), 'https://grok.com/imagine');
  assert.equal(cleanHttpUrl('ftp://x'), null);
});
