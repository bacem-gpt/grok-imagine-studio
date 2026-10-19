// grok.com composer integration: find the active prompt box, insert / read text, attach images, submit, and
// notice when the user submits. Works with plain textareas (React-controlled) and ProseMirror/tiptap-like
// contenteditable editors. Every operation verifies its effect and falls back to the next technique:
//   text:   execCommand('insertText') (undo-friendly) -> synthetic paste -> native value setter + input event
//   image:  input[type=file] near the composer (DataTransfer + input/change) -> synthetic paste -> synthetic drop
//   submit: enabled submit button near the composer (waits briefly for it to enable) -> Enter key events

const COMPOSER_SELECTORS = [
  '.query-bar div[contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
  'div.tiptap[contenteditable="true"]',
  'textarea[aria-label="Make a video"]',
  'textarea[aria-label*="Ask"]',
  'textarea[placeholder*="Ask"]',
  '[contenteditable="true"][role="textbox"]',
  'form textarea',
  'main textarea',
];
const POST_COMPOSER = 'textarea[aria-label="Make a video"]';
const ARROW_PATH = 'M6 11L12 5M12 5L18 11M12 5V19';
const NOT_SUBMIT_RE = /upload|attach|image|voice|mic|stop|cancel|close|model|mode|settings|menu|more|delete|remove|search|think/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isField = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
const norm = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

function usable(el) {
  if (!el || el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return false;
  if (el.closest('[aria-hidden="true"], [inert]')) return false;
  return isVisible(el);
}

/**
 * The composer the user would type into: on a post page the "Make a video" box, otherwise the bottom-most
 * visible prompt box (Grok keeps its query bar at the bottom).
 */
export function findComposer(doc = document) {
  if (doc.location?.pathname?.startsWith('/imagine/post/')) {
    const t = [...doc.querySelectorAll(POST_COMPOSER)].find(usable);
    if (t) return t;
  }
  const seen = new Set();
  let best = null;
  let bestBottom = -Infinity;
  for (const sel of COMPOSER_SELECTORS) {
    for (const el of doc.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!usable(el)) continue;
      // nested contenteditable children are part of their editor root
      if (!isField(el) && el.parentElement?.closest('[contenteditable="true"]')) continue;
      const bottom = el.getBoundingClientRect().bottom;
      if (bottom >= bestBottom - 1) {
        best = el;
        bestBottom = bottom;
      }
    }
  }
  return best;
}

/** Current text of a composer element. */
export function readText(el) {
  if (!el) return '';
  if (isField(el)) return el.value || '';
  return (el.innerText || el.textContent || '').replace(/ /g, ' ').replace(/\n+$/, '');
}

function joinText(existing, text) {
  if (!existing || !existing.trim()) return text;
  if (/\s$/.test(existing)) return existing + text;
  return existing + (text.includes('\n') || existing.includes('\n') ? '\n' : ' ') + text;
}

function landed(el, text, mode, before) {
  const now = norm(readText(el));
  const want = norm(text);
  if (!want) return now === '' || mode === 'append';
  if (mode === 'replace') return now === want || (now.includes(want) && now.length <= want.length + 2);
  return now.includes(want) && now.length >= norm(before).length;
}

