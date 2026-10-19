// Unit tests for extension/content/page-hook.js (MAIN-world network sniffer), run in a node:vm sandbox that stands
// in for the page: a fake window with fetch / XMLHttpRequest / postMessage. Verifies that responses reach the page
// untouched, that media records (JSON, streamed NDJSON, SSE, XHR, nested string JSON) are extracted and posted,
// and that nothing outside same-origin /rest/ is inspected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOOK = readFileSync(fileURLToPath(new URL('../../extension/content/page-hook.js', import.meta.url)), 'utf8');
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const asset = (id, name) => `https://assets.grok.com/users/u-0001/generated/${id}/${name}`;
const rel = (id, name) => `users/u-0001/generated/${id}/${name}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A page-like sandbox. routes: (url, init) => Response | Promise<Response>. globals: extra page globals. */
function sandbox({ routes = () => new Response('{}'), xhr = null, globals = {} } = {}) {
  const posted = [];
  const listeners = {};
  const created = new Map();
  let n = 0;
  class PageURL extends URL {
    static createObjectURL(obj) {
      const url = `blob:https://grok.com/${++n}`;
      created.set(url, obj);
      return url;
    }
    static revokeObjectURL(url) {
      created.delete(url);
    }
  }
  const win = {
    location: { origin: 'https://grok.com', href: 'https://grok.com/imagine' },
    URL: PageURL,
    Blob,
    TextDecoder,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (input, init) => routes(typeof input === 'string' ? input : input.url, init),
    XMLHttpRequest: xhr,
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
    postMessage: (data, origin) => {
      posted.push({ data, origin });
      // In the page, event.source is the same WindowProxy the hook calls `window` (here: the context's global).
      for (const fn of listeners.message || []) fn({ source: self, origin: 'https://grok.com', data });
    },
  };
  Object.assign(win, globals);
  win.window = win;
  vm.createContext(win);
  const self = vm.runInContext('globalThis', win);
  vm.runInContext(HOOK, win);
  const media = () => posted.filter((p) => p.data?.source === 'gis-hook' && p.data.type === 'media').flatMap((p) => p.data.items);
  return { win, posted, media, created };
}

const json = (obj, type = 'application/json') => new Response(JSON.stringify(obj), { headers: { 'content-type': type } });

function streamed(lines, { type = 'application/json', delay = 5 } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      for (const l of lines) {
        ctrl.enqueue(enc.encode(l));
        await sleep(delay);
      }
      ctrl.close();
    },
  });
  return new Response(body, { headers: { 'content-type': type } });
}

const postList = {
  posts: [
    {
      id: ID1,
      mediaType: 'MEDIA_POST_TYPE_VIDEO',
      mimeType: 'video/mp4',
      mediaUrl: asset(ID1, 'generated_video.mp4'),
      hdMediaUrl: asset(ID1, 'generated_video_hd.mp4'),
      thumbnailImageUrl: asset(ID1, 'preview_image.jpg'),
      prompt: 'A red sports car drifting through neon rain',
      originalPrompt: 'red car drift',
      createTime: '2026-10-18T12:00:00Z',
      modelName: 'imagine-video-1.5',
      resolution: { width: 1280, height: 720 },
      childPosts: [{ id: ID2, mediaType: 'MEDIA_POST_TYPE_VIDEO', mediaUrl: rel(ID2, 'generated_video.mp4') }],
    },
    { id: ID3, mediaType: 'MEDIA_POST_TYPE_IMAGE', mediaUrl: asset(ID3, 'image.jpg'), prompt: 'A poster' },
  ],
  user: { profileImageUrl: 'https://assets.grok.com/users/u-0001/profile-picture.jpg', avatarUrl: asset(ID3, 'image.jpg') },
};

