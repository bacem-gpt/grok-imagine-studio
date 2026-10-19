// memo() for the Clips area: the vendored Preact bundle has no compat memo(). A memoized component re-renders only
// when one of its props changes (shallow compare, like React.memo); its own hooks (store selectors, state) still
// re-render it. Bin cards use it so a status update of one item re-renders that card, not every card of the bin.
import { h } from '../../../vendor/preact-htm.mjs';

/** True when two props objects differ in any key (shallow). */
export function shallowDiffers(a, b) {
  for (const k in a) if (!(k in b)) return true;
  for (const k in b) if (a[k] !== b[k]) return true;
  return false;
}

function shouldUpdate(next) {
  return shallowDiffers(this.props, next);
}

/**
 * Wraps a function component so that it skips re-rendering while its props are shallow-equal. Callbacks passed to it
 * must be stable (or passed inside one stable object) for the skip to happen.
 */
export function memo(Fn) {
  function Memoed(props) {
    // Preact calls function components with the component instance as `this` (this is how compat's memo works).
    this.shouldComponentUpdate = shouldUpdate;
    return h(Fn, props);
  }
  Memoed.displayName = `Memo(${Fn.displayName || Fn.name || 'Component'})`;
  return Memoed;
}
