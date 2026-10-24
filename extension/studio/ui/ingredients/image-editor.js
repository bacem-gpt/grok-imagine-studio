// Image editor workspace (Ingredients tab): non-destructive crop with aspect presets and a draggable/resizable crop
// box, quarter-turn rotation, flips, resize presets and colour adjustments with a live canvas preview. Nothing is
// written until "Save as new" / "Overwrite" / "Download" / "Copy". Local undo/redo (Ctrl/⌘+Z) covers the edits; while
// the editor is open the header's sequence undo/redo is hidden (ingredients.css), so one undo pair is on screen.
import { html, useState, useEffect, useRef } from '../../../vendor/preact-htm.mjs';
import { trackPointer } from '../pointer.js';
import { addIngredient, getIngredientBlob, replaceIngredientImage } from '../../core/ingredients.js';
import { downloadBlob, copyImage, formatBytes } from '../../core/utils.js';
import { useElementSize } from '../hooks.js';
import { useHotkeys, isTypingTarget, modalOpen } from '../hotkeys.js';
import { Icon, Button, IconButton, Slider, NumberField, Select, Tabs, Section, Spinner, EmptyState, toast, confirmDialog, showMenu, cx } from '../kit.js';
import * as G from './geometry.js';
import { ADJUST_DEFAULTS, ADJUST_FIELDS, ADJUST_LOOKS, adjustEqual, adjustIsNeutral, adjustValue } from './pixels.js';
import { defaultEdits, editsAreNeutral, editGeometry, decodePreview, renderPreview, renderEdited } from './render.js';
import { editedName, ingredientFilename, outputMime } from './logic.js';
import { IngredientDetails } from './details.js';
import { revealIds, setEditorGuard, clearEditorGuard } from './state.js';
import { imageVersion } from './thumb.js';
import { openEditor } from './actions.js';