test('hook: JSON post list -> records with prompt, HD, thumbnail, children; page body untouched', async () => {
  const sb = sandbox({ routes: (url) => (url.includes('/rest/media/post/list') ? json(postList) : new Response('{}')) });
  const res = await sb.win.fetch('/rest/media/post/list', { method: 'POST' });
  const body = await res.json();
  assert.equal(body.posts.length, 2, 'the page still reads the full response');
  await sleep(30);
  const items = sb.media();
  assert.equal(items.length, 3);
  const v = items.find((i) => i.postId === ID1);
  assert.deepEqual(
    { kind: v.kind, url: v.url, hdUrl: v.hdUrl, thumbUrl: v.thumbUrl, prompt: v.prompt, model: v.model, createdAt: v.createdAt, width: v.width, height: v.height },
    {
      kind: 'video',
      url: asset(ID1, 'generated_video.mp4'),
      hdUrl: asset(ID1, 'generated_video_hd.mp4'),
      thumbUrl: asset(ID1, 'preview_image.jpg'),
      prompt: 'A red sports car drifting through neon rain',
      model: 'imagine-video-1.5',
      createdAt: '2026-10-18T12:00:00Z',
      width: 1280,
      height: 720,
    },
  );
  const child = items.find((i) => i.postId === ID2);
  assert.equal(child.url, asset(ID2, 'generated_video.mp4'), 'relative asset paths are absolutized');
  assert.equal(child.parentId, ID1);
  assert.equal(child.prompt, 'A red sports car drifting through neon rain', 'children inherit the parent prompt');
  const img = items.find((i) => i.postId === ID3);
  assert.equal(img.kind, 'image');
  assert.ok(!items.some((i) => /profile/.test(i.url || '')), 'profile / avatar keys are skipped');
  assert.equal(sb.posted[0].origin, 'https://grok.com', 'posted to the page origin only');
});

test('hook: streamed NDJSON chat response is parsed line by line; unfinished generations are skipped', async () => {
  const lines = [
    '{"result":{"conversation":{"conversationId":"c1"}}}\n',
    '{"result":{"response":{"token":"Here "}}}\n{"result":{"response":{"token":"you go"}}}\n',
    `{"result":{"response":{"streamingVideoGenerationResponse":{"videoId":"${ID2}","progress":40,"videoUrl":"${rel(ID2, 'generated_video.mp4')}"}}}}\n`,
    `{"result":{"response":{"streamingVideoGenerationResponse":{"videoId":"${ID2}","progress":100,"videoUrl":"${rel(ID2, 'generated_video.mp4')}",`,
    `"thumbnailImageUrl":"${rel(ID2, 'preview_image.jpg')}","videoPrompt":"neon chase at night","modelName":"imagine-video-1.5"}}}}\n`,
    '{"result":{"response":{"modelResponse":{"message":"Done"}}}}',
  ];
  const sb = sandbox({ routes: () => streamed(lines) });
  const res = await sb.win.fetch('https://grok.com/rest/app-chat/conversations/new', { method: 'POST' });
  const text = await res.text();
  assert.equal(text, lines.join(''), 'the page receives the exact stream');
  await sleep(40);
  const items = sb.media();
  assert.equal(items.length, 1, 'only the finished generation is reported');
  assert.deepEqual(
    { kind: items[0].kind, url: items[0].url, thumbUrl: items[0].thumbUrl, postId: items[0].postId, prompt: items[0].prompt },
    { kind: 'video', url: asset(ID2, 'generated_video.mp4'), thumbUrl: asset(ID2, 'preview_image.jpg'), postId: ID2, prompt: 'neon chase at night' },
  );
});

test('hook: records from a long stream are posted before the stream ends', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(enc.encode(JSON.stringify({ imageUrl: asset(ID3, 'image.jpg'), imagePrompt: 'early image' }) + '\n'));
      await gate;
      ctrl.close();
    },
  });
  const sb = sandbox({ routes: () => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }) });
  const res = await sb.win.fetch('/rest/app-chat/conversations/c1/responses');
  const reading = res.text();
  await sleep(400); // > flush interval
  release();
  await reading;
  await sleep(20);
  const items = sb.media();
  assert.equal(items.length, 1);
  assert.equal(items[0].prompt, 'early image');
});