function selectContents(el, mode) {
  el.focus({ preventScroll: true });
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  if (mode === 'append') range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

async function insertIntoField(el, text, mode) {
  const before = el.value || '';
  const target = mode === 'append' ? joinText(before, text) : text;
  // 1. execCommand keeps the browser's undo stack (Ctrl+Z restores the user's text).
  try {
    el.focus({ preventScroll: true });
    if (mode === 'append') {
      el.setSelectionRange(before.length, before.length);
      const piece = target.slice(before.length);
      if (piece && document.execCommand('insertText', false, piece) && el.value === target) return 'execCommand';
    } else {
      el.select();
      if (text ? document.execCommand('insertText', false, text) : document.execCommand('delete')) {
        if (el.value === target) return 'execCommand';
      }
    }
  } catch {
    /* fall through */
  }
  // 2. Native setter + input event: React sees the change because its value tracker lives in the page world.
  setNativeValue(el, target);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  try {
    el.setSelectionRange(target.length, target.length);
  } catch {
    /* some inputs do not support selection */
  }
  return el.value === target ? 'value' : null;
}

async function insertIntoEditable(el, text, mode) {
  const before = readText(el);
  // What goes in at the caret: in append mode a separator keeps the words apart.
  const piece = mode === 'append' && before.trim() ? (/\s$/.test(before) ? '' : text.includes('\n') ? '\n' : ' ') + text : text;
  // 1. execCommand('insertText'): native editing pipeline (input events), editors keep their state in sync.
  try {
    selectContents(el, mode);
    const ok = piece ? document.execCommand('insertText', false, piece) : document.execCommand('delete');
    if (ok) {
      await sleep(30);
      if (landed(el, text, mode, before)) return 'execCommand';
    }
  } catch {
    /* fall through */
  }
  // 2. Synthetic paste with text/plain: ProseMirror/tiptap/Lexical read event.clipboardData.
  try {
    selectContents(el, mode);
    const dt = new DataTransfer();
    dt.setData('text/plain', piece);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(40);
    if (landed(el, text, mode, before)) return 'paste';
  } catch {
    /* fall through */
  }
  // 3. Plain contenteditable (not a framework editor): write the DOM directly.
  if (!el.classList.contains('ProseMirror') && !el.hasAttribute('data-lexical-editor')) {
    el.textContent = mode === 'append' ? joinText(before, text) : text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    await sleep(20);
    if (landed(el, text, mode, before)) return 'dom';
  }
  return null;
}

/**
 * Inserts text into the composer. mode: 'replace' | 'append'; submit: also submit afterwards.
 * @returns {Promise<{ok: boolean, method: string|null, submitted?: boolean, error?: string}>}
 */
export async function insertText(text, { mode = 'replace', submit = false } = {}) {
  const el = findComposer();
  if (!el) return { ok: false, method: null, error: 'Grok composer not found on this page' };
  const value = String(text ?? '');
  const method = isField(el) ? await insertIntoField(el, value, mode) : await insertIntoEditable(el, value, mode);
  if (!method) return { ok: false, method: null, error: 'Grok did not accept the text' };
  const res = { ok: true, method };
  if (submit) {
    await sleep(80); // let the page enable its submit button
    const s = await submitComposer(el);
    res.submitted = s.ok;
    if (!s.ok) res.error = s.error;
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------------------------------------

function isDisabled(btn) {
  return btn.disabled || btn.getAttribute('aria-disabled') === 'true';
}

function submitScore(btn) {
  const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').trim();
  if (/^make (a )?video$/i.test(label)) return 10;
  if (/^send( message)?$/i.test(label) || btn.getAttribute('data-testid') === 'send-button') return 9;
  if (/^submit$/i.test(label)) return 8;
  if (btn.querySelector(`path[d="${ARROW_PATH}"]`) || [...btn.querySelectorAll('path')].some((p) => (p.getAttribute('d') || '').replace(/\s+/g, ' ').includes(ARROW_PATH))) return 7;
  if (label && NOT_SUBMIT_RE.test(label)) return 0;
  if (btn.type === 'submit' && btn.form) return 6;
  if (/send|submit|generate/i.test(label)) return 5;
  return 0;
}

/** Submit button that belongs to a composer (closest container first), or null. includeDisabled for waiting. */
export function findSubmitButton(composer = findComposer(), { includeDisabled = false } = {}) {
  if (!composer) return null;
  let node = composer.parentElement;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    let best = null;
    let bestScore = 0;
    for (const btn of node.querySelectorAll('button, [role="button"]')) {
      if (!includeDisabled && isDisabled(btn)) continue;
      if (!isVisible(btn)) continue;
      const s = submitScore(btn);
      if (s > bestScore) {
        best = btn;
        bestScore = s;
      }
    }
    if (best) return best;
    if (node.tagName === 'FORM' || node.matches?.('.query-bar')) break;
  }
  return null;
}

function pressEnter(el) {
  el.focus({ preventScroll: true });
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

/** Submits the composer: clicks its submit button (waiting up to `timeout` for it to enable) or presses Enter. */
export async function submitComposer(composer = findComposer(), { timeout = 1500 } = {}) {
  if (!composer) return { ok: false, method: null, error: 'Grok composer not found on this page' };
  const t0 = Date.now();
  let btn = findSubmitButton(composer, { includeDisabled: true });
  while (btn && isDisabled(btn) && Date.now() - t0 < timeout) {
    await sleep(80);
    btn = findSubmitButton(composer, { includeDisabled: true });
  }
  if (btn && !isDisabled(btn)) {
    btn.click();
    return { ok: true, method: 'button' };
  }
  if (!norm(readText(composer))) return { ok: false, method: null, error: 'Nothing to submit' };
  pressEnter(composer);
  return { ok: true, method: 'enter' };
}

// ---------------------------------------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------------------------------------

const IMAGE_EXT_RE = /^\.(png|jpe?g|jfif|pjpeg|webp|gif|avif|heic|heif|bmp|tiff?|svg|ico)$/i;
const INPUT_CONFIRM_MS = 800; // an attachment preview usually appears right away
const EVENT_CONFIRM_MS = 400;
// What an attachment shows in the composer: a preview image, a file chip, a remove button.
const EVIDENCE_SEL = 'img, video, canvas, [data-testid*="attach" i], [class*="attach" i], [class*="preview" i], [class*="upload" i], [class*="thumb" i], [aria-label*="remove" i]';

const acceptTokens = (accept) =>
  String(accept || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

/** True when an input's accept list allows images: empty, wildcards, image/* or image/<type>, image extensions. */
export function acceptsImages(accept) {
  const tokens = acceptTokens(accept);
  return !tokens.length || tokens.some((t) => t === '*' || t === '*/*' || t.startsWith('image/') || IMAGE_EXT_RE.test(t));
}

/** True when an accept list allows this file (by MIME type, type wildcard or file extension). */
export function acceptsFile(accept, { type = '', name = '' } = {}) {
  const tokens = acceptTokens(accept);
  if (!tokens.length) return true;
  const mime = String(type).toLowerCase();
  const ext = /\.[^./\\]+$/.exec(String(name).toLowerCase())?.[0] || '';
  return tokens.some((t) => t === '*' || t === '*/*' || (t.endsWith('/*') && mime.startsWith(t.slice(0, -1))) || t === mime || (t.startsWith('.') && t === ext));
}

/**
 * The composer's own area: its form (Grok keeps the hidden upload field, the Attach button and the attachment
 * previews there), else its query bar, else a few levels around it. Never the whole page.
 */
export function composerArea(composer) {
  const area = composer.closest('form') || composer.closest('.query-bar');
  if (area) return area;
  let node = composer;
  for (let i = 0; i < 3 && node.parentElement && node.parentElement !== document.body; i++) node = node.parentElement;
  return node;
}

/** The composer's upload field for this file: one that accepts it, else one that accepts images. */
function findFileInput(area, file) {
  const inputs = [...area.querySelectorAll('input[type="file"]')].filter((i) => !i.disabled);
  return inputs.find((i) => acceptsFile(i.accept, file)) || inputs.find((i) => acceptsImages(i.accept)) || null;
}

/**
 * Watches the composer area for signs that an attachment landed (a preview image, a file chip …).
 * wait(ms) resolves true as soon as one appears, false after ms; the observer stops either way.
 */
function watchAttachment(area) {
  let seen = false;
  let wake = null;
  const isEvidence = (n) => n.nodeType === 1 && (n.matches(EVIDENCE_SEL) || !!n.querySelector(EVIDENCE_SEL));
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (/^(blob|data):/i.test(r.target.getAttribute('src') || '')) seen = true;
      } else if ([...r.addedNodes].some(isEvidence)) seen = true;
      if (seen) break;
    }
    if (seen) wake?.();
  });
  mo.observe(area, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  return {
    wait(ms) {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          mo.disconnect();
          resolve(seen);
        };
        const timer = setTimeout(done, ms);
        wake = done;
        if (seen) done();
      });
    },
    stop: () => mo.disconnect(),
  };
}

