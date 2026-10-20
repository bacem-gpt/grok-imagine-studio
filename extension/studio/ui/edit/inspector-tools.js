// Inspector sections for the iMovie-style clip tools (used by inspector.js): speed tools (reverse, freeze frame,
// instant replay), the freeze-frame hold, crop & rotate (crop rectangle editor over the clip's picture, aspect
// presets, rotate / flip), the equalizer, voice-over ducking and the title styles. Every edit is one undo step
// (drags: one merge key per gesture).

import { html, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { projectStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { formatTime } from '../../core/utils.js';
import { EQ_PRESETS, eqName } from '../../engine/audio-fx.js';
import { useMediaPreview } from '../hooks.js';
import { IconButton, Button, Slider, TimeField, Select, Toggle, Field, Section, cx } from '../kit.js';
import * as Ops from './edit-ops.js';
import * as A from './actions.js';

const pct = (v) => `${Math.round(v * 100)}%`;

/** Reverse toggle + freeze frame / instant replay buttons (inside the video clip's Timing section). */
export function SpeedTools({ clip, session }) {
  const [replayRate, setReplayRate] = useState(0.5);
  return html`<div class="insp-tools">
    <${Toggle}
      checked=${!!clip.reverse}
      label="Reverse"
      title="Play the clip backwards (the preview is silent; the export plays its sound backwards)"
      onChange=${() => A.toggleReverse(clip.id)}
    />
    <div class="insp-actions">
      <${Button} size="sm" icon="snowflake" title="Hold the frame under the playhead (Shift+F)" onClick=${() => A.freezeFrame(session)}>Freeze frame<//>
      <${Button} size="sm" icon="repeat" title="Replay the 2 s before the playhead in slow motion" onClick=${() => A.instantReplay(session, { rate: replayRate })}>Instant replay<//>
      <${Select}
        class="insp-replay-rate"
        value=${String(replayRate)}
        title="Instant replay speed"
        options=${[
          { value: '0.5', label: '50%' },
          { value: '0.25', label: '25%' },
        ]}
        onChange=${(v) => setReplayRate(Number(v))}
      />
    </div>
    ${clip.reverse && html`<div class="insp-note">Reversed clips are silent in the preview; the export plays their sound backwards.</div>`}
  </div>`;
}

/** Timing of a freeze frame: its hold length and the frame it shows. */
export function FreezeTiming({ clip, item, project, ed }) {
  return html`<${Field} label="Hold for">
      <${TimeField} value=${clip.out - clip.in} min=${M.MIN_CLIP_DURATION} max=${600} fps=${project.settings.fps} onChange=${(v) => ed.set({ out: clip.in + v }, 'Freeze frame length')} />
    <//>
    <div class="insp-note">
      Freeze frame of <b class="mono">${formatTime(clip.freezeAt || 0)}</b> in the source · on the timeline
      <b class="mono">${formatTime(item.start)}</b> → <b class="mono">${formatTime(item.end)}</b>
    </div>`;
}

/**
 * Crop rectangle editor over the clip's (unrotated) picture: drag inside to move, drag a corner to resize (the aspect
 * stays locked when an aspect preset is chosen). The dimmed part is what the crop removes.
 */
function CropPad({ clip, media, ratio }) {
  const previews = useMediaPreview(clip.mediaId);
  const ref = useRef(null);
  const crop = clip.crop || { x: 0, y: 0, w: 1, h: 1 };
  const aspect = media?.width && media?.height ? media.width / media.height : 16 / 9;
  const onDown = (e, handle) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const pad = ref.current?.getBoundingClientRect();
    if (!pad?.width || !pad.height) return;
    const start = { ...crop };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const merge = `crop:${clip.id}:${Date.now()}`;
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const move = (ev) => A.setCrop(clip.id, Ops.dragCrop(start, handle, (ev.clientX - x0) / pad.width, (ev.clientY - y0) / pad.height, ratio), merge);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const box = `left:${crop.x * 100}%;top:${crop.y * 100}%;width:${crop.w * 100}%;height:${crop.h * 100}%`;
  // At most 260 px tall (portrait sources), always the source's shape.
  return html`<div class="insp-crop-pad" ref=${ref} style=${`aspect-ratio:${aspect};width:min(100%, ${Math.round(260 * aspect)}px)`}>
    ${previews?.thumb && html`<img class="insp-crop-img" src=${previews.thumb} alt="" draggable="false" />`}
    <div class="insp-crop-rect" style=${box} title="Drag to move the crop" onPointerDown=${(e) => onDown(e, 'move')}>
      <span class="insp-crop-third is-v1"></span><span class="insp-crop-third is-v2"></span>
      <span class="insp-crop-third is-h1"></span><span class="insp-crop-third is-h2"></span>
      ${['nw', 'ne', 'sw', 'se'].map((h) => html`<span key=${h} class=${`insp-crop-handle is-${h}`} title="Drag to resize" onPointerDown=${(e) => onDown(e, h)}></span>`)}
    </div>
  </div>`;
}

/** "Crop & rotate" section: rotate left / right, flip, crop presets and the crop rectangle. */
export function CropRotateSection({ clip, media, project }) {
  const [lock, setLock] = useState('free');
  const W = media?.width || project.settings.width || 16;
  const H = media?.height || project.settings.height || 9;
  const frameAspect = (project.settings.width || 16) / (project.settings.height || 9);
  const aspectOf = (id) => {
    const a = Ops.CROP_ASPECTS.find((x) => x.id === id)?.aspect;
    return a === 'frame' ? frameAspect : a;
  };
  const target = aspectOf(lock);
  // Locked ratio in normalized crop units (crop.w / crop.h) for the unrotated source picture.
  const quarter = (clip.rotate || 0) % 180 !== 0;
  const ratio = target ? (quarter ? 1 / target : target) * (H / W) : null;
  const choose = (id) => {
    setLock(id);
    const a = aspectOf(id);
    if (a) A.setCrop(clip.id, Ops.cropForAspect(a, W, H, clip.rotate || 0));
  };
  const rot = clip.rotate || 0;
  return html`<${Section} title="Crop & rotate">
    <div class="insp-inline insp-rotate">
      <${IconButton} icon="rotate-ccw" size="sm" title="Rotate left (90° counter-clockwise)" onClick=${() => A.rotateClip(clip.id, -1)} />
      <${IconButton} icon="rotate" size="sm" title="Rotate right (90° clockwise)" onClick=${() => A.rotateClip(clip.id, 1)} />
      <span class="insp-rotate-val mono" title="Rotation">${rot}°</span>
      <span class="spacer"></span>
      <${IconButton} icon="flip" size="sm" title="Flip horizontally (mirror)" active=${!!clip.flipH} onClick=${() => A.flipClip(clip.id, 'h')} />
      <${IconButton} icon="flip-v" size="sm" title="Flip vertically" active=${!!clip.flipV} onClick=${() => A.flipClip(clip.id, 'v')} />
    </div>
    <div class="insp-chips insp-crop-aspects">
      ${Ops.CROP_ASPECTS.map(
        (a) => html`<button type="button" key=${a.id} class=${cx('chip', lock === a.id && 'is-active')} title=${a.id === 'free' ? 'Resize the crop freely' : `Crop to ${a.label}`} onClick=${() => choose(a.id)}>
          ${a.label}
        </button>`,
      )}
    </div>
    <${CropPad} clip=${clip} media=${media} ratio=${ratio} />
    <div class="insp-actions">
      <${Button} size="sm" kind="ghost" icon="refresh" disabled=${!clip.crop && !rot && !clip.flipH && !clip.flipV} onClick=${() =>
        projectStore.update((p) => Ops.updateClipIfChanged(p, clip.id, { crop: null, rotate: 0, flipH: false, flipV: false }), { label: 'Reset crop & rotation' })}>Reset<//>
    </div>
    <div class="insp-note">The crop is drawn on the original picture; rotation and flips apply after it. Fill / Fit above frame the result.</div>
  <//>`;
}

/** Equalizer preset picker (main-track and audio clips). */
export function EqField({ clip }) {
  return html`<${Field} label="Equalizer">
    <${Select}
      value=${clip.eq || 'none'}
      title="Equalizer preset"
      options=${EQ_PRESETS.map((p) => ({ value: p.id, label: p.name }))}
      onChange=${(v) => A.setClipEq(clip.id, v, eqName(v))}
    />
  <//>`;
}

/** "Duck other audio" (iMovie: Reduce volume of other tracks) for an audio clip such as a voice-over. */
export function DuckSection({ clip, ed }) {
  const amount = clip.duckAmount ?? M.DEFAULT_DUCK_AMOUNT;
  return html`<${Toggle}
      checked=${!!clip.duck}
      label="Duck other audio"
      title="Lower every other sound while this clip plays"
      onChange=${(on) => ed.set({ duck: on, duckAmount: amount }, on ? 'Duck other audio' : 'Stop ducking')}
    />
    ${clip.duck &&
    html`<${Slider}
      label="Reduce others by"
      value=${amount}
      min=${0.1}
      max=${1}
      step=${0.05}
      format=${pct}
      resetValue=${M.DEFAULT_DUCK_AMOUNT}
      onChange=${(v) => ed.live('duckAmount', { duckAmount: v }, 'Ducking amount')}
      onCommit=${() => ed.end('duckAmount')}
    />`}`;
}

/** One-click title styles for a text clip. */
export function TitleStyles({ clip }) {
  const active = Ops.matchTitlePreset(clip);
  return html`<div class="insp-titles">
    ${Ops.TITLE_PRESETS.map(
      (p) => html`<button
        type="button"
        key=${p.id}
        class=${cx('insp-title-style', active === p.id && 'is-active')}
        data-title-preset=${p.id}
        title=${p.name}
        onClick=${() => A.applyTitlePreset(clip.id, p.id)}
      >
        <span class="insp-title-swatch" data-preset=${p.id}><span>Aa</span></span>
        <span class="insp-title-name">${p.name}</span>
      </button>`,
    )}
  </div>`;
}

/** Background picker menu items (for the timeline toolbar / context menus). */
export function backgroundMenuItems(session) {
  return Ops.BACKGROUND_PRESETS.map((b) => ({ label: b.name, icon: 'image', onClick: () => A.addBackground(session, b.id) }));
}

/** Title style menu items (for the timeline toolbar's title menu). */
export function titleMenuItems(session) {
  return Ops.TITLE_PRESETS.map((p) => ({ label: p.name, icon: 'type', onClick: () => A.addTitlePreset(session, p.id) }));
}

