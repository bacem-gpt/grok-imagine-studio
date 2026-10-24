// Shot list / storyboard: numbered cards (title, prompt excerpt, reference thumbnails, status, takes), drag to
// reorder (one undo step per drop), drop bin clips on a card to link them as takes, context menus, and the footer
// with the manual "Send next" queue, batch queue progress and "Assemble timeline".
import { html, useState, useRef, useEffect } from '../../../vendor/preact-htm.mjs';
import { trackPointer } from '../pointer.js';
import { useProject, useStore, usePage, useDragHighlightReset } from '../hooks.js';
import { Icon, IconButton, Button, EmptyState, showMenu, confirmDialog, toast, cx, MEDIA_DRAG_TYPE } from '../kit.js';
import { formatDuration, pluralize } from '../../core/utils.js';
import { projectStore } from '../../core/store.js';
import * as S from '../../prompts/shots.js';
import { queueProgress } from '../../prompts/queue.js';
import { ShotStatus, TakeThumb, IngThumb } from './common.js';
import {
  promptsUi,
  setUi,
  setPrefs,
  selectShot,
  newShot,
  duplicateShot,
  deleteShots,
  moveShotBy,
  setShotStatus,
  sendShot,
  copyShotPrompt,
  openPaste,
  importFromPage,
  copyAllPrompts,
  exportShots,
  queueStore,
  queueRunner,
  sendNextDraft,
  requestFocus,
  linkTakesByHand,
} from './state.js';

const MEDIA_TYPE = MEDIA_DRAG_TYPE;

export function shotMenuItems(shot, index, total) {
  return [
    { header: `Shot ${index + 1}` },
    { label: 'Insert into Grok', icon: 'send', shortcut: 'mod+enter', onClick: () => sendShot(shot.id) },
    { label: 'Insert & generate', icon: 'sparkles', shortcut: 'mod+shift+enter', onClick: () => sendShot(shot.id, { submit: true }) },
    { label: 'Copy prompt', icon: 'copy', onClick: () => copyShotPrompt(shot.id) },
    '-',
    { label: 'Duplicate', icon: 'copy', shortcut: 'mod+d', onClick: () => duplicateShot(shot.id) },
    { label: 'Move up', icon: 'arrow-up', disabled: index === 0, onClick: () => moveShotBy(shot.id, -1) },
    { label: 'Move down', icon: 'arrow-down', disabled: index >= total - 1, onClick: () => moveShotBy(shot.id, 1) },
    '-',
    { header: 'Status' },
    ...S.SHOT_STATUSES.map((st) => ({ label: S.STATUS_LABELS[st], checked: shot.status === st, onClick: () => setShotStatus(shot.id, st) })),
    '-',
    { label: 'Delete shot', icon: 'trash', danger: true, onClick: () => deleteShots([shot.id]) },
  ];
}

function listMenu(e, count) {
  showMenu(e, [
    { header: 'Shot list' },
    { label: 'Paste a prompt list…', icon: 'list', onClick: () => openPaste('') },
    { label: "Import Grok's latest reply", icon: 'inbox', onClick: () => importFromPage('reply') },
    { label: 'Import selected text on grok.com', icon: 'quote', onClick: () => importFromPage('selection') },
    '-',
    { label: 'Copy all prompts', icon: 'copy', disabled: !count, onClick: copyAllPrompts },
    { label: 'Export as text (.txt)', icon: 'download', disabled: !count, onClick: () => exportShots('txt') },
    { label: 'Export as Markdown (.md)', icon: 'download', disabled: !count, onClick: () => exportShots('md') },
    { label: 'Export as JSON (.json)', icon: 'download', disabled: !count, onClick: () => exportShots('json') },
    { label: 'Export as CSV (.csv)', icon: 'download', disabled: !count, onClick: () => exportShots('csv') },
    '-',
    { label: 'Assemble timeline…', icon: 'film', disabled: !count, onClick: () => setUi({ dialog: 'assemble' }) },
    { label: 'Batch send to Grok…', icon: 'send', disabled: !count, onClick: () => setUi({ dialog: 'queue' }) },
    '-',
    {
      label: 'Delete all shots…',
      icon: 'trash',
      danger: true,
      disabled: !count,
      onClick: async () => {
        if (await confirmDialog({ title: 'Delete all shots?', message: `All ${count} shots of this sequence will be removed. Linked clips stay in the bin. You can undo this.`, confirmLabel: 'Delete all', danger: true })) {
          deleteShots(S.getShots(projectStore.get()).map((s) => s.id));
        }
      },
    },
  ]);
}

