// Shared UI kit (Preact + htm). Every panel builds on these so the studio looks and behaves consistently.
//   Icon, Button, IconButton, ButtonGroup, Slider, NumberField, TimeField, Select, Toggle, TextField, Field,
//   Modal, Tabs, Segmented, EmptyState, Badge, Kbd, Spinner, ProgressBar, DropZone, Tooltip-ish (title attr)
//   toast(msg, opts), ToastHost, notConnectedToast(what, {copyText})
//   confirmDialog(opts) -> Promise<boolean>, promptDialog(opts) -> Promise<string|null>, DialogHost
//   showMenu(event | {x, y}, items), MenuHost      items: [{label, icon, shortcut, onClick, disabled, danger, checked} | '-']
//   MEDIA_DRAG_TYPE: dataTransfer type for bin items being dragged (JSON array of media ids)
//   Is a dialog or menu open? modalOpen() from ./hotkeys.js (every Modal and the open menu register a modal scope).
import { html, useState, useEffect, useRef } from '../../vendor/preact-htm.mjs';
import { iconMarkup } from './icons.js';
import { createStore } from '../core/store.js';
import { useStore } from './hooks.js';
import { useHotkeys, comboLabel } from './hotkeys.js';
import { clamp, formatTime, parseTime, uid, copyText } from '../core/utils.js';

const cx = (...parts) => parts.filter(Boolean).join(' ');
export { cx };

/** dataTransfer type of media dragged from the bin (value: JSON array of media ids). */
export const MEDIA_DRAG_TYPE = 'application/x-gis-media';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function Icon({ name, size = 16, class: klass = '', title }) {
  const { filled, body } = iconMarkup(name);
  return html`<svg
    class=${cx('icon', klass)}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill=${filled ? 'currentColor' : 'none'}
    stroke=${filled ? 'none' : 'currentColor'}
    stroke-width="1.9"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden=${title ? undefined : 'true'}
    dangerouslySetInnerHTML=${{ __html: (title ? `<title>${escapeHtml(title)}</title>` : '') + body }}
  ></svg>`;
}

export function Button({ children, icon, iconRight, kind = 'default', size = 'md', class: klass = '', active = false, ...rest }) {
  return html`<button
    type="button"
    class=${cx('btn', `btn-${kind}`, `btn-${size}`, active && 'is-active', !children && 'btn-icon-only', klass)}
    ...${rest}
  >
    ${icon && html`<${Icon} name=${icon} size=${size === 'sm' ? 14 : 16} />`}
    ${children && html`<span class="btn-label">${children}</span>`}
    ${iconRight && html`<${Icon} name=${iconRight} size=${size === 'sm' ? 14 : 16} />`}
  </button>`;
}

export function IconButton({ icon, title, size = 'md', kind = 'ghost', active = false, class: klass = '', badge = null, ...rest }) {
  return html`<button
    type="button"
    class=${cx('icon-btn', `icon-btn-${size}`, `icon-btn-${kind}`, active && 'is-active', klass)}
    title=${title}
    aria-label=${title}
    aria-pressed=${active ? 'true' : undefined}
    ...${rest}
  >
    <${Icon} name=${icon} size=${size === 'sm' ? 14 : size === 'lg' ? 20 : 16} />
    ${badge != null && badge !== 0 && html`<span class="icon-btn-badge">${badge}</span>`}
  </button>`;
}

export const ButtonGroup = ({ children, class: klass = '' }) => html`<div class=${cx('btn-group', klass)}>${children}</div>`;

/** Range slider with label and value; double-click the label to reset. onChange fires live, onCommit on release. */
export function Slider({ label, value, min = 0, max = 1, step = 0.01, onChange, onCommit, format = (v) => v.toFixed(2), resetValue, disabled = false, class: klass = '' }) {
  const pct = ((value - min) / (max - min)) * 100;
  return html`<label class=${cx('slider', disabled && 'is-disabled', klass)}>
    <span class="slider-top">
      <span class="slider-label" title=${resetValue != null ? 'Double-click to reset' : undefined} onDblClick=${() => resetValue != null && (onChange?.(resetValue), onCommit?.(resetValue))}>${label}</span>
      <span class="slider-value">${format(value)}</span>
    </span>
    <input
      type="range"
      min=${min}
      max=${max}
      step=${step}
      value=${value}
      disabled=${disabled}
      style=${`--pct:${clamp(pct, 0, 100)}%`}
      onInput=${(e) => onChange?.(Number(e.currentTarget.value))}
      onChange=${(e) => onCommit?.(Number(e.currentTarget.value))}
    />
  </label>`;
}

