// Inspector (right panel; a column or a sheet in the narrow / short layouts). Nothing selected -> sequence settings +
// stats + shortcuts; a main-track clip -> timing, speed, sound, framing, color look (presets + every filter), fades,
// Ken Burns motion and the transition into it; an audio clip -> timing, volume, fades, lane, fit to video; a text
// clip -> text, font, style, position, animation, timing. Sliders update live with one merge key per drag (one undo
// step per gesture).

import { html, useEffect, useLayoutEffect, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { projectStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { renameCurrentProject } from '../../core/app-state.js';
import { FONT_CHOICES, buildFilter } from '../../engine/effects.js';
import { formatTime, formatDuration, clamp } from '../../core/utils.js';
import { useProject, useUI, useMediaPreview } from '../hooks.js';
import { comboLabel } from '../hotkeys.js';
import { Icon, IconButton, Button, Slider, NumberField, TimeField, Select, Toggle, TextField, Field, Segmented, Section, Kbd, cx } from '../kit.js';
import * as Ops from './edit-ops.js';
import * as A from './actions.js';
import { TransitionSwatch, transitionName, maxTransitionAt, TRANSITION_KINDS } from './transition-popover.js';
import { SpeedTools, FreezeTiming, CropRotateSection, EqField, DuckSection, TitleStyles } from './inspector-tools.js';
import { OverlayPanel } from './overlay-panel.js';

export const FILTER_SPECS = [
  { key: 'brightness', label: 'Brightness', min: 0, max: 2, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'saturate', label: 'Saturation', min: 0, max: 3, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` },
  { key: 'grayscale', label: 'Black & white', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'sepia', label: 'Sepia', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'invert', label: 'Invert', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'blur', label: 'Blur', min: 0, max: 20, step: 0.1, fmt: (v) => `${v.toFixed(1)}px` },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.05, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV` },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, fmt: (v) => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? 'Warm' : 'Cool'} ${Math.round(Math.abs(v) * 100)}`) },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, fmt: (v) => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? 'Magenta' : 'Green'} ${Math.round(Math.abs(v) * 100)}`) },
];

const ANIMATION_LABELS = { none: 'None', fade: 'Fade', 'slide-up': 'Slide up', pop: 'Pop', typewriter: 'Typewriter', 'scroll-up': 'Credits roll' };
const TEXT_POSITIONS = [
  { id: 'top', label: 'Top', x: 0.5, y: 0.14 },
  { id: 'center', label: 'Center', x: 0.5, y: 0.5 },
  { id: 'lower', label: 'Lower third', x: 0.5, y: 0.74 },
  { id: 'bottom', label: 'Bottom', x: 0.5, y: 0.86 },
];
const SHORTCUTS = [
  ['space', 'Play / pause'],
  ['j', 'Shuttle back · K stop · L forward'],
  ['arrowleft', 'Frame back (Shift = 1 s)'],
  ['arrowup', 'Previous / next cut (↓)'],
  ['s', 'Split at playhead'],
  ['q', 'Trim start to playhead (W = end)'],
  ['delete', 'Delete selected'],
  ['mod+d', 'Duplicate'],
  ['mod+c', 'Copy (Ctrl+V paste at playhead)'],
  ['t', 'Add a title'],
  ['m', 'Add a marker'],
  ['shift+f', 'Freeze frame at the playhead'],
  ['plus', 'Zoom in (− out, \\ fit)'],
  ['f', 'Full-screen preview'],
];