function ShotCard({ shot, index, total, selected, sending, dragging, dropTarget, onPointerDown }) {
  const media = useProject((p) => p.media);
  const take = S.effectiveTake({ media }, shot);
  const takes = S.validTakes({ media }, shot).length;
  const refs = Array.isArray(shot.ingredientIds) ? shot.ingredientIds : [];
  const offers = useStore(promptsUi, (s) => s.offers[shot.id]?.length || 0);
  const [over, setOver] = useState(false);
  useDragHighlightReset(over, () => setOver(false));
  const excerpt = (shot.prompt || '').replace(/\s+/g, ' ').trim();

  const onDrop = (e) => {
    setOver(false);
    const raw = e.dataTransfer.getData(MEDIA_TYPE);
    if (!raw) return;
    e.preventDefault();
    let ids = [];
    try {
      ids = JSON.parse(raw);
    } catch {
      return;
    }
    const p = projectStore.get();
    const usable = (Array.isArray(ids) ? ids : []).filter((id) => p.media[id] && p.media[id].kind !== 'audio');
    if (!usable.length) return toast('Only video and image clips can be takes', { kind: 'warn' });
    linkTakesByHand(shot.id, usable);
    selectShot(shot.id);
    toast(`Linked ${pluralize(usable.length, 'take')} to shot ${index + 1}`, { kind: 'success' });
  };

  return html`<div
    class=${cx('pr-card', selected && 'is-selected', dragging && 'is-dragging', over && 'is-drop', dropTarget)}
    data-shot-id=${shot.id}
    role="option"
    aria-selected=${selected ? 'true' : 'false'}
    tabindex="0"
    onPointerDown=${onPointerDown}
    onClick=${() => selectShot(shot.id, { reveal: true })}
    onDblClick=${() => {
      selectShot(shot.id, { reveal: true });
      requestFocus('prompt');
    }}
    onKeyDown=${(e) => {
      if (e.key === 'Enter' && e.target === e.currentTarget) {
        selectShot(shot.id, { reveal: true });
        requestFocus('prompt');
      }
    }}
    onContextMenu=${(e) => showMenu(e, shotMenuItems(shot, index, total))}
    onDragOver=${(e) => {
      if (![...(e.dataTransfer?.types || [])].includes(MEDIA_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'link';
      if (!over) setOver(true);
    }}
    onDragLeave=${() => setOver(false)}
    onDrop=${onDrop}
  >
    <div class="pr-card-num" title="Drag to reorder"><span>${String(index + 1).padStart(2, '0')}</span><${Icon} name="grip" size=${12} class="pr-card-grip" /></div>
    <div class="pr-card-main">
      <div class="pr-card-top">
        <span class=${cx('pr-card-title', !shot.title && 'is-untitled')}>${shot.title || (excerpt ? excerpt.split(/[.,;:!?]/)[0].slice(0, 60) : 'Untitled shot')}</span>
        <button type="button" class="pr-card-menu" title="Shot actions" aria-label="Shot actions" onClick=${(e) => {
          e.stopPropagation();
          showMenu(e.currentTarget, shotMenuItems(shot, index, total));
        }}><${Icon} name="more" size=${14} /></button>
      </div>
      <div class="pr-card-body">
        <div class="pr-card-text">
          <div class=${cx('pr-card-prompt', !excerpt && 'is-empty')}>${excerpt || 'No prompt yet — double-click to write one'}</div>
          <div class="pr-card-meta">
            ${sending ? html`<span class="pr-card-sending" title="Sending to Grok…"><span class="spinner" style="width:11px;height:11px"></span>Sending</span>` : html`<${ShotStatus} shot=${shot} />`}
            ${refs.length > 0 &&
            html`<span class="pr-card-refs" title=${`${pluralize(refs.length, 'reference image')}`}>
              ${refs.slice(0, 3).map((id) => html`<${IngThumb} key=${id} id=${id} />`)}
              ${refs.length > 3 && html`<span class="pr-card-more">+${refs.length - 3}</span>`}
            </span>`}
            <span class="spacer"></span>
            ${offers > 0 && html`<span class="pr-chip-mini is-offer" title="Matching videos found on grok.com">${offers} new</span>`}
            <span class="pr-card-dur" title="Planned length">${formatDuration(shot.duration || 0)}</span>
            <span class=${cx('pr-card-takes', takes > 0 && 'has-takes')} title=${`${pluralize(takes, 'take')}`}><${Icon} name="film" size=${12} />${takes}</span>
          </div>
        </div>
        ${take && html`<div class="pr-card-take" title="Chosen take"><${TakeThumb} mediaId=${take} scrub=${false} /></div>`}
      </div>
    </div>
  </div>`;
}