/** Re-syncs a field's text when its value prop changes — but not on mount (initial state already has it), so
 *  text typed in the first frame after mounting is never overwritten. */
function useSyncedText(value, sync) {
  const prev = useRef(value);
  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    sync();
  }, [value]);
}

export function NumberField({ value, onChange, min = -Infinity, max = Infinity, step = 1, suffix = '', width = 72, disabled = false, title }) {
  const [text, setText] = useState(String(value ?? ''));
  useSyncedText(value, () => setText(String(value ?? '')));
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n)) onChange?.(clamp(n, min, max));
    else setText(String(value ?? ''));
  };
  return html`<span class="num-field" style=${`width:${width}px`} title=${title}>
    <input
      type="number"
      value=${text}
      step=${step}
      min=${Number.isFinite(min) ? min : undefined}
      max=${Number.isFinite(max) ? max : undefined}
      disabled=${disabled}
      onInput=${(e) => setText(e.currentTarget.value)}
      onBlur=${commit}
      onKeyDown=${(e) => e.key === 'Enter' && (commit(), e.currentTarget.blur())}
    />
    ${suffix && html`<span class="num-suffix">${suffix}</span>`}
  </span>`;
}

/** Time input accepting "1:02.5", "62.5" etc. */
export function TimeField({ value, onChange, fps = 30, min = 0, max = Infinity, width = 86, disabled = false, title }) {
  const [text, setText] = useState(formatTime(value || 0));
  useSyncedText(value, () => setText(formatTime(value || 0)));
  const commit = () => {
    const n = parseTime(text, fps);
    if (Number.isFinite(n)) onChange?.(clamp(n, min, max));
    else setText(formatTime(value || 0));
  };
  return html`<input
    class="time-field"
    style=${`width:${width}px`}
    value=${text}
    title=${title}
    disabled=${disabled}
    onInput=${(e) => setText(e.currentTarget.value)}
    onBlur=${commit}
    onKeyDown=${(e) => e.key === 'Enter' && (commit(), e.currentTarget.blur())}
  />`;
}

export function Select({ value, options, onChange, class: klass = '', disabled = false, title }) {
  return html`<span class=${cx('select', klass)}>
    <select value=${value} disabled=${disabled} title=${title} onChange=${(e) => onChange?.(e.currentTarget.value)}>
      ${options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)).map((o) => html`<option value=${o.value} disabled=${o.disabled}>${o.label}</option>`)}
    </select>
    <${Icon} name="chevron-down" size=${14} />
  </span>`;
}

export function Toggle({ checked, onChange, label, disabled = false, title }) {
  return html`<label class=${cx('toggle', disabled && 'is-disabled')} title=${title}>
    <input type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange?.(e.currentTarget.checked)} />
    <span class="toggle-track"><span class="toggle-thumb"></span></span>
    ${label && html`<span class="toggle-label">${label}</span>`}
  </label>`;
}

export function TextField({ value, onInput, onCommit, placeholder = '', multiline = false, rows = 3, class: klass = '', autoFocus = false, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);
  const props = {
    ref,
    class: cx('text-field', klass),
    value: value ?? '',
    placeholder,
    onInput: (e) => onInput?.(e.currentTarget.value),
    onBlur: (e) => onCommit?.(e.currentTarget.value),
    ...rest,
  };
  return multiline ? html`<textarea rows=${rows} ...${props}></textarea>` : html`<input type="text" ...${props} />`;
}

export function Field({ label, hint, children, class: klass = '', inline = false }) {
  return html`<div class=${cx('field', inline && 'field-inline', klass)}>
    ${label && html`<div class="field-label">${label}</div>`}
    <div class="field-body">${children}</div>
    ${hint && html`<div class="field-hint">${hint}</div>`}
  </div>`;
}

export function Tabs({ tabs, value, onChange, class: klass = '' }) {
  return html`<div class=${cx('tabs', klass)} role="tablist">
    ${tabs.map(
      (t) => html`<button
        type="button"
        role="tab"
        data-tab=${t.id}
        aria-selected=${t.id === value ? 'true' : 'false'}
        class=${cx('tab', t.id === value && 'is-active')}
        onClick=${() => onChange(t.id)}
        title=${t.title}
      >
        ${t.icon && html`<${Icon} name=${t.icon} size=${15} />`}
        <span class="tab-label">${t.label}</span>
        ${t.badge != null && t.badge !== '' && t.badge !== 0 && html`<span class="tab-badge">${t.badge}</span>`}
      </button>`,
    )}
  </div>`;
}