const pct = (v) => `${Math.round(v * 100)}%`;
const secs = (v) => `${v.toFixed(2)}s`;
const isHex = (v) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v || '');
const expandHex = (v) => (/^#[0-9a-f]{3}$/i.test(v) ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v);

/**
 * Live clip editing: each field gets its own merge key, renewed when a gesture ends (onCommit / blur). Edits that
 * change nothing (the active option clicked again, a slider pushed past its limit) record no undo step.
 */
function useClipEditor(clipId) {
  const gen = useRef({});
  return {
    set(patch, label) {
      projectStore.update((p) => Ops.updateClipIfChanged(p, clipId, patch), { label });
    },
    live(field, patch, label) {
      projectStore.update((p) => Ops.updateClipIfChanged(p, clipId, patch), { label, merge: `insp:${clipId}:${field}:${gen.current[field] || 0}` });
    },
    end(field) {
      gen.current[field] = (gen.current[field] || 0) + 1;
    },
  };
}

let colorGesture = 0;
/** Applies a color edit as part of one undo step per picker gesture. */
function colorUpdate(update, label) {
  return (v, { live = false } = {}) => {
    projectStore.update(update(v), { label, merge: `color:${colorGesture}` });
    if (!live) colorGesture += 1;
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

/**
 * Color swatch + hex field. `onChange(value, {live})`: live = true while the native picker is being dragged (the
 * caller merges those into one undo step); the final value arrives with live = false.
 */
function ColorField({ value, onChange, allowNone = false, title }) {
  const [text, setText] = useState(value || '');
  useEffect(() => setText(value || ''), [value]);
  const v = value || '';
  return html`<div class="insp-color" title=${title}>
    <label class=${cx('insp-swatch', !v && 'is-none')} style=${v ? `--sw:${v}` : ''}>
      <input
        type="color"
        value=${isHex(v) ? expandHex(v) : '#000000'}
        onInput=${(e) => onChange(e.currentTarget.value, { live: true })}
        onChange=${(e) => onChange(e.currentTarget.value, { live: false })}
      />
    </label>
    <input
      class="text-field insp-hex mono"
      value=${text || ''}
      placeholder=${allowNone ? 'none' : '#000000'}
      spellcheck="false"
      onInput=${(e) => setText(e.currentTarget.value)}
      onBlur=${() => {
        const t = text.trim();
        if (isHex(t)) onChange(expandHex(t).toLowerCase());
        else if (!t && allowNone) onChange('');
        else setText(v);
      }}
      onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
    ${allowNone && v && html`<${IconButton} icon="x" size="sm" title="No color" onClick=${() => onChange('')} />`}
  </div>`;
}

function ClipHeader({ icon, kind, title, sub, thumb }) {
  return html`<div class="insp-clip-head">
    <div class=${cx('insp-clip-thumb', `is-${kind}`)} style=${thumb ? `background-image:url("${thumb}")` : ''}>${!thumb && html`<${Icon} name=${icon} size=${16} />`}</div>
    <div class="insp-clip-meta">
      <div class="insp-clip-title" title=${title}>${title}</div>
      <div class="insp-clip-sub">${sub}</div>
    </div>
  </div>`;
}

function ActionRow({ children }) {
  return html`<div class="insp-actions">${children}</div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Video clip
// ---------------------------------------------------------------------------------------------------------

/** Visible window of a Ken Burns framing in pad percentages (the window is 1/zoom of the frame, kept inside it). */
function framingRect(pt) {
  const z = Math.max(1, pt.zoom || 1);
  const w = 100 / z;
  return { x: clamp((pt.x ?? 0.5) * 100 - w / 2, 0, 100 - w), y: clamp((pt.y ?? 0.5) * 100 - w / 2, 0, 100 - w), w };
}

/**
 * Ken Burns framing pad. Only the framing being edited (`which`: 'from' | 'to', picked with the Start/End switch)
 * is interactive and drawn on top, so overlapping boxes never steal each other's drags: drag the box to move it, or
 * press anywhere else on the pad to centre it there and keep dragging. The other framing is shown dashed behind.
 */
function FocusPad({ clip, settings, ed, which }) {
  const previews = useMediaPreview(clip.mediaId);
  const ref = useRef(null);
  const kb = clip.kenBurns;
  const aspect = (settings.width || 16) / (settings.height || 9);
  const onDown = (e) => {
    if (e.button !== 0) return;
    const padEl = ref.current;
    const pad = padEl.getBoundingClientRect();
    if (!pad.width || !pad.height) return;
    e.preventDefault();
    const base = clip.kenBurns;
    const cur = base[which];
    // The window centre can only travel where the window stays inside the frame (same clamp as the compositor), so
    // the stored point never drifts into a dead zone.
    const h = 0.5 / Math.max(1, cur.zoom || 1);
    const fx = (v) => clamp(v, h, 1 - h);
    const eff = { x: fx(cur.x ?? 0.5), y: fx(cur.y ?? 0.5) };
    const px = (e.clientX - pad.left) / pad.width;
    const py = (e.clientY - pad.top) / pad.height;
    const inside = Math.abs(px - eff.x) <= h && Math.abs(py - eff.y) <= h;
    const start = inside ? eff : { x: fx(px), y: fx(py) };
    const round = (v) => Math.round(v * 1000) / 1000;
    const apply = (x, y) => ed.live('kb-focus', { kenBurns: { ...base, [which]: { ...cur, x: round(x), y: round(y) } } }, 'Move Ken Burns framing');
    if (!inside) apply(start.x, start.y);
    const x0 = e.clientX;
    const y0 = e.clientY;
    try {
      padEl.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const move = (ev) => apply(fx(start.x + (ev.clientX - x0) / pad.width), fx(start.y + (ev.clientY - y0) / pad.height));
    const up = () => {
      padEl.removeEventListener('pointermove', move);
      padEl.removeEventListener('pointerup', up);
      padEl.removeEventListener('pointercancel', up);
      ed.end('kb-focus');
    };
    padEl.addEventListener('pointermove', move);
    padEl.addEventListener('pointerup', up);
    padEl.addEventListener('pointercancel', up);
  };
  const a = framingRect(kb.from);
  const b = framingRect(kb.to);
  const box = (r) => `left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.w}%`;
  const fit = clip.fit === 'contain' ? 'contain' : clip.fit === 'fill' ? 'fill' : 'cover';
  return html`<div
    class=${cx('insp-kb-pad', `is-editing-${which}`)}
    ref=${ref}
    style=${`aspect-ratio:${aspect}`}
    title=${`${which === 'from' ? 'Start' : 'End'} framing — drag the box, or click where it should be`}
    onPointerDown=${onDown}
  >
    ${previews?.thumb && html`<img class="insp-kb-img" src=${previews.thumb} style=${`object-fit:${fit}`} alt="" draggable="false" />`}
    <svg class="insp-kb-arrow" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1=${a.x + a.w / 2} y1=${a.y + a.w / 2} x2=${b.x + b.w / 2} y2=${b.y + b.w / 2} />
    </svg>
    <div class=${cx('insp-kb-rect', 'is-from', which === 'from' && 'is-active')} style=${box(a)}><span>Start</span></div>
    <div class=${cx('insp-kb-rect', 'is-to', which === 'to' && 'is-active')} style=${box(b)}><span>End</span></div>
  </div>`;
}

function TransitionField({ clip, project, session }) {
  const tr = clip.transition;
  const max = Math.max(0.1, Math.min(3, maxTransitionAt(project, clip.id)));
  const gen = useRef(0);
  const options = [{ value: '', label: 'Cut (none)' }];
  for (const k of TRANSITION_KINDS) for (const t of M.TRANSITIONS.filter((x) => x.kind === k.id)) options.push({ value: t.id, label: `${t.name}` });
  return html`<div class="insp-tr">
    <div class="insp-tr-row">
      ${tr ? html`<${TransitionSwatch} type=${tr.type} />` : html`<span class="tl-trsw tl-trsw-md" data-tr="cut"><span class="tl-trsw-a"></span><span class="tl-trsw-b"></span></span>`}
      <${Select}
        value=${tr?.type || ''}
        options=${options}
        title="Transition from the previous clip"
        onChange=${(v) =>
          projectStore.update((p) => M.setTransition(p, clip.id, v ? { type: v, duration: tr?.duration || M.DEFAULT_TRANSITION_DURATION } : null), {
            label: v ? `Transition: ${transitionName(v)}` : 'Remove transition',
          })}
      />
      <${IconButton} icon="grid" size="sm" title="Browse all transitions" onClick=${() => session.emit('transition', { clipId: clip.id })} />
    </div>
    ${tr &&
    html`<${Slider}
      label="Duration"
      value=${Math.min(tr.duration, max)}
      min=${0.1}
      max=${Math.max(0.2, max)}
      step=${0.05}
      format=${secs}
      onChange=${(v) =>
        projectStore.update((p) => M.setTransition(p, clip.id, { type: tr.type, duration: v }), { label: 'Transition duration', merge: `insp:${clip.id}:trdur:${gen.current}` })}
      onCommit=${() => (gen.current += 1)}
    />`}
  </div>`;
}

function VideoPanel({ clip, item, media, project, session }) {
  const ed = useClipEditor(clip.id);
  const previews = useMediaPreview(clip.mediaId);
  const isImage = media?.kind === 'image';
  const hasSound = media?.kind === 'video' && media.hasAudio !== false;
  const maxSrc = isImage ? Infinity : media?.duration || clip.out;
  const filters = M.clipFilters(clip);
  const presetId = Ops.matchFilterPreset(clip.filters);
  const neutral = M.filtersAreNeutral(clip.filters);
  const maxFade = Math.max(0.1, Math.min(5, item.duration));
  const kb = clip.kenBurns;
  const kbPreset = Ops.matchKenBurnsPreset(kb);
  const [kbWhich, setKbWhich] = useState('from'); // framing edited on the pad
  const kbCur = kb ? kb[kbWhich] : null;
  const speed = clip.speed || 1;
  const sub = `${isImage ? 'Still image' : 'Video'} · ${formatDuration(item.duration)}${media?.width ? ` · ${media.width}×${media.height}` : ''}`;
  return html`
    <${ClipHeader} icon=${isImage ? 'image' : 'film'} kind="video" title=${clip.label || media?.name || 'Clip'} sub=${sub} thumb=${previews?.thumb} />
    <${Section} title="Timing">
      ${clip.freeze
        ? html`<${FreezeTiming} clip=${clip} item=${item} project=${project} ed=${ed} />`
        : isImage
        ? html`<${Field} label="Duration">
            <${TimeField} value=${clip.out - clip.in} min=${M.MIN_CLIP_DURATION} max=${3600} fps=${project.settings.fps} onChange=${(v) => ed.set({ out: clip.in + v }, 'Set duration')} />
          <//>`
        : html`<div class="insp-grid2">
            <${Field} label="Source in">
              <${TimeField} value=${clip.in} min=${0} max=${Math.max(0, clip.out - M.MIN_CLIP_DURATION)} fps=${project.settings.fps} onChange=${(v) => ed.set({ in: v }, 'Set in point')} />
            <//>
            <${Field} label="Source out">
              <${TimeField} value=${clip.out} min=${clip.in + M.MIN_CLIP_DURATION} max=${maxSrc} fps=${project.settings.fps} onChange=${(v) => ed.set({ out: v }, 'Set out point')} />
            <//>
          </div>`}
      ${!clip.freeze && html`<div class="insp-note">On the timeline <b class="mono">${formatTime(item.start)}</b> → <b class="mono">${formatTime(item.end)}</b></div>`}
      ${!isImage &&
      !clip.freeze &&
      html`<${LiveSlider}
          ed=${ed}
          field="speed"
          label="Speed"
          value=${speed}
          min=${M.MIN_SPEED}
          max=${M.MAX_SPEED}
          step=${0.05}
          format=${(v) => `${v.toFixed(2)}×`}
          resetValue=${1}
          patch=${(v) => ({ speed: v })}
          undoLabel="Change speed"
        />
        <div class="insp-chips">
          ${[0.5, 1, 1.5, 2, 3].map(
            (s) => html`<button type="button" key=${s} class=${cx('chip', Math.abs(speed - s) < 1e-3 && 'is-active')} onClick=${() => ed.set({ speed: s }, `Speed ${s}×`)}>${s}×</button>`,
          )}
        </div>
        <${SpeedTools} clip=${clip} session=${session} />`}
    <//>
    ${hasSound &&
    !clip.freeze &&
    html`<${Section} title="Sound">
      <div class="insp-inline">
        <div class="grow">
          <${LiveSlider} ed=${ed} field="volume" label="Clip volume" value=${clip.volume ?? 1} min=${0} max=${2} step=${0.01} format=${pct} resetValue=${1} patch=${(v) => ({ volume: v })} disabled=${clip.muted} />
        </div>
        <${IconButton} icon=${clip.muted ? 'volume-x' : 'volume'} title=${clip.muted ? 'Unmute' : 'Mute'} active=${clip.muted} onClick=${() => ed.set({ muted: !clip.muted }, clip.muted ? 'Unmute clip' : 'Mute clip')} />
      </div>
      <${EqField} clip=${clip} />
      <${ActionRow}>
        <${Button} size="sm" kind="ghost" icon="music" disabled=${!Ops.canDetachAudio(project, clip)} title="Move the sound to an audio lane (needs 1× speed)" onClick=${() => A.detachAudio(clip.id)}>Detach audio<//>
      <//>
    <//>`}
    <${Section} title="Framing">
      <${Segmented}
        value=${clip.fit || 'cover'}
        options=${[
          { value: 'cover', label: 'Fill', title: 'Fill the frame (crop edges)' },
          { value: 'contain', label: 'Fit', title: 'Fit inside the frame (letterbox)' },
          { value: 'fill', label: 'Stretch', title: 'Stretch to the frame' },
        ]}
        onChange=${(v) => ed.set({ fit: v }, 'Change framing')}
      />
    <//>
    <${CropRotateSection} clip=${clip} media=${media} project=${project} />
    <${Section} title="Color & look">
      <div class="insp-looks">
        ${M.FILTER_PRESETS.map(
          (p) => html`<button
            type="button"
            key=${p.id}
            class=${cx('insp-look', presetId === p.id && 'is-active')}
            title=${p.name}
            data-preset=${p.id}
            onClick=${() => ed.set({ filters: Ops.filterPresetValues(p.id) }, `Look: ${p.name}`)}
          >
            <span class="insp-look-img" style=${`${previews?.thumb ? `background-image:url("${previews.thumb}");` : ''}filter:${buildFilter(p.filters, 72)}`}>
              ${p.filters.vignette ? html`<span class="insp-look-vig" style=${`opacity:${p.filters.vignette}`}></span>` : null}
            </span>
            <span class="insp-look-name">${p.name}</span>
          </button>`,
        )}
      </div>
      <div class="insp-sliders">
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
            patch=${(v) => ({ filters: { ...M.clipFilters(M.findClip(projectStore.get(), clip.id)?.clip || clip), [f.key]: v } })}
            undoLabel=${`Adjust ${f.label.toLowerCase()}`}
          />`,
        )}
      </div>
      <${ActionRow}>
        <${Button} size="sm" icon="wand" title="Balance brightness, contrast and colour from the clip's picture" onClick=${() => A.autoEnhance(clip.id)}>Auto enhance<//>
        <${Button} size="sm" kind="ghost" icon="refresh" disabled=${neutral} onClick=${() => ed.set({ filters: null }, 'Reset look')}>Reset look<//>
      <//>
    <//>
    <${Section} title="Fades">
      <${LiveSlider} ed=${ed} field="fadeIn" label="Fade in" value=${clip.fadeIn || 0} min=${0} max=${maxFade} step=${0.05} format=${secs} resetValue=${0} patch=${(v) => ({ fadeIn: v })} />
      <${LiveSlider} ed=${ed} field="fadeOut" label="Fade out" value=${clip.fadeOut || 0} min=${0} max=${maxFade} step=${0.05} format=${secs} resetValue=${0} patch=${(v) => ({ fadeOut: v })} />
    <//>
    <${Section} title="Motion (Ken Burns)">
      <${Toggle} checked=${!!kb} label="Slow pan & zoom" onChange=${(on) => ed.set({ kenBurns: on ? Ops.kenBurnsPreset('zoom-in') : null }, on ? 'Add motion' : 'Remove motion')} />
      ${kb &&
      html`<div class="insp-chips">
          ${Ops.KEN_BURNS_PRESETS.map(
            (p) => html`<button type="button" key=${p.id} class=${cx('chip', kbPreset === p.id && 'is-active')} onClick=${() => ed.set({ kenBurns: Ops.kenBurnsPreset(p.id) }, `Motion: ${p.name}`)}>${p.name}</button>`,
          )}
        </div>
        <div class="insp-kb-switch">
          <${Segmented}
            size="sm"
            value=${kbWhich}
            options=${[
              { value: 'from', label: 'Start framing', title: 'Edit what the first frame shows' },
              { value: 'to', label: 'End framing', title: 'Edit what the last frame shows' },
            ]}
            onChange=${setKbWhich}
          />
        </div>
        <${FocusPad} clip=${clip} settings=${project.settings} ed=${ed} which=${kbWhich} />
        <${LiveSlider}
          ed=${ed}
          field=${`kb-${kbWhich}`}
          label=${kbWhich === 'from' ? 'Start zoom' : 'End zoom'}
          value=${kbCur.zoom ?? 1}
          min=${1}
          max=${2.5}
          step=${0.01}
          format=${(v) => `${v.toFixed(2)}×`}
          resetValue=${kbWhich === 'from' ? 1 : 1.12}
          patch=${(v) => ({ kenBurns: { ...kb, [kbWhich]: { ...kb[kbWhich], zoom: v } } })}
          undoLabel=${kbWhich === 'from' ? 'Change start zoom' : 'Change end zoom'}
        />
        <div class="insp-note">
          ${(kbCur.zoom ?? 1) <= 1.001
            ? html`The ${kbWhich === 'from' ? 'start' : 'end'} shows the whole frame — raise its zoom to frame a detail, then drag the box onto it.`
            : html`Drag the box, or click where it should be, to choose what the ${kbWhich === 'from' ? 'first' : 'last'} frame shows.`}
        </div>`}
    <//>
    ${item.index > 0 &&
    html`<${Section} title="Transition in">
      <${TransitionField} clip=${clip} project=${project} session=${session} />
    <//>`}
    <${Section} title="Clip">
      <${Field} label="Label">
        <${TextField} value=${clip.label || ''} placeholder=${media?.name || 'Clip label'} onCommit=${(v) => v !== (clip.label || '') && ed.set({ label: v.trim() }, 'Rename clip')} />
      <//>
      <${ActionRow}>
        <${Button} size="sm" icon="scissors" onClick=${() => A.splitAtPlayhead(session)}>Split<//>
        <${Button} size="sm" icon="copy" onClick=${() => A.duplicateSelection()}>Duplicate<//>
        <${Button} size="sm" icon="camera" onClick=${() => A.grabFrame(session, 'bin')}>Grab frame<//>
        <${Button} size="sm" icon="search" kind="ghost" onClick=${() => A.revealInBin(clip.mediaId, session)}>Reveal in bin<//>
        <${Button} size="sm" icon="trash" kind="danger" onClick=${() => A.deleteSelection()}>Delete<//>
      <//>
    <//>
  `;
}

// ---------------------------------------------------------------------------------------------------------
// Audio clip
// ---------------------------------------------------------------------------------------------------------

function AudioPanel({ clip, item, media, project, session }) {
  const ed = useClipEditor(clip.id);
  const maxSrc = media?.duration > 0 ? media.duration : clip.out;
  const dur = M.audioClipDuration(clip);
  const lanes = Math.max(1, ...project.tracks.audio.map((c) => (c.lane || 0) + 1)) + 1;
  const maxFade = Math.max(0.1, Math.min(10, dur));
  return html`
    <${ClipHeader} icon=${media?.kind === 'video' ? 'film' : 'music'} kind="audio" title=${clip.label || media?.name || 'Audio'} sub=${`${media?.kind === 'video' ? 'Sound of a video' : 'Audio'} · ${formatDuration(dur)}`} />
    <${Section} title="Timing">
      <div class="insp-grid2">
        <${Field} label="Starts at">
          <${TimeField} value=${clip.start} min=${0} max=${36000} fps=${project.settings.fps} onChange=${(v) => ed.set({ start: v }, 'Move audio')} />
        <//>
        <${Field} label="Lane">
          <${Select}
            value=${String(clip.lane || 0)}
            options=${Array.from({ length: lanes }, (_, i) => ({ value: String(i), label: `A${i + 1}${i === lanes - 1 ? ' (new)' : ''}` }))}
            onChange=${(v) => projectStore.update((p) => M.moveAudioClip(p, clip.id, clip.start, Number(v)), { label: 'Change lane' })}
          />
        <//>
        <${Field} label="Source in">
          <${TimeField} value=${clip.in} min=${0} max=${Math.max(0, clip.out - M.MIN_CLIP_DURATION)} fps=${project.settings.fps} onChange=${(v) => ed.set({ in: v }, 'Set audio in')} />
        <//>
        <${Field} label="Source out">
          <${TimeField} value=${clip.out} min=${clip.in + M.MIN_CLIP_DURATION} max=${maxSrc} fps=${project.settings.fps} onChange=${(v) => ed.set({ out: v }, 'Set audio out')} />
        <//>
      </div>
      <div class="insp-note">Plays <b class="mono">${formatTime(item.start)}</b> → <b class="mono">${formatTime(item.end)}</b> (${formatDuration(dur)})</div>
      <${ActionRow}>
        <${Button} size="sm" icon="arrow-right" title="Trim every audio clip so nothing plays past the last video frame" onClick=${() => A.fitAudioToVideoEnd()}>Fit to video end<//>
      <//>
    <//>
    <${Section} title="Sound">
      <${LiveSlider} ed=${ed} field="volume" label="Volume" value=${clip.volume ?? 1} min=${0} max=${2} step=${0.01} format=${pct} resetValue=${1} patch=${(v) => ({ volume: v })} />
      <${LiveSlider} ed=${ed} field="fadeIn" label="Fade in" value=${clip.fadeIn || 0} min=${0} max=${maxFade} step=${0.05} format=${secs} resetValue=${0} patch=${(v) => ({ fadeIn: v })} />
      <${LiveSlider} ed=${ed} field="fadeOut" label="Fade out" value=${clip.fadeOut || 0} min=${0} max=${maxFade} step=${0.05} format=${secs} resetValue=${0} patch=${(v) => ({ fadeOut: v })} />
      <div class="insp-chips">
        <button type="button" class="chip" onClick=${() => ed.set({ fadeIn: Math.min(1, dur / 2), fadeOut: Math.min(2, dur / 2) }, 'Fade in & out')}>Fade in & out</button>
        <button type="button" class="chip" onClick=${() => ed.set({ fadeIn: 0, fadeOut: 0 }, 'Remove fades')}>No fades</button>
      </div>
      <${EqField} clip=${clip} />
      <${DuckSection} clip=${clip} ed=${ed} />
    <//>
    <${Section} title="Clip">
      <${ActionRow}>
        <${Button} size="sm" icon="scissors" onClick=${() => A.splitAtPlayhead(session)}>Split<//>
        <${Button} size="sm" icon="copy" onClick=${() => A.duplicateSelection()}>Duplicate<//>
        <${Button} size="sm" icon="search" kind="ghost" onClick=${() => A.revealInBin(clip.mediaId, session)}>Reveal in bin<//>
        <${Button} size="sm" icon="trash" kind="danger" onClick=${() => A.deleteSelection()}>Delete<//>
      <//>
    <//>
  `;
}

// ---------------------------------------------------------------------------------------------------------
// Text clip
// ---------------------------------------------------------------------------------------------------------

function TextPanel({ clip, item, project, session }) {
  const ed = useClipEditor(clip.id);
  const taRef = useRef(null);
  const style = { ...M.TEXT_STYLE_DEFAULTS, ...(clip.style || {}) };
  const setStyle = (patch, label) => ed.set({ style: { ...style, ...patch } }, label);
  const liveStyle = (field) => (v) => ({ style: { ...(M.findClip(projectStore.get(), clip.id)?.clip.style || style), [field]: v } });
  const styleColor = (field, label) => colorUpdate((v) => (p) => Ops.updateClipIfChanged(p, clip.id, { style: { ...(M.findClip(p, clip.id)?.clip.style || style), [field]: v } }), label);
  const fontOptions = FONT_CHOICES.map((f) => ({ value: f.value, label: f.label }));
  if (!fontOptions.some((f) => f.value === style.font)) fontOptions.unshift({ value: style.font, label: style.font.split(',')[0].replace(/["']/g, '') });
  const posId = TEXT_POSITIONS.find((p) => Math.abs(p.x - style.x) < 1e-3 && Math.abs(p.y - style.y) < 1e-3)?.id;

  // A title just added (T, toolbar, "Edit text") takes the keyboard as soon as this panel exists — a layout effect so
  // it lands before the next key event even when the inspector / drawer had to mount first.
  useLayoutEffect(() => {
    if (!session.consumeTextFocus(clip.id)) return;
    const ta = taRef.current?.querySelector('textarea');
    if (!ta) return;
    ta.focus({ preventScroll: true });
    ta.select();
  });

  return html`
    <${ClipHeader} icon="type" kind="text" title=${String(clip.text || '').split('\n')[0] || 'Title'} sub=${`Title · ${formatDuration(clip.duration)} · T${(clip.lane || 0) + 1}`} />
    <${Section} title="Text">
      <div class="insp-textarea" ref=${taRef}>
        <${TextField}
          multiline=${true}
          rows=${3}
          value=${clip.text}
          placeholder="Type your title…"
          onInput=${(v) => ed.live('text', { text: v }, 'Edit text')}
          onCommit=${() => ed.end('text')}
          onKeyDown=${(e) => e.key === 'Escape' && e.currentTarget.blur()}
        />
      </div>
      <${Field} label="Animation">
        <${Segmented}
          size="sm"
          value=${clip.animation || 'none'}
          options=${M.TEXT_ANIMATIONS.map((a) => ({ value: a, label: ANIMATION_LABELS[a] || a }))}
          onChange=${(v) => ed.set({ animation: v }, 'Text animation')}
        />
      <//>
    <//>
    <${Section} title="Title style">
      <${TitleStyles} clip=${clip} />
    <//>
    <${Section} title="Style">
      <${Field} label="Font">
        <${Select} value=${style.font} options=${fontOptions} onChange=${(v) => setStyle({ font: v }, 'Change font')} />
      <//>
      <${LiveSlider}
        ed=${ed}
        field="size"
        label="Size"
        value=${style.size}
        min=${0.02}
        max=${0.25}
        step=${0.005}
        format=${(v) => `${Math.round(v * (project.settings.height || 720))}px`}
        resetValue=${M.TEXT_STYLE_DEFAULTS.size}
        patch=${liveStyle('size')}
        undoLabel="Text size"
      />
      <div class="insp-inline">
        <${Segmented}
          size="sm"
          value=${Number(style.weight) || 700}
          options=${[
            { value: 400, label: 'Regular' },
            { value: 600, label: 'Semi' },
            { value: 700, label: 'Bold' },
            { value: 900, label: 'Black' },
          ]}
          onChange=${(v) => setStyle({ weight: v }, 'Text weight')}
        />
        <${IconButton} icon="type" size="sm" title="Italic" active=${!!style.italic} class="insp-italic" onClick=${() => setStyle({ italic: !style.italic }, style.italic ? 'Remove italic' : 'Italic')} />
      </div>
      <div class="insp-grid2">
        <${Field} label="Color">
          <${ColorField} value=${style.color} onChange=${styleColor('color', 'Text color')} />
        <//>
        <${Field} label="Background">
          <${ColorField} value=${style.background} allowNone=${true} onChange=${styleColor('background', 'Text background')} />
        <//>
      </div>
      <${Field} label="Align">
        <${Segmented}
          size="sm"
          value=${style.align}
          options=${[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Center' },
            { value: 'right', label: 'Right' },
          ]}
          onChange=${(v) => setStyle({ align: v }, 'Text align')}
        />
      <//>
      <div class="insp-toggles">
        <${Toggle} checked=${!!style.shadow} label="Shadow" onChange=${(v) => setStyle({ shadow: v }, v ? 'Text shadow' : 'No text shadow')} />
        <${Toggle} checked=${!!style.outline} label="Outline" onChange=${(v) => setStyle({ outline: v }, v ? 'Text outline' : 'No text outline')} />
        <${Toggle} checked=${!!style.letterbox} label="Letterbox" onChange=${(v) => setStyle({ letterbox: v }, v ? 'Letterbox bars' : 'No letterbox bars')} />
      </div>
      <${LiveSlider} ed=${ed} field="maxWidth" label="Wrap width" value=${style.maxWidth || 0.9} min=${0.2} max=${1} step=${0.01} format=${pct} resetValue=${0.9} patch=${liveStyle('maxWidth')} undoLabel="Text wrap width" />
    <//>
    <${Section} title="Position">
      <div class="insp-chips">
        ${TEXT_POSITIONS.map((p) => html`<button type="button" key=${p.id} class=${cx('chip', posId === p.id && 'is-active')} onClick=${() => setStyle({ x: p.x, y: p.y }, `Text position: ${p.label}`)}>${p.label}</button>`)}
      </div>
      <div class="insp-grid2">
        <${LiveSlider} ed=${ed} field="x" label="Horizontal" value=${style.x} min=${0} max=${1} step=${0.005} format=${pct} resetValue=${0.5} patch=${liveStyle('x')} undoLabel="Move text" />
        <${LiveSlider} ed=${ed} field="y" label="Vertical" value=${style.y} min=${0} max=${1} step=${0.005} format=${pct} resetValue=${0.86} patch=${liveStyle('y')} undoLabel="Move text" />
      </div>
    <//>
    <${Section} title="Timing">
      <div class="insp-grid2">
        <${Field} label="Starts at">
          <${TimeField} value=${clip.start} min=${0} max=${36000} fps=${project.settings.fps} onChange=${(v) => ed.set({ start: v }, 'Move text')} />
        <//>
        <${Field} label="Duration">
          <${TimeField} value=${clip.duration} min=${M.MIN_CLIP_DURATION} max=${3600} fps=${project.settings.fps} onChange=${(v) => ed.set({ duration: v }, 'Text duration')} />
        <//>
      </div>
      <div class="insp-note">Shows <b class="mono">${formatTime(item.start)}</b> → <b class="mono">${formatTime(item.end)}</b></div>
      <${ActionRow}>
        <${Button} size="sm" icon="arrow-right" onClick=${() => {
          const end = M.layoutProject(projectStore.get()).videoEnd;
          if (end > clip.start + M.MIN_CLIP_DURATION) ed.set({ duration: end - clip.start }, 'Extend text to video end');
        }}>Until video end<//>
      <//>
    <//>
    <${Section} title="Clip">
      <${ActionRow}>
        <${Button} size="sm" icon="scissors" onClick=${() => A.splitAtPlayhead(session)}>Split<//>
        <${Button} size="sm" icon="copy" onClick=${() => A.duplicateSelection()}>Duplicate<//>
        <${Button} size="sm" icon="trash" kind="danger" onClick=${() => A.deleteSelection()}>Delete<//>
      <//>
    <//>
  `;
}

// ---------------------------------------------------------------------------------------------------------
// Sequence (nothing selected) and multi-selection
// ---------------------------------------------------------------------------------------------------------

function ProjectPanel({ project }) {
  const s = project.settings;
  const presetId = Ops.resolutionPresetId(s);
  const firstMedia = project.tracks.video.map((c) => project.media[c.mediaId]).find((m) => m?.width && m?.height);
  const match = firstMedia ? Ops.sizeForMedia(firstMedia) : null;
  const stats = Ops.sequenceStats(project);
  const setSettings = (patch, label) =>
    projectStore.update((p) => (Object.entries(patch).every(([k, v]) => p.settings[k] === v) ? p : M.updateSettings(p, patch)), { label });
  return html`
    <${Section} title="Output format">
      <${Field} label="Name">
        <${TextField} value=${project.name} onCommit=${(v) => v.trim() && v !== project.name && renameCurrentProject(v)} />
      <//>
      <${Field} label="Resolution">
        <${Select}
          value=${presetId}
          options=${[...M.RESOLUTION_PRESETS.map((r) => ({ value: r.id, label: r.label })), { value: 'custom', label: 'Custom size' }]}
          onChange=${(v) => {
            const r = M.RESOLUTION_PRESETS.find((x) => x.id === v);
            if (r) setSettings({ width: r.width, height: r.height }, `Resolution ${r.width}×${r.height}`);
          }}
        />
      <//>
      <div class="insp-grid2">
        <${Field} label="Width">
          <${NumberField} value=${s.width} min=${16} max=${4096} step=${2} suffix="px" width=${110} onChange=${(v) => setSettings({ width: Math.round(v / 2) * 2 }, 'Change width')} />
        <//>
        <${Field} label="Height">
          <${NumberField} value=${s.height} min=${16} max=${4096} step=${2} suffix="px" width=${110} onChange=${(v) => setSettings({ height: Math.round(v / 2) * 2 }, 'Change height')} />
        <//>
      </div>
      ${match &&
      (match.width !== s.width || match.height !== s.height) &&
      html`<${ActionRow}>
        <${Button} size="sm" kind="ghost" icon="crop" title="Use the first clip's aspect ratio" onClick=${() => setSettings(match, 'Match first clip')}>Match first clip (${match.width}×${match.height})<//>
      <//>`}
      <${Field} label="Frame rate">
        <${Segmented} size="sm" value=${s.fps} options=${M.FPS_PRESETS.map((f) => ({ value: f, label: `${f} fps` }))} onChange=${(v) => setSettings({ fps: v }, `Frame rate ${v}`)} />
      <//>
      <${Field} label="Background">
        <${ColorField}
          value=${s.background}
          onChange=${colorUpdate((v) => (p) => ((v || '#000000') === p.settings.background ? p : M.updateSettings(p, { background: v || '#000000' })), 'Background color')}
        />
      <//>
    <//>
    <${Section} title="Overview">
      <div class="insp-stats">
        <div><b>${formatTime(stats.duration)}</b><span>Duration</span></div>
        <div><b>${stats.clips}</b><span>Clips</span></div>
        <div><b>${stats.transitions}</b><span>Transitions</span></div>
        <div><b>${stats.audio}</b><span>Audio</span></div>
        <div><b>${stats.text}</b><span>Titles</span></div>
        <div><b>${stats.markers}</b><span>Markers</span></div>
      </div>
      ${!stats.clips && html`<div class="insp-note">Select a clip on the timeline to trim it, change its speed, color look, fades, motion and transition.</div>`}
    <//>
    <${Section} title="Shortcuts" defaultOpen=${false}>
      <div class="insp-keys">
        ${SHORTCUTS.map(([combo, label]) => html`<div class="insp-key" key=${combo}><${Kbd}>${combo === 'plus' ? '+' : comboLabel(combo)}<//><span>${label}</span></div>`)}
      </div>
    <//>
  `;
}

function MultiPanel({ ids, project, session }) {
  const video = project.tracks.video.filter((c) => ids.includes(c.id));
  const others = ids.length - video.length;
  return html`
    <div class="insp-multi">
      <div class="insp-multi-count">${ids.length}</div>
      <div>
        <div class="insp-clip-title">${ids.length} clips selected</div>
        <div class="insp-clip-sub">${video.length} video · ${others} audio/text</div>
      </div>
    </div>
    ${video.length > 0 &&
    html`<${Section} title="Look for all selected video">
      <div class="insp-chips">
        ${M.FILTER_PRESETS.map(
          (p) => html`<button
            type="button"
            key=${p.id}
            class="chip"
            onClick=${() =>
              projectStore.update(
                (q) => {
                  let r = q;
                  for (const c of video) r = M.updateClip(r, c.id, { filters: Ops.filterPresetValues(p.id) });
                  return r;
                },
                { label: `Look: ${p.name} (${video.length} clips)` },
              )}
          >${p.name}</button>`,
        )}
      </div>
    <//>`}
    <${Section} title="Selection">
      <${ActionRow}>
        <${Button} size="sm" icon="copy" onClick=${() => A.duplicateSelection()}>Duplicate<//>
        <${Button} size="sm" icon="copy" kind="ghost" onClick=${() => A.copySelection()}>Copy<//>
        <${Button} size="sm" icon="repeat" kind="ghost" onClick=${() => {
          const r = Ops.selectionRange(projectStore.get(), ids);
          if (r) {
            session.loopRange(r);
            session.seek(r.start);
            session.play();
          }
        }}>Loop selection<//>
        <${Button} size="sm" icon="trash" kind="danger" onClick=${() => A.deleteSelection()}>Delete<//>
      <//>
    <//>
  `;
}

/**
 * @param {Object} props
 * @param {Object} props.session
 * @param {() => void} props.onClose
 * @param {boolean} [props.closable]  shown on demand (drawer layouts): × closes it; otherwise › collapses it to a rail
 */
export function Inspector({ session, onClose, closable = false }) {
  const selection = useUI((s) => s.selection);
  const project = useProject((p) => p);
  const bodyRef = useRef(null);
  const [, force] = useState(0);
  const shownId = selection.length === 1 ? selection[0] : selection.length ? 'multi' : 'project';
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [shownId]);
  // Already mounted: re-render so the text panel claims the focus request (session.consumeTextFocus).
  useEffect(() => session.on('focusText', () => force((x) => x + 1)), [session]);
  if (!project) return null;
  const live = selection.filter((id) => M.findClip(project, id));
  let title = 'Sequence';
  let body;
  if (live.length > 1) {
    title = 'Selection';
    body = html`<${MultiPanel} ids=${live} project=${project} session=${session} />`;
  } else if (live.length === 1) {
    const found = M.findClip(project, live[0]);
    const lay = M.layoutProject(project);
    if (found.track === 'video') {
      title = 'Clip';
      const item = lay.video.find((it) => it.clip.id === found.clip.id);
      body = html`<${VideoPanel} key=${found.clip.id} clip=${found.clip} item=${item} media=${project.media[found.clip.mediaId]} project=${project} session=${session} />`;
    } else if (found.track === 'audio') {
      title = 'Audio';
      const item = lay.audio.find((it) => it.clip.id === found.clip.id);
      body = html`<${AudioPanel} key=${found.clip.id} clip=${found.clip} item=${item} media=${project.media[found.clip.mediaId]} project=${project} session=${session} />`;
    } else if (found.track === 'overlay') {
      title = 'Overlay';
      const item = lay.overlay.find((it) => it.clip.id === found.clip.id);
      body = html`<${OverlayPanel} key=${found.clip.id} clip=${found.clip} item=${item} media=${project.media[found.clip.mediaId]} project=${project} session=${session} />`;
    } else {
      title = 'Title';
      const item = lay.text.find((it) => it.clip.id === found.clip.id);
      body = html`<${TextPanel} key=${found.clip.id} clip=${found.clip} item=${item} project=${project} session=${session} />`;
    }
  } else {
    body = html`<${ProjectPanel} project=${project} />`;
  }
  // × only ever closes (like the bin drawer's); going back to the sequence settings is its own labelled control.
  return html`<div class="insp panel">
    <div class="panel-header insp-header">
      ${live.length > 0
        ? html`<button
              type="button"
              class="insp-back"
              title=${closable ? 'Deselect and show the sequence settings' : 'Deselect and show the sequence settings (Esc)'}
              onClick=${() => A.clearSelection()}
            >
              <${Icon} name="chevron-left" size=${13} /><span>Sequence</span>
            </button>
            <span class="insp-crumb-sep" aria-hidden="true">/</span>`
        : html`<${Icon} name="sliders" size=${14} />`}
      <span class="panel-title">${title}</span>
      <span class="spacer"></span>
      ${closable
        ? html`<${IconButton} icon="x" size="sm" title="Close inspector (Esc)" class="insp-close" onClick=${onClose} />`
        : html`<${IconButton} icon="chevron-right" size="sm" title="Hide inspector" onClick=${onClose} />`}
    </div>
    <div class="panel-body insp-body" ref=${bodyRef}>${body}</div>
  </div>`;
}