/** Pointer-driven vertical reordering (no pointer capture until the drag starts, so inner buttons keep working). */
function useReorder(listRef, shots) {
  const [drag, setDrag] = useState(null); // {id, from, to}
  const stateRef = useRef(null);
  const scrollRaf = useRef(0);

  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);

  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('button, input, textarea, a, select')) return;
    const card = e.currentTarget;
    const id = card.dataset.shotId;
    const from = shots.findIndex((s) => s.id === id);
    if (from < 0) return;
    const startY = e.clientY;
    let started = false;
    let lastY = startY;
    const list = listRef.current;
    const targetIndex = (y) => {
      const cards = [...list.querySelectorAll('.pr-card')];
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return cards.length;
    };
    const autoScroll = () => {
      if (!stateRef.current) return;
      const r = list.getBoundingClientRect();
      const edge = 36;
      let dy = 0;
      if (lastY < r.top + edge) dy = -Math.ceil((r.top + edge - lastY) / 4);
      else if (lastY > r.bottom - edge) dy = Math.ceil((lastY - (r.bottom - edge)) / 4);
      if (dy) {
        list.scrollTop += dy;
        const to = targetIndex(lastY);
        setDrag((d) => (d && d.to !== to ? { ...d, to } : d));
      }
      scrollRaf.current = requestAnimationFrame(autoScroll);
    };
    const move = (ev) => {
      lastY = ev.clientY;
      if (!started) {
        if (Math.abs(ev.clientY - startY) < 6) return;
        started = true;
        stateRef.current = { id, from };
        document.body.classList.add('pr-dragging');
        scrollRaf.current = requestAnimationFrame(autoScroll);
      }
      ev.preventDefault();
      const to = targetIndex(ev.clientY);
      setDrag((d) => (d && d.to === to ? d : { id, from, to }));
    };
    const up = (ev, cancelled) => {
      cancelAnimationFrame(scrollRaf.current);
      document.body.classList.remove('pr-dragging');
      const st = stateRef.current;
      stateRef.current = null;
      if (!started || !st) return;
      // Swallow the click that follows a drag.
      const swallow = (ce) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50);
      const to = cancelled ? st.from : targetIndex(ev.clientY);
      setDrag(null);
      const finalIndex = to > st.from ? to - 1 : to;
      if (finalIndex !== st.from) projectStore.update((q) => S.moveShot(q, st.id, finalIndex), { label: 'Reorder shots', merge: `reorder-${st.id}-${Date.now()}` });
    };
    // Always ends (ui/pointer.js): a release outside the studio frame never leaves the grabbing cursor on.
    trackPointer(e, { target: card, onMove: move, onEnd: (ev, { cancelled }) => up(ev, cancelled) });
  };
  return { drag, onPointerDown };
}

function QueueBar({ count }) {
  const q = useStore(queueStore);
  const connected = usePage((s) => s.connected);
  const prog = queueProgress(q);
  const running = q.status === 'running' || q.status === 'paused';
  if (running) {
    const pct = prog.total ? (prog.done / prog.total) * 100 : 0;
    return html`<div class="pr-queue-live" role="status">
      <div class="pr-queue-live-top">
        <span class=${cx('pr-queue-dot', q.status === 'paused' && 'is-paused')}></span>
        <span class="pr-queue-live-label">${q.status === 'paused' ? 'Batch paused' : 'Batch sending'} · ${prog.done}/${prog.total}</span>
        <span class="spacer"></span>
        ${q.status === 'paused'
          ? html`<${IconButton} icon="play" size="sm" title="Resume" onClick=${() => queueRunner.resume()} />`
          : html`<${IconButton} icon="pause" size="sm" title="Pause after the current shot" onClick=${() => queueRunner.pause()} />`}
        <${IconButton} icon="x" size="sm" kind="danger" title="Stop the batch" onClick=${() => queueRunner.stop()} />
        <${IconButton} icon="list" size="sm" title="Batch details" onClick=${() => setUi({ dialog: 'queue' })} />
      </div>
      <div class="pr-queue-bar"><div style=${`width:${pct}%`}></div></div>
    </div>`;
  }
  return html`<div class="pr-queue-idle">
    <${Button} size="sm" icon="send" onClick=${() => sendNextDraft()} disabled=${!count} title=${connected ? 'Send the next unsent shot to Grok and generate it' : 'Open grok.com to send prompts'} data-testid="pr-send-next">Send next<//>
    <${IconButton} icon="repeat" size="sm" onClick=${() => setUi({ dialog: 'queue' })} disabled=${!count} title="Batch send: several shots one after another (opt-in)" data-testid="pr-batch" />
  </div>`;
}

