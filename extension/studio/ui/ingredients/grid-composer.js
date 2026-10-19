// Grid composer: combines 2-9 ingredients into one "reference sheet" image (layout, gap, background, cell fit,
// labels, output size) with a live preview, saved back to the library. Handy to give Grok several references at once.
import { html, useState, useEffect, useRef, useMemo } from '../../../vendor/preact-htm.mjs';
import { addIngredient, getIngredientBlob } from '../../core/ingredients.js';
import { downloadBlob, sanitizeFilename } from '../../core/utils.js';
import { useLibrary } from '../hooks.js';
import { Icon, Button, Modal, Field, Segmented, Slider, Select, NumberField, Spinner, toast, cx } from '../kit.js';
import { GRID_LAYOUTS, SHEET_SIZES, GRID_MIN, GRID_MAX, gridDims, sheetSize, medianAspect } from './geometry.js';
import { decodeImage, drawSheet, renderSheet, defaultSheetOptions } from './render.js';
import { mergeTags, extForImageMime } from './logic.js';
import { IngredientThumb } from './thumb.js';
import { revealIds } from './state.js';

const BACKGROUNDS = ['#111114', '#000000', '#ffffff', '#f2efe9', '#2b2d42', '#1f6f5c'];
const LABEL_OPTIONS = [
  { value: 'none', label: 'No labels' },
  { value: 'numbers', label: 'Numbers (1, 2, 3…)' },
  { value: 'names', label: 'Names' },
  { value: 'both', label: 'Numbers and names' },
];
const FORMATS = [
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/png', label: 'PNG' },
  { value: 'image/webp', label: 'WebP' },
];
const PREVIEW_MAX = 1100;

function sheetName(items) {
  const names = items.map((i) => i.name || 'Image');
  const head = names.slice(0, 3).join(' + ');
  return `Sheet: ${head}${names.length > 3 ? ` +${names.length - 3}` : ''}`.slice(0, 80);
}