/** Compact segmented control: options [{value, label, icon, title}] */
export function Segmented({ value, options, onChange, size = 'md' }) {
  return html`<div class=${cx('segmented', `segmented-${size}`)}>
    ${options.map(
      (o) => html`<button type="button" class=${cx(o.value === value && 'is-active')} title=${o.title || o.label} onClick=${() => onChange(o.value)}>
        ${o.icon && html`<${Icon} name=${o.icon} size=${14} />`}${o.label && html`<span>${o.label}</span>`}
      </button>`,
    )}
  </div>`;
}

export function EmptyState({ icon = 'inbox', title, children, action = null, compact = false }) {
  return html`<div class=${cx('empty', compact && 'empty-compact')}>
    <div class="empty-icon"><${Icon} name=${icon} size=${compact ? 22 : 30} /></div>
    ${title && html`<div class="empty-title">${title}</div>`}
    ${children && html`<div class="empty-body">${children}</div>`}
    ${action && html`<div class="empty-action">${action}</div>`}
  </div>`;
}

export const Badge = ({ children, kind = 'default', title }) => html`<span class=${cx('badge', `badge-${kind}`)} title=${title}>${children}</span>`;
export const Kbd = ({ combo, children }) => html`<kbd class="kbd">${children || comboLabel(combo)}</kbd>`;
export const Spinner = ({ size = 16 }) => html`<span class="spinner" style=${`width:${size}px;height:${size}px`}></span>`;

export function ProgressBar({ value = 0, indeterminate = false, label }) {
  return html`<div class=${cx('progress', indeterminate && 'is-indeterminate')} role="progressbar" aria-valuenow=${Math.round(value * 100)} aria-valuemin="0" aria-valuemax="100">
    <div class="progress-fill" style=${`width:${clamp(value, 0, 1) * 100}%`}></div>
    ${label && html`<div class="progress-label">${label}</div>`}
  </div>`;
}

