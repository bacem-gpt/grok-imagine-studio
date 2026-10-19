// Timeline: toolbar, adaptive ruler with markers and playhead, text lanes, the magnetic main track V1 and audio
// lanes A1..An. Interactions: click/shift/ctrl selection, drag V1 clips to reorder (insertion indicator), drag
// audio/text clips in time and across lanes (snapping), ripple trims on every edge with live monitor preview,
// fade handles, transition badges at each cut, drops from the bin (application/x-gis-media) and from the OS,
// context menus, ctrl+wheel zoom, wheel scroll and auto-scroll while playing. Every edit is one undo step
// (one merge key per drag gesture).

import { html, useState, useEffect, useRef, useMemo, useLayoutEffect } from '../../../vendor/preact-htm.mjs';
import { projectStore, uiStore, createStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { formatTime, formatDuration, clamp, pluralize } from '../../core/utils.js';
import { useProject, useUI, useStore, useElementSize } from '../hooks.js';
import { Icon, IconButton, Button, Kbd, showMenu, promptDialog, pickFiles, cx } from '../kit.js';
import {
  clampZoom,
  zoomToSlider,
  sliderToZoom,
  fitZoom,
  stepZoom,
  rulerTicks,
  laneCounts,
  trackGeometry,
  rowAt,
  laneAt,
  snapMove,
  snapCandidates,
  reorderTarget,
  editPoints,
  anchoredScroll,
  toolbarLayout,
  SNAP_PX,
  DEFAULT_ZOOM,
} from './timeline-math.js';
import * as Ops from './edit-ops.js';
import * as A from './actions.js';
import { VideoClipView, AudioClipView, TextClipView, TransitionBadge } from './timeline-clips.js';
import { TransitionPopover } from './transition-popover.js';

const RULER_H = 26;
/** Below this timeline width the track headers shrink (the toolbar decides its labels by its own width). */
const TIGHT_W = 600;

/**
 * Pointer gesture with capture: onStart (after `threshold` px; return false to abort) -> onMove -> onEnd,
 * or onClick when the pointer never moved far enough.
 */
function beginGesture(e, { threshold = 3, onStart, onMove, onEnd, onClick }) {
  const el = e.currentTarget;
  const id = e.pointerId;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let started = false;
  let ctx = null;
  try {
    el.setPointerCapture(id);
  } catch {
    /* ignore */
  }
  const cleanup = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('lostpointercapture', lost);
  };
  const finish = (ev, cancelled) => {
    cleanup();
    if (started) onEnd?.({ ev, ctx, cancelled, dx: ev.clientX - x0, dy: ev.clientY - y0 });
    else if (!cancelled) onClick?.(ev);
  };
  const move = (ev) => {
    if (ev.pointerId !== id) return;
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!started) {
      if (Math.hypot(dx, dy) < threshold) return;
      started = true;
      ctx = onStart ? onStart(ev) : {};
      if (ctx === false) {
        started = false;
        cleanup();
        return;
      }
    }
    onMove?.({ dx, dy, ev, ctx });
  };
  const up = (ev) => {
    if (ev.pointerId === id) finish(ev, ev.type === 'pointercancel');
  };
  const lost = (ev) => {
    if (ev.pointerId === id) finish(ev, false);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', lost);
}

function paintRuler(canvas, { width, height, zoom, scrollLeft, duration }) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(width * dpr));
  const H = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  canvas.style.width = `${width}px`;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  const endX = duration * zoom - scrollLeft;
  if (endX < width) {
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(Math.max(0, endX), 0, width, height);
  }
  const { ticks } = rulerTicks(zoom, scrollLeft / zoom, (scrollLeft + width) / zoom);
  g.font = '500 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  g.textBaseline = 'top';
  for (const tk of ticks) {
    const x = Math.round(tk.t * zoom - scrollLeft) + 0.5;
    if (x < -60 || x > width + 1) continue;
    g.fillStyle = tk.major ? 'rgba(185,185,198,0.55)' : 'rgba(127,127,143,0.42)';
    g.fillRect(x - 0.5, tk.major ? height - 10 : height - 5, 1, tk.major ? 10 : 5);
    // A label cut by the left edge would read wrong ("07.5" for "0:07.5"): skip it, the next is at most ~72 px away.
    if (tk.label && x + 4 >= 0) {
      g.fillStyle = '#8d8d9e';
      g.fillText(tk.label, x + 4, 6);
    }
  }
}

/** Ghost, insertion/drop indicators, snap line and the floating hint; re-rendered on every pointer move. */
function Overlays({ store, zoom, header, geo }) {
  const o = useStore(store, (s) => s, Object.is);
  if (!o) return null;
  const vRow = geo.rows.find((r) => r.kind === 'video');
  const x = (t) => header + t * zoom;
  const audioRow = o.dropLane != null ? geo.rows.find((r) => r.kind === 'audio' && r.lane === o.dropLane) : null;
  return html`
    ${o.ghost &&
    html`<div class="tl-ghost" style=${`left:${header + o.ghost.x}px;width:${o.ghost.w}px;top:${vRow.top + 5}px;height:${vRow.height - 10}px`}>
      <${Icon} name="film" size=${12} /><span>${o.ghost.label}</span>
    </div>`}
    ${o.insertAt != null && html`<div class="tl-insert" style=${`left:${x(o.insertAt) - 2}px;top:${vRow.top - 3}px;height:${vRow.height + 6}px`}></div>`}
    ${o.dropAudioAt != null &&
    audioRow &&
    html`<div class="tl-insert tl-insert-audio" style=${`left:${x(o.dropAudioAt) - 1}px;top:${audioRow.top + 2}px;height:${audioRow.height - 4}px`}></div>`}
    ${o.snap != null && html`<div class="tl-snapline" style=${`left:${x(o.snap)}px`}></div>`}
    ${o.hint && html`<div class="tl-hint" style=${`left:${o.hint.x}px;top:${o.hint.y}px`}>${o.hint.text}</div>`}
  `;
}

function rowIcon(kind) {
  return kind === 'text' ? 'type' : kind === 'video' ? 'film' : 'music';
}

/**
 * @param {Object} props
 * @param {Object} props.session   edit session (session.js)
 * @param {boolean} props.active
 * @param {boolean} props.narrow   the Edit view's narrow (stacked) layout: smaller tracks
 */
