// Direct manipulation of overlay-track clips: the picture-in-picture box editor (drag to move, corner handle to
// resize) used both on the program monitor (over the live picture) and on the inspector's position pad, plus the
// monitor's "pick the key colour from the frame" eyedropper for green / blue screen overlays.
//
// Geometry comes from engine/overlays.js (pipRect / pipPositionFor) so the box drawn here is exactly the box the
// compositor renders. One merge key per drag gesture = one undo step.

import { html, useEffect, useRef, useState } from '../../../vendor/preact-htm.mjs';
import { trackPointer } from '../pointer.js';
import { projectStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { clamp } from '../../core/utils.js';
import { pipRect, pipPositionFor } from '../../engine/overlays.js';
import { useProject, useUI } from '../hooks.js';
import { Icon, toast, cx } from '../kit.js';
import * as Ops from './edit-ops.js';

let gestureSeq = 0;

/** Source size for the PiP box aspect (media dimensions; 16:9 until known). */
export const overlaySourceSize = (media) => (media?.width > 0 && media?.height > 0 ? { w: media.width, h: media.height } : { w: 16, h: 9 });

/**
 * The PiP box over a W x H area (px): drag it to move, drag its corner handle (the one facing the frame centre) to
 * resize. `clip` must be an overlay clip; `media` its media item.
 */
export function PipBoxEditor({ clip, media, W, H, label = true }) {
  const boxRef = useRef(null);
  if (!(W > 0 && H > 0)) return null;
  const src = overlaySourceSize(media);
  const pip = { ...M.PIP_DEFAULTS, ...(clip.pip || {}) };
  const r = pipRect(pip, src.w, src.h, W, H);
  const handleRight = r.x + r.w / 2 < W / 2;
  const handleBottom = r.y + r.h / 2 < H / 2;
  const update = (patch, merge) =>
    projectStore.update((p) => Ops.updateClipIfChanged(p, clip.id, { pip: { ...pip, ...(M.findClip(p, clip.id)?.clip.pip || {}), ...patch } }), { label: patch.scale != null ? 'Resize picture in picture' : 'Move picture in picture', merge });

  const capture = (e) => {
    e.preventDefault();
    e.stopPropagation();
    return e;
  };
  // Always ends (ui/pointer.js): the box never stays attached to the mouse after a missed release.
  const track = (e, onMove) => trackPointer(e, { onMove });
  const round = (v) => Math.round(v * 1000) / 1000;

  const onMoveDown = (e) => {
    if (e.button !== 0) return;
    capture(e);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const merge = `pip-move:${clip.id}:${++gestureSeq}`;
    track(e, (ev) => {
      const pos = pipPositionFor(r.x + ev.clientX - x0, r.y + ev.clientY - y0, r.w, r.h, W, H);
      // Light magnetism toward the centre lines so "centred" is easy to hit.
      const snap = (v) => (Math.abs(v - 0.5) < 0.025 ? 0.5 : v);
      update({ x: round(snap(pos.x)), y: round(snap(pos.y)) }, merge);
    });
  };
  const onResizeDown = (e) => {
    if (e.button !== 0) return;
    capture(e);
    const x0 = e.clientX;
    const merge = `pip-scale:${clip.id}:${++gestureSeq}`;
    track(e, (ev) => {
      const dx = (ev.clientX - x0) * (handleRight ? 1 : -1);
      update({ scale: round(clamp((r.w + dx) / W, 0.1, 1)) }, merge);
    });
  };
  const k = H / 720;
  return html`<div
    class=${cx('ovh-box', pip.shadow !== false && 'has-shadow')}
    ref=${boxRef}
    data-pip-box=${clip.id}
    style=${`left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border-radius:${(pip.radius || 0) * k}px`}
    title="Drag to move the picture in picture"
    onPointerDown=${onMoveDown}
    onClick=${(e) => e.stopPropagation()}
    onDblClick=${(e) => e.stopPropagation()}
  >
    ${label && r.w > 70 && html`<span class="ovh-label">${Math.round(pip.scale * 100)}%</span>`}
    <span
      class=${cx('ovh-handle', handleRight ? 'is-right' : 'is-left', handleBottom ? 'is-bottom' : 'is-top')}
      title="Drag to resize"
      onPointerDown=${onResizeDown}
    ></span>
  </div>`;
}

/**
 * Layer over the program monitor's canvas (dispW x dispH, centred in the stage): the PiP box of the selected overlay
 * clip while the playhead is inside it, and the key-colour eyedropper when the inspector asks for it.
 */
export function MonitorOverlayHandles({ session, dispW, dispH, active }) {
  const selection = useUI((s) => s.selection);
  const selId = selection.length === 1 ? selection[0] : null;
  const clip = useProject((p) => (selId ? (p.tracks.overlay || []).find((c) => c.id === selId) || null : null));
  const media = useProject((p) => (clip ? p.media[clip.mediaId] || null : null));
  const playing = useUI((s) => s.playing);
  const [inside, setInside] = useState(false);
  const [pick, setPick] = useState(null); // clip id whose key colour is being picked
  const live = useRef({ clip });
  live.current.clip = clip;

  useEffect(() => {
    const check = (t) => {
      const c = live.current.clip;
      const yes = !!c && t >= c.start && t < c.start + M.clipDuration(c);
      setInside((was) => (was === yes ? was : yes));
    };
    check(session.time());
    return session.onTime(check);
  }, [session, clip]);
  useEffect(() => session.on('overlayPick', ({ clipId }) => setPick(clipId)), [session]);
  useEffect(() => {
    if (!pick) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setPick(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pick]);
  useEffect(() => {
    if (!active) setPick(null);
  }, [active]);

  if (!(dispW > 0 && dispH > 0)) return null;
  const onPick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const id = pick;
    setPick(null);
    const color = await session.player?.sampleOverlayColor?.(id, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    if (!color) {
      toast('Move the playhead over the overlay to pick its key colour', { kind: 'info' });
      return;
    }
    projectStore.update(
      (p) => {
        const c = M.findClip(p, id)?.clip;
        return c ? Ops.updateClipIfChanged(p, id, { key: { ...M.KEY_DEFAULTS, ...(c.key || {}), color } }) : p;
      },
      { label: 'Pick key colour' },
    );
  };
  const showBox = clip && clip.mode === 'pip' && inside && !playing && !pick;
  if (!showBox && !pick) return null;
  return html`<div class="ovh-layer" style=${`width:${dispW}px;height:${dispH}px`}>
    ${showBox && html`<${PipBoxEditor} clip=${clip} media=${media} W=${dispW} H=${dispH} />`}
    ${pick &&
    html`<div class="ovh-pick" title="Click the colour to remove (Esc to cancel)" onPointerDown=${(e) => e.stopPropagation()} onClick=${onPick} onDblClick=${(e) => e.stopPropagation()}>
      <span class="ovh-pick-hint"><${Icon} name="pipette" size=${12} /> Click the screen colour to key out · Esc cancels</span>
    </div>`}
  </div>`;
}