/** Wraps children; accepts dropped files (and optional custom drag types). */
export function DropZone({ onFiles, onDropData, accept = null, children, class: klass = '', label = 'Drop files to import' }) {
  const [over, setOver] = useState(0);
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  return html`<div
    class=${cx('dropzone', over > 0 && 'is-over', klass)}
    onDragEnter=${(e) => {
      if (!isFileDrag(e) && !onDropData) return;
      e.preventDefault();
      setOver((n) => n + 1);
    }}
    onDragOver=${(e) => {
      if (!isFileDrag(e) && !onDropData) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }}
    onDragLeave=${() => setOver((n) => Math.max(0, n - 1))}
    onDrop=${(e) => {
      setOver(0);
      const files = [...(e.dataTransfer?.files || [])].filter((f) => !accept || accept(f));
      if (files.length) {
        e.preventDefault();
        onFiles?.(files);
      } else if (onDropData) {
        e.preventDefault();
        onDropData(e.dataTransfer, e);
      }
    }}
  >
    ${children}
    ${over > 0 && html`<div class="dropzone-overlay"><${Icon} name="upload" size=${28} /><span>${label}</span></div>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------------------

export function Modal({ title, onClose, children, footer = null, width = 520, class: klass = '', closeOnBackdrop = true }) {
  // modal: true — while open, shortcuts of views underneath (Space, Enter, Delete…) are suspended.
  useHotkeys({ escape: () => onClose?.() }, { modal: true });
  const ref = useRef(null);
  useEffect(() => {
    // Initial focus: an explicit [data-autofocus] element, else the dialog itself — never a random field, so
    // dialog shortcuts (Enter to confirm/export) work right away. Fields that want focus use autoFocus.
    const root = ref.current;
    if (!root || root.contains(document.activeElement)) return;
    (root.querySelector('[data-autofocus]') || root).focus({ preventScroll: true });
  }, []);
  return html`<div class="modal-backdrop" onMouseDown=${(e) => closeOnBackdrop && e.target === e.currentTarget && onClose?.()}>
    <div ref=${ref} tabindex="-1" class=${cx('modal', klass)} style=${`width:min(${width}px, calc(100vw - 24px))`} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="modal-header">
        <div class="modal-title">${title}</div>
        <${IconButton} icon="x" title="Close" onClick=${onClose} />
      </div>
      <div class="modal-body">${children}</div>
      ${footer && html`<div class="modal-footer">${footer}</div>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------------------

const toastStore = createStore([]);

/** toast('Saved', {kind: 'success'|'error'|'info'|'warn', duration: ms, action: {label, run}, actions: [{label, run}]}) */
export function toast(message, { kind = 'info', duration = 3200, action = null, actions = null } = {}) {
  const id = uid('tst');
  const list = [action, ...(actions || [])].filter((a) => a && a.label && typeof a.run === 'function');
  toastStore.set((cur) => [...cur.slice(-3), { id, message, kind, actions: list }]);
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
  return id;
}

/** Opens Grok Imagine in a new tab (or focuses the extension's choice of tab). */
function openGrokImagine() {
  try {
    if (globalThis.chrome?.tabs?.create) return void chrome.tabs.create({ url: 'https://grok.com/imagine' });
  } catch {
    /* fall through */
  }
  window.open('https://grok.com/imagine', '_blank', 'noopener');
}

/**
 * The one message for "this needs a grok.com tab" (every panel words it the same way): a warning that says what
 * could not be done, an "Open Grok Imagine" action, plus "Copy" when there is text the user may want to keep.
 *   notConnectedToast('send this prompt', {copyText: prompt})
 */
export function notConnectedToast(what, { copyText: text = null } = {}) {
  const actions = [{ label: 'Open Grok Imagine', run: openGrokImagine }];
  if (text) actions.push({ label: 'Copy', run: () => copyText(text).then((ok) => ok && toast('Copied', { kind: 'success', duration: 1600 })) });
  return toast(`Not connected to grok.com — open Grok Imagine to ${what}.`, { kind: 'warn', duration: 8000, actions });
}
export const dismissToast = (id) => toastStore.set((list) => list.filter((t) => t.id !== id));

export function ToastHost() {
  const toasts = useStore(toastStore);
  return html`<div class="toast-host" aria-live="polite">
    ${toasts.map(
      (t) => html`<div class=${cx('toast', `toast-${t.kind}`)} key=${t.id}>
        <${Icon} name=${t.kind === 'success' ? 'check' : t.kind === 'error' ? 'alert' : t.kind === 'warn' ? 'alert' : 'info'} size=${15} />
        <span class="toast-msg">${t.message}</span>
        ${(t.actions || []).map((a) => html`<button class="toast-action" onClick=${() => (a.run(), dismissToast(t.id))}>${a.label}</button>`)}
        <button class="toast-close" aria-label="Dismiss" onClick=${() => dismissToast(t.id)}><${Icon} name="x" size=${13} /></button>
      </div>`,
    )}
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------------------

const dialogStore = createStore(null);

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => dialogStore.set(() => ({ type: 'confirm', title, message, confirmLabel, cancelLabel, danger, resolve })));
}

export function promptDialog({ title = 'Enter a value', label = '', value = '', placeholder = '', confirmLabel = 'OK', multiline = false } = {}) {
  return new Promise((resolve) => dialogStore.set(() => ({ type: 'prompt', title, label, value, placeholder, confirmLabel, multiline, resolve })));
}

function PromptBody({ d, onDone }) {
  const [v, setV] = useState(d.value);
  return html`<form
    onSubmit=${(e) => {
      e.preventDefault();
      onDone(v);
    }}
  >
    ${d.label && html`<div class="field-label">${d.label}</div>`}
    <${TextField} value=${v} onInput=${setV} placeholder=${d.placeholder} multiline=${d.multiline} rows=${6} autoFocus=${true} />
    <div class="modal-footer modal-footer-inline">
      <${Button} kind="ghost" onClick=${() => onDone(null)}>Cancel<//>
      <button type="submit" class="btn btn-primary btn-md"><span class="btn-label">${d.confirmLabel}</span></button>
    </div>
  </form>`;
}

export function DialogHost() {
  const d = useStore(dialogStore, (s) => s, Object.is);
  if (!d) return null;
  const done = (v) => {
    dialogStore.set(() => null);
    d.resolve(v);
  };
  if (d.type === 'confirm') {
    return html`<${Modal}
      title=${d.title}
      width=${420}
      onClose=${() => done(false)}
      footer=${html`<${Button} kind="ghost" onClick=${() => done(false)}>${d.cancelLabel}<//><${Button} kind=${d.danger ? 'danger' : 'primary'} onClick=${() => done(true)} data-autofocus="true">${d.confirmLabel}<//>`}
    >
      <p class="dialog-message">${d.message}</p>
    <//>`;
  }
  return html`<${Modal} title=${d.title} width=${d.multiline ? 560 : 420} onClose=${() => done(null)}><${PromptBody} d=${d} onDone=${done} /><//>`;
}

// ---------------------------------------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------------------------------------

const menuStore = createStore(null);

/** Opens a context menu at the event position (or {x, y}). */
export function showMenu(evOrPos, items) {
  let x;
  let y;
  if (evOrPos && 'clientX' in evOrPos) {
    evOrPos.preventDefault?.();
    evOrPos.stopPropagation?.();
    x = evOrPos.clientX;
    y = evOrPos.clientY;
  } else if (evOrPos?.currentTarget?.getBoundingClientRect || evOrPos?.getBoundingClientRect) {
    const r = (evOrPos.currentTarget || evOrPos).getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  } else {
    x = evOrPos?.x ?? 100;
    y = evOrPos?.y ?? 100;
  }
  menuStore.set(() => ({ x, y, items: items.filter(Boolean) }));
}
export const closeMenu = () => menuStore.set(() => null);

export function MenuHost() {
  const m = useStore(menuStore, (s) => s, Object.is);
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!m) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) closeMenu();
    };
    const onBlur = () => closeMenu();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [m]);
  useEffect(() => {
    if (!m || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    const x = Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4));
    const y = m.y + r.height > window.innerHeight - 4 ? Math.max(4, m.y - r.height) : m.y;
    setPos({ x, y });
  }, [m]);
  useHotkeys({ escape: () => (m ? closeMenu() : false) }, { enabled: !!m, modal: true });
  if (!m) return null;
  return html`<div class="menu" ref=${ref} role="menu" style=${`left:${(pos || m).x}px;top:${(pos || m).y}px;visibility:${pos ? 'visible' : 'hidden'}`}>
    ${m.items.map((it, i) =>
      it === '-'
        ? html`<div class="menu-sep" key=${'sep' + i}></div>`
        : it.header
          ? html`<div class="menu-header" key=${'h' + i}>${it.header}</div>`
          : html`<button
              type="button"
              key=${i}
              role=${it.checked != null ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked=${it.checked != null ? String(!!it.checked) : undefined}
              class=${cx('menu-item', it.danger && 'is-danger', it.checked && 'is-checked')}
              disabled=${it.disabled}
              onClick=${() => {
                closeMenu();
                it.onClick?.();
              }}
            >
              <span class="menu-icon">${it.icon ? html`<${Icon} name=${it.icon} size=${14} />` : it.checked ? html`<${Icon} name="check" size=${14} />` : null}</span>
              <span class="menu-label">${it.label}</span>
              ${it.shortcut && html`<span class="menu-shortcut">${comboLabel(it.shortcut)}</span>`}
              ${it.checked && it.icon && html`<span class="menu-check" aria-hidden="true"><${Icon} name="check" size=${14} /></span>`}
            </button>`,
    )}
  </div>`;
}