const PAD_X = 24;
const PAD_TOP = 40;
const PAD_BOTTOM = 64; // room for the floating tool bar
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const FORMAT_OPTIONS = [
  { value: 'auto', label: 'Same as original' },
  { value: 'image/png', label: 'PNG (lossless)' },
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/webp', label: 'WebP' },
];
/** A dialog or menu is open: its keys win (Escape closes it, not the editor). */
const anyModalOpen = () => modalOpen() || !!document.querySelector('.modal-backdrop, .menu');
/** Focused form control (slider, select, text field): it keeps its native keys (arrows move a slider). */
const isFormControl = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || !!el.isContentEditable);
const mimeLabel = (m) => ({ 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP' }[m] || 'PNG');

/** Small rectangle glyph drawn at the preset's ratio. */
function AspectGlyph({ ratio }) {
  if (!ratio) return html`<span class="ing-aspect-glyph is-free"></span>`;
  const w = ratio >= 1 ? 16 : Math.round(16 * ratio);
  const h = ratio >= 1 ? Math.round(16 / ratio) : 16;
  return html`<span class="ing-aspect-glyph" style=${`width:${w}px;height:${h}px`}></span>`;
}

export function ImageEditor({ ing, tab = 'edit', onTab, onClose, active }) {
  const [edits, setEdits] = useState(defaultEdits);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const hist = useRef({ past: [], future: [], pending: null });
  const [, setHistTick] = useState(0);
  const [src, setSrc] = useState(null); // {bitmap (preview), width, height (full), blob}
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);
  const [compare, setCompare] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [reload, setReload] = useState(0);
  const [fieldKeys, setFieldKeys] = useState({}); // remount counters for number fields (see bumpField)
  const savedRef = useRef(null); // the edit state already saved: the loaded image, or the last "Save as new"
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const panelRef = useRef(null);
  const [stageRef, stage] = useElementSize();
  const version = imageVersion(ing);

  // Load the image (and reset the edits) whenever a different image is shown.
  useEffect(() => {
    let alive = true;
    let bitmap = null;
    setSrc(null);
    setError(null);
    const fresh = defaultEdits();
    savedRef.current = fresh;
    editsRef.current = fresh;
    setEdits(fresh);
    hist.current = { past: [], future: [], pending: null };
    setHistTick((x) => x + 1);
    (async () => {
      const blob = await getIngredientBlob(ing.id);
      if (!blob) throw new Error('The image file is missing from storage');
      const p = await decodePreview(blob, 1600);
      if (!alive) return p.bitmap.close();
      bitmap = p.bitmap;
      setSrc({ ...p, blob });
    })().catch((e) => alive && setError(String(e?.message || e)));
    return () => {
      alive = false;
      bitmap?.close();
    };
  }, [ing.id, version, reload]);

  const W = src?.width || ing.width || 1;
  const H = src?.height || ing.height || 1;
  const o = G.orientedSize(W, H, edits.rotation);
  const crop = G.cropOf(edits, W, H);
  const ratio = G.aspectRatioOf(edits.aspect);
  const geo = editGeometry(W, H, edits);
  const neutral = editsAreNeutral(edits, o.width, o.height);
  const dirty = !neutral && !G.editStatesEqual(edits, savedRef.current, W, H);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const type = outputMime(ing.mime || src?.blob?.type, edits.format);
  const fit = G.fitContain(o.width, o.height, Math.max(0, stage.width - PAD_X * 2), Math.max(0, stage.height - PAD_TOP - PAD_BOTTOM), 8);
  const box = { left: PAD_X + fit.x, top: PAD_TOP + fit.y, width: fit.width, height: fit.height };

  // Live preview (coalesced to one render per frame), rendered at the on-screen size (bucketed to 128 device px).
  const previewWidth = Math.max(128, Math.ceil((fit.width * (window.devicePixelRatio || 1)) / 128) * 128);
  useEffect(() => {
    if (!src || !canvasRef.current || !fit.width) return undefined;
    const raf = requestAnimationFrame(() => {
      try {
        renderPreview(canvasRef.current, src.bitmap, editsRef.current, { showOriginal: compare, maxWidth: previewWidth });
      } catch (e) {
        console.warn('[gis] preview render failed', e);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [src, edits.rotation, edits.flipH, edits.flipV, edits.adjust, compare, previewWidth, !fit.width]);

  // ---------------------------------------------------------------- history
  const bump = () => setHistTick((x) => x + 1);
  const record = (prev) => {
    const h = hist.current;
    h.past.push(prev);
    if (h.past.length > 100) h.past.shift();
    h.future = [];
    bump();
  };
  /**
   * Applies a new edit state; commit=false for live gesture steps (see begin/endGesture). Edits that change nothing
   * (a nudge against the edge, a clamped number) are skipped so they never become undo steps. Returns true if applied.
   */
  const apply = (next, commit = true) => {
    const cur = editsRef.current;
    if (!next || next === cur || G.editStatesEqual(next, cur, W, H)) return false;
    if (commit) record(cur);
    editsRef.current = next;
    setEdits(next);
    return true;
  };
  const beginGesture = () => {
    if (!hist.current.pending) hist.current.pending = editsRef.current;
  };
  const endGesture = () => {
    const p = hist.current.pending;
    hist.current.pending = null;
    if (p && !G.editStatesEqual(p, editsRef.current, W, H)) record(p);
  };
  const undo = () => {
    const h = hist.current;
    if (!h.past.length) return;
    h.future.push(editsRef.current);
    const prev = h.past.pop();
    editsRef.current = prev;
    setEdits(prev);
    bump();
  };
  const redo = () => {
    const h = hist.current;
    if (!h.future.length) return;
    h.past.push(editsRef.current);
    const next = h.future.pop();
    editsRef.current = next;
    setEdits(next);
    bump();
  };

  // ---------------------------------------------------------------- edit operations
  const cur = () => editsRef.current;
  const rotate = (dir) => apply(G.rotateEditState(cur(), dir, W, H));
  const flip = (axis) => apply(G.flipEditState(cur(), axis, W, H));
  const setAspect = (id) => apply(G.setAspectState(cur(), id, W, H));
  const setResize = (preset) => apply(G.setResizeState(cur(), preset, W, H));
  const setResizeField = (patch) => apply({ ...cur(), resize: { ...cur().resize, ...patch } });
  const setCropField = (field, v) => apply(G.setCropFieldState(cur(), field, v, W, H));
  const resetCrop = () => apply({ ...cur(), crop: null, aspect: 'free' });
  const resetAll = () => apply(defaultEdits());
  const setAdjust = (key, v, commit) => {
    if (!commit) beginGesture();
    apply({ ...cur(), adjust: { ...cur().adjust, [key]: v } }, false);
    if (commit) endGesture();
  };
  const applyLook = (look) => apply({ ...cur(), adjust: { ...ADJUST_DEFAULTS, ...look.adjust } });
  /** Arrow-key crop nudge; false (key not handled) on the Details tab, in a form control or against the edge. */
  const nudge = (dx, dy, e) => {
    if (tab !== 'edit' || isFormControl(e?.target)) return false;
    const c = G.cropOf(cur(), W, H);
    return apply({ ...cur(), crop: G.moveRect(c, dx, dy, o.width, o.height) });
  };
  /** Number fields re-sync their text only when their value changes: remount one after each commit. */
  const bumpField = (f) => setFieldKeys((k) => ({ ...k, [f]: (k[f] || 0) + 1 }));

  // ---------------------------------------------------------------- crop gestures
  const toImage = (e) => {
    const r = overlayRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) / fit.scale, y: (e.clientY - r.top) / fit.scale };
  };
  const gesture = (e, onMove) => {
    if (e.button !== 0 || !fit.scale) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    // Always ends (ui/pointer.js), so the editor never stays in "dragging" after a missed release.
    trackPointer(e, {
      target: el,
      onMove: (ev) => {
        const dx = (ev.clientX - start.x) / fit.scale;
        const dy = (ev.clientY - start.y) / fit.scale;
        if (!moved) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 2) return;
          moved = true;
          beginGesture();
          setDragging(true);
        }
        apply(onMove(dx, dy, ev), false);
      },
      onEnd: () => {
        if (moved) {
          endGesture();
          setDragging(false);
        }
      },
    });
  };
  const startMove = (e) => {
    const r0 = crop;
    gesture(e, (dx, dy) => ({ ...cur(), crop: G.moveRect(r0, dx, dy, o.width, o.height) }));
  };
  const startResize = (e, handle) => {
    const r0 = crop;
    gesture(e, (dx, dy) => ({ ...cur(), crop: G.resizeRect(r0, handle, dx, dy, { W: o.width, H: o.height, ratio, min: G.MIN_CROP }) }));
  };
  const startDraw = (e) => {
    const p0 = toImage(e);
    gesture(e, (dx, dy) => ({ ...cur(), crop: G.rectFromPoints(p0, { x: p0.x + dx, y: p0.y + dy }, { W: o.width, H: o.height, ratio, min: G.MIN_CROP }) }));
  };

  // ---------------------------------------------------------------- save / export
  const render = async (e = editsRef.current) => {
    if (!src) throw new Error('The image is still loading');
    if (editsAreNeutral(e, o.width, o.height)) return { blob: src.blob, width: W, height: H, type: src.blob.type };
    return renderEdited(src.blob, e, { srcMime: ing.mime || src.blob.type });
  };
  const run = async (kind, fn) => {
    if (saving) return;
    setSaving(kind);
    try {
      await fn();
    } catch (e) {
      console.warn('[gis] image editor action failed', e);
      toast(`Could not ${kind === 'new' ? 'save the copy' : kind === 'overwrite' ? 'save' : kind}: ${e?.message || e}`, { kind: 'error' });
    } finally {
      setSaving(null);
    }
  };
  const saveAsNew = () =>
    run('new', async () => {
      const used = editsRef.current;
      const out = await render(used);
      const id = await addIngredient(out.blob, { name: editedName(ing.name), origin: 'edit', sourceUrl: ing.sourceUrl || null, tags: [...(ing.tags || [])], note: ing.note || '', prompt: ing.prompt || null });
      savedRef.current = used; // closing now loses nothing
      bump();
      revealIds([id]);
      toast(`Saved a copy (${out.width} × ${out.height})`, { kind: 'success', action: { label: 'Open copy', run: () => openEditor(id) } });
    });
  const overwrite = () =>
    run('overwrite', async () => {
      const old = src.blob;
      const out = await render();
      await replaceIngredientImage(ing.id, out.blob);
      toast(`Image updated (${out.width} × ${out.height})`, {
        kind: 'success',
        duration: 9000,
        action: {
          label: 'Undo',
          run: () => replaceIngredientImage(ing.id, old).then(() => toast('Original image restored'), (e) => toast(`Could not restore: ${e.message}`, { kind: 'error' })),
        },
      });
      setReload((x) => x + 1); // same byte size is possible: reload explicitly
    });
  const download = () =>
    run('download', async () => {
      const out = await render();
      await downloadBlob(out.blob, ingredientFilename(ing, out.type));
    });
  const copy = () =>
    run('copy', async () => {
      const out = await render();
      await copyImage(out.blob);
      toast('Image copied to the clipboard', { kind: 'success' });
    });

  /** Resolves true when the editor may be left: asks first if there are unsaved edits. */
  const confirmLeave = async () =>
    !dirtyRef.current || confirmDialog({ title: 'Discard changes?', message: 'Your edits to this image have not been saved.', confirmLabel: 'Discard', danger: true });
  const close = async () => {
    if (await confirmLeave()) onClose();
  };
  // Opening another image from elsewhere (a toast, the library) goes through the same question.
  useEffect(() => {
    const guard = () => confirmLeave();
    setEditorGuard(guard);
    return () => clearEditorGuard(guard);
  }, []);
  // Each panel tab starts at the top (the Edit tab is long at narrow widths).
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [tab]);

  // ---------------------------------------------------------------- keyboard
  const blocked = () => !active || anyModalOpen();
  const typing = (e) => isTypingTarget(e.target);
  // Single-key tools stay away from focused form controls (a slider keeps its arrows, a select its letters).
  const tool = (fn) => (e) => (blocked() || isFormControl(e.target) ? false : fn());
  useHotkeys(
    {
      escape: (e) => {
        if (blocked()) return false;
        if (typing(e)) {
          e.target.blur();
          return true;
        }
        close();
      },
      'mod+z': () => (blocked() ? false : (undo(), true)),
      'mod+shift+z': () => (blocked() ? false : (redo(), true)),
      'mod+y': () => (blocked() ? false : (redo(), true)),
      'mod+s': () => (blocked() ? false : (saveAsNew(), true)),
      r: tool(() => rotate(1)),
      'shift+r': tool(() => rotate(-1)),
      h: tool(() => flip('h')),
      v: tool(() => flip('v')),
      arrowleft: (e) => (blocked() ? false : nudge(-1, 0, e)),
      arrowright: (e) => (blocked() ? false : nudge(1, 0, e)),
      arrowup: (e) => (blocked() ? false : nudge(0, -1, e)),
      arrowdown: (e) => (blocked() ? false : nudge(0, 1, e)),
      'shift+arrowleft': (e) => (blocked() ? false : nudge(-10, 0, e)),
      'shift+arrowright': (e) => (blocked() ? false : nudge(10, 0, e)),
      'shift+arrowup': (e) => (blocked() ? false : nudge(0, -10, e)),
      'shift+arrowdown': (e) => (blocked() ? false : nudge(0, 10, e)),
    },
    { enabled: active },
  );

  const canUndo = hist.current.past.length > 0;
  const canRedo = hist.current.future.length > 0;
  const cropIsFull = crop.x === 0 && crop.y === 0 && Math.round(crop.w) === o.width && Math.round(crop.h) === o.height;
  const exactPreset = G.resizePresetOf(edits.resize?.preset);
  const coverHint = exactPreset.width && Math.abs(crop.w / crop.h - exactPreset.width / exactPreset.height) > 0.01;
  const moreMenu = (e) =>
    showMenu(e.currentTarget, [
      { label: 'Overwrite original', icon: 'save', disabled: neutral || !!saving, onClick: overwrite },
      { label: 'Copy image', icon: 'copy', onClick: copy },
      { label: 'Download', icon: 'download', onClick: download },
      '-',
      { label: 'Reset all edits', icon: 'refresh', disabled: neutral, onClick: resetAll },
    ]);

  return html`<div class="ing-ws" role="region" aria-label=${`Edit ${ing.name}`}>
    <header class="ing-ws-header">
      <${IconButton} icon="chevron-left" title="Back to the library (Esc)" onClick=${close} />
      <div class="ing-ws-title">
        <span class="ing-ws-name" title=${ing.name}>${ing.name}</span>
        <span class="ing-ws-dims mono">${W} × ${H}${!neutral ? html` <${Icon} name="arrow-right" size=${11} /> ${geo.out.width} × ${geo.out.height}` : ''}</span>
      </div>
      <div class="ing-ws-actions">
        <${IconButton} icon="undo" title="Undo image edit (Ctrl+Z)" disabled=${!canUndo} onClick=${undo} />
        <${IconButton} icon="redo" title="Redo image edit (Ctrl+Shift+Z)" disabled=${!canRedo} onClick=${redo} />
        <span class="ing-ws-sep ing-wide-only"></span>
        <${IconButton} icon="refresh" class="ing-wide-only" title="Reset all edits" disabled=${neutral} onClick=${resetAll} />
        <${IconButton} icon="copy" class="ing-wide-only" title="Copy the edited image" disabled=${!src || !!saving} onClick=${copy} />
        <${IconButton} icon="download" class="ing-wide-only" title="Download the edited image" disabled=${!src || !!saving} onClick=${download} />
        <${Button} icon="save" class="ing-wide-only" disabled=${!src || neutral || !!saving} onClick=${overwrite} title="Replace the original image (can be undone from the notification)">
          ${saving === 'overwrite' ? 'Saving…' : 'Overwrite'}
        <//>
        <${IconButton} icon="more" class="ing-narrow-only" title="More" onClick=${moreMenu} />
        <${Button} kind="primary" icon="plus" disabled=${!src || !!saving} onClick=${saveAsNew} title="Save the result as a new image (Ctrl+S)">
          ${saving === 'new' ? 'Saving…' : 'Save as new'}
        <//>
      </div>
    </header>
    <div class="ing-ws-body">
      <div class="ing-stage checker" ref=${stageRef}>
        ${error
          ? html`<${EmptyState} icon="alert" title="Could not open the image">${error}<//>`
          : !src
            ? html`<div class="ing-stage-loading"><${Spinner} size=${22} /></div>`
            : html`
                <canvas class="ing-stage-canvas" ref=${canvasRef} style=${`left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`}></canvas>
                ${tab === 'edit' &&
                html`<div
                  class=${cx('ing-crop', dragging && 'is-dragging')}
                  ref=${overlayRef}
                  style=${`left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`}
                  onPointerDown=${startDraw}
                >
                  <div class="ing-crop-dim" aria-hidden="true">
                    <span class=${cx(cropIsFull && 'is-full')} style=${`left:${crop.x * fit.scale}px;top:${crop.y * fit.scale}px;width:${crop.w * fit.scale}px;height:${crop.h * fit.scale}px`}></span>
                  </div>
                  <div
                    class=${cx('ing-crop-box', cropIsFull && 'is-full')}
                    style=${`left:${crop.x * fit.scale}px;top:${crop.y * fit.scale}px;width:${crop.w * fit.scale}px;height:${crop.h * fit.scale}px`}
                    onPointerDown=${startMove}
                    data-testid="crop-box"
                  >
                    <span class="ing-crop-grid"></span>
                    ${HANDLES.map((h) => html`<span key=${h} class=${`ing-crop-h h-${h}`} data-handle=${h} onPointerDown=${(e) => startResize(e, h)}></span>`)}
                    ${dragging && html`<span class="ing-crop-size mono">${Math.round(crop.w)} × ${Math.round(crop.h)}</span>`}
                  </div>
                </div>`}
                <div class="ing-stage-badge mono" title="Output size">${geo.out.width} × ${geo.out.height} · ${mimeLabel(type)}</div>
                <div class="ing-stage-tools">
                  <${IconButton} icon="rotate" class="ing-mirror-icon" title="Rotate left (Shift+R)" onClick=${() => rotate(-1)} />
                  <${IconButton} icon="rotate" title="Rotate right (R)" onClick=${() => rotate(1)} />
                  <${IconButton} icon="flip" title="Flip horizontal (H)" active=${edits.flipH} onClick=${() => flip('h')} />
                  <${IconButton} icon="flip" class="ing-rot90-icon" title="Flip vertical (V)" active=${edits.flipV} onClick=${() => flip('v')} />
                  <span class="ing-ws-sep"></span>
                  <button
                    type="button"
                    class=${cx('icon-btn icon-btn-md icon-btn-ghost', compare && 'is-active')}
                    title="Hold to compare with the original"
                    aria-label="Hold to compare with the original"
                    disabled=${adjustIsNeutral(edits.adjust)}
                    onPointerDown=${(e) => {
                      setCompare(true);
                      trackPointer(e, { onEnd: () => setCompare(false) });
                    }}
                    onPointerLeave=${() => setCompare(false)}
                  ><${Icon} name="eye" size=${16} /></button>
                </div>
              `}
      </div>
      <aside class="ing-ws-panel">
        <${Tabs}
          class="ing-ws-tabs"
          value=${tab}
          onChange=${onTab}
          tabs=${[
            { id: 'edit', label: 'Edit', icon: 'sliders' },
            { id: 'details', label: 'Details', icon: 'info' },
          ]}
        />
        <div class="ing-ws-panel-body" ref=${panelRef}>
          ${tab === 'details'
            ? html`<div class="ing-ws-details"><${IngredientDetails} ing=${ing} key=${ing.id} /></div>`
            : html`
                <${Section} title="Crop" actions=${!cropIsFull && html`<button type="button" class="ing-link-btn" onClick=${resetCrop}>Reset</button>`}>
                  <div class="ing-aspects" role="group" aria-label="Aspect ratio">
                    ${G.ASPECT_PRESETS.map(
                      (a) => html`<button type="button" key=${a.id} class=${cx('ing-aspect', edits.aspect === a.id && 'is-active')} aria-pressed=${edits.aspect === a.id ? 'true' : 'false'} onClick=${() => setAspect(a.id)} title=${a.ratio ? `Crop to ${a.label}` : 'Free crop'}>
                        <${AspectGlyph} ratio=${a.ratio} /><span>${a.label}</span>
                      </button>`,
                    )}
                  </div>
                  <div class="ing-crop-fields">
                    ${['x', 'y', 'w', 'h'].map(
                      (f) => html`<label class="ing-num" key=${f}>
                        <span>${f.toUpperCase()}</span>
                        <${NumberField}
                          key=${`${f}-${fieldKeys[f] || 0}`}
                          value=${Math.round(crop[f])}
                          min=${f === 'w' || f === 'h' ? G.MIN_CROP : 0}
                          max=${f === 'x' || f === 'w' ? o.width : o.height}
                          width=${70}
                          onChange=${(v) => {
                            setCropField(f, v);
                            bumpField(f); // shows the value actually used (clamped / kept inside the image)
                          }}
                          title=${{ x: 'Left', y: 'Top', w: 'Width', h: 'Height' }[f]}
                        />
                      </label>`,
                    )}
                  </div>
                  <div class="field-hint">Drag the box or its handles, or drag on the image to draw a new crop. Arrow keys nudge it.</div>
                <//>
                <${Section} title="Rotate & flip">
                  <div class="ing-transform-row">
                    <${Button} size="sm" icon="rotate" class="ing-mirror-icon" onClick=${() => rotate(-1)}>Left<//>
                    <${Button} size="sm" icon="rotate" onClick=${() => rotate(1)}>Right<//>
                    <${Button} size="sm" icon="flip" active=${edits.flipH} onClick=${() => flip('h')}>Flip H<//>
                    <${Button} size="sm" icon="flip" class="ing-rot90-icon" active=${edits.flipV} onClick=${() => flip('v')}>Flip V<//>
                  </div>
                <//>
                <${Section} title="Resize">
                  <${Select} value=${edits.resize.preset} options=${G.RESIZE_PRESETS.map((p) => ({ value: p.id, label: p.label }))} onChange=${setResize} title="Output size" />
                  ${edits.resize.preset === 'custom' &&
                  html`<div class="ing-custom-size">
                    <label class="ing-num"><span>W</span><${NumberField}
                      key=${`rw-${fieldKeys.rw || 0}`}
                      value=${geo.out.width}
                      min=${1}
                      max=${G.MAX_OUTPUT_DIM}
                      width=${82}
                      suffix="px"
                      onChange=${(v) => {
                        setResizeField(edits.resize.lock !== false ? { width: v, height: 0 } : { width: v, height: geo.out.height });
                        bumpField('rw');
                      }}
                    /></label>
                    <${IconButton} icon="link" size="sm" active=${edits.resize.lock !== false} title=${edits.resize.lock !== false ? 'Keeps the crop ratio (click to set both sides)' : 'Both sides set: the crop is trimmed to fit'} onClick=${() => setResizeField({ lock: edits.resize.lock === false, width: geo.out.width, height: edits.resize.lock === false ? 0 : geo.out.height })} />
                    <label class="ing-num"><span>H</span><${NumberField}
                      key=${`rh-${fieldKeys.rh || 0}`}
                      value=${geo.out.height}
                      min=${1}
                      max=${G.MAX_OUTPUT_DIM}
                      width=${82}
                      suffix="px"
                      onChange=${(v) => {
                        setResizeField(edits.resize.lock !== false ? { height: v, width: 0 } : { width: geo.out.width, height: v });
                        bumpField('rh');
                      }}
                    /></label>
                  </div>`}
                  <div class="ing-out-summary">
                    <span>Output</span><strong class="mono">${geo.out.width} × ${geo.out.height}</strong>
                    ${coverHint && html`<span class="muted tiny">(the crop is trimmed to ${exactPreset.width}:${exactPreset.height})</span>`}
                  </div>
                <//>
                <${Section} title="Adjust" actions=${!adjustIsNeutral(edits.adjust) && html`<button type="button" class="ing-link-btn" onClick=${() => applyLook(ADJUST_LOOKS[0])}>Reset</button>`}>
                  <div class="ing-looks">
                    ${ADJUST_LOOKS.map((l) => {
                      const on = adjustEqual(edits.adjust, l.adjust);
                      return html`<button type="button" key=${l.id} class=${cx('chip', on && 'is-active')} aria-pressed=${on ? 'true' : 'false'} onClick=${() => applyLook(l)}>${l.label}</button>`;
                    })}
                  </div>
                  ${ADJUST_FIELDS.map(
                    (f) => html`<${Slider}
                      key=${f.key}
                      label=${f.label}
                      value=${adjustValue(edits.adjust, f.key)}
                      min=${f.min}
                      max=${f.max}
                      step=${1}
                      format=${f.format}
                      resetValue=${ADJUST_DEFAULTS[f.key]}
                      onChange=${(v) => setAdjust(f.key, v, false)}
                      onCommit=${(v) => setAdjust(f.key, v, true)}
                    />`,
                  )}
                <//>
                <${Section} title="Format">
                  <${Select} value=${edits.format || 'auto'} options=${FORMAT_OPTIONS} onChange=${(v) => apply({ ...cur(), format: v })} title="File format" />
                  <div class="field-hint">
                    ${mimeLabel(type)}${type === 'image/jpeg' ? ' · transparent areas become white' : ''} · original ${formatBytes(ing.size)}
                  </div>
                <//>
              `}
        </div>
      </aside>
    </div>
  </div>`;
}