export function Timeline({ session, active, narrow }) {
  const tracks = useProject((p) => p.tracks);
  const markers = useProject((p) => p.markers || []);
  // DOM order by id, not time: a marker dragged past another must not be re-inserted (that would drop pointer capture).
  const markerViews = useMemo(() => [...markers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), [markers]);
  const media = useProject((p) => p.media);
  const fps = useProject((p) => p.settings.fps || 30);
  const zoom = useUI((s) => clampZoom(s.zoom));
  const snapping = useUI((s) => s.snapping);
  const selection = useUI((s) => s.selection);
  useUI((s) => s.binSelection);

  const [bodyRef, bodySize] = useElementSize();
  const scrollRef = useRef(null);
  const rulerRef = useRef(null);
  const rulerTrackRef = useRef(null);
  const playheadRef = useRef(null);
  const headRef = useRef(null);
  const anchorRef = useRef(null);
  const autoFit = useRef(Math.abs(clampZoom(uiStore.get().zoom) - DEFAULT_ZOOM) < 1e-6);
  const dragRef = useRef(false);
  const paintQueued = useRef(false);

  const [mode, setMode] = useState(null); // {type:'reorder', ids} | {type:'trim', rippleFrom, shift} | {type:'move', track} | {type:'drop', audio}
  const [settling, setSettling] = useState(false);
  const [popover, setPopover] = useState(null); // {clipId, mode, anchor}
  const closePopover = useMemo(() => () => setPopover(null), []);
  const overlay = useMemo(() => createStore(null), []);
  const viewport = useMemo(() => createStore({ left: 0, width: 0 }), []);

  const tight = narrow || (bodySize.width > 0 && bodySize.width < TIGHT_W);
  // labels and zoom slider by the toolbar's own width (= the timeline's), not by the Edit view's layout
  const tb = toolbarLayout(bodySize.width || (narrow ? 480 : 1000));
  const HEADER = tight ? 46 : 74;
  const dims = narrow ? { textH: 26, videoH: 56, audioH: 40 } : { textH: 30, videoH: 66, audioH: 46 };
  const lay = useMemo(() => M.layoutProject({ tracks }), [tracks]);
  const counts = laneCounts({ tracks });
  const extraAudio = (mode?.type === 'move' && mode.track === 'audio') || (mode?.type === 'drop' && mode.audio) ? 1 : 0;
  const geo = useMemo(() => trackGeometry(counts, { ...dims, extraAudio }), [counts.text, counts.audio, narrow, extraAudio]);
  const empty = !tracks.video.length && !tracks.audio.length && !tracks.text.length;

  const viewW = bodySize.width;
  const lanesW = Math.max(0, viewW - HEADER);
  const contentSec = Math.max(lay.duration + Math.max(6, (lanesW * 0.35) / zoom), lanesW / zoom);
  const contentW = Math.ceil(contentSec * zoom);
  const selSet = useMemo(() => new Set(selection), [selection]);

  const live = useRef({});
  live.current = { zoom, lay, tracks, geo, snapping, HEADER, fps, media, contentW };

  // ------------------------------------------------------------------ geometry helpers

  const timeAtClientX = (clientX) => {
    const sc = scrollRef.current;
    const r = sc.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - live.current.HEADER + sc.scrollLeft) / live.current.zoom);
  };
  const yInTracks = (clientY) => {
    const sc = scrollRef.current;
    const r = sc.getBoundingClientRect();
    return clientY - r.top + sc.scrollTop;
  };
  const edgeScroll = (clientX) => {
    const sc = scrollRef.current;
    const r = sc.getBoundingClientRect();
    const left = r.left + live.current.HEADER;
    if (clientX < left + 28) sc.scrollLeft -= Math.ceil((left + 28 - clientX) / 2.5);
    else if (clientX > r.right - 28) sc.scrollLeft += Math.ceil((clientX - (r.right - 28)) / 2.5);
  };

  const paint = () => {
    paintQueued.current = false;
    const c = rulerRef.current;
    const sc = scrollRef.current;
    if (!c || !sc) return;
    const L = live.current;
    paintRuler(c, { width: Math.max(1, sc.clientWidth - L.HEADER), height: RULER_H, zoom: L.zoom, scrollLeft: sc.scrollLeft, duration: L.lay.duration });
  };
  const schedulePaint = () => {
    if (paintQueued.current) return;
    paintQueued.current = true;
    requestAnimationFrame(paint);
  };
  const syncScroll = () => {
    const sc = scrollRef.current;
    if (!sc) return;
    const vp = { left: sc.scrollLeft, width: Math.max(0, sc.clientWidth - live.current.HEADER) };
    const cur = viewport.get();
    if (cur.left !== vp.left || cur.width !== vp.width) viewport.set(vp);
    if (rulerTrackRef.current) rulerTrackRef.current.style.transform = `translateX(${-sc.scrollLeft}px)`;
    schedulePaint();
  };

  const placePlayhead = (t) => {
    const L = live.current;
    const x = t * L.zoom;
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${L.HEADER + x}px)`;
    if (headRef.current) headRef.current.style.transform = `translateX(${x}px)`;
  };
  const follow = (t) => {
    const sc = scrollRef.current;
    if (!sc || dragRef.current) return;
    const L = live.current;
    const x = t * L.zoom;
    const w = sc.clientWidth - L.HEADER;
    if (w <= 0) return;
    if (x > sc.scrollLeft + w - 20 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - Math.min(80, w * 0.12));
  };

  useEffect(() => session.onTime((t) => (placePlayhead(t), follow(t))), [session]);
  useLayoutEffect(() => {
    placePlayhead(session.time());
    syncScroll();
  });

  // ------------------------------------------------------------------ zoom

  const setZoom = (z, anchorT = null, anchorX = null) => {
    const sc = scrollRef.current;
    const L = live.current;
    const nz = clampZoom(z);
    autoFit.current = false;
    if (!sc || Math.abs(nz - L.zoom) < 1e-6) return;
    if (anchorT == null) {
      const t = session.time();
      const x = t * L.zoom - sc.scrollLeft;
      if (x >= 0 && x <= sc.clientWidth - L.HEADER) {
        anchorT = t;
        anchorX = x;
      } else {
        anchorX = (sc.clientWidth - L.HEADER) / 2;
        anchorT = (sc.scrollLeft + anchorX) / L.zoom;
      }
    }
    anchorRef.current = { t: anchorT, x: anchorX };
    uiStore.set((s) => ({ ...s, zoom: nz }));
  };
  const fit = () => {
    const sc = scrollRef.current;
    if (!sc) return;
    const L = live.current;
    const z = fitZoom(L.lay.duration || 10, sc.clientWidth - L.HEADER);
    if (Math.abs(z - L.zoom) < 1e-6) {
      sc.scrollLeft = 0;
      return;
    }
    anchorRef.current = { t: 0, x: 0 };
    uiStore.set((s) => ({ ...s, zoom: z }));
  };
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a || !scrollRef.current) return;
    anchorRef.current = null;
    scrollRef.current.scrollLeft = anchoredScroll(a.t, zoom, a.x);
    syncScroll();
  }, [zoom]);

  useEffect(() => {
    const offs = [
      session.on('zoom', ({ dir }) => setZoom(stepZoom(live.current.zoom, dir))),
      session.on('fit', () => fit()),
      session.on('transition', ({ clipId }) => openTransition(clipId)),
      session.on('reveal', ({ clipId }) => {
        requestAnimationFrame(() => {
          const L = live.current;
          const it = [...L.lay.video, ...L.lay.audio, ...L.lay.text].find((x) => x.clip.id === clipId);
          const sc = scrollRef.current;
          if (!it || !sc) return;
          const w = sc.clientWidth - L.HEADER;
          const x0 = it.start * L.zoom;
          const x1 = it.end * L.zoom;
          if (x0 < sc.scrollLeft || x1 > sc.scrollLeft + w) sc.scrollLeft = Math.max(0, (x0 + x1) / 2 - w / 2);
          const el = sc.querySelector(`[data-clip-id="${clipId}"]`);
          el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        });
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [session]);

  // Auto-fit: until the user zooms by hand (and only if the zoom was never customised), keep the whole sequence in
  // view when the timeline is resized; and fit whenever the sequence goes from empty to having content.
  const hadContent = useRef(null);
  useEffect(() => {
    if (viewW <= 0) return;
    const L = live.current;
    if (autoFit.current && L.lay.duration > 0 && L.lay.duration * L.zoom > lanesW - 24) requestAnimationFrame(fit);
  }, [viewW]);
  useEffect(() => {
    if (viewW <= 0) return;
    const has = lay.duration > 0;
    if (hadContent.current === false && has) requestAnimationFrame(fit);
    hadContent.current = has;
  }, [lay.duration > 0, viewW > 0]);

  // Wheel: ctrl/cmd zooms around the cursor; vertical wheel scrolls horizontally when there's nothing to scroll vertically.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      const sc = scrollRef.current;
      if (!sc) return;
      const L = live.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = sc.getBoundingClientRect();
        const x = clamp(e.clientX - r.left - L.HEADER, 0, sc.clientWidth - L.HEADER);
        const t = (sc.scrollLeft + x) / L.zoom;
        const factor = Math.exp(-clamp(e.deltaY, -120, 120) * 0.0025);
        setZoom(L.zoom * factor, t, x);
        return;
      }
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey && sc.scrollHeight <= sc.clientHeight + 1) {
        e.preventDefault();
        sc.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ------------------------------------------------------------------ transitions popover

  const openTransition = (clipId, anchorEl = null) => {
    const el = anchorEl || bodyRef.current?.querySelector(`[data-tr-for="${clipId}"]`);
    const r = el?.getBoundingClientRect() || bodyRef.current?.getBoundingClientRect();
    if (!r) return;
    setPopover({ clipId, mode: 'one', anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
  };

  // ------------------------------------------------------------------ gestures

  const startReorder = (e, clip, additive) => {
    beginGesture(e, {
      threshold: 4,
      onClick: () => A.clickSelect(clip.id, additive),
      onStart: () => {
        const L = live.current;
        let sel = A.getSelection();
        if (!sel.includes(clip.id)) {
          sel = additive ? [...sel, clip.id] : [clip.id];
          A.setSelection(sel);
        }
        const ids = new Set(L.tracks.video.filter((c) => sel.includes(c.id)).map((c) => c.id));
        const item = L.lay.video.find((it) => it.clip.id === clip.id);
        if (!item) return false;
        const sc = scrollRef.current;
        const r = sc.getBoundingClientRect();
        const grab = clamp(e.clientX - (r.left + L.HEADER - sc.scrollLeft + item.start * L.zoom), 0, 120);
        const width = ids.size > 1 ? 150 : clamp(item.duration * L.zoom, 40, 260);
        const label = ids.size > 1 ? `${ids.size} clips` : clip.label || L.media[clip.mediaId]?.name || 'Clip';
        dragRef.current = true;
        setMode({ type: 'reorder', ids });
        return { ids, grab: Math.min(grab, width - 10), width, label, target: null };
      },
      onMove: ({ ev, ctx }) => {
        edgeScroll(ev.clientX);
        const L = live.current;
        const target = reorderTarget(L.lay.video, ctx.ids, timeAtClientX(ev.clientX));
        ctx.target = target;
        const sc = scrollRef.current;
        const r = sc.getBoundingClientRect();
        const x = ev.clientX - r.left - L.HEADER + sc.scrollLeft - ctx.grab;
        overlay.set(() => ({ ghost: { x, w: ctx.width, label: ctx.label }, insertAt: target.noop ? null : target.time }));
      },
      onEnd: ({ ctx, cancelled }) => {
        dragRef.current = false;
        overlay.set(() => null);
        setMode(null);
        if (cancelled || !ctx?.target || ctx.target.noop) return;
        projectStore.update((p) => Ops.moveVideoClips(p, [...ctx.ids], ctx.target.toIndex), { label: ctx.ids.size > 1 ? 'Move clips' : 'Move clip' });
      },
    });
  };

  const startFreeMove = (e, clip, track, additive) => {
    const scroll0 = scrollRef.current?.scrollLeft || 0;
    beginGesture(e, {
      threshold: 3,
      onClick: () => A.clickSelect(clip.id, additive),
      onStart: () => {
        const L = live.current;
        let sel = A.getSelection();
        if (!sel.includes(clip.id)) {
          sel = additive ? [...sel, clip.id] : [clip.id];
          A.setSelection(sel);
        }
        const moving = L.tracks[track].filter((c) => sel.includes(c.id)).map((c) => ({ id: c.id, start: c.start, lane: Math.floor(c.lane || 0) }));
        const dur = track === 'audio' ? M.audioClipDuration(clip) : clip.duration;
        dragRef.current = true;
        setMode({ type: 'move', track });
        return {
          moving,
          dur,
          origStart: clip.start,
          grabLane: Math.floor(clip.lane || 0),
          points: snapCandidates(projectStore.get(), moving.map((m) => m.id), [session.time()]),
          merge: `move:${clip.id}:${Date.now()}`,
          minStart: Math.min(...moving.map((m) => m.start)),
          minLane: Math.min(...moving.map((m) => m.lane)),
        };
      },
      onMove: ({ dx, ev, ctx }) => {
        edgeScroll(ev.clientX);
        const L = live.current;
        // pointer travel in timeline pixels: screen travel plus whatever edge auto-scroll moved the view meanwhile
        const travel = dx + (scrollRef.current.scrollLeft - scroll0);
        let delta = Math.max(travel / L.zoom, -ctx.minStart);
        let snap = null;
        if (L.snapping && !ev.altKey) {
          const s = snapMove(ctx.origStart + delta, ctx.dur, ctx.points, SNAP_PX / L.zoom);
          if (s.snapped) {
            delta = Math.max(s.start - ctx.origStart, -ctx.minStart);
            snap = s.point;
          }
        }
        const lane = laneAt(L.geo, track, yInTracks(ev.clientY));
        const laneDelta = Math.max(lane - ctx.grabLane, -ctx.minLane);
        projectStore.update(
          (p) => {
            let q = p;
            for (const m of ctx.moving) {
              const start = Math.max(0, m.start + delta);
              const ln = clamp(m.lane + laneDelta, 0, 15);
              q = track === 'audio' ? M.moveAudioClip(q, m.id, start, ln) : M.updateClip(q, m.id, { start, lane: ln });
            }
            return q;
          },
          { label: track === 'audio' ? 'Move audio' : 'Move text', merge: ctx.merge },
        );
        overlay.set(() => ({ snap, hint: { x: ev.clientX, y: ev.clientY, text: formatTime(ctx.origStart + delta) } }));
      },
      onEnd: () => {
        dragRef.current = false;
        overlay.set(() => null);
        setMode(null);
      },
    });
  };

  const onClipDown = (e, clip, track) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (track === 'video') startReorder(e, clip, additive);
    else startFreeMove(e, clip, track, additive);
  };

  const onTrimDown = (e, clip, track, edge) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const scroll0 = scrollRef.current?.scrollLeft || 0;
    beginGesture(e, {
      threshold: 1,
      onStart: () => {
        const L = live.current;
        if (!A.getSelection().includes(clip.id)) A.setSelection([clip.id]);
        if (session.isPlaying()) session.pause();
        const p = projectStore.get();
        const ctx = { merge: `trim:${clip.id}:${edge}:${Date.now()}`, orig: { ...clip }, held: session.time() };
        if (track === 'video') {
          const item = L.lay.video.find((it) => it.clip.id === clip.id);
          if (!item) return false;
          ctx.item = item;
          // Later main-track boundaries ripple with the trim, so only earlier ones are snap targets.
          const before = L.lay.video.slice(0, item.index).flatMap((it) => [it.start, it.end]);
          ctx.points = [...before, ...snapCandidates({ ...p, tracks: { ...p.tracks, video: [] } }, [], [ctx.held])];
        } else {
          ctx.points = snapCandidates(p, [clip.id], [ctx.held]);
        }
        dragRef.current = true;
        setMode({ type: 'trim', clipId: clip.id, rippleFrom: null, shift: 0 });
        return ctx;
      },
      onMove: ({ dx: screenDx, ev, ctx }) => {
        edgeScroll(ev.clientX);
        const L = live.current;
        const z = L.zoom;
        const dx = screenDx + (scrollRef.current.scrollLeft - scroll0); // include edge auto-scroll
        const snapOn = L.snapping && !ev.altKey;
        const snapAt = (T) => {
          if (!snapOn) return { T, snap: null };
          const s = M.snapTime(T, ctx.points, SNAP_PX / z);
          return s.snapped ? { T: s.time, snap: s.point } : { T, snap: null };
        };
        const c = ctx.orig;
        let snap = null;
        let text = '';
        if (track === 'video') {
          const speed = c.speed || 1;
          // Both edges snap where they are drawn during the drag: the out edge ripples the clips after it, the in
          // edge moves right/left while the later clips hold still until release (see `shift`).
          const r = snapAt((edge === 'out' ? ctx.item.end : ctx.item.start) + dx / z);
          snap = r.snap;
          // out: T is the new end -> new out point; in: T is the new (drawn) left edge -> new in point. Same formula.
          const src = c.in + (r.T - ctx.item.start) * speed;
          projectStore.update((p) => M.trimVideoClip(p, clip.id, edge, src), { label: 'Trim clip', merge: ctx.merge });
          const it2 = M.layoutVideo(projectStore.get().tracks.video).find((it) => it.clip.id === clip.id);
          if (it2) {
            const shift = edge === 'in' ? ((it2.clip.in - c.in) / speed) * z : 0;
            session.seek(edge === 'in' ? it2.start : Math.max(it2.start, it2.end - 1 / (L.fps || 30)));
            text = `${edge === 'in' ? `In ${formatTime(it2.clip.in)}` : `Out ${formatTime(it2.clip.out)}`} · ${formatDuration(it2.duration)}`;
            if (edge === 'in') setMode({ type: 'trim', clipId: clip.id, rippleFrom: it2.index, shift });
          }
        } else if (track === 'audio') {
          const r = snapAt((edge === 'in' ? c.start : c.start + M.audioClipDuration(c)) + dx / z);
          snap = r.snap;
          // Extending the start stops where the source runs out or at 0 (past that the sound would slip out of sync).
          let T = r.T;
          if (edge === 'in' && T < Ops.audioTrimFloor(c)) {
            T = Ops.audioTrimFloor(c);
            snap = null;
          }
          projectStore.update((p) => M.trimAudioClip(p, clip.id, edge, T), { label: 'Trim audio', merge: ctx.merge });
          const nc = M.findClip(projectStore.get(), clip.id)?.clip;
          if (nc) text = `${edge === 'in' ? 'Start' : 'End'} ${formatTime(edge === 'in' ? nc.start : nc.start + M.audioClipDuration(nc))} · ${formatDuration(M.audioClipDuration(nc))}`;
        } else {
          const r = snapAt((edge === 'in' ? c.start : c.start + c.duration) + dx / z);
          snap = r.snap;
          projectStore.update((p) => Ops.trimTextTo(p, clip.id, edge, r.T, c), { label: 'Trim text', merge: ctx.merge });
          const nc = M.findClip(projectStore.get(), clip.id)?.clip;
          if (nc) text = `${edge === 'in' ? 'Start' : 'End'} ${formatTime(edge === 'in' ? nc.start : nc.start + nc.duration)} · ${formatDuration(nc.duration)}`;
        }
        overlay.set(() => ({ snap, hint: text ? { x: ev.clientX, y: ev.clientY, text } : null }));
      },
      onEnd: ({ ctx }) => {
        dragRef.current = false;
        overlay.set(() => null);
        if (track === 'video' && edge === 'in') {
          setSettling(true);
          setTimeout(() => setSettling(false), 240);
        }
        setMode(null);
        if (track === 'video' && ctx) session.seek(Math.min(ctx.held, session.duration()));
      },
    });
  };

  const onFadeDown = (e, clip, track, which) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    beginGesture(e, {
      threshold: 1,
      onStart: () => {
        dragRef.current = true;
        return { orig: clip[which] || 0, dur: track === 'video' ? M.clipDuration(clip) : M.audioClipDuration(clip), merge: `fade:${clip.id}:${which}:${Date.now()}` };
      },
      onMove: ({ dx, ev, ctx }) => {
        const z = live.current.zoom;
        const v = Math.round(clamp(ctx.orig + (which === 'fadeIn' ? dx : -dx) / z, 0, ctx.dur) * 100) / 100;
        projectStore.update((p) => M.updateClip(p, clip.id, { [which]: v }), { label: which === 'fadeIn' ? 'Fade in' : 'Fade out', merge: ctx.merge });
        overlay.set(() => ({ hint: { x: ev.clientX, y: ev.clientY, text: `${which === 'fadeIn' ? 'Fade in' : 'Fade out'} ${v.toFixed(2)}s` } }));
      },
      onEnd: () => {
        dragRef.current = false;
        overlay.set(() => null);
      },
    });
  };

  const onRulerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (session.isPlaying()) session.pause();
    const points = editPoints(projectStore.get());
    const seekAt = (clientX, alt) => {
      const L = live.current;
      let t = timeAtClientX(clientX);
      if (L.snapping && !alt) {
        const s = M.snapTime(t, points, SNAP_PX / L.zoom);
        if (s.snapped) t = s.time;
      }
      session.seek(t);
    };
    seekAt(e.clientX, e.altKey);
    dragRef.current = true;
    beginGesture(e, {
      threshold: 0,
      onMove: ({ ev }) => {
        edgeScroll(ev.clientX);
        seekAt(ev.clientX, ev.altKey);
      },
      onEnd: () => (dragRef.current = false),
      onClick: () => (dragRef.current = false),
    });
  };

  const onRowDown = (e) => {
    if (e.button !== 0) return;
    if (!(e.shiftKey || e.ctrlKey || e.metaKey)) A.clearSelection();
  };

  // ------------------------------------------------------------------ menus

  const clipMenu = (e, clip, track) => {
    e.preventDefault();
    e.stopPropagation();
    if (!A.getSelection().includes(clip.id)) A.setSelection([clip.id]);
    const p = projectStore.get();
    const L = live.current;
    const t = session.time();
    const items = [];
    const it = [...L.lay.video, ...L.lay.audio, ...L.lay.text].find((x) => x.clip.id === clip.id);
    const inside = !!it && t > it.start + 0.05 && t < it.end - 0.05;
    items.push({ label: 'Split at playhead', icon: 'scissors', shortcut: 's', disabled: !inside, onClick: () => A.splitAtPlayhead(session) });
    items.push({ label: 'Trim start to playhead', icon: 'mark-in', shortcut: 'q', disabled: !inside, onClick: () => A.trimToPlayhead(session, 'in') });
    items.push({ label: 'Trim end to playhead', icon: 'mark-out', shortcut: 'w', disabled: !inside, onClick: () => A.trimToPlayhead(session, 'out') });
    items.push('-');
    if (track === 'video') {
      const m = p.media[clip.mediaId];
      const first = it?.index === 0;
      items.push({
        label: first ? 'Transition (needs a clip before)' : clip.transition ? 'Change transition…' : 'Add transition…',
        icon: 'transition',
        disabled: first,
        onClick: () => openTransition(clip.id),
      });
      if (clip.transition) items.push({ label: 'Remove transition', icon: 'x', onClick: () => projectStore.update((q) => M.setTransition(q, clip.id, null), { label: 'Remove transition' }) });
      items.push({ label: 'Detach audio', icon: 'music', disabled: !Ops.canDetachAudio(p, clip), onClick: () => A.detachAudio(clip.id) });
      if (m?.kind === 'video') {
        items.push({
          label: clip.muted ? 'Unmute clip' : 'Mute clip',
          icon: clip.muted ? 'volume' : 'volume-x',
          onClick: () => projectStore.update((q) => M.updateClip(q, clip.id, { muted: !clip.muted }), { label: clip.muted ? 'Unmute clip' : 'Mute clip' }),
        });
      }
      items.push('-');
      items.push({
        label: 'Grab frame to bin',
        icon: 'camera',
        onClick: () => {
          if (!inside && it) session.seek(it.start + Math.min(it.duration / 2, 0.5));
          A.grabFrame(session, 'bin');
        },
      });
      items.push({ label: 'Reveal in bin', icon: 'search', onClick: () => A.revealInBin(clip.mediaId, session) });
      items.push({ label: 'Open in source monitor', icon: 'eye', onClick: () => A.openInSource(clip.mediaId) });
    } else if (track === 'audio') {
      items.push({ label: 'Fit audio to video end', icon: 'arrow-right', onClick: () => A.fitAudioToVideoEnd() });
      items.push({ label: 'Reveal in bin', icon: 'search', onClick: () => A.revealInBin(clip.mediaId, session) });
    } else {
      items.push({ label: 'Edit text', icon: 'edit', onClick: () => editText(clip.id) });
    }
    if (it) {
      items.push({
        label: 'Loop this clip',
        icon: 'repeat',
        onClick: () => {
          session.loopRange({ start: it.start, end: it.end });
          session.seek(it.start);
          session.play();
        },
      });
    }
    items.push('-');
    items.push({ label: 'Duplicate', icon: 'copy', shortcut: 'mod+d', onClick: () => A.duplicateSelection() });
    items.push({ label: 'Copy', icon: 'copy', shortcut: 'mod+c', onClick: () => A.copySelection() });
    items.push({ label: 'Delete', icon: 'trash', shortcut: 'delete', danger: true, onClick: () => A.deleteSelection() });
    showMenu(e, items);
  };

  const rowMenu = (e, row) => {
    e.preventDefault();
    const t = timeAtClientX(e.clientX);
    const items = [
      { label: 'Paste here', icon: 'copy', shortcut: 'mod+v', disabled: !A.hasClipboard(), onClick: () => A.pasteAt(t) },
      { label: 'Add text here', icon: 'type', onClick: () => A.addTextAt(session, t) },
      { label: 'Add marker here', icon: 'marker', onClick: () => A.addMarkerAt(t) },
    ];
    if (row?.kind === 'audio') {
      items.push('-', { label: 'Add audio file…', icon: 'upload', onClick: () => (session.seek(t), A.addAudioFromFiles(session)) });
      items.push({ label: 'Add audio from a link…', icon: 'link', onClick: () => (session.seek(t), A.addAudioFromUrl(session)) });
    }
    items.push('-', { label: 'Select all', icon: 'check', shortcut: 'mod+a', onClick: () => A.selectAll() });
    showMenu(e, items);
  };

  const editText = (id) => {
    A.setSelection([id]);
    uiStore.set((s) => (s.inspectorOpen ? s : { ...s, inspectorOpen: true }));
    session.emit('showInspector', {});
    session.requestTextFocus(id);
  };

  const openInspector = () => {
    uiStore.set((s) => (s.inspectorOpen ? s : { ...s, inspectorOpen: true }));
    session.emit('showInspector', {});
  };

  /** Marker: click = go to it, drag = move it (snaps to cuts, other markers and the playhead; one undo step). */
  const onMarkerDown = (e, m) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    e.preventDefault();
    const scroll0 = scrollRef.current?.scrollLeft || 0;
    beginGesture(e, {
      threshold: 3,
      onClick: () => session.seek(m.time),
      onStart: () => {
        dragRef.current = true;
        const p = projectStore.get();
        const others = { ...p, markers: (p.markers || []).filter((x) => x.id !== m.id) };
        return { merge: `marker:${m.id}:${Date.now()}`, points: snapCandidates(others, [], [session.time()]) };
      },
      onMove: ({ dx, ev, ctx }) => {
        edgeScroll(ev.clientX);
        const L = live.current;
        let t = Math.max(0, m.time + (dx + scrollRef.current.scrollLeft - scroll0) / L.zoom);
        let snap = null;
        if (L.snapping && !ev.altKey) {
          const s = M.snapTime(t, ctx.points, SNAP_PX / L.zoom);
          if (s.snapped) {
            t = s.time;
            snap = s.point;
          }
        }
        A.moveMarker(m.id, t, ctx.merge);
        overlay.set(() => ({ snap, hint: { x: ev.clientX, y: ev.clientY, text: `${m.label || 'Marker'} · ${formatTime(t)}` } }));
      },
      onEnd: () => {
        dragRef.current = false;
        overlay.set(() => null);
      },
    });
  };

  const markerMenu = (e, m) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e, [
      { label: 'Go to marker', icon: 'arrow-right', onClick: () => session.seek(m.time) },
      { label: 'Rename…', icon: 'edit', onClick: () => renameMarkerDialog(m) },
      { label: 'Delete marker', icon: 'trash', danger: true, onClick: () => A.removeMarker(m.id) },
    ]);
  };
  const renameMarkerDialog = async (m) => {
    const label = await promptDialog({ title: 'Marker label', value: m.label || '', placeholder: 'e.g. Beat drop', confirmLabel: 'Save' });
    if (label != null) A.renameMarker(m.id, label.trim());
  };

  const audioMenu = (e) => {
    const p = projectStore.get();
    const bin = p.mediaOrder.map((id) => p.media[id]).filter((m) => m && m.kind === 'audio' && m.status !== 'error');
    showMenu(e, [
      { header: 'Add audio at the playhead' },
      { label: 'From a file…', icon: 'upload', onClick: () => A.addAudioFromFiles(session) },
      { label: 'From a link (URL)…', icon: 'link', onClick: () => A.addAudioFromUrl(session) },
      ...(bin.length ? ['-', { header: 'From the bin' }, ...bin.slice(0, 8).map((m) => ({ label: m.name, icon: 'music', onClick: () => A.placeAsAudio([m.id], session.time()) }))] : []),
      '-',
      { label: 'Fit audio to video end', icon: 'arrow-right', disabled: !p.tracks.audio.length, onClick: () => A.fitAudioToVideoEnd() },
    ]);
  };

  // ------------------------------------------------------------------ drag & drop from the bin / OS

  const dropTarget = (e) => {
    const L = live.current;
    const t = timeAtClientX(e.clientX);
    const row = rowAt(L.geo, yInTracks(e.clientY));
    const audio = row?.kind === 'audio';
    let at = t;
    if (L.snapping) {
      const s = M.snapTime(t, snapCandidates(projectStore.get(), [], [session.time()]), SNAP_PX / L.zoom);
      if (s.snapped) at = s.time;
    }
    const index = M.insertionIndexAt(L.lay.video, t);
    const boundary = index < L.lay.video.length ? L.lay.video[index].start : L.lay.videoEnd;
    return { t, at, row, audio, boundary };
  };
  const acceptsDrag = (e) => {
    const types = [...(e.dataTransfer?.types || [])];
    return types.includes(A.MEDIA_DRAG_TYPE) || types.includes('Files');
  };
  const onDragOver = (e) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const d = dropTarget(e);
    if (mode?.type !== 'drop' || mode.audio !== d.audio) setMode({ type: 'drop', audio: d.audio });
    const next = d.audio ? { dropAudioAt: d.at, dropLane: d.row.lane } : { insertAt: d.boundary };
    const cur = overlay.get();
    if (!cur || cur.insertAt !== next.insertAt || cur.dropAudioAt !== next.dropAudioAt || cur.dropLane !== next.dropLane) overlay.set(() => next);
  };
  const clearDrop = () => {
    overlay.set(() => null);
    if (mode?.type === 'drop') setMode(null);
  };
  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) clearDrop();
  };
  const onDrop = (e) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    const d = dropTarget(e);
    clearDrop();
    const opts = { time: d.t, audioTime: d.at, audioLane: d.audio ? d.row.lane : null };
    const raw = e.dataTransfer.getData(A.MEDIA_DRAG_TYPE);
    if (raw) {
      let ids = [];
      try {
        ids = JSON.parse(raw);
      } catch {
        ids = [];
      }
      if (!Array.isArray(ids)) ids = [ids];
      const p = projectStore.get();
      ids = ids.filter((id) => typeof id === 'string' && p.media[id]);
      if (ids.length) A.placeMedia(ids, opts);
      return;
    }
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) A.importAndPlace(files, opts);
  };

  // ------------------------------------------------------------------ render

  const shiftFor = (index) => (mode?.type === 'trim' && mode.rippleFrom != null && index >= mode.rippleFrom ? mode.shift : 0);
  const vRow = geo.rows.find((r) => r.kind === 'video');
  const pad = 3;
  const textTop = (lane) => geo.laneTop('text', lane) + 3;
  const audioTop = (lane) => geo.laneTop('audio', lane) + 3;
  const addable = empty ? A.clipsToAdd() : null;
  const binCount = useProject((p) => p.mediaOrder.length);

  const toolbar = html`<div class="tl-toolbar">
    <div class="tl-tools">
      <${IconButton} icon="scissors" size="sm" title="Split at playhead (S)" onClick=${() => A.splitAtPlayhead(session)} />
      <${IconButton} icon="trash" size="sm" kind="danger" title="Delete selected (Del)" disabled=${!selection.length} onClick=${() => A.deleteSelection()} />
      <${IconButton} icon="copy" size="sm" title="Duplicate selected (Ctrl+D)" disabled=${!selection.length} onClick=${() => A.duplicateSelection()} />
      <span class="tl-sep"></span>
      <${Button} size="sm" kind="ghost" icon="type" class="tl-tool-btn" title="Add a title at the playhead (T)" onClick=${() => A.addTextAt(session, session.time())}>${tb.text && 'Text'}<//>
      <${Button} size="sm" kind="ghost" icon="music" class="tl-tool-btn" title="Add music or sound (file, link or bin)" onClick=${audioMenu}>${tb.audio && 'Audio'}<//>
      <${IconButton} icon="marker" size="sm" title="Add a marker at the playhead (M)" onClick=${() => A.addMarkerAt(session.time())} />
      <${Button}
        size="sm"
        kind="ghost"
        icon="transition"
        class="tl-tool-btn"
        title="Put one transition on every cut"
        disabled=${tracks.video.length < 2}
        onClick=${(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPopover({ clipId: null, mode: 'all', anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
        }}
        >${tb.transitions && 'Transitions'}<//
      >
    </div>
    <span class="spacer"></span>
    <div class="tl-zoom">
      <${IconButton}
        icon="magnet"
        size="sm"
        title=${snapping ? 'Snapping on (hold Alt to bypass)' : 'Snapping off'}
        active=${snapping}
        onClick=${() => uiStore.set((s) => ({ ...s, snapping: !s.snapping }))}
      />
      <${IconButton} icon="zoom-out" size="sm" title="Zoom out (-)" onClick=${() => setZoom(stepZoom(zoom, -1))} />
      ${tb.slider !== 'none' &&
      html`<input
        type="range"
        class=${cx('tl-zoom-slider', tb.slider === 'small' && 'is-small')}
        min="0"
        max="1000"
        step="1"
        value=${zoomToSlider(zoom)}
        aria-label="Timeline zoom"
        title="Zoom (Ctrl + mouse wheel)"
        style=${`--pct:${zoomToSlider(zoom) / 10}%`}
        onInput=${(e) => setZoom(sliderToZoom(Number(e.currentTarget.value)))}
      />`}
      <${IconButton} icon="zoom-in" size="sm" title="Zoom in (+)" onClick=${() => setZoom(stepZoom(zoom, 1))} />
      <${IconButton} icon="maximize" size="sm" title="Fit the sequence (\\)" onClick=${fit} />
    </div>
  </div>`;

  return html`<div class=${cx('tl', tight && 'is-narrow')}>
    ${toolbar}
    <div class=${cx('tl-body', mode?.type === 'drop' && 'is-dropping')} ref=${bodyRef} onDragOver=${onDragOver} onDragLeave=${onDragLeave} onDrop=${onDrop}>
      <div class="tl-ruler-row" style=${`height:${RULER_H}px`}>
        <div class="tl-corner" style=${`width:${HEADER}px`} title=${`Sequence ${formatTime(lay.duration)}`}>
          <span class="mono">${formatDuration(lay.duration)}</span>
        </div>
        <div class="tl-ruler" style=${`left:${HEADER}px`} onPointerDown=${onRulerDown}>
          <canvas ref=${rulerRef} class="tl-ruler-canvas"></canvas>
          <div class="tl-ruler-track" ref=${rulerTrackRef}>
            ${markerViews.map(
              (m) => html`<button
                type="button"
                key=${m.id}
                class="tl-marker"
                style=${`left:${m.time * zoom}px;--mk:${m.color || '#ffd166'}`}
                title=${`${m.label || 'Marker'} · ${formatTime(m.time)} — click to go there, drag to move, double-click to rename`}
                onPointerDown=${(e) => onMarkerDown(e, m)}
                onDblClick=${() => renameMarkerDialog(m)}
                onContextMenu=${(e) => markerMenu(e, m)}
              >
                ${m.label && zoom > 20 && html`<span class="tl-marker-label">${m.label}</span>`}
              </button>`,
            )}
            <div class="tl-head" ref=${headRef}></div>
          </div>
        </div>
      </div>
      <div class="tl-scroll" ref=${scrollRef} style=${`top:${RULER_H}px`} onScroll=${syncScroll}>
        <div class="tl-content" style=${`width:${HEADER + contentW}px;height:${geo.height + 10}px`}>
          ${geo.rows.map(
            (r) => html`<div
              key=${`${r.kind}${r.lane}`}
              class=${cx('tl-row', `tl-row-${r.kind}`, r.extra && 'is-extra')}
              style=${`top:${r.top}px;height:${r.height}px`}
              data-kind=${r.kind}
              data-lane=${r.lane}
              onPointerDown=${onRowDown}
              onContextMenu=${(e) => rowMenu(e, r)}
            >
              <div class="tl-row-head" style=${`width:${HEADER}px`} title=${r.kind === 'video' ? 'Main track — clips play back to back' : r.kind === 'text' ? 'Titles & captions' : 'Music, voice & sound'}>
                <${Icon} name=${rowIcon(r.kind)} size=${tight ? 12 : 13} />
                <span>${r.extra ? 'New' : r.label}</span>
              </div>
            </div>`,
          )}
          <div class="tl-end" style=${`left:${HEADER + lay.duration * zoom}px`}></div>
          <div class=${cx('tl-layer', settling && 'is-settling')} style=${`left:${HEADER}px;width:${contentW}px;height:${geo.height}px`}>
            ${lay.text.map(
              (it) => html`<${TextClipView}
                key=${it.clip.id}
                item=${it}
                zoom=${zoom}
                top=${textTop(Math.floor(it.clip.lane || 0))}
                height=${dims.textH - 6}
                selected=${selSet.has(it.clip.id)}
                onPointerDown=${(e) => onClipDown(e, it.clip, 'text')}
                onContextMenu=${(e) => clipMenu(e, it.clip, 'text')}
                onTrimDown=${(e, edge) => onTrimDown(e, it.clip, 'text', edge)}
                onDblClick=${() => editText(it.clip.id)}
              />`,
            )}
            ${lay.video.map(
              (it) => html`<${VideoClipView}
                key=${it.clip.id}
                item=${it}
                media=${media[it.clip.mediaId]}
                zoom=${zoom}
                top=${vRow.top + pad}
                height=${dims.videoH - pad * 2}
                selected=${selSet.has(it.clip.id)}
                dragging=${mode?.type === 'reorder' && mode.ids.has(it.clip.id)}
                shift=${shiftFor(it.index)}
                onPointerDown=${(e) => onClipDown(e, it.clip, 'video')}
                onContextMenu=${(e) => clipMenu(e, it.clip, 'video')}
                onTrimDown=${(e, edge) => onTrimDown(e, it.clip, 'video', edge)}
                onFadeDown=${(e, which) => onFadeDown(e, it.clip, 'video', which)}
                onDblClick=${openInspector}
              />`,
            )}
            ${lay.video.slice(1).map(
              (it) => html`<${TransitionBadge}
                key=${`tr-${it.clip.id}`}
                item=${it}
                zoom=${zoom}
                top=${vRow.top}
                height=${dims.videoH}
                shift=${shiftFor(it.index)}
                active=${popover?.clipId === it.clip.id}
                onOpen=${(e, id) => openTransition(id, e.currentTarget)}
              />`,
            )}
            ${lay.audio.map(
              (it) => html`<${AudioClipView}
                key=${it.clip.id}
                item=${it}
                media=${media[it.clip.mediaId]}
                zoom=${zoom}
                top=${audioTop(Math.floor(it.clip.lane || 0))}
                height=${dims.audioH - 6}
                selected=${selSet.has(it.clip.id)}
                viewport=${viewport}
                onPointerDown=${(e) => onClipDown(e, it.clip, 'audio')}
                onContextMenu=${(e) => clipMenu(e, it.clip, 'audio')}
                onTrimDown=${(e, edge) => onTrimDown(e, it.clip, 'audio', edge)}
                onFadeDown=${(e, which) => onFadeDown(e, it.clip, 'audio', which)}
                onDblClick=${openInspector}
              />`,
            )}
          </div>
          <${Overlays} store=${overlay} zoom=${zoom} header=${HEADER} geo=${geo} />
          <div class="tl-playhead" ref=${playheadRef}></div>
        </div>
      </div>
      ${empty &&
      html`<div class="tl-empty">
        <div class="tl-empty-card">
          <div class="tl-empty-icon"><${Icon} name="clapper" size=${20} /></div>
          <div class="tl-empty-title">Build your sequence here</div>
          <div class="tl-empty-text">
            Drag clips from the bin — or video, image and audio files from your computer — onto the timeline. Trim by dragging clip edges, split with <${Kbd}>S<//>, and click a cut to add a transition.
          </div>
          <div class="tl-empty-actions">
            ${addable.ids.length
              ? html`<${Button} kind="primary" size="sm" icon="plus" onClick=${() => A.addFromClips()}>
                  ${addable.what === 'picked' ? `Add ${pluralize(addable.ids.length, 'pick')}` : addable.what === 'selected' ? `Add ${addable.ids.length} selected` : `Add all ${pluralize(addable.ids.length, 'clip')}`}
                <//>`
              : html`<${Button} kind="primary" size="sm" icon="film" onClick=${() => uiStore.set((s) => ({ ...s, tab: 'clips' }))}>${binCount ? 'Pick clips' : 'Collect clips from Grok'}<//>`}
            <${Button}
              kind="ghost"
              size="sm"
              icon="upload"
              onClick=${async () => {
                const files = await pickFiles({ accept: 'video/*,image/*,audio/*' });
                if (files.length) A.importAndPlace(files, {});
              }}
              >Import files<//
            >
          </div>
        </div>
      </div>`}
    </div>
    ${popover &&
    html`<${TransitionPopover} key=${`${popover.mode}:${popover.clipId}`} clipId=${popover.clipId} mode=${popover.mode} anchor=${popover.anchor} session=${session} onClose=${closePopover} />`}
  </div>`;
}