test('hook: SSE data lines, RSC rows, nested string JSON and loose URLs in text', async () => {
  const sse = [`data: ${JSON.stringify({ mediaUrl: asset(ID1, 'generated_video.mp4'), mediaType: 'MEDIA_POST_TYPE_VIDEO', id: ID1 })}\n\n`, 'data: [DONE]\n'];
  const sb = sandbox({
    routes: (url) => {
      if (url.includes('sse')) return streamed(sse, { type: 'text/event-stream' });
      if (url.includes('rsc')) return new Response(`0:["$@1",["x",null]]\n1:{"post":{"id":"${ID2}","mediaUrl":"${asset(ID2, 'image.jpg')}","prompt":"rsc prompt"}}\n`, { headers: { 'content-type': 'text/x-component' } });
      return json({ cardAttachmentsJson: [JSON.stringify({ image: { url: asset(ID3, 'image.jpg') } })], message: `Look: ![img](${asset(ID1, 'image.jpg')}). And ${rel(ID2, 'preview_image.jpg')}` });
    },
  });
  await (await sb.win.fetch('/rest/sse')).text();
  await (await sb.win.fetch('/imagine/post/x?_rsc=abc')).text();
  await (await sb.win.fetch('/rest/app-chat/conversations/c1')).json();
  await sleep(60);
  const items = sb.media();
  const byUrl = Object.fromEntries(items.map((i) => [i.url || i.thumbUrl, i]));
  assert.equal(byUrl[asset(ID1, 'generated_video.mp4')].kind, 'video', 'SSE data line');
  assert.equal(byUrl[asset(ID2, 'image.jpg')].prompt, 'rsc prompt', 'RSC row');
  assert.ok(byUrl[asset(ID3, 'image.jpg')], 'string-encoded JSON is expanded');
  assert.equal(byUrl[asset(ID1, 'image.jpg')].kind, 'image', 'markdown URL in text');
  const thumb = byUrl[asset(ID2, 'preview_image.jpg')];
  assert.equal(thumb.kind, 'video', 'a loose thumbnail stands for its video');
  assert.equal(thumb.url, null);
});

test('hook: pretty-printed JSON (multi-line) is parsed as a whole', async () => {
  const sb = sandbox({ routes: () => new Response(JSON.stringify(postList, null, 2), { headers: { 'content-type': 'application/json' } }) });
  await (await sb.win.fetch('/rest/media/post/list')).text();
  await sleep(40);
  const v = sb.media().find((i) => i.url === asset(ID1, 'generated_video.mp4'));
  assert.ok(v);
  assert.equal(v.prompt, 'A red sports car drifting through neon rain', 'metadata survives (merged after the line pass)');
});

test('hook: ignores other origins, non-API paths, binary types and failed responses; never alters errors', async () => {
  let calls = 0;
  const sb = sandbox({
    routes: (url) => {
      calls++;
      if (url.includes('fail')) return Promise.reject(new TypeError('Failed to fetch'));
      if (url.includes('404')) return new Response(JSON.stringify(postList), { status: 404, headers: { 'content-type': 'application/json' } });
      if (url.includes('image')) return new Response(JSON.stringify(postList), { headers: { 'content-type': 'image/png' } });
      return json(postList);
    },
  });
  await (await sb.win.fetch('https://api.example.com/rest/media/post/list')).text();
  await (await sb.win.fetch('/_next/data/posts.json')).text();
  await (await sb.win.fetch('/rest/404')).text();
  await (await sb.win.fetch('/rest/image')).text();
  await assert.rejects(sb.win.fetch('/rest/fail'), { name: 'TypeError', message: 'Failed to fetch' });
  await (await sb.win.fetch('/rest/bad')).text().catch(() => {});
  await sleep(40);
  assert.equal(calls, 6);
  assert.equal(sb.media().length, 3, 'only /rest/bad (valid JSON, same origin) was inspected');
});

test('hook: malformed JSON and odd values never throw', async () => {
  const sb = sandbox({ routes: () => new Response('{"posts": [ {"mediaUrl": 5, "prompt": {}}, null, "x"', { headers: { 'content-type': 'application/json' } }) });
  const res = await sb.win.fetch('/rest/media/post/list');
  assert.equal((await res.text()).length > 10, true);
  await sleep(30);
  assert.equal(sb.media().length, 0);
});

