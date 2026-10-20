// Review mode: a focused, keyboard-driven player that walks the filtered bin one item at a time so triaging
// 40 generations down to the 3 keepers takes seconds: ←/→ browse, Space play, P/X/U flag, 1–5 rate, I/O marks,
// Enter adds the (marked) clip to the timeline and moves on, Esc exits. The walk order is a snapshot taken when
// review starts, so flagging an item never yanks it out from under the cursor. Items that leave the project while
// reviewing (removed, undo of their import) are skipped; review closes itself when none are left or the sequence
// changes.
import { html, useState, useEffect, useRef, useMemo } from '../../../vendor/preact-htm.mjs';
import { uiStore } from '../../core/store.js';
import { formatTime, formatDuration, pluralize } from '../../core/utils.js';
import { useProject } from '../hooks.js';
import { useHotkeys } from '../hotkeys.js';
import { Icon, IconButton, Button, Toggle, Kbd, ProgressBar, Badge, toast, cx } from '../kit.js';
import { applyMark, markTime, markedRange, mediaMarks, flagStats, resolveWalk, walkStep, displayTitle, placedOnTimeline, EMPTY_MARKS } from './bin-logic.js';
import { useSourcePlayer, useMediaSrc, ScrubBar, TimeReadout } from './source-player.js';
import { MediaThumb, usePreviews, Waveform } from './media-thumb.js';
import { StageStatus, FlagControls } from './source-monitor.js';
import { memo } from './memo.js';
import { usePref } from './prefs.js';
import { guardKeys, revealIn } from './keys.js';
import { setMarks, flagMedia, rateMedia, addToTimeline, removeFromBin } from './actions.js';

const STAMPS = {
  pick: { text: 'Picked', icon: 'flag', cls: 'is-pick' },
  reject: { text: 'Rejected', icon: 'x', cls: 'is-reject' },
  unflag: { text: 'Unflagged', icon: 'minus', cls: 'is-neutral' },
  deleted: { text: 'Deleted', icon: 'trash', cls: 'is-reject' },
  added: { text: 'Added to timeline', icon: 'check', cls: 'is-added' },
};

const KEY_HINTS = [
  ['←', '→', 'browse'],
  ['Space', null, 'play'],
  ['P', null, 'pick'],
  ['X', null, 'reject'],
  ['U', null, 'unflag'],
  ['1', '5', 'rate'],
  ['I', 'O', 'in / out'],
  ['↵', null, 'add & next'],
  ['Del', null, 'delete'],
  ['Esc', null, 'exit'],
];

// Memoized: a status update of one item re-renders its own thumbnail only, not the whole strip.
const FilmItem = memo(function FilmItem({ id, pos, current, jump }) {
  return html`<button type="button" class=${cx('clips-review-film-item', current && 'is-current')} title=${`${pos + 1}`} onClick=${() => jump.current(pos)}>
    <${MediaThumb} mediaId=${id} scrub=${false} showFlag=${true} showDuration=${false} showKind=${false} showUsage=${false} />
  </button>`;
});

function ReviewFilmstrip({ ids, index, onJump }) {
  const ref = useRef(null);
  const jump = useRef(onJump);
  jump.current = onJump;
  useEffect(() => revealIn(ref.current, ref.current?.querySelector('.is-current'), { axis: 'x', center: true }), [index, ids.length]);
  return html`<div class="clips-review-film" ref=${ref}>
    ${ids.map((id, i) => html`<${FilmItem} key=${id} id=${id} pos=${i} current=${i === index} jump=${jump} />`)}
  </div>`;
}

/**
 * ids: the walk order (snapshot of the filtered bin); startIndex: where to start (0 = the first item).
 * onExit(lastId | null) is called with the item the cursor was on.
 */
