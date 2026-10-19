// Text extraction from grok.com: readable text of a DOM subtree (lists keep their numbering so the studio's prompt
// list parser sees "1. …" lines), chat message discovery (latest assistant reply, the user message before a media
// element) and the current selection. domToText() only uses a minimal node interface (nodeType, nodeValue, tagName,
// childNodes, getAttribute, hidden) so it is unit-testable with plain objects.

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL',
]);
const PARA_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE', 'FIGURE', 'DL']);
const SKIP_TAGS = new Set([
  'BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'IMG', 'VIDEO', 'AUDIO',
  'CANVAS', 'IFRAME', 'TEMPLATE', 'PICTURE', 'SOURCE', 'MATH', 'OBJECT', 'GIS-STUDIO-ROOT',
]);
const SKIP_ROLES = new Set(['button', 'toolbar', 'menu', 'menubar', 'tooltip', 'progressbar', 'status']);
const LIST_PREFIX_RE = /(^|\n)[ \t]*(\d+\. |- )$/;

const attr = (node, name) => (typeof node.getAttribute === 'function' ? node.getAttribute(name) : null);

/** Readable text of a DOM subtree: paragraphs separated by blank lines, list items numbered, UI chrome skipped. */
export function domToText(root) {
  if (!root) return '';
  let out = '';
  const ensureBreak = (n) => {
    if (!out || LIST_PREFIX_RE.test(out)) return;
    out = out.replace(/[ \t]+$/, '');
    let have = 0;
    for (let i = out.length - 1; i >= 0 && out[i] === '\n'; i--) have++;
    while (have < n) {
      out += '\n';
      have++;
    }
  };
  const visit = (node, pre, depth, li = false) => {
    if (!node || depth > 200) return;
    if (node.nodeType === 3) {
      let t = node.nodeValue || '';
      if (!pre) {
        t = t.replace(/\s+/g, ' ');
        if (!out || /[\n ]$/.test(out)) t = t.replace(/^ /, '');
      }
      out += t;
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return;
    if (node.nodeType === 1) {
      const tag = String(node.tagName || '').toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (node.hidden || attr(node, 'aria-hidden') === 'true' || attr(node, 'data-gis-ignore') != null) return;
      if (SKIP_ROLES.has(attr(node, 'role'))) return;
      if (/(^|\s)(sr-only|visually-hidden)(\s|$)/.test(attr(node, 'class') || '')) return;
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      if (tag === 'HR') {
        ensureBreak(2);
        return;
      }
      if (tag === 'OL' || tag === 'UL') {
        ensureBreak(2);
        let n = Number(attr(node, 'start')) || 1;
        for (const ch of node.childNodes || []) {
          if (ch.nodeType === 1 && String(ch.tagName).toUpperCase() === 'LI') {
            ensureBreak(1);
            out += tag === 'OL' ? `${n++}. ` : '- ';
            for (const g of ch.childNodes || []) visit(g, pre, depth + 1, true);
            ensureBreak(1);
          } else visit(ch, pre, depth + 1, li);
        }
        ensureBreak(2);
        return;
      }
      const block = BLOCK_TAGS.has(tag);
      const gap = PARA_TAGS.has(tag) && !li ? 2 : 1; // paragraphs inside list items stay on consecutive lines
      if (block) ensureBreak(gap);
      const isPre = pre || tag === 'PRE';
      for (const ch of node.childNodes || []) visit(ch, isPre, depth + 1, li);
      if (block) ensureBreak(gap);
      return;
    }
    for (const ch of node.childNodes || []) visit(ch, pre, depth + 1, li);
  };
  visit(root, false, 0);
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Single-line text (whitespace collapsed). */
export const inlineText = (root) => domToText(root).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------------------------------------

const ROLE_ATTRS = '[data-message-author-role], [data-role="assistant"], [data-role="user"], [data-author], [data-testid$="-message"], [data-testid*="assistant-message" i], [data-testid*="user-message" i]';
const MARKDOWN_SEL = '.response-content-markdown, .markdown, [class*="markdown"], .prose';

function classOf(el) {
  const c = el.getAttribute?.('class');
  return typeof c === 'string' ? c : '';
}

function roleFromAttrs(el) {
  const v = [el.getAttribute('data-message-author-role'), el.getAttribute('data-role'), el.getAttribute('data-author'), el.getAttribute('data-testid')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/assistant|grok|bot|model/.test(v)) return 'assistant';
  if (/user|human/.test(v)) return 'user';
  return 'unknown';
}

/** Grok marks user rows `items-end` (right) and assistant rows `items-start` (left). */
function roleFromLayout(el) {
  const own = classOf(el);
  if (/\bitems-end\b/.test(own)) return 'user';
  if (/\bitems-start\b/.test(own)) return 'assistant';
  const bubble = el.matches?.('.message-bubble') ? el : el.querySelector?.('.message-bubble');
  if (bubble) {
    const bc = classOf(bubble);
    const pc = classOf(bubble.parentElement || bubble);
    if (/\bitems-end\b|\bself-end\b|\bml-auto\b|rounded-br-lg/.test(bc + ' ' + pc)) return 'user';
    if (/\bitems-start\b|\bself-start\b/.test(bc + ' ' + pc)) return 'assistant';
  }
  if (el.querySelector?.('.response-content-markdown, .markdown, [class*="markdown"]')) return 'assistant';
  return 'unknown';
}

/**
 * Chat messages in document order: [{el, role: 'user'|'assistant'|'unknown'}], using the first strategy that
 * finds anything (Grok rows `[id^="response-"]`, explicit role attributes, `.message-bubble`).
 * Linear in the number of rows (long discussions have hundreds of them).
 */
export function findMessages(root = document) {
  const main = root.querySelector?.('main') || root;
  // Outermost matches only (a message may contain elements matching the same selector): no matching ancestor
  // between the element and `main`.
  const outermost = (sel) =>
    [...main.querySelectorAll(sel)].filter((el) => {
      const up = el.parentElement?.closest(sel);
      return !up || up === main || !main.contains(up);
    });
  let els = outermost('[id^="response-"]');
  if (els.length) return els.map((el) => ({ el, role: roleFromLayout(el) }));
  els = outermost(ROLE_ATTRS);
  if (els.length) return els.map((el) => ({ el, role: roleFromAttrs(el) }));
  els = outermost('.message-bubble');
  return els.map((el) => ({ el, role: roleFromLayout(el) }));
}

/**
 * The chat messages of a page plus fast lookups, built once per DOM pass and shared by every media element of it:
 * indexOf(el) = index of the message containing el (walks el's ancestors, -1 when none); userText(i) = text of the
 * user message at or before index i (memoised), or null.
 */
export function messageIndex(root = document) {
  const msgs = findMessages(root);
  const pos = new Map(msgs.map((m, i) => [m.el, i]));
  const texts = new Map();
  const textAt = (i) => {
    if (!texts.has(i)) texts.set(i, messageText(msgs[i].el).replace(/\s+/g, ' ').trim().slice(0, 1000) || null);
    return texts.get(i);
  };
  return {
    msgs,
    indexOf(el) {
      for (let n = el; n; n = n.parentElement) {
        const i = pos.get(n);
        if (i !== undefined) return i;
      }
      return -1;
    },
    userText(from) {
      for (let i = Math.min(from, msgs.length - 1); i >= 0; i--) {
        if (msgs[i].role !== 'user') continue;
        const t = textAt(i);
        if (t) return t;
      }
      return null;
    },
  };
}

function messageText(el) {
  const content = el.querySelector?.('.response-content-markdown') || el.querySelector?.('.markdown, [class*="markdown"]') || el.querySelector?.('.message-bubble') || el;
  return domToText(content);
}

/** Text of the latest assistant reply in a Grok chat ('' when none). */
export function lastAssistantReply(root = document) {
  const msgs = findMessages(root);
  const hasAssistant = msgs.some((m) => m.role === 'assistant');
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' || (!hasAssistant && m.role === 'unknown')) {
      const text = messageText(m.el);
      if (text) return text;
    }
  }
  if (msgs.length) return '';
  // No recognisable message rows: the last rendered markdown block (assistant output) on the page.
  const blocks = [...(root.querySelector?.('main') || root).querySelectorAll(MARKDOWN_SEL)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const text = domToText(blocks[i]);
    if (text) return text;
  }
  return '';
}

/**
 * Text of the user message preceding the message that contains `el` (chat prompt fallback), or null. Pass the
 * messageIndex() of the current DOM pass when looking up several elements.
 */
export function precedingUserText(el, root = document, index = null) {
  const idx = index || messageIndex(root);
  const i = idx.indexOf(el);
  return i < 0 ? null : idx.userText(i);
}

/** Current text selection on the page (textarea/input selections included). */
export function selectionText(doc = document) {
  const ae = doc.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && /^(text|search|url)$/i.test(ae.type || 'text')))) {
    const { selectionStart: s, selectionEnd: e } = ae;
    if (Number.isInteger(s) && Number.isInteger(e) && e > s) return ae.value.slice(s, e);
  }
  const sel = doc.getSelection?.();
  return sel ? sel.toString() : '';
}
