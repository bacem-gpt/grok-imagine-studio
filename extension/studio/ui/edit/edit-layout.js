// Edit tab layout rules (pure; unit-tested in tests/unit/edit.test.mjs): which arrangement the Edit view uses at a
// given size, and where the inspector opens in the narrow / short arrangements.

/** Below this width: monitor on top, timeline below; the bin and the inspector open on demand. */
export const NARROW_W = 760;
/** Below this height (and not narrow, e.g. docked at the bottom of grok.com): monitor and timeline side by side. */
export const SHORT_H = 500;
/** Wide layout below this width: slimmer bin and inspector columns. */
export const MID_W = 1180;
/** Narrow layout at least this wide: the inspector opens as a column beside the monitor. */
export const NARROW_COLUMN_W = 640;
/** Short layout at least this wide: the inspector opens as a third column, right of the timeline. */
export const SHORT_COLUMN_W = 1040;
/** Inspector column width in the short layout (keep in sync with `.edit-view.is-short > .edit-insp` in edit.css). */
export const SHORT_INSP_W = 300;

/**
 * Layout of the Edit view at width × height px: {narrow, short, drawers, mid, inspector}. `drawers` = narrow or
 * short (the bin is a drawer). `inspector` = 'panel' in the wide layouts (the collapsible right panel), else where it
 * opens on demand: 'column' when there is room (the monitor shrinks, the timeline stays usable) or 'sheet' over the
 * timeline (the monitor stays visible and playing). Never a modal drawer over the monitor: the inspector is for
 * seeing the result while adjusting fades, speed, looks or titles.
 */
export function editLayout(width, height) {
  const narrow = width > 0 && width < NARROW_W;
  const short = !narrow && height > 0 && height < SHORT_H;
  const drawers = narrow || short;
  const mid = !drawers && width > 0 && width < MID_W;
  const inspector = !drawers ? 'panel' : width >= (narrow ? NARROW_COLUMN_W : SHORT_COLUMN_W) ? 'column' : 'sheet';
  return { narrow, short, drawers, mid, inspector };
}
