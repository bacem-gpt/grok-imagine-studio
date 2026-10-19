// Mock grok.com behaviour for the E2E suite (served at /fixtures/mock-grok.js, loaded with the test nonce under
// grok.com's CSP). Mirrors the real facts the extension relies on (docs/ARCHITECTURE.md "Grok facts"):
//  - Imagine feed: role=listitem masonry cards (div[class*="group/media-post-masonry-card"]) rendered from
//    POST /rest/media/post/list; infinite scroll requests the next page; SPA links to /imagine/post/<id>
//  - post page: main > article with video#sd-video + video#hd-video, variant thumbnails, "Make a video" box
//  - chat: user/assistant rows ([id^="response-"], items-end / items-start), a streamed NDJSON reply with a video
//  - composers: .query-bar contenteditable (ProseMirror-like) or textarea, Upload image button + hidden file input,
//    submit button with the arrow icon (disabled while empty); submitting starts a (mock) generation
// Test hooks: window.__mock = {submitted, attached, generated, listPosts, streams, errors, log}.
// Page URL switches: ?strict (editor only accepts pasted text), ?noinput (no file input: attach must paste),
// ?nopaste (the editor ignores pasted files: attach must drop), ?nosubmitbtn (no submit button: Enter submits),
// ?gen=<postId> (the mock generation returns that post), ?page2age=<s> / ?skew=<s> (forwarded to the mock API: age
// of the feed's page-2 posts, server clock running behind the browser's), ?stream (chat streams a reply on load).
(() => {
  'use strict';
  const USER = 'test-user-0000';
  const ARROW = 'M6 11L12 5M12 5L18 11M12 5V19';
  // Same fake posts as tests/e2e/fixtures-map.mjs (post pages are "server rendered" without an API call).
  const POSTS = {
    '11111111-1111-4111-8111-111111111111': { kind: 'video', prompt: 'A red sports car drifting through neon rain, cinematic tracking shot' },
    '22222222-2222-4222-8222-222222222222': { kind: 'video', prompt: 'A misty green forest at dawn, slow dolly forward' },
    '33333333-3333-4333-8333-333333333333': { kind: 'video', prompt: 'Deep blue ocean waves crashing on black rocks, drone shot' },
    '44444444-4444-4444-8444-444444444444': { kind: 'video', prompt: 'A purple nebula swirling, slow orbit, 24fps HD' },
    '55555555-5555-4555-8555-555555555555': { kind: 'image', prompt: 'A colorful test pattern poster' },
    '66666666-6666-4666-8666-666666666666': { kind: 'video', prompt: 'Vertical orange sunset over a desert road' },
  };
  const params = new URLSearchParams(location.search);
  const mock = (window.__mock = { page: document.body.dataset.page, submitted: [], attached: [], generated: [], listPosts: 0, listCalls: 0, streams: 0, errors: [], log: [] });
  window.addEventListener('error', (e) => mock.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => mock.errors.push(String(e.reason?.message || e.reason)));

  const asset = (id, name) => `https://assets.grok.com/users/${USER}/generated/${id}/${name}`;
  const abs = (u) => (!u ? null : /^https?:/.test(u) ? u : `https://assets.grok.com/${u.replace(/^\/+/, '')}`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c != null) node.append(c);
    return node;
  }

  function icon(d, size = 18, fill = false) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', fill ? 'currentColor' : 'none');
    svg.setAttribute('stroke', fill ? 'none' : 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const part of [].concat(d)) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', part);
      svg.append(p);
    }
    return svg;
  }

  async function* ndjson(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) yield JSON.parse(line);
      }
    }
    if (buf.trim()) yield JSON.parse(buf);
  }

  // -------------------------------------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------------------------------------

  /** Wires a composer form: editor (contenteditable or textarea), upload, paste/drop of files, submit. */
  function setupComposer(form, onSubmit) {
    const editor = form.querySelector('[contenteditable="true"], textarea');
    let send = form.querySelector('button[type="submit"]');
    if (send && params.has('nosubmitbtn')) {
      send.remove();
      send = null;
    }
    let fileInput = form.querySelector('input[type="file"]');
    if (fileInput && params.has('noinput')) {
      fileInput.remove();
      fileInput = null;
    }
    const uploadBtn = form.querySelector('button[aria-label="Upload image"]');
    const attachments = form.querySelector('.attachments');
    const rich = editor.isContentEditable;
    // ?strict: a state-driven editor that re-renders from its own model and reverts DOM edits it did not make
    // (execCommand), so only its paste handler can change the text.
    const strict = rich && params.has('strict');
    let model = '';
    const getText = () => (rich ? editor.innerText.replace(/\n$/, '') : editor.value);
    const update = () => {
      if (send) send.disabled = !getText().trim();
      if (rich) {
        const first = editor.firstElementChild;
        if (!first || first.tagName !== 'P') {
          const p = h('p', { 'data-placeholder': editor.dataset.placeholder || '' });
          while (editor.firstChild) p.append(editor.firstChild);
          editor.append(p);
        }
        const p = editor.firstElementChild;
        p.dataset.placeholder = editor.dataset.placeholder || '';
        p.classList.toggle('is-empty', !getText().trim() && editor.children.length === 1);
      }
    };
    const render = (text) => {
      editor.replaceChildren(h('p', {}, text ? [text] : [h('br')]));
      update();
    };
    const clear = () => {
      model = '';
      if (rich) editor.replaceChildren(h('p', {}, [h('br')]));
      else editor.value = '';
      attachments?.replaceChildren();
      update();
    };
    const addFiles = (files, method) => {
      for (const f of files) {
        mock.attached.push({ name: f.name, size: f.size, type: f.type, method });
        if (attachments && f.type.startsWith('image/')) attachments.append(h('div', { class: 'att' }, [h('img', { alt: 'Attachment', src: URL.createObjectURL(f) })]));
      }
    };
    const insertPlain = (text) => {
      const sel = getSelection();
      if (!sel.rangeCount || !editor.contains(sel.anchorNode)) {
        const r = document.createRange();
        r.selectNodeContents(editor);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      editor.querySelectorAll('br').forEach((b) => b.parentElement?.childNodes.length > 1 && b.remove());
    };
    const submit = () => {
      const text = getText().trim();
      if (!text) return;
      mock.submitted.push(text);
      clear();
      onSubmit?.(text);
    };

    editor.addEventListener('input', (e) => {
      if (strict) {
        mock.log.push('reverted-' + (e.inputType || 'input'));
        render(model);
        return;
      }
      update();
    });
    editor.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length && !params.has('nopaste')) {
        e.preventDefault();
        addFiles(files, 'paste');
        return;
      }
      if (!rich) return;
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        e.preventDefault();
        insertPlain(text);
        model = getText();
        update();
      }
    });
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    uploadBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      addFiles([...fileInput.files], 'input');
      fileInput.value = '';
    });
    form.addEventListener('dragover', (e) => e.preventDefault());
    form.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      addFiles(files, 'drop');
    });
    clear();
    return { editor, update, clear };
  }

  // -------------------------------------------------------------------------------------------------------
  // Imagine feed / favorites
  // -------------------------------------------------------------------------------------------------------

  function card({ id, kind, mediaUrl, thumbUrl, caption = null, moderated = false, meta = null }) {
    const media =
      kind === 'video'
        ? h('video', { src: mediaUrl, poster: thumbUrl || null, muted: true, loop: true, playsinline: true, preload: 'metadata' })
        : h('img', { class: 'media', alt: moderated ? 'Moderated' : '', src: mediaUrl, draggable: 'false' });
    if (kind === 'video') media.muted = true;
    const inner = h('div', { class: 'group/media-post-masonry-card relative card' + (moderated ? ' moderated' : ''), 'data-post-id': id || null }, [
      media,
      id ? h('a', { class: 'card-link', href: `/imagine/post/${id}`, 'aria-label': 'Open post' }) : null,
      h('div', { class: 'card-shade' }),
      h('button', { class: 'card-fav', type: 'button', 'aria-label': 'Favorite' }, [icon('M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z', 16)]),
      caption ? h('p', { class: 'card-caption', text: caption }) : null,
      meta ? h('span', { class: 'card-meta', text: meta }) : null,
    ]);
    if (kind === 'video') {
      inner.addEventListener('mouseenter', () => media.play().catch(() => {}));
      inner.addEventListener('mouseleave', () => media.pause());
    }
    return h('div', { role: 'listitem' }, [inner]);
  }

  function postCard(post) {
    const isVideo = post.mediaType === 'MEDIA_POST_TYPE_VIDEO';
    return card({ id: post.id, kind: isVideo ? 'video' : 'image', mediaUrl: post.mediaUrl, thumbUrl: isVideo ? post.thumbnailImageUrl : null, meta: isVideo ? 'Video' : null });
  }

  let feedState = { loading: false, done: false };

  async function renderFeed(kind) {
    const main = $('main.main');
    main.replaceChildren(
      h('div', { class: 'topbar' }, [
        h('h1', { text: 'Imagine' }),
        h('nav', { class: 'tabs' }, [
          h('a', { href: '/imagine', class: kind === 'imagine' ? 'active' : null, text: 'For you' }),
          h('a', { href: '/imagine/favorites', class: kind === 'favorites' ? 'active' : null, text: 'Favorites' }),
        ]),
      ]),
      h('section', { class: 'feed' }, [h('div', { role: 'list', class: 'masonry', id: 'feed' })]),
      h('div', { class: 'sentinel', id: 'sentinel', text: 'Scroll for more' }),
    );
    $('.query-dock').hidden = false;
    feedState = { loading: false, done: kind !== 'imagine' };
    const feed = $('#feed');
    mock.listCalls++;
    const res = await fetch('/rest/media/post/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 40, filter: { source: kind === 'favorites' ? 'MEDIA_POST_SOURCE_LIKED' : 'MEDIA_POST_SOURCE_OWNED' } }),
    });
    const data = await res.json();
    mock.listPosts = (data.posts || []).length;
    for (const post of data.posts || []) feed.append(postCard(post));
    if (kind === 'imagine') {
      // A clip without any API record (DOM-only detection, prompt from the card text) and a moderated image.
      feed.append(card({ kind: 'video', mediaUrl: 'https://assets.grok.com/test/clip-cyan.webm', caption: 'Cyan light waves rolling over a glass floor, loop', meta: null }));
      feed.append(card({ kind: 'image', mediaUrl: 'https://assets.grok.com/test/still.png', moderated: true, caption: 'Content moderated' }));
    }
  }

  async function loadNextPage() {
    if (feedState.loading || feedState.done) return;
    feedState.loading = true;
    $('#sentinel').textContent = 'Loading…';
    try {
      mock.listCalls++;
      let url = '/rest/media/post/list?cursor=page-2';
      if (params.has('page2age')) url += `&age=${encodeURIComponent(params.get('page2age'))}`;
      if (params.has('skew')) url += `&skew=${encodeURIComponent(params.get('skew'))}`;
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor: 'page-2' }) });
      const data = await res.json();
      await sleep(250);
      for (const post of data.posts || []) $('#feed')?.append(postCard(post));
      feedState.done = true;
      $('#sentinel').textContent = "You're all caught up";
    } finally {
      feedState.loading = false;
    }
  }

  function placeholderCard() {
    const bar = h('i');
    const label = h('span', { class: 'gen-label', text: 'Generating… 0%' });
    const node = h('div', { role: 'listitem' }, [h('div', { class: 'group/media-post-masonry-card relative card generating' }, [h('div', {}, [label, h('div', { class: 'gen-bar' }, [bar])])])]);
    return {
      node,
      progress(p) {
        label.textContent = `Generating… ${p}%`;
        bar.style.width = `${p}%`;
      },
    };
  }

  async function generate(text) {
    const feed = $('#feed');
    const ph = placeholderCard();
    feed?.prepend(ph.node);
    mock.streams++;
    const res = await fetch(params.has('skew') ? `/rest/app-chat/conversations/new?skew=${encodeURIComponent(params.get('skew'))}` : '/rest/app-chat/conversations/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, toolOverrides: { videoGen: true }, genId: params.get('gen') || undefined }),
    });
    for await (const obj of ndjson(res)) {
      const v = obj?.result?.response?.streamingVideoGenerationResponse;
      if (!v) continue;
      await sleep(350);
      ph.progress(v.progress);
      if (v.progress >= 100 && v.videoUrl) {
        ph.node.replaceWith(card({ id: v.videoId, kind: 'video', mediaUrl: abs(v.videoUrl), thumbUrl: abs(v.thumbnailImageUrl), meta: 'New' }));
        mock.generated.push(v.videoId);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Post page
  // -------------------------------------------------------------------------------------------------------

  function renderPost(id) {
    const post = POSTS[id] || { kind: 'video', prompt: 'Untitled' };
    let meta = document.querySelector('meta[property="og:description"]');
    if (!meta) {
      meta = h('meta', { property: 'og:description' });
      document.head.append(meta);
    }
    meta.setAttribute('content', post.prompt);
    document.title = `${post.prompt.slice(0, 40)} - Grok Imagine`;
    const others = Object.keys(POSTS).filter((k) => k !== id && POSTS[k].kind === 'video').slice(0, 3);
    const player =
      post.kind === 'video'
        ? h('div', { class: 'player' }, [
            h('video', { id: 'sd-video', src: asset(id, 'generated_video.mp4'), poster: asset(id, 'preview_image.jpg'), muted: true, playsinline: true, preload: 'metadata', style: 'display:none' }),
            h('video', { id: 'hd-video', src: asset(id, 'generated_video_hd.mp4'), poster: asset(id, 'preview_image.jpg'), muted: true, loop: true, playsinline: true, controls: true, preload: 'metadata' }),
          ])
        : h('div', { class: 'player' }, [h('img', { class: 'media', alt: '', src: asset(id, 'image.jpg') })]);
    const form = h('form', { class: 'make-video' }, [
      h('textarea', { 'aria-label': 'Make a video', placeholder: 'Describe the motion…', rows: '2' }),
      h('button', { type: 'submit', class: 'make-btn', 'aria-label': 'Make video', disabled: true, text: 'Make video' }),
    ]);
    const article = h('article', { class: 'post' }, [
      player,
      h('p', { class: 'post-prompt', text: post.prompt }),
      h('div', { class: 'post-meta' }, [h('span', { text: 'imagine-video-1.5' }), h('span', { text: 'Oct 18, 2026' })]),
      h(
        'div',
        { class: 'variants' },
        others.map((o, i) =>
          h('button', { type: 'button', 'data-href': `/imagine/post/${o}`, onclick: () => navigate(`/imagine/post/${o}`) }, [h('img', { alt: `Thumbnail ${i + 1}`, src: asset(o, 'preview_image.jpg') })]),
        ),
      ),
      form,
    ]);
    const main = $('main.main');
    main.replaceChildren(h('div', { class: 'topbar' }, [h('a', { href: '/imagine', text: '← Imagine', style: 'text-decoration:none;color:var(--muted)' })]), article);
    main.scrollTop = 0;
    $('.query-dock').hidden = true;
    setupComposer(form, (text) => mock.log.push('make-video:' + text));
  }

  // -------------------------------------------------------------------------------------------------------
  // SPA routing for the Imagine pages
  // -------------------------------------------------------------------------------------------------------

  function route() {
    const p = location.pathname;
    const m = /^\/imagine\/post\/([0-9a-f-]{36})/.exec(p);
    if (m) renderPost(m[1]);
    else renderFeed(p.startsWith('/imagine/favorites') || p.startsWith('/imagine/saved') ? 'favorites' : 'imagine').catch((e) => mock.errors.push(String(e)));
  }

  function navigate(path) {
    history.pushState({}, '', path);
    route();
  }

  function setupImagine() {
    const form = $('form.query-bar');
    setupComposer(form, (text) => generate(text).catch((e) => mock.errors.push(String(e))));
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href^="/imagine"]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      navigate(a.getAttribute('href'));
    });
    window.addEventListener('popstate', route);
    $('main.main').addEventListener('scroll', () => {
      const s = $('#sentinel');
      if (s && s.getBoundingClientRect().top < window.innerHeight + 50) loadNextPage().catch((e) => mock.errors.push(String(e)));
    });
    route();
  }

  // -------------------------------------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------------------------------------

  let replyCount = 0;
  function row(role, children) {
    replyCount++;
    return h('div', { id: `response-mock-${role}-${replyCount}`, class: `relative group flex flex-col justify-center w-full ${role === 'user' ? 'items-end' : 'items-start'}` }, [
      h('div', { class: 'message-bubble relative' }, children),
      role === 'assistant'
        ? h('div', { class: 'msg-actions' }, [
            h('button', { type: 'button', 'aria-label': 'Copy', text: '⧉' }),
            h('button', { type: 'button', 'aria-label': 'Regenerate', text: '↻' }),
            h('button', { type: 'button', 'aria-label': 'Like', text: '👍' }),
          ])
        : null,
    ]);
  }

  async function sendChat(text) {
    const chat = $('.chat');
    chat.append(row('user', [h('span', { class: 'whitespace-pre-wrap', text })]));
    const md = h('div', { class: 'response-content-markdown markdown' }, [h('p', { class: 'typing', text: '…' })]);
    const assistant = row('assistant', [md]);
    chat.append(assistant);
    mock.streams++;
    const cid = location.pathname.split('/')[2] || 'new';
    const res = await fetch(`/rest/app-chat/conversations/${cid}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, genId: params.get('gen') || undefined }),
    });
    let textSoFar = '';
    const para = h('p');
    md.replaceChildren(para);
    for await (const obj of ndjson(res)) {
      const r = obj?.result?.response;
      if (!r) continue;
      if (typeof r.token === 'string') {
        textSoFar += r.token;
        para.textContent = textSoFar;
      }
      const v = r.streamingVideoGenerationResponse;
      if (v && v.progress >= 100 && v.videoUrl) {
        // The app plays generated clips from a blob: URL (exercises PAGE_FETCH for page-owned blobs).
        const bytes = await (await fetch(abs(v.videoUrl))).blob();
        const video = h('video', { class: 'gen-media', src: URL.createObjectURL(bytes), poster: abs(v.thumbnailImageUrl), controls: true, muted: true, playsinline: true });
        md.append(video);
        mock.generated.push(v.videoId);
      }
    }
  }

  function setupChat() {
    const form = $('form.query-bar');
    setupComposer(form, (text) => sendChat(text).catch((e) => mock.errors.push(String(e))));
    if (params.has('stream')) sendChat('Animate the hero car drifting through the neon city at night').catch((e) => mock.errors.push(String(e)));
  }

  // -------------------------------------------------------------------------------------------------------

  const page = document.body.dataset.page;
  if (page === 'chat') setupChat();
  else setupImagine();
})();
