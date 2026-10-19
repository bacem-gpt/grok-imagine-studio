// Small building blocks shared by the Prompts tab components.
import { html, Component, useState, useEffect, useRef, useCallback, useMemo } from '../../../vendor/preact-htm.mjs';
import { useStore, useMediaPreview, useProject, useLibrary, usePage } from '../hooks.js';
import { Icon, cx } from '../kit.js';
import { getIngredientThumb } from '../../core/ingredients.js';
import { MediaThumb } from '../media/media-thumb.js';
import { STATUS_LABELS } from '../../prompts/shots.js';
import { expandTokens } from '../../prompts/tokens.js';
import { getBible } from '../../prompts/library.js';
import { prefsStore, setSectionOpen, pendingFlushers, promptsUi } from './state.js';

/** Bible + snippets used for token expansion, memoised on their identities. */
export function useExpandCtx() {
  const bible = useProject((p) => p.bible);
  const snippets = useLibrary((l) => l.snippets);
  return useMemo(() => ({ bible: getBible({ bible }), snippets: snippets || [] }), [bible, snippets]);
}

/** True while grok.com's prompt box holds this shot's current prompt, put there by the studio and not submitted. */
export function useShotInBox(shot) {
  const connected = usePage((s) => s.connected);
  const boxText = useStore(promptsUi, (s) => (s.inBox?.shotId === shot.id ? s.inBox.text : null));
  const ctx = useExpandCtx();
  return !!connected && boxText != null && boxText === expandTokens(shot.prompt || '', ctx).text;
}

// 'inbox' is not a stored status: a sent (or draft) shot whose prompt waits, unsubmitted, in Grok's prompt box.
const LABELS = { ...STATUS_LABELS, inbox: 'In Grok’s box' };
const TITLES = { inbox: 'The prompt is in Grok’s prompt box, not generating yet — press Generate (or Grok’s own button)' };

/** Status pill with a coloured dot. */
export function StatusBadge({ status = 'draft', compact = false, title }) {
  return html`<span class=${cx('pr-status', `is-${status}`, compact && 'is-compact')} title=${title || TITLES[status] || LABELS[status]}>
    <span class="pr-status-dot"></span>${!compact && html`<span class="pr-status-label">${LABELS[status] || status}</span>`}
  </span>`;
}

/** A shot's status pill: "In Grok’s box" while the studio's insert of its prompt hasn't been submitted. */
export function ShotStatus({ shot, compact = false }) {
  const inBox = useShotInBox(shot);
  return html`<${StatusBadge} status=${inBox ? 'inbox' : shot.status} compact=${compact} />`;
}

/**
 * Collapsible section whose open state is remembered per user (prefs.sections[id]) once they toggle it; until then
 * it follows `defaultOpen`. Same look as the kit Section, plus a count badge and header actions that don't toggle.
 */
export function PrSection({ id, title, icon, count = null, actions = null, defaultOpen = true, children, class: klass = '' }) {
  const chosen = useStore(prefsStore, (p) => p.sections?.[id]);
  const open = typeof chosen === 'boolean' ? chosen : !!defaultOpen;
  return html`<section class=${cx('section', 'pr-section', open && 'is-open', klass)} data-section=${id}>
    <header class="section-header">
      <button type="button" class="section-toggle" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setSectionOpen(id, !open)}>
        <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} size=${14} />
        ${icon && html`<${Icon} name=${icon} size=${14} class="pr-section-icon" />`}
        <span>${title}</span>
        ${count != null && count !== 0 && html`<span class="pr-count">${count}</span>`}
      </button>
      ${actions && open && html`<div class="section-actions">${actions}</div>`}
    </header>
    ${open && html`<div class="section-body">${children}</div>`}
  </section>`;
}

/**
 * Local text state for a field that commits to the project with a debounce.
 *   key     entity identity (e.g. shot id) — switching flushes the pending commit to the previous entity
 *   value   current stored value (external changes such as undo/redo replace the local text)
 *   commit  (key, text, session) => void
 * Returns {text, setText, flush, bumpSession}. `session` increments on bumpSession() (call on focus) so one focus
 * session = one undo step via projectStore merge keys.
 */