/**
 * Dispatches a synthetic paste / drop carrying the file and tells whether the page took it: it called
 * preventDefault(), its handlers used the file (attach probe in the page world, see page-hook.js: they inspected or
 * read it), or a preview appeared in the composer. Only then is the next way skipped, so the image never lands twice
 * and a page that ignored it still gets the next way. Returns {taken, confirmed}.
 */
async function offerFile(target, file, kind, area, probe) {
  const watch = watchAttachment(area);
  let armed = false;
  try {
    armed = probe ? await probe.start() : false;
  } catch {
    armed = false;
  }
  let prevented = false;
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    if (kind === 'paste') {
      target.focus({ preventScroll: true });
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      prevented = ev.defaultPrevented;
    } else {
      const r = target.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      target.dispatchEvent(new DragEvent('dragenter', at));
      target.dispatchEvent(new DragEvent('dragover', at));
      const drop = new DragEvent('drop', at);
      target.dispatchEvent(drop);
      prevented = drop.defaultPrevented;
    }
  } catch {
    /* treated as not taken */
  }
  let seenByPage = null; // {read, used} from the probe; null: unknown
  if (armed) {
    try {
      seenByPage = await probe.stop();
    } catch {
      seenByPage = null;
    }
  }
  if (prevented) {
    watch.stop();
    return { taken: true, confirmed: true };
  }
  if (seenByPage && !seenByPage.read && !seenByPage.used) {
    watch.stop(); // the page never even looked at the files
    return { taken: false, confirmed: false };
  }
  const seen = await watch.wait(EVENT_CONFIRM_MS);
  return { taken: seen || !!seenByPage?.used, confirmed: seen };
}

