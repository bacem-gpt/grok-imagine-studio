// Per-viewer conveniences of the Clips tab (card size, collapsed sections, monitor volume …) kept in localStorage.
// The studio is an extension page, so the embedded overlay and the standalone tab share them. Never required:
// every read falls back to a default and every write is best effort.
import { useState, useCallback } from '../../../vendor/preact-htm.mjs';

const PREFIX = 'gis.clips.';

export function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: the preference just isn't remembered */
  }
}

/** useState backed by a stored preference: [value, setValue]. */
export function usePref(key, fallback) {
  const [value, setValue] = useState(() => loadPref(key, fallback));
  const set = useCallback(
    (next) =>
      setValue((prev) => {
        const v = typeof next === 'function' ? next(prev) : next;
        savePref(key, v);
        return v;
      }),
    [key],
  );
  return [value, set];
}