test('hook: XHR responses (text and json) are inspected read-only', async () => {
  const bodies = { '/rest/a': JSON.stringify(postList), '/rest/b': postList };
  class FakeXHR {
    constructor() {
      this.l = {};
      this.status = 0;
      this.responseType = '';
    }
    open(method, url) {
      this.url = url;
      this.opened = method;
    }
    send() {
      setTimeout(() => {
        this.status = 200;
        const b = bodies[this.url];
        if (typeof b === 'string') this.responseText = b;
        else {
          this.responseType = 'json';
          this.response = b;
        }
        for (const fn of this.l.loadend || []) fn.call(this);
      }, 1);
    }
    getResponseHeader() {
      return 'application/json';
    }
    addEventListener(t, fn) {
      (this.l[t] ||= []).push(fn);
    }
    removeEventListener(t, fn) {
      this.l[t] = (this.l[t] || []).filter((f) => f !== fn);
    }
  }
  const sb = sandbox({ xhr: FakeXHR });
  const a = new sb.win.XMLHttpRequest();
  a.open('GET', '/rest/a');
  a.send();
  const b = new sb.win.XMLHttpRequest();
  b.open('GET', '/rest/b');
  b.send();
  assert.equal(a.opened, 'GET', 'original open() still runs');
  await sleep(60);
  const urls = new Set(sb.media().map((i) => i.url));
  assert.ok(urls.has(asset(ID1, 'generated_video.mp4')));
  assert.ok(urls.has(asset(ID3, 'image.jpg')));
});

test('hook: backlog is replayed when the content script says hello', async () => {
  const sb = sandbox({ routes: () => json(postList) });
  await (await sb.win.fetch('/rest/media/post/list')).json();
  await sleep(30);
  const before = sb.posted.length;
  sb.win.postMessage({ source: 'gis-content', type: 'hello' }, 'https://grok.com');
  const replay = sb.posted.slice(before + 1).filter((p) => p.data?.from === 'backlog');
  assert.equal(replay.length, 1);
  assert.equal(replay[0].data.items.length, 3);
});

test('hook: page-owned blob URLs are served from the createObjectURL map, other URLs refused', async () => {
  const sb = sandbox();
  const blob = new Blob(['video-bytes'], { type: 'video/mp4' });
  const url = sb.win.URL.createObjectURL(blob);
  assert.match(url, /^blob:https:\/\/grok\.com\//, 'createObjectURL still returns the real URL');
  sb.win.postMessage({ source: 'gis-content', type: 'fetch-blob', id: 'f1', url }, 'https://grok.com');
  sb.win.postMessage({ source: 'gis-content', type: 'fetch-blob', id: 'f2', url: 'https://evil.example/x' }, 'https://grok.com');
  await sleep(10);
  const results = Object.fromEntries(sb.posted.filter((p) => p.data?.type === 'fetch-result').map((p) => [p.data.id, p.data]));
  assert.equal(results.f1.ok, true);
  assert.equal(await results.f1.blob.text(), 'video-bytes');
  assert.equal(results.f2.ok, false);
  sb.win.URL.revokeObjectURL(url);
  assert.equal(sb.created.has(url), false, 'revoke still reaches the real implementation');
});

test('hook: installs once and keeps fetch looking native', () => {
  const sb = sandbox();
  const wrapped = sb.win.fetch;
  vm.runInContext(HOOK, sb.win);
  assert.equal(sb.win.fetch, wrapped, 'second injection is a no-op');
  assert.equal(sb.win.fetch.name, 'fetch');
});

test('hook: the API id only comes from id fields; batches carry the Date header for clock-skew estimation', async () => {
  const date = 'Mon, 19 Oct 2026 10:00:00 GMT';
  const sb = sandbox({
    routes: (url) =>
      new Response(JSON.stringify(url.includes('list') ? postList : { message: `see ${asset(ID1, 'image.jpg')}`, imageUrl: asset(ID2, 'image.jpg') }), {
        headers: { 'content-type': 'application/json', date },
      }),
  });
  const t0 = Date.now();
  await (await sb.win.fetch('/rest/media/post/list')).json();
  await (await sb.win.fetch('/rest/app-chat/conversations/c1')).json();
  await sleep(40);
  const items = sb.media();
  assert.equal(items.find((i) => i.url === asset(ID1, 'generated_video.mp4')).apiId, ID1, 'a post id field');
  assert.equal(items.find((i) => i.postId === ID2 && i.parentId === ID1).apiId, ID2, 'a child post id field');
  const loose = items.find((i) => i.url === asset(ID1, 'image.jpg'));
  assert.equal(loose.postId, ID1, 'the asset folder id is only a hint...');
  assert.equal(loose.apiId ?? null, null, '...never an API id');
  assert.equal(items.find((i) => i.url === asset(ID2, 'image.jpg')).apiId, null, 'an object without id fields');
  const batches = sb.posted.filter((p) => p.data?.source === 'gis-hook' && p.data.type === 'media');
  assert.ok(batches.length >= 2);
  for (const b of batches) {
    assert.equal(b.data.serverDate, date);
    assert.ok(b.data.clientAt >= t0 && b.data.clientAt <= Date.now());
  }
  // The backlog replay keeps the timing of each batch.
  sb.win.postMessage({ source: 'gis-content', type: 'hello' }, 'https://grok.com');
  const replay = sb.posted.filter((p) => p.data?.from === 'backlog');
  assert.equal(replay.length, batches.length);
  assert.ok(replay.every((p) => p.data.serverDate === date && Number.isFinite(p.data.clientAt)));
});

// -----------------------------------------------------------------------------------------------------------
// Transparency: cancellation, rejections; object URLs; attach probe
// -----------------------------------------------------------------------------------------------------------

/** An endless NDJSON stream that records whether its source was cancelled (the network request stopped). */
function endless() {
  const state = { pulls: 0, cancelled: false };
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async pull(ctrl) {
      state.pulls++;
      ctrl.enqueue(enc.encode(JSON.stringify({ result: { response: { token: `t${state.pulls}` } } }) + '\n'));
      await sleep(2);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), state };
}

