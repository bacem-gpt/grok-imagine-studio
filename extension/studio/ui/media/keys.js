// Keyboard helpers for the Clips area. The shell's hotkey stack lets the most recently mounted map win. Kit modals
// and menus shield the maps registered before them, but a Clips map mounted after them (the Clips view first opened
// after the menu host, review mode) sits above them and would otherwise steal Enter, Space or letters meant for a
// confirm dialog or an open menu. guardKeys() makes every handler yield while one is open; revealIn() keeps keyboard
// navigation's scrolling inside the list being navigated.

/** True while a kit modal (dialogs, frame grab, shortcuts) or a context menu is on screen. */
export const overlayOpen = () => !!document.querySelector('.modal-backdrop, .menu');

const SLIDER_KEYS = /^(shift\+)?(arrowleft|arrowright|arrowup|arrowdown|home|end|pageup|pagedown)$/;

/**
 * Wraps each handler of a useHotkeys map so it falls through (returns false) while an overlay is open, and leaves
 * arrow keys to a focused range slider (volume, card size).
 */
export function guardKeys(map) {
  const out = {};
  for (const [combo, fn] of Object.entries(map)) {
    out[combo] = (e) => {
      if (overlayOpen()) return false;
      if (e?.target?.type === 'range' && SLIDER_KEYS.test(combo)) return false;
      return fn(e);
    };
  }
  return out;
}

/**
 * Scrolls `container` just enough to show `el` (or centres it with center: true) without touching any other
 * ancestor — unlike Element.scrollIntoView, which also scrolls overflow:hidden ancestors such as the page body.
 */
export function revealIn(container, el, { axis = 'y', center = false, margin = 8 } = {}) {
  if (!container || !el) return;
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (axis === 'x') {
    if (center) container.scrollLeft += r.left + r.width / 2 - (c.left + c.width / 2);
    else if (r.left < c.left) container.scrollLeft -= c.left - r.left + margin;
    else if (r.right > c.right) container.scrollLeft += r.right - c.right + margin;
    return;
  }
  if (center) container.scrollTop += r.top + r.height / 2 - (c.top + c.height / 2);
  else if (r.top < c.top) container.scrollTop -= c.top - r.top + margin;
  else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom + margin;
}