export function useCommittedText(key, value, commit, { delay = 60 } = {}) {
  const [text, setTextState] = useState(value ?? '');
  const pending = useRef(null);
  const timer = useRef(null);
  const session = useRef(0);
  const lastKey = useRef(key);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) commitRef.current(p.key, p.text, p.session);
  }, []);

  useEffect(() => {
    if (lastKey.current !== key) {
      flush();
      lastKey.current = key;
      session.current++;
    }
    setTextState(value ?? '');
  }, [key]);

  useEffect(() => {
    if (!pending.current) setTextState(value ?? '');
  }, [value]);

  useEffect(() => {
    pendingFlushers.add(flush);
    return () => {
      pendingFlushers.delete(flush);
      flush();
    };
  }, []);

  const setText = useCallback(
    (t) => {
      setTextState(t);
      pending.current = { key: lastKey.current, text: t, session: session.current };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [delay],
  );
  const bumpSession = useCallback(() => {
    session.current++;
  }, []);
  return { text, setText, flush, bumpSession };
}

/** Error boundary: renders `fallback` when a child (e.g. another area's component) throws. */
export class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  componentDidCatch(error) {
    console.warn('[gis] prompts: component failed, using fallback', error);
    this.setState({ error });
  }
  render() {
    return this.state.error ? this.props.fallback ?? null : this.props.children;
  }
}

/** Plain thumbnail (used when MediaThumb is unavailable or fails). */
function PlainThumb({ mediaId }) {
  const previews = useMediaPreview(mediaId);
  return html`<div class="pr-plain-thumb">${previews?.thumb ? html`<img src=${previews.thumb} alt="" draggable="false" />` : html`<${Icon} name="film" size=${18} />`}</div>`;
}

/** Take thumbnail: the Clips tab MediaThumb (hover scrub, status overlays) with a plain fallback. */
export function TakeThumb({ mediaId, scrub = true }) {
  return html`<${Boundary} fallback=${html`<${PlainThumb} mediaId=${mediaId} />`}>
    <${MediaThumb} mediaId=${mediaId} scrub=${scrub} showUsage=${false} showKind=${false} />
  <//>`;
}

/** Small square thumbnail of an ingredient (reference image). */
export function IngThumb({ id, title = '' }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    getIngredientThumb(id)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  return html`<span class="pr-ing-thumb" title=${title}>${url ? html`<img src=${url} alt="" draggable="false" />` : html`<${Icon} name="image" size=${12} />`}</span>`;
}

/** Inline editable text that looks like plain text until hovered / focused. */
export function GhostInput({ value, placeholder, onInput, onBlur, onFocus, class: klass = '', ...rest }) {
  return html`<input type="text" class=${cx('pr-ghost-input', klass)} value=${value} placeholder=${placeholder} onInput=${(e) => onInput?.(e.currentTarget.value)} onBlur=${onBlur} onFocus=${onFocus} ...${rest} />`;
}

/** Auto-growing textarea (grows with its content between minRows and maxRows, then scrolls). */
export function AutoTextarea({ value, onInput, minRows = 3, maxRows = 16, inputRef, class: klass = '', ...rest }) {
  const ref = useRef(null);
  const resize = () => {
    const el = ref.current;
    if (!el || !el.isConnected) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 19;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = 'auto';
    const content = el.scrollHeight;
    const min = minRows * lh + padY;
    const max = maxRows * lh + padY;
    el.style.height = `${Math.ceil(Math.min(Math.max(content, min), max) + border)}px`;
    el.style.overflowY = content > max + 1 ? 'auto' : 'hidden';
  };
  useEffect(resize, [value]);
  useEffect(() => {
    // Re-measure when the width changes (wrapping changes); height changes we cause ourselves are ignored.
    let lastWidth = -1;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w === lastWidth) return;
      lastWidth = w;
      requestAnimationFrame(resize);
    });
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const setRef = (el) => {
    ref.current = el;
    if (inputRef) inputRef.current = el;
  };
  return html`<textarea ref=${setRef} class=${cx('text-field', 'pr-autotext', klass)} value=${value} onInput=${(e) => onInput?.(e.currentTarget.value, e)} ...${rest}></textarea>`;
}