/** Hidden file input helper: pickFiles({accept, multiple}) -> Promise<File[]> */
export function pickFiles({ accept = '', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      resolve([...(input.files || [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    input.click();
  });
}

/** Simple collapsible section. */
export function Section({ title, children, defaultOpen = true, actions = null, class: klass = '' }) {
  const [open, setOpen] = useState(defaultOpen);
  return html`<section class=${cx('section', open && 'is-open', klass)}>
    <header class="section-header">
      <button type="button" class="section-toggle" onClick=${() => setOpen(!open)}>
        <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} size=${14} />
        <span>${title}</span>
      </button>
      ${actions && html`<div class="section-actions">${actions}</div>`}
    </header>
    ${open && html`<div class="section-body">${children}</div>`}
  </section>`;
}

/** Star rating input (0..5). */
export function Rating({ value = 0, onChange, size = 14 }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return html`<span class="rating" onMouseLeave=${() => setHover(0)}>
    ${[1, 2, 3, 4, 5].map(
      (n) => html`<button
        type="button"
        class=${cx('rating-star', n <= shown && 'is-on')}
        title=${`${n} star${n > 1 ? 's' : ''}`}
        onMouseEnter=${() => setHover(n)}
        onClick=${(e) => {
          e.stopPropagation();
          onChange?.(n === value ? 0 : n);
        }}
      ><${Icon} name=${n <= shown ? 'star-filled' : 'star'} size=${size} /></button>`,
    )}
  </span>`;
}
