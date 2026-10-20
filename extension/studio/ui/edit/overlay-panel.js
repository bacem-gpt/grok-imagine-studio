// Inspector panel for overlay-track clips (iMovie's video overlay settings): overlay mode (picture in picture,
// cutaway, side by side, green/blue screen), PiP position presets + draggable position pad + size, border, rounded
// corners and shadow, split side and size, chroma key colour (presets, picker, eyedropper on the program monitor) with
// tolerance / softness / spill, entrance and exit animations, timing, sound, fades, look and clip actions.
// Sliders update live with one merge key per drag (one undo step per gesture), like the other inspector panels.

import { html, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { projectStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { buildFilter } from '../../engine/effects.js';
import { formatTime, formatDuration, clamp } from '../../core/utils.js';
import { useMediaPreview, useElementSize } from '../hooks.js';
import { Icon, IconButton, Button, Slider, TimeField, Select, Toggle, TextField, Field, Segmented, Section, cx } from '../kit.js';
import * as Ops from './edit-ops.js';
import * as A from './actions.js';
import { FILTER_SPECS } from './inspector.js';
import { PipBoxEditor, overlaySourceSize } from './overlay-handles.js';
import { pipRect } from '../../engine/overlays.js';

const MODE_INFO = {
  pip: { icon: 'pip', label: 'Picture in picture', short: 'PiP', hint: 'A smaller picture over the main track.' },
  cutaway: { icon: 'film', label: 'Cutaway', short: 'Cutaway', hint: 'Covers the main picture; the main track keeps running (and keeps its sound) underneath.' },
  split: { icon: 'split-v', label: 'Side by side', short: 'Split', hint: 'Splits the frame: the overlay on one side, the main track on the other.' },
  greenscreen: { icon: 'layers', label: 'Green/blue screen', short: 'Key', hint: 'Removes the screen colour so the main track shows through.' },
};
const PIP_POSITIONS = [
  { id: 'tl', label: 'Top left', x: 0, y: 0 },
  { id: 'tr', label: 'Top right', x: 1, y: 0 },
  { id: 'c', label: 'Centre', x: 0.5, y: 0.5 },
  { id: 'bl', label: 'Bottom left', x: 0, y: 1 },
  { id: 'br', label: 'Bottom right', x: 1, y: 1 },
];
const KEY_PRESETS = [
  { id: 'green', label: 'Green', color: '#00ff00' },
  { id: 'blue', label: 'Blue', color: '#0047ff' },
];
const pct = (v) => `${Math.round(v * 100)}%`;
const secs = (v) => `${v.toFixed(2)}s`;
const px = (v) => `${Math.round(v)}px`;

/** Per-field live editing with one merge key per gesture (same contract as the inspector's useClipEditor). */
function useOverlayEditor(clipId) {
  const gen = useRef({});
  const current = () => M.findClip(projectStore.get(), clipId)?.clip;
  return {
    current,
    set(patch, label) {
      projectStore.update((p) => Ops.updateClipIfChanged(p, clipId, patch), { label });
    },
    live(field, patch, label) {
      projectStore.update((p) => Ops.updateClipIfChanged(p, clipId, patch), { label, merge: `insp-ov:${clipId}:${field}:${gen.current[field] || 0}` });
    },
    end(field) {
      gen.current[field] = (gen.current[field] || 0) + 1;
    },
    /** Patch for a nested settings object (pip / split / key / transitionIn / transitionOut), from the latest clip. */
    sub(group, patch) {
      const c = current();
      return { [group]: { ...(c?.[group] || {}), ...patch } };
    },
  };
}

function LiveSlider({ ed, field, label, value, min, max, step, format, resetValue, patch, undoLabel, disabled }) {
  return html`<${Slider}
    label=${label}
    value=${clamp(value, min, max)}
    min=${min}
    max=${max}
    step=${step}
    format=${format}
    resetValue=${resetValue}
    disabled=${disabled}
    onChange=${(v) => ed.live(field, patch(v), undoLabel || `Change ${label.toLowerCase()}`)}
    onCommit=${() => ed.end(field)}
  />`;
}

/** Frame-shaped pad with the PiP box (drag / resize), over the clip's thumbnail. */
function PipPad({ clip, media, settings }) {
  const previews = useMediaPreview(clip.mediaId);
  const [ref, size] = useElementSize();
  const aspect = (settings.width || 16) / (settings.height || 9);
  return html`<div class="ovp-pad" ref=${ref} style=${`aspect-ratio:${aspect}`} title="Drag the box to place the picture in picture; drag its corner to resize">
    <div class="ovp-pad-main"><span>Main track</span></div>
    ${previews?.thumb && size.width > 0 && html`<${PadThumb} clip=${clip} media=${media} thumb=${previews.thumb} W=${size.width} H=${size.width / aspect} />`}
    ${size.width > 0 &&
    html`<div class="ovp-pad-layer">
      <${PipBoxEditor} clip=${clip} media=${media} W=${size.width} H=${size.width / aspect} label=${false} />
    </div>`}
  </div>`;
}

/** The overlay's thumbnail drawn inside the pad's PiP box (under the box editor, which is transparent). */
function PadThumb({ clip, media, thumb, W, H }) {
  const src = overlaySourceSize(media);
  const r = pipRect({ ...M.PIP_DEFAULTS, ...(clip.pip || {}) }, src.w, src.h, W, H);
  return html`<div class="ovp-pad-thumb" style=${`left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background-image:url("${thumb}")`}></div>`;
}

function TransitionRow({ ed, which, clip, maxDur }) {
  const tr = clip[which] || M.OVERLAY_TRANSITION_DEFAULT;
  const label = which === 'transitionIn' ? 'In' : 'Out';
  return html`<div class="ovp-tr">
    <${Field} label=${which === 'transitionIn' ? 'Entrance' : 'Exit'}>
      <${Segmented}
        size="sm"
        value=${tr.type}
        options=${M.OVERLAY_TRANSITIONS.map((t) => ({ value: t.id, label: t.name }))}
        onChange=${(v) => ed.set(ed.sub(which, { type: v }), `Overlay ${label.toLowerCase()}: ${M.OVERLAY_TRANSITIONS.find((t) => t.id === v)?.name}`)}
      />
    <//>
    ${tr.type !== 'none' &&
    html`<${LiveSlider}
      ed=${ed}
      field=${`${which}-dur`}
      label=${`${label} duration`}
      value=${tr.duration}
      min=${0.1}
      max=${Math.max(0.2, Math.min(3, maxDur))}
      step=${0.05}
      format=${secs}
      resetValue=${M.OVERLAY_TRANSITION_DEFAULT.duration}
      patch=${(v) => ed.sub(which, { duration: v })}
    />`}
  </div>`;
}

/**
 * Inspector body for one overlay-track clip.
 * @param {{clip:Object, item:Object, media:Object, project:Object, session:Object}} props
 */
export function OverlayPanel({ clip, item, media, project, session }) {
  const ed = useOverlayEditor(clip.id);
  const previews = useMediaPreview(clip.mediaId);
  const [showFilters, setShowFilters] = useState(false);
  const isImage = media?.kind === 'image';
  const hasSound = media?.kind === 'video' && media.hasAudio !== false;
  const maxSrc = isImage ? Infinity : media?.duration || clip.out;
  const mode = clip.mode || 'pip';
  const info = MODE_INFO[mode] || MODE_INFO.pip;
  const pip = { ...M.PIP_DEFAULTS, ...(clip.pip || {}) };
  const split = { ...M.SPLIT_DEFAULTS, ...(clip.split || {}) };
  const key = { ...M.KEY_DEFAULTS, ...(clip.key || {}) };
  const filters = M.clipFilters(clip);
  const presetId = Ops.matchFilterPreset(clip.filters);
  const speed = clip.speed || 1;
  const maxFade = Math.max(0.1, Math.min(5, item.duration));
  const lanes = Math.max(1, ...(project.tracks.overlay || []).map((c) => (c.lane || 0) + 1)) + 1;
  const posId = PIP_POSITIONS.find((p) => Math.abs(p.x - pip.x) < 1e-3 && Math.abs(p.y - pip.y) < 1e-3)?.id;
  const sub = `${isImage ? 'Still' : 'Video'} overlay · ${formatDuration(item.duration)} · V${(clip.lane || 0) + 2}`;
  return html`
    <div class="insp-clip-head">
      <div class="insp-clip-thumb is-overlay" style=${previews?.thumb ? `background-image:url("${previews.thumb}")` : ''}>${!previews?.thumb && html`<${Icon} name="pip" size=${16} />`}</div>
      <div class="insp-clip-meta">
        <div class="insp-clip-title" title=${clip.label || media?.name || 'Overlay'}>${clip.label || media?.name || 'Overlay'}</div>
        <div class="insp-clip-sub">${sub}</div>
      </div>
    </div>
    <${Section} title="Overlay">
      <div class="ovp-modes" role="radiogroup" aria-label="Overlay mode">
        ${M.OVERLAY_MODES.map((mo) => {
          const mi = MODE_INFO[mo.id];
          return html`<button
            type="button"
            key=${mo.id}
            role="radio"
            aria-checked=${mode === mo.id ? 'true' : 'false'}
            class=${cx('ovp-mode', mode === mo.id && 'is-active')}
            data-mode=${mo.id}
            title=${mi.hint}
            onClick=${() => ed.set({ mode: mo.id }, `Overlay: ${mo.name}`)}
          >
            <span class=${cx('ovp-mode-art', `is-${mo.id}`)} aria-hidden="true"><span></span></span>
            <span class="ovp-mode-name">${mi.label}</span>
          </button>`;
        })}
      </div>
      <div class="insp-note">${info.hint}</div>
    <//>
    ${mode === 'pip' &&
    html`<${Section} title="Position & size">
      <${PipPad} clip=${clip} media=${media} settings=${project.settings} />
      <div class="insp-chips">
        ${PIP_POSITIONS.map((p) => html`<button type="button" key=${p.id} class=${cx('chip', posId === p.id && 'is-active')} data-pos=${p.id} onClick=${() => ed.set(ed.sub('pip', { x: p.x, y: p.y }), `PiP: ${p.label}`)}>${p.label}</button>`)}
      </div>
      <${LiveSlider} ed=${ed} field="pip-scale" label="Size" value=${pip.scale} min=${0.1} max=${1} step=${0.01} format=${pct} resetValue=${M.PIP_DEFAULTS.scale} patch=${(v) => ed.sub('pip', { scale: v })} undoLabel="Resize picture in picture" />
      <div class="insp-grid2">
        <${LiveSlider} ed=${ed} field="pip-border" label="Border" value=${pip.border} min=${0} max=${24} step=${1} format=${px} resetValue=${0} patch=${(v) => ed.sub('pip', { border: v })} undoLabel="PiP border" />
        <${LiveSlider} ed=${ed} field="pip-radius" label="Corners" value=${pip.radius} min=${0} max=${80} step=${1} format=${px} resetValue=${0} patch=${(v) => ed.sub('pip', { radius: v })} undoLabel="PiP corners" />
      </div>
      <div class="ovp-row">
        <label class="ovp-color" title="Border colour">
          <input type="color" value=${pip.borderColor} onChange=${(e) => ed.set(ed.sub('pip', { borderColor: e.currentTarget.value.toLowerCase(), border: pip.border || 4 }), 'PiP border colour')} />
          <span class="ovp-swatch" style=${`--sw:${pip.borderColor}`}></span>
          <span>Border colour</span>
        </label>
        <${Toggle} checked=${pip.shadow} label="Shadow" onChange=${(v) => ed.set(ed.sub('pip', { shadow: v }), v ? 'PiP shadow' : 'No PiP shadow')} />
      </div>
      <div class="insp-note">Tip: with the playhead over this overlay, drag the box on the monitor too.</div>
    <//>`}
    ${mode === 'split' &&
    html`<${Section} title="Side by side">
      <${Field} label="Overlay side">
        <${Segmented}
          size="sm"
          value=${split.side}
          options=${[
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
            { value: 'top', label: 'Top' },
            { value: 'bottom', label: 'Bottom' },
          ]}
          onChange=${(v) => ed.set(ed.sub('split', { side: v }), `Split: ${v}`)}
        />
      <//>
      <${LiveSlider} ed=${ed} field="split-size" label="Overlay share" value=${split.size} min=${0.2} max=${0.8} step=${0.01} format=${pct} resetValue=${0.5} patch=${(v) => ed.sub('split', { size: v })} undoLabel="Split size" />
      <div class="insp-note">The main track moves to the other side, centre-cropped (nothing is squeezed).</div>
    <//>`}
    ${mode === 'greenscreen' &&
    html`<${Section} title="Key colour">
      <div class="ovp-row">
        ${KEY_PRESETS.map(
          (k) => html`<button type="button" key=${k.id} class=${cx('chip', 'ovp-keychip', key.color === k.color && 'is-active')} data-key=${k.id} onClick=${() => ed.set(ed.sub('key', { color: k.color }), `Key: ${k.label.toLowerCase()} screen`)}>
            <span class="ovp-swatch" style=${`--sw:${k.color}`}></span>${k.label}
          </button>`,
        )}
        <label class="ovp-color" title="Custom key colour">
          <input type="color" value=${key.color} onChange=${(e) => ed.set(ed.sub('key', { color: e.currentTarget.value.toLowerCase() }), 'Key colour')} />
          <span class="ovp-swatch" style=${`--sw:${key.color}`}></span>
          <span class="mono">${key.color}</span>
        </label>
        <${IconButton} icon="pipette" size="sm" title="Pick the colour from the frame on the monitor" onClick=${() => session.emit('overlayPick', { clipId: clip.id })} />
      </div>
      <${LiveSlider} ed=${ed} field="key-tol" label="Tolerance" value=${key.tolerance} min=${0} max=${1} step=${0.01} format=${pct} resetValue=${M.KEY_DEFAULTS.tolerance} patch=${(v) => ed.sub('key', { tolerance: v })} undoLabel="Key tolerance" />
      <${LiveSlider} ed=${ed} field="key-soft" label="Edge softness" value=${key.softness} min=${0} max=${0.5} step=${0.005} format=${pct} resetValue=${M.KEY_DEFAULTS.softness} patch=${(v) => ed.sub('key', { softness: v })} undoLabel="Key softness" />
      <${LiveSlider} ed=${ed} field="key-spill" label="Spill suppression" value=${key.spill} min=${0} max=${1} step=${0.01} format=${pct} resetValue=${M.KEY_DEFAULTS.spill} patch=${(v) => ed.sub('key', { spill: v })} undoLabel="Spill suppression" />
    <//>`}
    ${mode !== 'pip' &&
    html`<${Section} title="Framing">
      <${Segmented}
        value=${clip.fit || 'cover'}
        options=${[
          { value: 'cover', label: 'Fill', title: 'Fill the area (crop edges)' },
          { value: 'contain', label: 'Fit', title: 'Fit inside the area (letterbox)' },
          { value: 'fill', label: 'Stretch', title: 'Stretch to the area' },
        ]}
        onChange=${(v) => ed.set({ fit: v }, 'Overlay framing')}
      />
    <//>`}
    <${Section} title="Animation">
      <${TransitionRow} ed=${ed} which="transitionIn" clip=${clip} maxDur=${item.duration / 2} />
      <${TransitionRow} ed=${ed} which="transitionOut" clip=${clip} maxDur=${item.duration / 2} />
    <//>
    <${Section} title="Timing">
      <div class="insp-grid2">
        <${Field} label="Starts at">
          <${TimeField} value=${clip.start} min=${0} max=${36000} fps=${project.settings.fps} onChange=${(v) => ed.set({ start: v }, 'Move overlay')} />
        <//>
        <${Field} label="Lane">
          <${Select}
            value=${String(clip.lane || 0)}
            options=${Array.from({ length: lanes }, (_, i) => ({ value: String(i), label: `V${i + 2}${i === lanes - 1 ? ' (new)' : ''}` }))}
            onChange=${(v) => projectStore.update((p) => M.moveOverlayClip(p, clip.id, clip.start, Number(v)), { label: 'Change overlay lane' })}
          />
        <//>
        ${isImage
          ? html`<${Field} label="Duration">
              <${TimeField} value=${clip.out - clip.in} min=${M.MIN_CLIP_DURATION} max=${3600} fps=${project.settings.fps} onChange=${(v) => ed.set({ out: clip.in + v * speed }, 'Overlay duration')} />
            <//>`
          : html`<${Field} label="Source in">
                <${TimeField} value=${clip.in} min=${0} max=${Math.max(0, clip.out - M.MIN_CLIP_DURATION)} fps=${project.settings.fps} onChange=${(v) => ed.set({ in: v }, 'Set overlay in point')} />
              <//>
              <${Field} label="Source out">
                <${TimeField} value=${clip.out} min=${clip.in + M.MIN_CLIP_DURATION} max=${maxSrc} fps=${project.settings.fps} onChange=${(v) => ed.set({ out: v }, 'Set overlay out point')} />
              <//>`}
      </div>
      <div class="insp-note">Shows <b class="mono">${formatTime(item.start)}</b> → <b class="mono">${formatTime(item.end)}</b></div>
      ${!isImage &&
      html`<${LiveSlider} ed=${ed} field="speed" label="Speed" value=${speed} min=${M.MIN_SPEED} max=${M.MAX_SPEED} step=${0.05} format=${(v) => `${v.toFixed(2)}×`} resetValue=${1} patch=${(v) => ({ speed: v })} undoLabel="Overlay speed" />`}
    <//>
    ${hasSound &&
    html`<${Section} title="Sound">
      <div class="insp-inline">
        <div class="grow">
          <${LiveSlider} ed=${ed} field="volume" label="Overlay volume" value=${clip.volume ?? 1} min=${0} max=${2} step=${0.01} format=${pct} resetValue=${1} patch=${(v) => ({ volume: v })} disabled=${clip.muted} />
        </div>
        <${IconButton} icon=${clip.muted ? 'volume-x' : 'volume'} title=${clip.muted ? 'Unmute' : 'Mute'} active=${clip.muted} onClick=${() => ed.set({ muted: !clip.muted }, clip.muted ? 'Unmute overlay' : 'Mute overlay')} />
      </div>
    <//>`}
    <${Section} title="Fades">
      <${LiveSlider} ed=${ed} field="fadeIn" label="Fade in" value=${clip.fadeIn || 0} min=${0} max=${maxFade} step=${0.05} format=${secs} resetValue=${0} patch=${(v) => ({ fadeIn: v })} />
      <${LiveSlider} ed=${ed} field="fadeOut" label="Fade out" value=${clip.fadeOut || 0} min=${0} max=${maxFade} step=${0.05} format=${secs} resetValue=${0} patch=${(v) => ({ fadeOut: v })} />
    <//>
    <${Section} title="Color & look" defaultOpen=${false}>
      <div class="insp-looks">
        ${M.FILTER_PRESETS.map(
          (p) => html`<button type="button" key=${p.id} class=${cx('insp-look', presetId === p.id && 'is-active')} title=${p.name} onClick=${() => ed.set({ filters: Ops.filterPresetValues(p.id) }, `Look: ${p.name}`)}>
            <span class="insp-look-img" style=${`${previews?.thumb ? `background-image:url("${previews.thumb}");` : ''}filter:${buildFilter(p.filters, 72)}`}></span>
            <span class="insp-look-name">${p.name}</span>
          </button>`,
        )}
      </div>
      <${Toggle} checked=${showFilters} label="Fine-tune" onChange=${setShowFilters} />
      ${showFilters &&
      html`<div class="insp-sliders">
        ${FILTER_SPECS.map(
          (f) => html`<${LiveSlider}
            key=${f.key}
            ed=${ed}
            field=${`f-${f.key}`}
            label=${f.label}
            value=${filters[f.key]}
            min=${f.min}
            max=${f.max}
            step=${f.step}
            format=${f.fmt}
            resetValue=${M.FILTER_DEFAULTS[f.key]}
            patch=${(v) => ({ filters: { ...M.clipFilters(ed.current() || clip), [f.key]: v } })}
            undoLabel=${`Adjust ${f.label.toLowerCase()}`}
          />`,
        )}
      </div>`}
    <//>
    <${Section} title="Clip">
      <${Field} label="Label">
        <${TextField} value=${clip.label || ''} placeholder=${media?.name || 'Overlay label'} onCommit=${(v) => v !== (clip.label || '') && ed.set({ label: v.trim() }, 'Rename overlay')} />
      <//>
      <div class="insp-actions">
        <${Button} size="sm" icon="scissors" onClick=${() => A.splitAtPlayhead(session)}>Split<//>
        <${Button} size="sm" icon="copy" onClick=${() => A.duplicateSelection()}>Duplicate<//>
        <${Button} size="sm" icon="film" kind="ghost" title="Put this clip back on the main track" onClick=${() => A.moveToMain(clip.id)}>To main track<//>
        <${Button} size="sm" icon="trash" kind="danger" onClick=${() => A.deleteSelection()}>Delete<//>
      </div>
    <//>
  `;
}