/**
 * Attaches an image File/Blob to the composer, in the first way the page takes: the composer's own upload field,
 * a pasted file, a dropped file — never two of them. Only the composer's own area is used (never another uploader
 * on the page). confirmed: an attachment preview appeared in the composer.
 * opts.probe: attach probe from network.js (tells whether the page's handlers read a pasted / dropped file).
 * @returns {Promise<{ok: boolean, method: 'input'|'paste'|'drop'|null, confirmed?: boolean, error?: string}>}
 */
export async function attachFile(blob, name = 'image.png', { probe = null } = {}) {
  if (!(blob instanceof Blob)) return { ok: false, method: null, error: 'No image data' };
  const file = blob instanceof File && blob.name ? blob : new File([blob], name || 'image.png', { type: blob.type || 'image/png', lastModified: Date.now() });
  const composer = findComposer();
  if (!composer) return { ok: false, method: null, error: 'Grok composer not found on this page' };
  const area = composerArea(composer);
  const input = findFileInput(area, file);
  if (input) {
    const watch = watchAttachment(area);
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // The page's own upload field took it: never offer it a second time, even when no preview shows up.
      return { ok: true, method: 'input', confirmed: await watch.wait(INPUT_CONFIRM_MS) };
    } catch (e) {
      watch.stop();
      console.warn('[gis] file input attach failed', e);
    }
  }
  const pasted = await offerFile(composer, file, 'paste', area, probe);
  if (pasted.taken) return { ok: true, method: 'paste', confirmed: pasted.confirmed };
  const target = composer.closest('.query-bar, form') || composer;
  const dropped = await offerFile(target, file, 'drop', area, probe);
  if (dropped.taken) return { ok: true, method: 'drop', confirmed: dropped.confirmed };
  return { ok: false, method: null, error: 'Grok did not accept the image (no upload field in its prompt box)' };
}

// ---------------------------------------------------------------------------------------------------------
// Submission watcher
// ---------------------------------------------------------------------------------------------------------

const GENERATE_LABEL_RE = /^(make (a )?video|make video|generate( video| image)?|regenerate|redo|retry|animate|extend( video)?|remix|upscale|make variations?|create video)$/i;

/** True for buttons that start a generation outside the composer (card "Make video", "Redo", "Extend" …). */
export function isGenerateButton(btn) {
  if (!btn || isDisabled(btn)) return false;
  const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '').replace(/\s+/g, ' ').trim();
  return label.length < 40 && GENERATE_LABEL_RE.test(label);
}

/**
 * Calls onSubmit(text) when the user (or the studio) submits a prompt on grok.com: Enter in the composer or a
 * click on its submit button. Text is read before Grok clears the box. onGenerate() is also called for clicks on
 * buttons that start a generation without the composer (it tells media detection that new media will follow).
 * Returns stop().
 */
export function watchSubmissions(onSubmit, { onGenerate = null } = {}) {
  let last = { text: '', at: 0 };
  const fire = (text) => {
    const t = String(text || '').trim();
    if (!t) return;
    const now = Date.now();
    if (t === last.text && now - last.at < 1500) return;
    last = { text: t, at: now };
    try {
      onSubmit(t);
    } catch (e) {
      console.warn('[gis] submit handler failed', e);
    }
  };
  const onKey = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return;
    const target = e.target;
    if (!(target instanceof Element) || !(target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
    const composer = findComposer();
    if (!composer || !(composer === target || composer.contains(target))) return;
    fire(readText(composer));
  };
  const onClick = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest('button, [role="button"]');
    if (!btn || isDisabled(btn)) return;
    if (onGenerate && isGenerateButton(btn)) {
      try {
        onGenerate();
      } catch (err) {
        console.warn('[gis] generate handler failed', err);
      }
    }
    if (submitScore(btn) === 0) return; // cheap checks first: most clicks stop here
    const composer = findComposer();
    if (!composer) return;
    if (findSubmitButton(composer) !== btn) return;
    fire(readText(composer));
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('click', onClick, true);
  return () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onClick, true);
  };
}