const STREAMS = { ReadableStream, ReadableStreamDefaultReader, Response };

test('hook: when the page stops reading a stream it inspects, the request stops too (no tee left reading)', async () => {
  const ways = {
    readerCancel: async (r) => {
      const rd = r.body.getReader();
      await rd.read();
      await rd.cancel();
    },
    streamCancel: async (r) => {
      const rd = r.body.getReader();
      await rd.read();
      rd.releaseLock();
      await r.body.cancel();
    },
    forAwaitBreak: async (r) => {
      let n = 0;
      for await (const chunk of r.body) if (chunk && ++n >= 2) break;
    },
    pipedCancel: async (r) => {
      const rd = r.body.pipeThrough(new TextDecoderStream()).getReader();
      await rd.read();
      await rd.cancel();
    },
    pipeAbort: async (r) => {
      const ac = new AbortController();
      const done = r.body.pipeTo(new WritableStream({ write() {} }), { signal: ac.signal }).catch(() => {});
      await sleep(10);
      ac.abort();
      await done;
    },
  };
  for (const [name, stop] of Object.entries(ways)) {
    const src = endless();
    const sb = sandbox({ routes: () => src.res, globals: STREAMS });
    const res = await sb.win.fetch('/rest/app-chat/conversations/c1/responses');
    await stop(res);
    await sleep(40);
    assert.equal(src.state.cancelled, true, `${name}: the source is cancelled`);
    const pulls = src.state.pulls;
    await sleep(30);
    assert.equal(src.state.pulls, pulls, `${name}: nothing is read any more`);
  }
});

test('hook: a stream read to the end is still inspected, and the page reads every byte', async () => {
  const enc = new TextEncoder();
  const lines = [{ result: { response: { streamingVideoGenerationResponse: { videoId: ID1, progress: 100, videoUrl: rel(ID1, 'generated_video.mp4') } } } }, { result: { response: { token: 'done' } } }];
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const sb = sandbox({ routes: () => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } }), globals: STREAMS });
  const res = await sb.win.fetch('/rest/app-chat/conversations/new');
  let got = '';
  for await (const chunk of res.body) got += new TextDecoder().decode(chunk);
  assert.equal(got, text);
  await sleep(30);
  assert.deepEqual(sb.media().map((i) => [i.url, i.live]), [[asset(ID1, 'generated_video.mp4'), true]]);
});

