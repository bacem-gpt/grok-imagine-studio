// Transition picker popover: every TRANSITIONS entry grouped by kind (with a tiny animated swatch), a duration
// slider, remove / apply-to-all / preview. Used for one junction (clipId = the clip the transition leads INTO) or,
// with mode 'all', to apply one transition to every cut. 'All' mode shows what the cuts use now ('Mixed' when they
// differ: then no option is highlighted); replacing or removing transitions that were there offers an Undo.

import { html, useEffect, useRef, useState, useLayoutEffect } from '../../../vendor/preact-htm.mjs';
import { projectStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { pluralize } from '../../core/utils.js';
import { useProject } from '../hooks.js';
import { Icon, IconButton, Button, Slider, cx, toast } from '../kit.js';
import { sameTransitions, cutTransitions, transitionSnapshot, replacedTransitions, restoreTransitions } from './edit-ops.js';

/** Applies a transition change unless it changes nothing (clicking the active option records no undo step). */
const changed = (fn) => (p) => {
  const next = fn(p);
  return sameTransitions(p, next) ? p : next;
};

export const TRANSITION_KINDS = [
  { id: 'fade', label: 'Fades' },
  { id: 'wipe', label: 'Wipes' },
  { id: 'slide', label: 'Pushes & whips' },
  { id: 'zoom', label: 'Zoom & spin' },
  { id: 'shape', label: 'Shapes' },
  { id: 'stylized', label: 'Stylized' },
];

export const transitionName = (type) => M.TRANSITIONS.find((t) => t.id === type)?.name || type;

/** Max transition length allowed at a junction: half of the shorter neighbour (model clamps the same way). */
export function maxTransitionAt(project, clipId) {
  const i = project.tracks.video.findIndex((c) => c.id === clipId);
  if (i <= 0) return 0;
  return Math.min(M.clipDuration(project.tracks.video[i - 1]), M.clipDuration(project.tracks.video[i])) / 2;
}

/** Small CSS-animated preview of a transition (A = blue, B = orange). */
export function TransitionSwatch({ type, size = 'md' }) {
  return html`<span class=${cx('tl-trsw', `tl-trsw-${size}`)} data-tr=${type} aria-hidden="true"><span class="tl-trsw-a"></span><span class="tl-trsw-b"></span></span>`;
}

let mergeCounter = 0;

/**
 * Toast for a change that replaced or removed transitions, with an Undo putting `snapshot` back (a plain undo when
 * nothing else changed the project since, else a "Restore transitions" step).
 */
function offerUndo(message, snapshot, after) {
  toast(message, {
    kind: 'info',
    duration: 6000,
    action: {
      label: 'Undo',
      run: () => {
        if (projectStore.get() === after && projectStore.undo()) return;
        projectStore.update((p) => restoreTransitions(p, snapshot), { label: 'Restore transitions' });
      },
    },
  });
}

/**
 * @param {Object} props
 * @param {string|null} props.clipId     clip the transition leads into (null with mode 'all')
 * @param {'one'|'all'} [props.mode]
 * @param {DOMRect|{left, top, bottom, right}} props.anchor  element rect to position against
 * @param {Object} props.session          edit session (for the preview button)
 * @param {() => void} props.onClose
 */
export function TransitionPopover({ clipId, mode = 'one', anchor, session, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const all = mode === 'all';
  const info = useProject((p) => {
    const i = p.tracks.video.findIndex((c) => c.id === clipId);
    const clip = i >= 0 ? p.tracks.video[i] : null;
    return { clip, index: i, count: p.tracks.video.length, max: clip ? maxTransitionAt(p, clipId) : 0 };
  });
  // 'all' mode follows the cuts as they are: hard cuts only, one transition everywhere, or a mix
  const cuts = useProject((p) => {
    if (!all) return null;
    const s = cutTransitions(p);
    return { kind: s.kind, type: s.type, duration: s.duration, count: s.cuts, withTransition: s.withTransition, types: s.types.join(',') };
  });
  // the transitions when the popover opened: what the Undo after replacing / removing some of them puts back
  const opened = useRef(null);
  if (all && !opened.current) opened.current = { snapshot: transitionSnapshot(projectStore.get()), offered: false };
  const merge = useRef(`trdur:${++mergeCounter}`);

  const mixed = all && cuts?.kind === 'mixed';
  const current = all ? (cuts?.kind === 'same' ? { type: cuts.type, duration: cuts.duration } : null) : info?.clip?.transition || null;
  const max = all ? 2 : Math.max(0.1, Math.min(3, info?.max || 0));
  const duration = current ? Math.min(current.duration, max) : Math.min(M.DEFAULT_TRANSITION_DURATION, max);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = (anchor.left + (anchor.right ?? anchor.left)) / 2 - r.width / 2;
    left = Math.max(6, Math.min(left, vw - r.width - 6));
    let top = (anchor.top ?? 0) - r.height - 8;
    if (top < 6) top = Math.min((anchor.bottom ?? anchor.top) + 8, vh - r.height - 6);
    setPos({ left, top: Math.max(6, top) });
  }, [anchor?.left, anchor?.top]);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  useEffect(() => {
    if (mode === 'one' && (!info || !info.clip || info.index <= 0)) onClose();
  }, [info?.clip, info?.index]);

  const apply = (type, dur = duration, { merging = false } = {}) => {
    const tr = type ? { type, duration: dur } : null;
    if (!all) {
      projectStore.update(
        changed((p) => M.setTransition(p, clipId, tr)),
        { label: type ? `Transition: ${transitionName(type)}` : 'Remove transition', merge: merging ? merge.current : null },
      );
      return;
    }
    const before = projectStore.get();
    const after = projectStore.update(
      changed((p) => M.setAllTransitions(p, tr)),
      { label: type ? `${transitionName(type)} on every cut` : 'Remove all transitions', merge: merging ? merge.current : null },
    );
    // the first change that replaces or removes transitions the cuts had offers to put them back (once per popover)
    if (merging || after === before || opened.current.offered) return;
    const n = replacedTransitions(opened.current.snapshot, after);
    if (!n) return;
    opened.current.offered = true;
    offerUndo(type ? `${transitionName(type)} on every cut — replaced ${pluralize(n, 'transition')}` : `Removed ${pluralize(n, 'transition')}`, opened.current.snapshot, after);
  };

  /** "All cuts" (one-junction mode): this junction's transition everywhere. */
  const applyToAll = () => {
    const name = transitionName(current.type);
    const before = projectStore.get();
    const snapshot = transitionSnapshot(before);
    const after = projectStore.update(changed((p) => M.setAllTransitions(p, current)), { label: `${name} on every cut` });
    if (after === before) return toast(`Every cut already uses ${name}`, { kind: 'info' });
    const n = replacedTransitions(snapshot, after);
    if (n) offerUndo(`${name} on every cut — replaced ${pluralize(n, 'transition')}`, snapshot, after);
    else toast(`${name} applied to every cut`, { kind: 'success' });
  };

  const preview = () => {
    const p = projectStore.get();
    const lay = M.layoutVideo(p.tracks.video);
    const item = lay.find((it) => it.clip.id === clipId);
    if (!item || !session?.player) return;
    const a = item.transIn ? item.transIn.start : item.start;
    const b = item.transIn ? item.transIn.end : item.start;
    session.player.playRange(Math.max(0, a - 0.8), Math.min(M.layoutProject(p).duration, b + 0.8));
  };

  if (mode === 'one' && (!info || !info.clip)) return null;
  const tooShort = mode === 'one' && info.max < 0.05;
  // 'all' mode with transitions on some cuts: the cut option removes them all (and says so)
  const removesAll = all && cuts?.withTransition > 0;
  const names = mixed ? cuts.types.split(',').map(transitionName).join(', ') : '';
  const badgeTitle = !mixed
    ? undefined
    : cuts.withTransition === cuts.count
      ? `The ${cuts.count} cuts use different transitions: ${names}`
      : `${cuts.withTransition} of ${pluralize(cuts.count, 'cut')} ${cuts.withTransition === 1 ? 'has' : 'have'} a transition: ${names}`;

  return html`<div
    class="tl-pop"
    ref=${ref}
    role="dialog"
    aria-label=${all ? 'Transition for every cut' : 'Transition'}
    style=${pos ? `left:${pos.left}px;top:${pos.top}px` : 'left:-9999px;top:0;visibility:hidden'}
    onPointerDown=${(e) => e.stopPropagation()}
  >
    <div class="tl-pop-head">
      <${Icon} name="transition" size=${15} />
      <span class="tl-pop-title">${all ? `Every cut (${cuts?.count ?? 0})` : 'Transition'}</span>
      <span class=${cx('tl-pop-current', mixed && 'is-mixed')} title=${badgeTitle}>${mixed ? 'Mixed' : current ? transitionName(current.type) : 'Cut'}</span>
      <${IconButton} icon="x" title="Close" size="sm" onClick=${onClose} />
    </div>
    ${tooShort
      ? html`<div class="tl-pop-empty">These clips are too short for a transition.</div>`
      : html`<div class="tl-pop-body">
          <button
            type="button"
            class=${cx('tl-tr-opt', 'tl-tr-cut', !current && !mixed && 'is-active')}
            onClick=${() => apply(null)}
            title=${removesAll ? `Remove the ${pluralize(cuts.withTransition, 'transition')}: hard cuts everywhere` : 'Hard cut (no transition)'}
          >
            <span class="tl-trsw tl-trsw-md" data-tr="cut"><span class="tl-trsw-a"></span><span class="tl-trsw-b"></span></span>
            <span>${removesAll ? 'Remove all transitions' : 'Cut'}</span>
          </button>
          ${TRANSITION_KINDS.map(
            (k) => html`<div class="tl-tr-group" key=${k.id}>
              <div class="tl-tr-kind">${k.label}</div>
              <div class="tl-tr-grid">
                ${M.TRANSITIONS.filter((t) => t.kind === k.id).map(
                  (t) => html`<button
                    type="button"
                    key=${t.id}
                    class=${cx('tl-tr-opt', current?.type === t.id && 'is-active')}
                    data-transition=${t.id}
                    title=${t.name}
                    onClick=${() => apply(t.id, duration)}
                  >
                    <${TransitionSwatch} type=${t.id} />
                    <span>${t.name}</span>
                  </button>`,
                )}
              </div>
            </div>`,
          )}
        </div>
        <div class="tl-pop-foot">
          <${Slider}
            label="Duration"
            value=${duration}
            min=${0.1}
            max=${Math.max(0.2, max)}
            step=${0.05}
            disabled=${!current}
            format=${(v) => `${v.toFixed(2)}s`}
            onChange=${(v) => current && apply(current.type, v, { merging: true })}
            onCommit=${() => {
              merge.current = `trdur:${++mergeCounter}`;
            }}
          />
          <div class="tl-pop-actions">
            ${mode === 'one' &&
            html`<${Button} size="sm" kind="ghost" icon="play" onClick=${preview} disabled=${!current}>Preview<//>
              <${Button} size="sm" kind="ghost" icon="layers" disabled=${!current} onClick=${applyToAll} title="Use this transition on every cut">All cuts<//>`}
            <span class="spacer"></span>
            ${(all ? removesAll : current) && html`<${Button} size="sm" kind="danger" icon="trash" onClick=${() => apply(null)}>${all ? 'Remove all' : 'Remove'}<//>`}
          </div>
        </div>`}
  </div>`;
}