export function GridComposer({ ids, onClose }) {
  const library = useLibrary((l) => l.ingredients);
  const byId = useMemo(() => new Map(library.map((i) => [i.id, i])), [library]);
  const [order, setOrder] = useState(() => ids.slice(0, GRID_MAX));
  const [opts, setOpts] = useState(defaultSheetOptions);
  const [bitmaps, setBitmaps] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [dragIndex, setDragIndex] = useState(-1);
  const canvasRef = useRef(null);

  const items = order.map((id) => byId.get(id)).filter(Boolean);
  const dims = gridDims(items.length, opts.layout);
  const shown = items.slice(0, dims.count);
  const size = sheetSize(opts.size, { n: shown.length, layout: opts.layout, cellAspect: medianAspect(shown), gap: opts.gap, custom: opts.custom });
  const ready = shown.length >= GRID_MIN && shown.every((i) => bitmaps[i.id]);
  const set = (patch) => setOpts((o) => ({ ...o, ...patch }));

  // Decode the images once (capped at 2048 px: plenty for a cell of a sheet), freed on close.
  useEffect(() => {
    let alive = true;
    const made = [];
    (async () => {
      for (const id of ids.slice(0, GRID_MAX)) {
        const blob = await getIngredientBlob(id);
        if (!blob) continue;
        const bmp = await decodeImage(blob, { maxSide: 2048 });
        if (!alive) {
          bmp.close();
          break;
        }
        made.push(bmp);
        setBitmaps((b) => ({ ...b, [id]: bmp }));
      }
    })().catch((e) => alive && setLoadError(String(e?.message || e)));
    return () => {
      alive = false;
      for (const b of made) b.close();
    };
  }, []);

  // Live preview, drawn at a reduced scale.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shown.length) return undefined;
    const raf = requestAnimationFrame(() => {
      const k = Math.min(1, PREVIEW_MAX / Math.max(size.width, size.height));
      canvas.width = Math.max(1, Math.round(size.width * k));
      canvas.height = Math.max(1, Math.round(size.height * k));
      const ctx = canvas.getContext('2d');
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawSheet(ctx, shown.map((i) => ({ bitmap: bitmaps[i.id] || null, name: i.name })), opts, size.width, size.height);
    });
    return () => cancelAnimationFrame(raf);
  });

  const move = (from, to) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = order.slice();
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    setOrder(next);
  };
  const remove = (id) => setOrder((o) => o.filter((x) => x !== id));

  const render = () => renderSheet(shown.map((i) => ({ bitmap: bitmaps[i.id], name: i.name })), opts, size.width, size.height);

  const save = async () => {
    if (!ready || busy) return;
    setBusy('save');
    try {
      const out = await render();
      const legend = shown.map((i, n) => `${n + 1} = ${i.name}`).join('; ');
      const id = await addIngredient(out.blob, {
        name: sheetName(shown),
        origin: 'grid',
        tags: mergeTags(...shown.map((i) => i.tags || [])),
        note: `Reference sheet of ${shown.length} images`,
        prompt: `Reference sheet (${dims.cols}×${dims.rows}). ${legend}`,
      });
      revealIds([id]);
      toast(`Saved the reference sheet (${out.width} × ${out.height})`, { kind: 'success' });
      onClose();
    } catch (e) {
      toast(`Could not create the sheet: ${e?.message || e}`, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!ready || busy) return;
    setBusy('download');
    try {
      const out = await render();
      await downloadBlob(out.blob, sanitizeFilename(`reference-sheet-${shown.length}.${extForImageMime(out.type)}`));
    } catch (e) {
      toast(`Could not export the sheet: ${e?.message || e}`, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const hidden = items.length - shown.length;
  const footer = html`
    <span class="spacer"></span>
    <${Button} kind="ghost" onClick=${onClose}>Cancel<//>
    <${Button} icon="download" disabled=${!ready || !!busy} onClick=${download}>${busy === 'download' ? 'Exporting…' : 'Download'}<//>
    <${Button} kind="primary" icon="save" disabled=${!ready || !!busy} onClick=${save} data-testid="sheet-save">${busy === 'save' ? 'Saving…' : 'Save to library'}<//>
  `;

  return html`<${Modal} title="Reference sheet" width=${980} class="ing-composer-modal" onClose=${onClose} footer=${footer}>
    <div class="ing-composer">
      <div class="ing-composer-preview checker">
        ${loadError
          ? html`<div class="ing-composer-msg"><${Icon} name="alert" size=${18} />${loadError}</div>`
          : shown.length < GRID_MIN
            ? html`<div class="ing-composer-msg">Add at least ${GRID_MIN} images to the sheet.</div>`
            : html`<canvas ref=${canvasRef} class="ing-composer-canvas" aria-label="Reference sheet preview"></canvas>`}
        ${shown.length >= GRID_MIN && !loadError && html`<span class="ing-composer-size mono" title="Output size">${size.width} × ${size.height}px</span>`}
        ${!ready && shown.length >= GRID_MIN && !loadError && html`<div class="ing-composer-loading"><${Spinner} size=${18} /></div>`}
      </div>
      <div class="ing-composer-controls">
        <${Field} label="Layout">
          <${Segmented} value=${opts.layout} options=${GRID_LAYOUTS.map((l) => ({ value: l.id, label: l.label }))} onChange=${(layout) => set({ layout })} />
        <//>
        ${hidden > 0 && html`<div class="field-hint ing-warn"><${Icon} name="info" size=${12} />${GRID_LAYOUTS.find((l) => l.id === opts.layout)?.label} shows the first ${dims.count}: ${hidden} not included.</div>`}
        <${Field} label=${`Images (${items.length}) · drag to reorder`}>
          <div class="ing-composer-order">
            ${items.map(
              (ing, i) => html`<div
                key=${ing.id}
                class=${cx('ing-order-item', i >= dims.count && 'is-out', dragIndex === i && 'is-dragging')}
                draggable="true"
                onDragStart=${(e) => {
                  setDragIndex(i);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/x-gis-order', String(i));
                }}
                onDragEnd=${() => setDragIndex(-1)}
                onDragOver=${(e) => e.dataTransfer.types.includes('text/x-gis-order') && e.preventDefault()}
                onDrop=${(e) => {
                  const from = Number(e.dataTransfer.getData('text/x-gis-order'));
                  if (Number.isFinite(from)) {
                    e.preventDefault();
                    e.stopPropagation();
                    move(from, i);
                  }
                  setDragIndex(-1);
                }}
                title=${ing.name}
              >
                <${IngredientThumb} ing=${ing} />
                <span class="ing-order-num">${i + 1}</span>
                <div class="ing-order-tools">
                  <button type="button" title="Move earlier" aria-label="Move earlier" disabled=${i === 0} onClick=${() => move(i, i - 1)}><${Icon} name="chevron-left" size=${12} /></button>
                  <button type="button" title="Remove from the sheet" aria-label="Remove from the sheet" onClick=${() => remove(ing.id)}><${Icon} name="x" size=${12} /></button>
                  <button type="button" title="Move later" aria-label="Move later" disabled=${i === items.length - 1} onClick=${() => move(i, i + 1)}><${Icon} name="chevron-right" size=${12} /></button>
                </div>
              </div>`,
            )}
          </div>
        <//>
        <div class="ing-composer-row">
          <${Field} label="Cells">
            <${Segmented} value=${opts.fit} options=${[{ value: 'cover', label: 'Fill', title: 'Fill each cell (crops the edges)' }, { value: 'contain', label: 'Fit', title: 'Show whole images' }]} onChange=${(fit) => set({ fit })} />
          <//>
          <${Field} label="Format">
            <${Segmented} value=${opts.format} options=${FORMATS} onChange=${(format) => set({ format })} />
          <//>
        </div>
        <${Slider} label="Gap" value=${opts.gap} min=${0} max=${64} step=${1} format=${(v) => `${v}px`} resetValue=${16} onChange=${(gap) => set({ gap })} />
        <${Field} label="Background">
          <div class="ing-swatches">
            ${BACKGROUNDS.map((c) => html`<button type="button" key=${c} class=${cx('ing-swatch', opts.background.toLowerCase() === c && 'is-active')} style=${`background:${c}`} title=${c} aria-label=${`Background ${c}`} onClick=${() => set({ background: c })}></button>`)}
            <label class="ing-swatch ing-swatch-custom" title="Custom colour">
              <input type="color" value=${opts.background} onInput=${(e) => set({ background: e.currentTarget.value })} aria-label="Custom background colour" />
              <${Icon} name="palette" size=${13} />
            </label>
          </div>
        <//>
        <${Field} label="Labels">
          <${Select} value=${opts.labels} options=${LABEL_OPTIONS} onChange=${(labels) => set({ labels })} />
        <//>
        <${Field} label="Output size">
          <${Select} value=${opts.size} options=${SHEET_SIZES.map((s) => ({ value: s.id, label: s.label }))} onChange=${(sz) => set({ size: sz })} />
        <//>
        ${opts.size === 'custom' &&
        html`<div class="ing-custom-size">
          <label class="ing-num"><span>W</span><${NumberField} value=${opts.custom.width} min=${64} max=${8192} width=${84} suffix="px" onChange=${(w) => set({ custom: { ...opts.custom, width: w } })} /></label>
          <span class="muted">×</span>
          <label class="ing-num"><span>H</span><${NumberField} value=${opts.custom.height} min=${64} max=${8192} width=${84} suffix="px" onChange=${(h) => set({ custom: { ...opts.custom, height: h } })} /></label>
        </div>`}
        <div class="field-hint">Numbered sheets make prompts like “the character from image 1 in the setting of image 2” easy.</div>
      </div>
    </div>
  <//>`;
}