test('hook: the page gets its own fetch rejection to handle (nothing handles it on its behalf) and the same response', async () => {
  // fetch's own promise, instrumented: which handlers does the hook attach to it?
  const calls = [];
  class Spy extends Promise {
    then(onFulfilled, onRejected) {
      calls.push({ on: this, handlesRejection: typeof onRejected === 'function' });
      return super.then(onFulfilled, onRejected);
    }
  }
  let native = null;
  const sb = sandbox({ globals: { fetch: (url) => (native = url.includes('refuse') ? Spy.reject(new TypeError('Failed to fetch')) : Spy.resolve(json(postList))) } });
  const ok = await sb.win.fetch('/rest/media/post/list');
  assert.equal((await ok.json()).posts.length, 2, 'the same response');
  const p = sb.win.fetch('/rest/refuse');
  assert.notEqual(p, native, 'the page gets a promise derived from fetch\'s');
  const reason = await p.then(
    () => null,
    (e) => e,
  );
  assert.equal(reason.message, 'Failed to fetch', 'with the same rejection');
  assert.equal(calls.filter((c) => c.on === native && c.handlesRejection).length, 0, 'an unhandled rejection stays unhandled for the page (reported to it)');
  assert.equal(sb.win.fetch('/other/refuse'), native, 'non-API requests are not wrapped at all');
  await native.catch(() => {});
});

test('hook: MediaSource URLs are reported as streams and refused; blobs read from Grok media responses carry their URL', async () => {
  class MediaSource {}
  const sb = sandbox({ globals: { MediaSource, Response } });
  const notes = () => sb.posted.filter((p) => p.data?.type === 'object-url').map((p) => p.data);
  const msUrl = sb.win.URL.createObjectURL(new MediaSource());
  const plain = (v) => JSON.parse(JSON.stringify(v)); // objects made in the page realm
  assert.deepEqual(plain(notes()), [{ source: 'gis-hook', type: 'object-url', url: msUrl, mse: true }]);
  sb.win.postMessage({ source: 'gis-content', type: 'fetch-blob', id: 'f1', url: msUrl }, 'https://grok.com');
  await sleep(5);
  const refused = sb.posted.find((p) => p.data?.type === 'fetch-result' && p.data.id === 'f1').data;
  assert.equal(refused.ok, false);
  assert.equal(refused.stream, true);
  // The page downloads a generated clip and plays it from a blob: URL.
  const res = new Response(new Blob(['video-bytes'], { type: 'video/mp4' }));
  Object.defineProperty(res, 'url', { value: asset(ID1, 'generated_video.mp4') });
  const blob = await res.blob();
  assert.equal(await blob.text(), 'video-bytes', 'the page gets its blob');
  const url = sb.win.URL.createObjectURL(blob);
  assert.deepEqual(plain(notes().at(-1)), { source: 'gis-hook', type: 'object-url', url, src: asset(ID1, 'generated_video.mp4') });
  // Other blobs (no Grok media response behind them) are not reported.
  const other = new Response(new Blob(['x']));
  sb.win.URL.createObjectURL(await other.blob());
  assert.equal(notes().length, 2);
  // Notes are replayed with the backlog when the content script says hello.
  const before = sb.posted.length;
  sb.win.postMessage({ source: 'gis-content', type: 'hello' }, 'https://grok.com');
  assert.equal(sb.posted.slice(before).filter((p) => p.data?.type === 'object-url').length, 2);
});

test('hook: the attach probe tells a page that took a pasted file from one that only looked at the list', async () => {
  class DataTransfer {
    constructor(files) {
      this._files = files;
    }
    get files() {
      return this._files;
    }
    get items() {
      return [];
    }
  }
  const sb = sandbox({ globals: { DataTransfer, File } });
  const probe = (id, on) => {
    sb.win.postMessage({ source: 'gis-content', type: 'attach-probe', id, on }, 'https://grok.com');
    return sb.posted.filter((p) => p.data?.type === 'attach-probe' && p.data.id === id).at(-1).data;
  };
  const dt = new DataTransfer([new File(['png'], 'ref.png', { type: 'image/png' })]);
  assert.equal(probe('a', true).on, true);
  assert.equal(dt.files.length, 1); // a handler that only checks for files
  assert.deepEqual([probe('a', false).read, probe('a', false).used], [true, false]);
  probe('b', true);
  const f = dt.files[0];
  assert.equal(f.name, 'ref.png'); // a handler that takes the file
  const r = probe('b', false);
  assert.deepEqual([r.read, r.used], [true, true]);
  probe('c', true);
  assert.deepEqual([probe('c', false).read, probe('c', false).used], [false, false], 'nothing looked at');
  assert.equal(f.name, 'ref.png', 'outside a probe everything works as before');
});