export function ReviewMode({ active, ids, startIndex = 0, onExit }) {
  const [list] = useState(ids);
  const [pos, setPos] = useState(() => Math.min(Math.max(0, startIndex | 0), Math.max(0, ids.length - 1)));
  const mediaMap = useProject((p) => p.media);
  const tracks = useProject((p) => p.tracks);
  const projectId = useProject((p) => p.id);
  const [startProject] = useState(projectId);
  const [volume] = usePref('volume', 1);
  const [muted, setMuted] = usePref('muted', false);
  const [loop, setLoop] = usePref('reviewLoop', true);
  const [autoAdvance, setAutoAdvance] = usePref('autoAdvance', false);
  const [stamp, setStamp] = useState(null);
  const stampTimer = useRef(0);
  const visited = useRef(new Set());

  // Everything below is derived during render, so an item that disappears is never dereferenced.
  const alive = (x) => !!mediaMap[x];
  const live = useMemo(() => list.filter((x) => mediaMap[x]), [list, mediaMap]);
  const at = resolveWalk(list, pos, alive);
  const done = at >= list.length;
  const id = done ? null : list[at];
  const m = id ? mediaMap[id] : null;
  const gone = live.length === 0 || projectId !== startProject;
  if (id) visited.current.add(id);

  const marks = mediaMarks(m);
  const ready = m?.status === 'ready';
  const src = useMediaSrc(id, ready);
  const previews = usePreviews(id, m?.kind === 'video');
  const player = useSourcePlayer({ media: m, src, active: active && !done && !gone, marks, loop, autoplay: true, volume, muted });

  useEffect(() => () => clearTimeout(stampTimer.current), []);
  // Nothing left to review (everything removed, another sequence opened): leave.
  useEffect(() => {
    if (gone) onExit?.(null);
  }, [gone]);

  const kind = m?.kind || 'video';
  const timed = !!m && kind !== 'image';
  const dur = m ? m.duration || player.duration() : 0;
  const fps = m?.fps || 30;
  const stats = flagStats({ media: mediaMap }, live);
  const livePos = done ? live.length : live.indexOf(id);
  const seen = live.filter((x) => visited.current.has(x)).length;
  const unseen = live.find((x) => !visited.current.has(x)) || null;

  const showStamp = (k) => {
    clearTimeout(stampTimer.current);
    setStamp({ k, n: Date.now() });
    stampTimer.current = setTimeout(() => setStamp(null), 750);
  };
  const goPos = (i) => setPos(Math.max(0, Math.min(list.length, i)));
  const next = () => goPos(walkStep(list, at, 1, alive));
  const prev = () => goPos(walkStep(list, at, -1, alive));
  const jumpTo = (x) => x && goPos(list.indexOf(x));
  const flag = (f) => {
    if (!m) return;
    flagMedia([m.id], f);
    showStamp(f || 'unflag');
    if (autoAdvance) next();
  };
  const rate = (n) => m && rateMedia([m.id], n);
  const markIn = () => timed && setMarks(m.id, applyMark(marks, 'in', markTime('in', player.getTime(), fps, dur), dur), { label: 'Mark IN' });
  const markOut = () => timed && setMarks(m.id, applyMark(marks, 'out', markTime('out', player.getTime(), fps, dur), dur), { label: 'Mark OUT' });
  const addAndNext = () => {
    if (!m) return;
    if (m.status === 'error') {
      toast("This item failed to download, so it can't go on the timeline. Retry it from the bin.", { kind: 'warn' });
      return;
    }
    const r = markedRange(m, marks.in, marks.out);
    addToTimeline([m.id], { ranges: r ? { [m.id]: r } : {}, quiet: true });
    showStamp('added');
    next();
  };
  // Delete the item on screen and go to the next one (the walk skips items that no longer exist).
  const deleteAndNext = async () => {
    if (!m) return;
    const nextPos = walkStep(list, at, 1, (x) => x !== m.id && alive(x));
    if (!(await removeFromBin([m.id]))) return;
    showStamp('deleted');
    goPos(nextPos);
  };
  const startOver = () => {
    visited.current = new Set();
    goPos(resolveWalk(list, 0, alive));
  };
  const exit = () => onExit?.(id || live[live.length - 1] || null);

  const keys = {
    arrowleft: prev,
    arrowright: next,
    space: () => (done ? exit() : timed && player.toggle()),
    p: () => flag('pick'),
    x: () => flag('reject'),
    u: () => flag(null),
    0: () => rate(0),
    i: markIn,
    o: markOut,
    'mod+shift+x': () => m && setMarks(m.id, EMPTY_MARKS, { label: 'Clear IN/OUT' }),
    enter: () => (done ? exit() : addAndNext()),
    delete: deleteAndNext,
    backspace: deleteAndNext,
    escape: exit,
    j: () => timed && player.shuttle('j'),
    k: () => timed && player.shuttle('k'),
    l: () => timed && player.shuttle('l'),
    ',': () => timed && player.step(-1),
    '.': () => timed && player.step(1),
    home: () => goPos(resolveWalk(list, 0, alive)),
    end: () => goPos(walkStep(list, list.length, -1, alive)),
    m: () => setMuted(!muted),
    'mod+a': () => {}, // nothing to select here: keep the browser from selecting the page text
  };
  for (const n of [1, 2, 3, 4, 5]) keys[String(n)] = () => rate(n);
  useHotkeys(guardKeys(keys), { enabled: active && !gone });

  if (gone) return null;

  const progress = live.length ? Math.min(livePos + 1, live.length) / live.length : 0;
  const pickedIds = live.filter((x) => mediaMap[x]?.flag === 'pick');
  // Picks already on the timeline (Enter = "add & next", or added before the review) are not added a second time.
  const placed = new Set(placedOnTimeline({ media: mediaMap, tracks }, pickedIds));
  const toAdd = pickedIds.filter((x) => !placed.has(x));
  const addLabel = !pickedIds.length
    ? 'Add picked to timeline'
    : !toAdd.length
      ? 'Every pick is on the timeline'
      : placed.size
        ? `Add ${toAdd.length} picked not on the timeline yet`
        : `Add ${toAdd.length} picked to timeline`;
  const range = m ? markedRange(m, marks.in, marks.out) : null;
  const st = stamp && STAMPS[stamp.k];
  const complete = seen >= live.length;

  return html`<div class="clips-review" role="dialog" aria-label="Review mode">
    <header class="clips-review-head">
      <div class="clips-review-title"><${Icon} name="play2" size=${16} /><span>Review</span></div>
      <div class="clips-review-progress">
        <span class="clips-review-count mono">${done ? live.length : livePos + 1} / ${live.length}</span>
        <${ProgressBar} value=${progress} />
      </div>
      <div class="clips-review-stats">
        <${Badge} kind="ok" title="Picked">${stats.picked} picked<//>
        <${Badge} kind="err" title="Rejected">${stats.rejected} rejected<//>
        <${Badge} title="Not flagged yet">${stats.unflagged} unflagged<//>
      </div>
      <span class="spacer"></span>
      <div class="clips-review-toggles">
        <${Toggle} checked=${autoAdvance} onChange=${setAutoAdvance} label="Auto-advance" title="Move to the next item after P / X / U" />
        <${Toggle} checked=${loop} onChange=${setLoop} label="Loop" title="Loop each clip (or its marked range)" />
      </div>
      <${Button} kind="ghost" icon="x" class="clips-review-exit" onClick=${exit} title="Exit review (Esc)">Exit<//>
    </header>

    ${done
      ? html`<div class="clips-review-done">
          <div class=${cx('clips-review-done-icon', !complete && 'is-partial')}><${Icon} name=${complete ? 'check' : 'play2'} size=${28} /></div>
          <div class="clips-review-done-title">${complete ? 'Review complete' : `Reviewed ${seen} of ${live.length}`}</div>
          <div class="clips-review-done-body">
            ${complete
              ? html`You picked <b>${stats.picked}</b> of ${pluralize(live.length, 'item')}${stats.rejected ? ` and rejected ${stats.rejected}` : ''}.`
              : html`${pluralize(live.length - seen, 'item')} not seen yet. So far you picked <b>${stats.picked}</b>${stats.rejected ? ` and rejected ${stats.rejected}` : ''}.`}
            ${placed.size > 0 && html` <span class="clips-review-placed">${placed.size === pickedIds.length ? (placed.size > 1 ? 'All of them are' : 'It is') : `${placed.size} of them ${placed.size > 1 ? 'are' : 'is'}`} already on the timeline.</span>`}
          </div>
          <div class="clips-review-done-actions">
            ${!complete && html`<${Button} kind="primary" icon="play2" onClick=${() => jumpTo(unseen)}>Review the ${live.length - seen} remaining<//>`}
            <${Button}
              kind=${complete && toAdd.length ? 'primary' : 'default'}
              icon=${pickedIds.length && !toAdd.length ? 'check' : 'plus'}
              class="clips-review-add-picked"
              disabled=${!toAdd.length}
              title=${placed.size ? 'Picks already on the timeline are not added again' : 'Append the picked items to the end of the timeline, in this order'}
              onClick=${() => {
                addToTimeline(toAdd);
                exit();
              }}
              >${addLabel}<//
            >
            <${Button}
              icon="filter"
              disabled=${!pickedIds.length}
              title="Filter the bin to the picked items"
              onClick=${() => {
                uiStore.set((s) => ({ ...s, binFilter: { ...s.binFilter, flag: 'pick' } }));
                exit();
              }}
              >Show picked in the bin<//
            >
            <${Button} icon="repeat" onClick=${startOver}>Start over<//>
            <${Button} kind="ghost" onClick=${exit}>Back to the bin<//>
          </div>
        </div>`
      : html`<div class="clips-review-main">
          <div class="clips-review-player">
            <div class=${cx('clips-review-stage', `is-${kind}`, m.flag && `is-${m.flag}`)} onClick=${() => timed && ready && player.toggle()}>
              ${kind === 'image'
                ? src && html`<img class="src-image" src=${src} alt="" draggable="false" />`
                : html`${kind === 'audio' && html`<${Waveform} mediaId=${m.id} ready=${ready} class="src-wave" color="#41d3a0" />`}
                    <video class="src-video" ref=${player.videoRef} src=${src || undefined} preload="auto" playsInline ...${player.videoProps}></video>`}
              <${StageStatus} media=${m} />
              ${st && html`<div class=${cx('clips-review-stamp', st.cls)} key=${stamp.n}><${Icon} name=${st.icon} size=${22} /><span>${st.text}</span></div>`}
              ${timed && ready && !player.playing && html`<div class="src-stage-play" aria-hidden="true"><${Icon} name="play" size=${30} /></div>`}
            </div>
            ${timed &&
            html`<div class="clips-review-scrubrow">
              <${IconButton} icon=${player.playing ? 'pause' : 'play'} size="sm" kind="solid" title="Play / pause (Space)" disabled=${!ready} onClick=${player.toggle} />
              <${ScrubBar}
                duration=${dur}
                time=${player.time}
                marks=${marks}
                strip=${previews?.strip || null}
                disabled=${!ready}
                onSeek=${(t) => player.seek(t)}
                onMarks=${(mk, phase, gesture) => setMarks(m.id, mk, { label: gesture.role === 'in' ? 'Trim IN' : 'Trim OUT', merge: gesture.key })}
              />
              <${TimeReadout} time=${player.time} duration=${dur} />
              <${IconButton} icon=${muted ? 'volume-x' : 'volume'} size="sm" title=${muted ? 'Unmute (M)' : 'Mute (M)'} onClick=${() => setMuted(!muted)} />
            </div>`}
          </div>

          <aside class="clips-review-side">
            <div class="clips-review-name" title=${m.name || displayTitle(m)}>${m.name || displayTitle(m)}</div>
            <div class="clips-review-meta">${[m.kind, m.duration ? formatDuration(m.duration) : null, m.width ? `${m.width}×${m.height}` : null].filter(Boolean).join(' · ')}</div>
            <${FlagControls} media=${m} size="lg" onDelete=${deleteAndNext} />
            ${timed &&
            html`<div class="clips-review-marks">
              <span class=${cx('clips-review-mark', marks.in != null && 'is-set')}>IN ${formatTime(marks.in ?? 0)}</span>
              <span class=${cx('clips-review-mark', marks.out != null && 'is-set')}>OUT ${formatTime(marks.out ?? dur)}</span>
              <span class="clips-review-mark-len">${formatTime(range ? (range.out ?? dur) - range.in : dur)}</span>
            </div>`}
            <${Button}
              kind="primary"
              icon="plus"
              class="clips-review-add"
              disabled=${m.status === 'error'}
              onClick=${addAndNext}
              title="Add to the timeline (with the marked range) and go to the next item"
            >
              Add to timeline & next <${Kbd}>↵<//>
            <//>
            <div class="clips-review-nav">
              <${Button} icon="chevron-left" disabled=${livePos <= 0} onClick=${prev}>Prev<//>
              <${Button} iconRight="chevron-right" onClick=${next}>${livePos === live.length - 1 ? 'Finish' : 'Next'}<//>
            </div>
            <div class="clips-review-prompt">
              <div class="clips-review-label">Prompt</div>
              <div class="clips-review-prompt-text">${m.prompt || html`<span class="muted">No prompt for this item.</span>`}</div>
            </div>
          </aside>
        </div>`}

    <${ReviewFilmstrip} ids=${live} index=${livePos} onJump=${(i) => jumpTo(live[i])} />
    <div class="clips-review-keys">
      ${KEY_HINTS.map(
        ([a, b, label]) => html`<span class="clips-review-key" key=${label}><${Kbd}>${a}<//>${b && html`<${Kbd}>${b}<//>`}<span>${label}</span></span>`,
      )}
    </div>
  </div>`;
}
