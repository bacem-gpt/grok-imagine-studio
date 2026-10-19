// MAIN-world content script (document_start, classic script, self-contained: it cannot import modules).
//
// Read-only network sniffer for Grok's media JSON. It wraps window.fetch and XMLHttpRequest WITHOUT altering any
// request or response: same-origin /rest/ (and /api/, RSC) responses are cloned and parsed in the background —
// JSON, NDJSON / JSON lines (chat responses stream one object per line), SSE "data:" lines and RSC "n:{…}" rows.
// Objects that carry media URLs (mediaUrl, hdMediaUrl, videoUrl, imageUrl, url, thumbnailImageUrl …) plus
// prompt / originalPrompt / createTime / modelName / mediaType / mimeType / ids / childPosts, and loose strings that
// look like generated media (absolute URLs or relative "users/<uid>/generated/<id>/…" paths), are reduced to
// compact records and posted to the isolated-world content script:
//     window.postMessage({source: 'gis-hook', type: 'media', items, from, serverDate, clientAt}, location.origin)
// (serverDate = the response's Date header, clientAt = local time when its headers arrived: the content script
// estimates the clock skew between Grok's createTime values and the local clock from them).
// A record's apiId is only set from the record's own id fields (postId / videoId / id …), postId may come from the
// asset URL's /generated/<id>/ folder.
// It also answers {source: 'gis-content', type: 'fetch-blob', id, url} for same-origin blob: URLs (page-owned
// blobs are only readable from the page itself) with {source: 'gis-hook', type: 'fetch-result', id, ok, blob|error},
// and reports what it knows about the page's object URLs: {source: 'gis-hook', type: 'object-url', url, mse} for a
// MediaSource stream (nothing to read), {..., url, src} for a Blob read from a Grok media response (the media URL
// the bytes came from, so the content script can match a <video src="blob:…"> with Grok's record of it).
//
// Transparency: the page gets a promise derived from fetch's (same value, same rejection, and an unhandled rejection
// still reaches the page's handlers). Inspected bodies are read from a clone (a tee); when the page stops reading
// its branch (cancel(), breaking a for-await loop, cancelling a piped stream, aborting a pipe), the clone is cancelled
// too, so the request stops like it would without the extension.
//
// Contract: never throw into the page, never block, never change behaviour, never keep page objects alive.
(() => {
  'use strict';
  const FLAG = '__gisHook';
  try {
    if (window[FLAG]) return;
    Object.defineProperty(window, FLAG, { value: true });
  } catch (e) {
    return;
  }

  const ORIGIN = location.origin;
  const SOURCE = 'gis-hook';
  const MAX_BODY = 8 * 1024 * 1024; // bytes inspected per response
  const MAX_LINE = 4 * 1024 * 1024;
  const MAX_DEPTH = 10;
  const MAX_NODES = 60000; // per parsed document / line
  const MAX_TOTAL_NODES = 600000; // per response
  const MAX_RECORDS = 500; // per response
  const MAX_NESTED_JSON = 1024 * 1024; // string-encoded JSON values we expand
  const MAX_TEXT_SCAN = 64 * 1024; // loose text scanned for URLs
  const FLUSH_MS = 250;

  const TEXT_TYPES = /json|ndjson|jsonl|text\/plain|event-stream|x-component/i;
  const URLISH_RE = /url|generated|https?:|share-/i;
  const RSC_ROW_RE = /^[0-9a-f]{1,8}:(?=[[{"IT])/i;
  const HD_KEYS = ['hdMediaUrl', 'hdVideoUrl', 'hdUrl'];
  const MAIN_KEYS = ['mediaUrl', 'videoUrl', 'imageUrl', 'url', 'fileUrl', 'assetUrl', 'downloadUrl'];
  const THUMB_KEYS = ['thumbnailImageUrl', 'thumbnailUrl', 'previewImageUrl', 'posterUrl', 'thumbnail'];
  const LIST_KEYS = ['generatedImageUrls', 'imageUrls', 'videoUrls', 'mediaUrls'];
  const PROMPT_KEYS = ['prompt', 'originalPrompt', 'videoPrompt', 'imagePrompt', 'revisedPrompt', 'enhancedPrompt'];
  const ID_KEYS = ['postId', 'videoId', 'imageId', 'mediaId'];
  const SKIP_KEY_RE = /avatar|profile|pfp|favicon|logo|icon|banner/i;
  const GEN_PATH_RE = /^\/?users\/[^/\s"'<>]+\/generated\//i;
  const URL_IN_TEXT_RE = /https:\/\/[a-z0-9.-]+\/[^\s"'<>()\\]+|\/?users\/[^\s"'<>()\\/]+\/generated\/[^\s"'<>()\\]+/gi;
  const VIDEO_RE = /\.(mp4|webm|mov|m4v)(?:[?#]|$)|generated_video|share-videos/i;
  const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
  const THUMB_RE = /_thumbnail\.(jpe?g|png|webp)|\/preview_image\.(jpe?g|png|webp)/i;
  const ID_RE = /^[0-9A-Za-z_-]{6,64}$/;
  const UUID_G_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const hasOwn = Object.prototype.hasOwnProperty;
  const noop = () => {};
  let probe = null; // attach probe in progress: {id, read, used} (see below)

  // ---------------------------------------------------------------------------------------------------------
  // Values
  // ---------------------------------------------------------------------------------------------------------

  /** Absolute URL of a Grok generated-media asset, or null (never avatars / UI assets / other hosts). */
  function mediaUrl(raw) {
    if (typeof raw !== 'string') return null;
    let u = raw.trim();
    if (u.length < 10 || u.length > 2048) return null;
    if (u.charCodeAt(0) === 47 && u.charCodeAt(1) === 47) u = 'https:' + u;
    else if (GEN_PATH_RE.test(u)) u = 'https://assets.grok.com/' + u.replace(/^\/+/, '');
    else if (u.slice(0, 8).toLowerCase() !== 'https://') return null;
    let p;
    try {
      p = new URL(u);
    } catch (e) {
      return null;
    }
    const host = p.hostname.toLowerCase();
    const path = p.pathname;
    if (/profile|avatar|pfp|favicon/i.test(path)) return null;
    // Grok's showcase catalogues (agent-skills / templates thumbnails) are not generated media (seen live 2026-10-19).
    if (/\/(agent-skills|skills|templates|presets|examples|showcase|onboarding)\//i.test(path)) return null;
    const generated = /\/generated\//i.test(path);
    const fileLike = VIDEO_RE.test(path) || IMAGE_RE.test(path);
    if (host === 'imagine-public.x.ai' || host.endsWith('.imagine-public.x.ai')) {
      return generated || /\/imagine-public\/|share-(videos|images)/i.test(path) ? p.href : null;
    }
    if (host === 'assets.grok.com' || host === 'assets.grokusercontent.com' || host.endsWith('.grokusercontent.com')) return generated || fileLike ? p.href : null;
    if (host === 'grok.com' || host.endsWith('.grok.com')) return generated ? p.href : null;
    return null;
  }

  function kindFromUrl(u) {
    if (!u) return null;
    if (VIDEO_RE.test(u)) return 'video';
    if (THUMB_RE.test(u)) return 'video';
    if (IMAGE_RE.test(u)) return 'image';
    return null;
  }

  function str(v, max) {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max || 4000) : null;
  }

  function num(v) {
    if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return Number(v) || null;
    return null;
  }

  function idOf(v) {
    if (typeof v === 'number' && isFinite(v)) v = String(v);
    return typeof v === 'string' && ID_RE.test(v) ? v : null;
  }

  function idFromUrl(u) {
    if (!u) return null;
    const m = /\/generated\/([0-9A-Za-z_-]{6,64})(?:\/|$)/.exec(u);
    if (m) return m[1];
    if (/share-videos|share-images|imagine-public/i.test(u)) {
      const all = u.match(UUID_G_RE);
      return all ? all[all.length - 1] : null;
    }
    return null;
  }

  function firstStr(obj, keys) {
    for (const k of keys) {
      if (!hasOwn.call(obj, k)) continue;
      const s = str(obj[k]);
      if (s) return s;
    }
    return null;
  }

  function dimsOf(obj) {
    let w = num(obj.width);
    let h = num(obj.height);
    const r = obj.resolution;
    if ((!w || !h) && r && typeof r === 'object') {
      w = num(r.width);
      h = num(r.height);
    } else if ((!w || !h) && typeof r === 'string') {
      const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/.exec(r.trim());
      if (m) {
        w = Number(m[1]);
        h = Number(m[2]);
      }
    }
    return { w: w || null, h: h || null };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------------------------------------------

  function newCtx(from, serverDate) {
    return {
      from: from || '',
      serverDate: typeof serverDate === 'string' && serverDate.length < 64 ? serverDate : null,
      clientAt: Date.now(),
      records: new Map(),
      queue: new Set(),
      count: 0,
      nodes: 0,
      totalNodes: 0,
      parent: null,
    };
  }

  function addRecord(ctx, r) {
    const id = r.url || r.hdUrl || r.thumbUrl;
    if (!id) return;
    const prev = ctx.records.get(id);
    if (prev) {
      let changed = false;
      for (const k in r) {
        if (hasOwn.call(r, k) && r[k] != null && prev[k] == null) {
          prev[k] = r[k];
          changed = true;
        }
      }
      if (changed) ctx.queue.add(id);
      return;
    }
    if (ctx.count >= MAX_RECORDS) return;
    ctx.records.set(id, r);
    ctx.queue.add(id);
    ctx.count++;
  }

  function firstUrl(obj, keys, used) {
    for (const k of keys) {
      if (!hasOwn.call(obj, k)) continue;
      const u = mediaUrl(obj[k]);
      if (u) {
        used.add(k);
        return u;
      }
    }
    return null;
  }

  /** Media records described by one JSON object (a post, a generation result, a message with images …). */
  function recordsFromObject(obj, ctx) {
    const used = new Set();
    const hd = firstUrl(obj, HD_KEYS, used);
    let main = null;
    let mainKey = null;
    const extra = [];
    for (const k of MAIN_KEYS) {
      if (!hasOwn.call(obj, k)) continue;
      const u = mediaUrl(obj[k]);
      if (!u) continue;
      used.add(k);
      if (!main) {
        main = u;
        mainKey = k;
      } else if (u !== main && u !== hd) extra.push(u);
    }
    let thumb = firstUrl(obj, THUMB_KEYS, used);
    if (main && THUMB_RE.test(main)) {
      // A video poster in a generic url field: it identifies the video, it is not an image post.
      if (!thumb) thumb = main;
      main = extra.length ? extra.shift() : null;
      mainKey = null;
    }
    const lists = [];
    for (const k of LIST_KEYS) {
      const arr = obj[k];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length && i < 50; i++) {
        const x = arr[i];
        const u = mediaUrl(typeof x === 'string' ? x : x && typeof x === 'object' ? x.url || x.imageUrl || x.mediaUrl : null);
        if (u) {
          used.add(k);
          lists.push(u);
        }
      }
    }
    if (!hd && !main && !thumb && !lists.length) return null;

    const parent = ctx.parent;
    const prompt = firstStr(obj, PROMPT_KEYS) || (parent ? parent.prompt : null);
    const model = str(obj.modelName, 80) || str(obj.model, 80);
    const created = obj.createTime != null ? obj.createTime : obj.createdAt != null ? obj.createdAt : obj.createTimestamp;
    const createdAt = typeof created === 'string' || typeof created === 'number' ? created : null;
    const mime = str(obj.mimeType, 80) || str(obj.mime, 80);
    // A streaming generation that has not finished yet (its URL may not exist yet): report nothing for now.
    const pending = typeof obj.progress === 'number' && obj.progress < 100;
    const out = [];
    let postId = null;

    if (hd || main || thumb) {
      const mt = typeof obj.mediaType === 'string' ? obj.mediaType : '';
      let kind = /VIDEO/i.test(mt) ? 'video' : /IMAGE/i.test(mt) ? 'image' : null;
      if (!kind && mime) kind = /^video\//i.test(mime) ? 'video' : /^image\//i.test(mime) ? 'image' : null;
      if (!kind && (hd || main)) {
        kind = kindFromUrl(hd || main);
        if (!kind) kind = mainKey === 'videoUrl' ? 'video' : mainKey === 'imageUrl' ? 'image' : null;
      }
      if (!kind && thumb && THUMB_RE.test(thumb)) kind = 'video';
      const looksPost = hasOwn.call(obj, 'mediaType') || hasOwn.call(obj, 'mediaUrl') || hasOwn.call(obj, 'hdMediaUrl') || hasOwn.call(obj, 'childPosts');
      for (const k of ID_KEYS) {
        postId = idOf(obj[k]);
        if (postId) break;
      }
      if (!postId && looksPost) postId = idOf(obj.id);
      const apiId = postId;
      if (!postId) postId = idFromUrl(hd || main || thumb);
      if (!pending) {
        const d = dimsOf(obj);
        out.push({
          kind,
          url: main || hd,
          hdUrl: hd && hd !== main ? hd : null,
          thumbUrl: thumb,
          postId,
          apiId,
          parentId: parent ? parent.postId : null,
          prompt,
          model,
          createdAt,
          mime,
          width: d.w,
          height: d.h,
          duration: num(obj.duration) || num(obj.durationSeconds) || num(obj.videoDuration),
          live: typeof obj.progress === 'number' || undefined, // finished streaming generation: brand new media
        });
      }
    }
    if (!pending) {
      for (const u of extra) out.push({ kind: kindFromUrl(u), url: u, postId: idFromUrl(u), parentId: postId, prompt: null });
      for (const u of lists) {
        const isThumb = THUMB_RE.test(u);
        out.push({ kind: isThumb ? 'video' : kindFromUrl(u) || 'image', url: isThumb ? null : u, thumbUrl: isThumb ? u : null, postId: idFromUrl(u), parentId: postId, prompt, model, createdAt });
      }
    }
    return { used, out, parent: { postId: postId || (parent ? parent.postId : null), prompt } };
  }

  function walk(node, depth, ctx) {
    if (depth > MAX_DEPTH || ctx.count >= MAX_RECORDS) return;
    if (++ctx.nodes > MAX_NODES || ++ctx.totalNodes > MAX_TOTAL_NODES) return;
    if (typeof node === 'string') {
      looseText(node, depth, ctx);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const n = Math.min(node.length, 5000);
      for (let i = 0; i < n; i++) walk(node[i], depth + 1, ctx);
      return;
    }
    const found = recordsFromObject(node, ctx);
    if (found) for (const r of found.out) addRecord(ctx, r);
    const prevParent = ctx.parent;
    if (found) ctx.parent = found.parent; // nested objects (childPosts …) inherit post id + prompt
    for (const k in node) {
      if (!hasOwn.call(node, k) || (found && found.used.has(k)) || SKIP_KEY_RE.test(k)) continue;
      const v = node[k];
      if (typeof v === 'string') looseText(v, depth + 1, ctx);
      else if (v && typeof v === 'object') walk(v, depth + 1, ctx);
    }
    ctx.parent = prevParent;
  }

  function looseText(s, depth, ctx) {
    const n = s.length;
    if (n < 10) return;
    const c = s.charCodeAt(0);
    if ((c === 123 || c === 91) && n <= MAX_NESTED_JSON && depth < MAX_DEPTH && URLISH_RE.test(s)) {
      // String-encoded JSON (card attachments, tool results …)
      let v = null;
      try {
        v = JSON.parse(s);
      } catch (e) {
        v = null;
      }
      if (v && typeof v === 'object') {
        walk(v, depth + 1, ctx);
        return;
      }
    }
    if (n > MAX_TEXT_SCAN) return;
    if (s.indexOf('generated') < 0 && s.indexOf('imagine-public') < 0 && s.indexOf('share-') < 0) return;
    URL_IN_TEXT_RE.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = URL_IN_TEXT_RE.exec(s)) && guard++ < 50) {
      const u = mediaUrl(m[0].replace(/[.,;:!?)\]]+$/, ''));
      if (!u) continue;
      const thumb = THUMB_RE.test(u);
      addRecord(ctx, {
        kind: thumb ? 'video' : kindFromUrl(u),
        url: thumb ? null : u,
        thumbUrl: thumb ? u : null,
        postId: idFromUrl(u),
        parentId: ctx.parent ? ctx.parent.postId : null,
        prompt: null,
      });
    }
  }

  /** One line of a streamed body. Returns 1 parsed JSON, 0 nothing to do, -1 not JSON. */
  function handleLine(line, ctx) {
    let s = line.trim();
    if (!s) return 0;
    if (s.slice(0, 5) === 'data:') s = s.slice(5).trim();
    else {
      const m = RSC_ROW_RE.exec(s);
      if (m) s = s.slice(m[0].length);
    }
    if (!s || s === '[DONE]') return 0;
    if (!URLISH_RE.test(s)) return 0; // token / progress lines without URLs: skip the parse entirely
    const c = s.charCodeAt(0);
    if (c !== 123 && c !== 91) {
      looseText(s, 0, ctx);
      return -1;
    }
    if (s.length > MAX_LINE) return -1;
    let v;
    try {
      v = JSON.parse(s);
    } catch (e) {
      looseText(s, 0, ctx);
      return -1;
    }
    ctx.nodes = 0;
    walk(v, 0, ctx);
    return 1;
  }

  function parseWhole(text, ctx) {
    if (!URLISH_RE.test(text)) return;
    let v;
    try {
      v = JSON.parse(text);
    } catch (e) {
      return;
    }
    ctx.nodes = 0;
    walk(v, 0, ctx);
  }

  // Records seen before the isolated-world content script is listening (it starts at document_idle, after
  // Grok's first API calls) are kept in a bounded backlog of batches and replayed when it says hello.
  const MAX_BACKLOG = 1500; // records
  const backlog = []; // [{items, from, serverDate, clientAt}]
  let backlogSize = 0;

  function post(batch) {
    try {
      window.postMessage({ source: SOURCE, type: 'media', items: batch.items, from: batch.from, serverDate: batch.serverDate, clientAt: batch.clientAt }, ORIGIN);
    } catch (e) {
      /* ignore */
    }
  }

  function flush(ctx) {
    if (!ctx.queue.size) return;
    const items = [];
    for (const id of ctx.queue) {
      const r = ctx.records.get(id);
      if (r) items.push(Object.assign({}, r));
    }
    ctx.queue.clear();
    const batch = { items, from: ctx.from, serverDate: ctx.serverDate, clientAt: ctx.clientAt };
    backlog.push(batch);
    backlogSize += items.length;
    while (backlogSize > MAX_BACKLOG && backlog.length > 1) backlogSize -= backlog.shift().items.length;
    post(batch);
  }

  const idle = () =>
    new Promise((resolve) => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: 1500 });
      else setTimeout(resolve, 0);
    });

  /** Processes a complete text body (XHR). */
  async function processText(text, ctx) {
    try {
      if (!text || text.length > MAX_BODY) return;
      await idle();
      let parsed = false;
      let start = 0;
      while (start <= text.length) {
        let nl = text.indexOf('\n', start);
        if (nl < 0) nl = text.length;
        if (handleLine(text.slice(start, nl), ctx) > 0) parsed = true;
        start = nl + 1;
      }
      if (!parsed && text.indexOf('\n') >= 0) parseWhole(text, ctx);
    } catch (e) {
      /* ignore */
    }
    flush(ctx);
  }

  /** Reads a cloned response body progressively (streamed NDJSON gets reported as it arrives). */
  async function readBody(res, ctx, follow) {
    let reader = null;
    try {
      reader = res.body.getReader();
      follow.reader = reader;
      if (follow.stopped) {
        reader.cancel().catch(noop); // the page gave up on its branch before we started
        return;
      }
      const decoder = new TextDecoder();
      let buf = '';
      let whole = '';
      let keepWhole = true;
      let sawNewline = false;
      let parsed = false;
      let total = 0;
      let lastFlush = Date.now();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        const chunk = step.value;
        total += (chunk && chunk.byteLength) || 0;
        if (total > MAX_BODY) {
          keepWhole = false;
          reader.cancel().catch(noop); // only cancels our tee branch
          break;
        }
        const text = decoder.decode(chunk, { stream: true });
        const from = buf.length;
        buf += text;
        let nl = buf.indexOf('\n', from);
        if (nl >= 0 && !sawNewline) {
          sawNewline = true;
          if (keepWhole && !parsed) whole = buf;
        } else if (sawNewline && keepWhole && !parsed) whole += text;
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.length > 65536) await idle();
          if (handleLine(line, ctx) > 0) parsed = true;
          nl = buf.indexOf('\n');
        }
        if (parsed && whole) {
          whole = '';
          keepWhole = false;
        }
        if (buf.length > MAX_LINE) {
          buf = '';
          keepWhole = false;
        }
        if (Date.now() - lastFlush > FLUSH_MS) {
          flush(ctx);
          lastFlush = Date.now();
        }
      }
      buf += decoder.decode();
      if (buf) {
        if (buf.length > 65536) await idle();
        if (handleLine(buf, ctx) > 0) parsed = true;
      }
      if (!parsed && sawNewline && keepWhole && whole) {
        await idle();
        parseWhole(whole, ctx);
      }
    } catch (e) {
      /* aborted / network error: report what we have */
    }
    flush(ctx);
  }

  // ---------------------------------------------------------------------------------------------------------
  // fetch / XHR wrappers (read-only)
  // ---------------------------------------------------------------------------------------------------------

  function pathOf(raw) {
    try {
      return new URL(raw, location.href).pathname;
    } catch (e) {
      return '';
    }
  }

  function shouldSniff(raw) {
    try {
      const u = new URL(raw, location.href);
      if (u.origin !== ORIGIN) return false;
      return /^\/(rest|api)\//.test(u.pathname) || u.searchParams.has('_rsc');
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Following the page's branch of a tee: res.clone() tees the body, and a tee only cancels its source once BOTH
  // branches are cancelled. `followed` maps the page's body stream (and readers / piped streams derived from it) to
  // our branch's controller; the stream methods are wrapped read-only to notice when the page stops reading.
  // ---------------------------------------------------------------------------------------------------------

  const followed = new WeakMap(); // page stream | reader | iterator source -> {reader, stopped, stop()}

  function newFollow() {
    return {
      reader: null,
      stopped: false,
      stop() {
        if (this.stopped) return;
        this.stopped = true;
        try {
          if (this.reader) this.reader.cancel().catch(noop);
        } catch (e) {
          /* ignore */
        }
      },
    };
  }

  function stopFollowing(obj) {
    try {
      const f = obj && followed.get(obj);
      if (f) f.stop();
    } catch (e) {
      /* never affect the page */
    }
  }

  /** Makes a wrapper look like the native function it replaces (name, length, toString). */
  function nativeLike(wrapper, orig) {
    try {
      Object.defineProperty(wrapper, 'name', { value: orig.name, configurable: true });
      Object.defineProperty(wrapper, 'length', { value: orig.length, configurable: true });
      Object.defineProperty(wrapper, 'toString', { value: () => Function.prototype.toString.call(orig), configurable: true, writable: true });
    } catch (e) {
      /* cosmetic */
    }
    return wrapper;
  }

  /** Replaces proto[key] (keeping its property attributes) with make(original); no-op when it is not a function. */
  function wrapMethod(proto, key, make) {
    try {
      const desc = proto && Object.getOwnPropertyDescriptor(proto, key);
      if (!desc || typeof desc.value !== 'function') return null;
      const wrapper = nativeLike(make(desc.value), desc.value);
      Object.defineProperty(proto, key, Object.assign({}, desc, { value: wrapper }));
      return wrapper;
    } catch (e) {
      return null;
    }
  }

  const RS = window.ReadableStream;
  if (typeof RS === 'function' && RS.prototype) {
    const P = RS.prototype;
    wrapMethod(P, 'cancel', (orig) =>
      function cancel() {
        stopFollowing(this);
        return orig.apply(this, arguments);
      },
    );
    wrapMethod(P, 'getReader', (orig) =>
      function getReader() {
        const reader = orig.apply(this, arguments);
        try {
          const f = followed.get(this);
          if (f && reader && typeof reader === 'object') followed.set(reader, f);
        } catch (e) {
          /* ignore */
        }
        return reader;
      },
    );
    // Async iteration (for await … of res.body): breaking out of the loop calls the iterator's return().
    const iterating = (orig) =>
      function values() {
        const it = orig.apply(this, arguments);
        try {
          const f = followed.get(this);
          const ret = it && it.return;
          if (f && typeof ret === 'function') {
            Object.defineProperty(it, 'return', {
              value: function () {
                f.stop();
                return ret.apply(this, arguments);
              },
              configurable: true,
              writable: true,
            });
          }
        } catch (e) {
          /* ignore */
        }
        return it;
      };
    const valuesFn = P.values;
    const wrappedValues = wrapMethod(P, 'values', iterating);
    if (typeof Symbol === 'function' && Symbol.asyncIterator) {
      if (wrappedValues && P[Symbol.asyncIterator] === valuesFn) {
        try {
          const desc = Object.getOwnPropertyDescriptor(P, Symbol.asyncIterator);
          Object.defineProperty(P, Symbol.asyncIterator, Object.assign({}, desc, { value: wrappedValues }));
        } catch (e) {
          /* ignore */
        }
      } else wrapMethod(P, Symbol.asyncIterator, iterating);
    }
    const onAbort = (opts, f) => {
      try {
        const signal = opts && opts.signal;
        if (signal && typeof signal.addEventListener === 'function') {
          if (signal.aborted) f.stop();
          else signal.addEventListener('abort', () => f.stop(), { once: true });
        }
      } catch (e) {
        /* ignore */
      }
    };
    wrapMethod(P, 'pipeTo', (orig) =>
      function pipeTo(dest, opts) {
        const f = followed.get(this);
        if (f) onAbort(opts, f);
        return orig.apply(this, arguments);
      },
    );
    // A piped stream (pipeThrough(new TextDecoderStream()) …) carries the page's reading on: follow it too.
    wrapMethod(P, 'pipeThrough', (orig) =>
      function pipeThrough(transform, opts) {
        const out = orig.apply(this, arguments);
        try {
          const f = followed.get(this);
          if (f) {
            onAbort(opts, f);
            if (out && typeof out === 'object') followed.set(out, f);
          }
        } catch (e) {
          /* ignore */
        }
        return out;
      },
    );
  }
  for (const name of ['ReadableStreamDefaultReader', 'ReadableStreamBYOBReader']) {
    const R = window[name];
    if (typeof R !== 'function' || !R.prototype) continue;
    wrapMethod(R.prototype, 'cancel', (orig) =>
      function cancel() {
        stopFollowing(this);
        return orig.apply(this, arguments);
      },
    );
  }

  function inspectResponse(res, url) {
    try {
      if (!res || typeof res.clone !== 'function' || res.bodyUsed) return;
      if (res.type === 'opaque' || res.type === 'opaqueredirect' || !res.ok || res.status === 204) return;
      const ct = (res.headers && res.headers.get('content-type')) || '';
      if (ct && !TEXT_TYPES.test(ct)) return;
      const len = Number((res.headers && res.headers.get('content-length')) || 0);
      if (len > MAX_BODY) return;
      const clone = res.clone();
      if (!clone.body) return;
      const follow = newFollow();
      if (res.body) followed.set(res.body, follow);
      readBody(clone, newCtx(pathOf(url), res.headers && res.headers.get('date')), follow).catch(noop);
    } catch (e) {
      /* never affect the page */
    }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    const wrapped = function fetch(input, init) {
      const promise = nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input && typeof input === 'object' ? input.url || input.href || '' : String(input || '');
        if (url && shouldSniff(url) && promise && typeof promise.then === 'function') {
          // A promise derived from fetch's: the same response or rejection; inspection runs before the page's handlers,
          // and a rejection the page leaves unhandled is still reported to it (handling fetch's own promise here
          // would swallow it).
          return promise.then((res) => {
            inspectResponse(res, url);
            return res;
          });
        }
      } catch (e) {
        /* never affect the page */
      }
      return promise;
    };
    try {
      Object.defineProperty(wrapped, 'toString', { value: () => Function.prototype.toString.call(nativeFetch), configurable: true, writable: true });
    } catch (e) {
      /* cosmetic */
    }
    try {
      window.fetch = wrapped;
    } catch (e) {
      /* non-writable fetch: give up silently */
    }
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
    const xhrUrls = new WeakMap();
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    const onXhrDone = function () {
      const xhr = this;
      try {
        xhr.removeEventListener('loadend', onXhrDone);
        if (xhr.status < 200 || xhr.status >= 300) return;
        const ct = xhr.getResponseHeader('content-type') || '';
        if (ct && !TEXT_TYPES.test(ct)) return;
        const url = xhrUrls.get(xhr) || '';
        const date = xhr.getResponseHeader('date');
        const rt = xhr.responseType;
        if (rt === '' || rt === 'text') {
          const text = xhr.responseText;
          if (text && text.length <= MAX_BODY && URLISH_RE.test(text)) processText(text, newCtx(pathOf(url), date)).catch(noop);
        } else if (rt === 'json') {
          const obj = xhr.response;
          if (obj && typeof obj === 'object') {
            const ctx = newCtx(pathOf(url), date);
            idle().then(() => {
              try {
                walk(obj, 0, ctx);
              } catch (e) {
                /* ignore */
              }
              flush(ctx);
            });
          }
        }
      } catch (e) {
        /* never affect the page */
      }
    };
    XHR.prototype.open = function (method, url) {
      try {
        xhrUrls.set(this, String(url));
      } catch (e) {
        /* ignore */
      }
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        const url = xhrUrls.get(this);
        if (url && shouldSniff(url)) this.addEventListener('loadend', onXhrDone);
      } catch (e) {
        /* ignore */
      }
      return origSend.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Page-owned blob: URLs for the content script (it cannot always read them from the isolated world, and
  // grok.com's connect-src does not allow fetching blob: URLs). URL.createObjectURL is wrapped read-only to
  // remember which Blob a URL stands for; entries are dropped on revoke, so nothing outlives the page's own URL.
  // MediaSource URLs are remembered as streams (they cannot be read), and a Blob the page read from a Grok media
  // response (Response.prototype.blob, wrapped read-only) is reported with the media URL it came from.
  // ---------------------------------------------------------------------------------------------------------

  const MAX_BLOB_URLS = 300;
  const MAX_URL_NOTES = 200;
  const blobUrls = new Map(); // blob: URL -> Blob
  const streamUrls = new Set(); // blob: URLs of MediaSource objects
  const blobSources = new WeakMap(); // Blob -> media URL it was read from
  const urlNotes = []; // object-url notes, replayed when the content script says hello

  function noteObjectUrl(note) {
    urlNotes.push(note);
    if (urlNotes.length > MAX_URL_NOTES) urlNotes.shift();
    try {
      window.postMessage(Object.assign({ source: SOURCE, type: 'object-url' }, note), ORIGIN);
    } catch (e) {
      /* ignore */
    }
  }

  try {
    const RP = window.Response && window.Response.prototype;
    wrapMethod(RP, 'blob', (orig) =>
      function blob() {
        const p = orig.apply(this, arguments);
        try {
          const src = typeof this.url === 'string' ? mediaUrl(this.url) : null;
          if (src && p && typeof p.then === 'function') {
            return p.then((b) => {
              try {
                if (b && typeof b === 'object') blobSources.set(b, src);
              } catch (e) {
                /* ignore */
              }
              return b;
            });
          }
        } catch (e) {
          /* never affect the page */
        }
        return p;
      },
    );
  } catch (e) {
    /* never affect the page */
  }

  try {
    const U = window.URL;
    const origCreate = U && U.createObjectURL;
    const origRevoke = U && U.revokeObjectURL;
    if (typeof origCreate === 'function' && typeof origRevoke === 'function') {
      U.createObjectURL = nativeLike(function createObjectURL(obj) {
        const url = origCreate.apply(this, arguments);
        try {
          if (probe && typeof Blob === 'function' && obj instanceof Blob) probe.used = true;
          if (typeof url === 'string' && typeof Blob === 'function' && obj instanceof Blob) {
            blobUrls.set(url, obj);
            if (blobUrls.size > MAX_BLOB_URLS) blobUrls.delete(blobUrls.keys().next().value);
            const src = blobSources.get(obj);
            if (src) noteObjectUrl({ url, src });
          } else if (typeof url === 'string' && typeof window.MediaSource === 'function' && obj instanceof window.MediaSource) {
            streamUrls.add(url);
            if (streamUrls.size > MAX_BLOB_URLS) streamUrls.delete(streamUrls.values().next().value);
            noteObjectUrl({ url, mse: true });
          }
        } catch (e) {
          /* ignore */
        }
        return url;
      }, origCreate);
      U.revokeObjectURL = nativeLike(function revokeObjectURL(url) {
        try {
          blobUrls.delete(String(url));
          streamUrls.delete(String(url));
        } catch (e) {
          /* ignore */
        }
        return origRevoke.apply(this, arguments);
      }, origRevoke);
    }
  } catch (e) {
    /* never affect the page */
  }

  // ---------------------------------------------------------------------------------------------------------
  // Attach probe: while the content script pastes / drops an image into Grok's composer (a moment around the
  // synthetic event), record what page code does with it: `read` = it looked at the event's files (DataTransfer
  // files / items), `used` = it inspected or read a file (name, type, size, its bytes, a preview URL). A handler that
  // takes the image without preventDefault() uses it; one that ignores it at most looks at the list. Read-only
  // wrappers, inert outside a probe.
  // ---------------------------------------------------------------------------------------------------------

  function wrapGetter(proto, key, flag) {
    try {
      const desc = proto && Object.getOwnPropertyDescriptor(proto, key);
      if (!desc || typeof desc.get !== 'function') return;
      const get = desc.get;
      const getter = nativeLike(function () {
        if (probe) probe[flag] = true;
        return get.call(this);
      }, get);
      Object.defineProperty(proto, key, Object.assign({}, desc, { get: getter }));
    } catch (e) {
      /* never affect the page */
    }
  }

  function flagMethod(proto, key) {
    wrapMethod(proto, key, (orig) =>
      function () {
        if (probe) probe.used = true;
        return orig.apply(this, arguments);
      },
    );
  }

  const DTP = window.DataTransfer && window.DataTransfer.prototype;
  for (const key of ['files', 'items']) wrapGetter(DTP, key, 'read');
  const BP = window.Blob && window.Blob.prototype;
  for (const key of ['type', 'size']) wrapGetter(BP, key, 'used');
  wrapGetter(window.File && window.File.prototype, 'name', 'used');
  for (const key of ['arrayBuffer', 'text', 'stream', 'slice', 'bytes']) flagMethod(BP, key);
  const FRP = window.FileReader && window.FileReader.prototype;
  for (const key of ['readAsDataURL', 'readAsArrayBuffer', 'readAsText', 'readAsBinaryString']) flagMethod(FRP, key);

  window.addEventListener('message', (e) => {
    try {
      if (e.source !== window || e.origin !== ORIGIN) return;
      const d = e.data;
      if (!d || typeof d !== 'object' || d.source !== 'gis-content') return;
      if (d.type === 'attach-probe') {
        let read = false;
        let used = false;
        if (d.on) probe = { id: d.id, read: false, used: false };
        else if (probe && probe.id === d.id) {
          read = probe.read;
          used = probe.used;
          probe = null;
        }
        window.postMessage({ source: SOURCE, type: 'attach-probe', id: d.id, on: !!d.on, read, used }, ORIGIN);
        return;
      }
      if (d.type === 'hello') {
        for (const batch of backlog) post({ items: batch.items, from: 'backlog', serverDate: batch.serverDate, clientAt: batch.clientAt });
        for (const note of urlNotes.slice()) window.postMessage(Object.assign({ source: SOURCE, type: 'object-url' }, note), ORIGIN);
        return;
      }
      if (d.type !== 'fetch-blob') return;
      const id = d.id;
      const url = String(d.url || '');
      const reply = (msg) => {
        try {
          window.postMessage(Object.assign({ source: SOURCE, type: 'fetch-result', id }, msg), ORIGIN);
        } catch (err) {
          /* ignore */
        }
      };
      if (url.indexOf('blob:' + ORIGIN + '/') !== 0) {
        reply({ ok: false, error: 'Only page blob: URLs can be read' });
        return;
      }
      if (streamUrls.has(url)) {
        reply({ ok: false, stream: true, error: 'Grok streams this clip (MediaSource): there is no file to read on the page' });
        return;
      }
      const known = blobUrls.get(url);
      if (known) {
        reply({ ok: true, blob: known });
        return;
      }
      if (typeof nativeFetch !== 'function') {
        reply({ ok: false, error: 'This blob is no longer available' });
        return;
      }
      nativeFetch
        .call(window, url)
        .then((r) => r.blob())
        .then(
          (blob) => reply({ ok: true, blob }),
          (err) => reply({ ok: false, error: String((err && err.message) || err) }),
        );
    } catch (err) {
      /* ignore */
    }
  });
})();
