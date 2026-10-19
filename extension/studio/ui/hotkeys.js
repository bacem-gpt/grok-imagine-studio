// Keyboard shortcut registry. Components register maps with useHotkeys({'mod+z': fn, 'space': fn, ...}).
// The most recently mounted (and enabled) map wins. Handlers returning `false` let the event fall through.
// Combo format: modifiers in the order mod (Ctrl or Cmd), alt, shift, then the key: 'mod+shift+z', 'arrowleft',
// 'shift+arrowleft', 'space', 'delete', 'backspace', 'escape', 'enter', 's', '1', '+', '-'.
import { useEffect, useRef } from '../../vendor/preact-htm.mjs';

const stack = [];

export function comboFromEvent(e) {
  let key = e.key;
  if (key === ' ' || key === 'Spacebar') key = 'space';
  key = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  if (key === 'esc') key = 'escape';
  if (key === 'del') key = 'delete';
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  // Shift is implied for symbols like '+', '?', so only add it to letters, digits and named keys.
  if (e.shiftKey && (key.length > 1 || /[a-z0-9]/.test(key))) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (el.isContentEditable) return true;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes(type);
  }
  return false;
}

/** Combos that still work while typing in a field. */
const ALWAYS = new Set(['escape', 'mod+enter', 'mod+s', 'mod+e']);

function onKeyDown(e) {
  if (e.isComposing) return;
  if (e.defaultPrevented && comboFromEvent(e) !== 'mod+d') return;
  const combo = comboFromEvent(e);
  // The studio never wants the browser's bookmark dialog (Ctrl/Cmd+D duplicates clips), even while typing.
  if (combo === 'mod+d') e.preventDefault();
  if (isTypingTarget(e.target) && !ALWAYS.has(combo)) return;
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (!entry.enabled()) continue;
    const fn = entry.map()[combo];
    if (fn) {
      const res = fn(e);
      if (res !== false) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    // An open modal (dialog / menu) shields everything registered before it.
    if (entry.modal) return;
  }
}

/** True while a modal-scoped map (dialog, menu) is active. */
export const modalOpen = () => stack.some((e) => e.modal && e.enabled());

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', onKeyDown);
}

/**
 * Registers shortcuts while the component is mounted. `enabled` may change between renders.
 * modal: true marks a dialog/menu scope — while it is enabled, maps registered before it never fire.
 */
export function useHotkeys(map, { enabled = true, modal = false } = {}) {
  const mapRef = useRef(map);
  const enabledRef = useRef(enabled);
  mapRef.current = map;
  enabledRef.current = enabled;
  useEffect(() => {
    install();
    const entry = { map: () => mapRef.current, enabled: () => enabledRef.current, modal };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, []);
}

/** Human label for a combo, e.g. 'mod+shift+z' -> '⌘⇧Z' on Mac, 'Ctrl+Shift+Z' elsewhere. */
export function comboLabel(combo) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return combo
    .split('+')
    .map((p) => {
      if (p === 'mod') return mac ? '⌘' : 'Ctrl';
      if (p === 'shift') return mac ? '⇧' : 'Shift';
      if (p === 'alt') return mac ? '⌥' : 'Alt';
      if (p === 'arrowleft') return '←';
      if (p === 'arrowright') return '→';
      if (p === 'arrowup') return '↑';
      if (p === 'arrowdown') return '↓';
      if (p === 'space') return 'Space';
      if (p === 'escape') return 'Esc';
      if (p === 'delete') return 'Del';
      return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
    })
    .join(mac ? '' : '+');
}
