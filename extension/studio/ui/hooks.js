// Preact hooks bridging the framework-free stores into components.
import { useState, useEffect, useRef, useCallback } from '../../vendor/preact-htm.mjs';
import { trackPointer, isPrimary, onDragSessionEnd } from './pointer.js';
import { projectStore, uiStore, pageStore, libraryStore } from '../core/store.js';
import { shallowEqual } from '../core/utils.js';
import { getPreviews, getMediaUrl, onMediaEvent } from '../core/media.js';

/** Subscribe to a store slice; re-renders only when the selected value changes (shallow compare). */
export function useStore(store, selector = (s) => s, equal = shallowEqual) {
  const [, force] = useState(0);
  const selRef = useRef(selector);
  selRef.current = selector;
  const valRef = useRef();
  valRef.current = selector(store.get());
  useEffect(() => {
    const check = (s) => {
      const next = selRef.current(s);
      if (!equal(next, valRef.current)) {
        valRef.current = next;
        force((x) => x + 1);
      }
    };
    check(store.get()); // catch updates between render and subscribe
    return store.subscribe(check);
  }, [store]);
  return valRef.current;
}

export const useProject = (selector = (p) => p) => useStore(projectStore, (p) => (p ? selector(p) : undefined));
export const useUI = (selector = (s) => s) => useStore(uiStore, selector);
export const usePage = (selector = (s) => s) => useStore(pageStore, selector);
export const useLibrary = (selector = (s) => s) => useStore(libraryStore, selector);

/** Undo/redo availability (re-renders on history changes). */
export function useHistoryState() {
  const [state, setState] = useState(() => ({ canUndo: projectStore.canUndo(), canRedo: projectStore.canRedo() }));
  useEffect(
    () =>
      projectStore.onHistory(() =>
        setState({ canUndo: projectStore.canUndo(), canRedo: projectStore.canRedo(), undoLabel: projectStore.undoLabel(), redoLabel: projectStore.redoLabel() }),
      ),
    [],
  );
  return state;
}

/** Thumbnail/filmstrip object URLs for a media item; refreshes when the item finishes processing. */
export function useMediaPreview(mediaId) {
  const [previews, setPreviews] = useState(null);
  useEffect(() => {
    if (!mediaId) return undefined;
    let alive = true;
    const load = () =>
      getPreviews(mediaId).then((p) => {
        if (alive) setPreviews(p);
      });
    load();
    const off = onMediaEvent((e) => {
      if (e.id === mediaId && e.type === 'ready') load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [mediaId]);
  return previews;
}

/** Object URL of the media binary (null until downloaded). */
export function useMediaUrl(mediaId) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!mediaId) return undefined;
    let alive = true;
    const load = () =>
      getMediaUrl(mediaId).then((u) => {
        if (alive) setUrl(u);
      });
    load();
    const off = onMediaEvent((e) => {
      if (e.id === mediaId && e.type === 'ready') load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [mediaId]);
  return url;
}

/** Element size via ResizeObserver: [ref, {width, height}]. */
export function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Stable callback that always sees the latest closure. */
export function useEvent(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args) => ref.current(...args), []);
}

/**
 * Pointer drag helper: returns onPointerDown; calls onMove({dx, dy, event}) and onEnd. Always ends, even when the
 * pointerup is never delivered (see ui/pointer.js).
 */
export function useDrag({ onStart, onMove, onEnd, threshold = 0 } = {}) {
  const handlers = useRef({ onStart, onMove, onEnd });
  handlers.current = { onStart, onMove, onEnd };
  return useCallback(
    (e) => {
      if (!isPrimary(e)) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let started = threshold === 0;
      let ctx = null;
      if (started) ctx = handlers.current.onStart?.(e);
      if (ctx === false) return;
      const stop = trackPointer(e, {
        onMove: (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!started) {
            if (Math.hypot(dx, dy) < threshold) return;
            started = true;
            ctx = handlers.current.onStart?.(e);
            if (ctx === false) {
              started = false;
              return stop();
            }
          }
          handlers.current.onMove?.({ dx, dy, event: ev, ctx });
        },
        onEnd: (ev, { cancelled }) => {
          if (started) handlers.current.onEnd?.({ dx: ev.clientX - startX, dy: ev.clientY - startY, event: ev, ctx, cancelled });
        },
      });
    },
    [threshold],
  );
}

/** While `active` (a drop-target highlight is on), calls `reset` when the drag-and-drop session ends, however it ends. */
export function useDragHighlightReset(active, reset) {
  const fn = useRef(reset);
  fn.current = reset;
  useEffect(() => (active ? onDragSessionEnd(() => fn.current()) : undefined), [active]);
}

