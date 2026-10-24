// Robust pointer gestures. A drag must ALWAYS end, even when the browser never delivers its pointerup: the button
// released outside the window or over another frame, a context menu or a dialog stealing the pointer, Alt+Tab, the
// tab hidden, the element removed mid-drag, pointer capture lost… A drag that never ends leaves the UI "stuck"
// (a clip glued to the mouse, a resize cursor that never goes away). trackPointer() ends the gesture on whichever
// of these comes first, exactly once:
//   pointerup → end · pointercancel / Escape → end (cancelled) · lostpointercapture, window blur, tab hidden,
//   a move with no button pressed (the release was missed), the element leaving the document → end.
//
//   const stop = trackPointer(e, { onMove(ev), onEnd(ev, {cancelled}) })   // stop() ends it from outside (cancelled)

/** True for a primary-button press (left mouse, pen tip, touch). */
export const isPrimary = (e) => e.button === 0 && !(e.ctrlKey && /Mac/i.test(navigator.platform || ''));

/**
 * Follows one pointer from its pointerdown event until the gesture ends (see above). Returns a function that ends it
 * early (as cancelled). The element receiving the events is `e.currentTarget` unless `target` is given.
 */
export function trackPointer(e, { target = e.currentTarget, onMove = null, onEnd = null } = {}) {
  const id = e.pointerId;
  const win = target?.ownerDocument?.defaultView || window;
  const doc = win.document;
  let done = false;
  let last = e; // latest pointer event: an end without its own event (blur, Escape…) reports the last position
  try {
    target.setPointerCapture(id);
  } catch {
    /* not capturable (e.g. a synthetic event): window listeners below still see the pointer */
  }
  const finish = (ev, cancelled) => {
    if (done) return;
    done = true;
    target.removeEventListener('lostpointercapture', lost);
    win.removeEventListener('pointermove', move, true);
    win.removeEventListener('pointerup', up, true);
    win.removeEventListener('pointercancel', up, true);
    win.removeEventListener('blur', blur);
    win.removeEventListener('keydown', key, true);
    doc.removeEventListener('visibilitychange', hidden);
    try {
      if (target.hasPointerCapture?.(id)) target.releasePointerCapture(id);
    } catch {
      /* already released */
    }
    try {
      onEnd?.(ev || last, { cancelled });
    } catch (err) {
      console.warn('[gis] drag end failed', err);
    }
  };
  const move = (ev) => {
    if (ev.pointerId !== id || done) return;
    // The button is up but no pointerup reached us (released outside the window / over another frame).
    if (ev.pointerType === 'mouse' && ev.buttons === 0) return finish(ev, false);
    if (!target.isConnected) return finish(ev, true);
    last = ev;
    onMove?.(ev);
  };
  const up = (ev) => {
    if (ev.pointerId === id) finish(ev, ev.type === 'pointercancel');
  };
  const lost = (ev) => {
    if (ev.pointerId === id) finish(ev, false);
  };
  const blur = () => finish(null, false);
  const hidden = () => doc.hidden && finish(null, false);
  const key = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(null, true);
  };
  // Window listeners in the capture phase see every pointer event of the document, captured to `target` or not, so
  // a lost capture never leaves the gesture without its end.
  target.addEventListener('lostpointercapture', lost);
  win.addEventListener('pointermove', move, true);
  win.addEventListener('pointerup', up, true);
  win.addEventListener('pointercancel', up, true);
  win.addEventListener('blur', blur);
  win.addEventListener('keydown', key, true);
  doc.addEventListener('visibilitychange', hidden);
  return () => finish(null, true);
}

/**
 * Calls `fn` once when the current HTML drag-and-drop session is over, whichever way it ends: a drop anywhere (also
 * one a child handled and stopped), dragend, the window losing focus, or the mouse moving again with no drag (the
 * drag left the frame and ended elsewhere). Drop-target highlights use it so they can never stay on.
 * Returns an unsubscribe function.
 */
export function onDragSessionEnd(fn, win = window) {
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    off();
    fn();
  };
  const evs = [
    ['drop', true],
    ['dragend', true],
    ['blur', false],
    ['mousemove', true],
    ['pointerdown', true],
  ];
  const off = () => evs.forEach(([t, c]) => win.removeEventListener(t, end, c));
  evs.forEach(([t, c]) => win.addEventListener(t, end, c));
  return () => {
    done = true;
    off();
  };
}