export function ShotList({ layout = 'wide' }) {
  const shots = useProject((p) => S.getShots(p));
  const anyTakes = useProject((p) => S.getShots(p).some((s) => S.effectiveTake(p, s)));
  const total = S.totalDuration(shots);
  const counts = S.statusCounts(shots);
  const selectedId = useStore(promptsUi, (s) => s.selectedId);
  const sending = useStore(promptsUi, (s) => s.sending);
  const listRef = useRef(null);
  const { drag, onPointerDown } = useReorder(listRef, shots);

  return html`<div class="pr-list panel">
    <div class="panel-header pr-list-head">
      <span class="panel-title">Shots</span>
      ${shots.length > 0 && html`<span class="pr-list-sum" title="Planned length of the sequence">${shots.length} · ≈${formatDuration(total)}</span>`}
      <span class="spacer"></span>
      <${IconButton} icon="list" size="sm" title="Paste a prompt list" onClick=${() => openPaste('')} />
      <${IconButton} icon="more" size="sm" title="Import, export, assemble…" onClick=${(e) => listMenu(e.currentTarget, shots.length)} />
      <${Button} size="sm" kind="primary" icon="plus" onClick=${() => newShot()} title="New shot (Alt+N)" data-testid="pr-new-shot">New<//>
    </div>
    ${shots.length > 0 &&
    html`<div class="pr-list-progress" title=${`${counts.draft} draft · ${counts.sent} sent · ${counts.generated} generated · ${counts.approved} approved`}>
      ${S.SHOT_STATUSES.map((st) => (counts[st] ? html`<span key=${st} class=${cx('pr-prog-seg', `is-${st}`)} style=${`flex:${counts[st]}`}></span>` : null))}
    </div>`}
    <div class="panel-body pr-list-body" ref=${listRef} role="listbox" aria-label="Shots">
      ${shots.length === 0 && layout !== 'narrow'
        ? html`<${EmptyState} icon="clapper" title="No shots yet" compact=${true}>Create a shot, paste a prompt list, or import Grok’s reply.<//>`
        : shots.length === 0
        ? html`<${EmptyState}
            icon="clapper"
            title="Plan your sequence shot by shot"
            action=${html`<${Button} kind="primary" icon="plus" onClick=${() => newShot()}>New shot<//>
              <${Button} icon="list" onClick=${() => openPaste('')}>Paste a list<//>`}
          >
            Write one prompt per shot, or paste a whole list — numbered lines, bullets, “Shot 3:” blocks, JSON or CSV.
            Send each shot to Grok; the videos it generates come back here as takes.
            <div class="pr-empty-hint">
              <button type="button" class="pr-link-btn" onClick=${() => (setPrefs({ libraryTab: 'templates' }), setUi({ libraryOpen: true, pane: 'library' }))}>
                <${Icon} name="wand" size=${12} /> Ask Grok to write the shot list
              </button>
            </div>
          <//>`
        : shots.map(
            (shot, i) => html`<${ShotCard}
              key=${shot.id}
              shot=${shot}
              index=${i}
              total=${shots.length}
              selected=${shot.id === selectedId}
              sending=${sending.includes(shot.id)}
              dragging=${drag?.id === shot.id}
              dropTarget=${drag && drag.to === i && drag.to !== drag.from && drag.to !== drag.from + 1 ? 'is-drop-before' : drag && i === shots.length - 1 && drag.to === shots.length && drag.from !== shots.length - 1 ? 'is-drop-after' : ''}
              onPointerDown=${onPointerDown}
            />`,
          )}
    </div>
    ${shots.length > 0 &&
    html`<div class="pr-list-foot">
      <${QueueBar} count=${shots.length} />
      <${Button} size="sm" icon="film" kind=${anyTakes ? 'default' : 'ghost'} disabled=${!anyTakes} onClick=${() => setUi({ dialog: 'assemble' })} title=${anyTakes ? 'Put the chosen takes on the timeline in shot order' : 'Link takes to shots first'} data-testid="pr-assemble">Assemble<//>
    </div>`}
  </div>`;
}

