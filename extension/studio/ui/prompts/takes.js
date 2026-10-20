// Takes: generated media linked to shots. TakesSection (per shot: choose the best take, open it in the source monitor,
// unlink, link from the bin, offers of matching grok.com videos) and LinkTakesDialog (bin picker sorted by prompt
// similarity). Automatic linking lives in take-watcher.js.
import { html, useState, useMemo } from '../../../vendor/preact-htm.mjs';
import { useProject, useStore, usePage } from '../hooks.js';
import { Icon, IconButton, Button, Modal, EmptyState, Toggle, toast, showMenu, cx } from '../kit.js';
import { projectStore } from '../../core/store.js';
import { appEvents } from '../../core/app-state.js';
import { pluralize, formatDuration } from '../../core/utils.js';
import * as S from '../../prompts/shots.js';
import { promptSimilarity } from '../../prompts/match.js';
import { PrSection, TakeThumb, useShotInBox } from './common.js';
import { promptsUi, setUi, prefsStore, setPrefs, expandPrompt, linkTakesByHand, unlinkTakeByHand } from './state.js';
import { linkCandidates } from './take-watcher.js';
import { removeFromBin } from '../media/actions.js';

const openInSource = (mediaId) => appEvents.emit('source.open', { mediaId });

function TakeCard({ shot, mediaId, chosen, index }) {
  const media = useProject((p) => p.media[mediaId] || null);
  if (!media) return null;
  const failed = media.status === 'error';
  const choose = () => projectStore.update((q) => S.chooseTake(q, shot.id, chosen ? null : mediaId), { label: chosen ? 'Clear chosen take' : 'Choose take' });
  const unlink = () => unlinkTakeByHand(shot.id, mediaId);
  const menu = (e) =>
    showMenu(e, [
      { label: chosen ? 'Clear choice' : 'Use this take', icon: 'star', onClick: choose },
      { label: 'Open in source monitor', icon: 'eye', onClick: () => openInSource(mediaId) },
      '-',
      { label: 'Unlink from shot', icon: 'x', onClick: unlink },
      { label: 'Delete this video', icon: 'trash', danger: true, onClick: () => removeFromBin([mediaId]) },
    ]);
  return html`<div class=${cx('pr-take', chosen && 'is-chosen', failed && 'is-failed')} data-media-id=${mediaId} onContextMenu=${menu}>
    <button type="button" class="pr-take-media" title=${failed ? `Download failed: ${media.error || 'unknown error'} — retry it in the Clips tab. Assemble skips it.` : 'Double-click to open in the source monitor'} onClick=${choose} onDblClick=${() => openInSource(mediaId)}>
      <${TakeThumb} mediaId=${mediaId} />
      ${chosen && html`<span class="pr-take-badge"><${Icon} name="star-filled" size=${11} /> Chosen</span>`}
    </button>
    <div class="pr-take-foot">
      <span class="pr-take-name" title=${media.prompt || media.name}>Take ${index + 1}${failed ? ' · failed' : media.duration ? ` · ${formatDuration(media.duration)}` : ''}</span>
      <${IconButton} icon=${chosen ? 'star-filled' : 'star'} size="sm" title=${chosen ? 'Chosen take (click to clear)' : 'Use this take in the sequence'} active=${chosen} onClick=${choose} />
      <${IconButton} icon="eye" size="sm" title="Open in the source monitor" onClick=${() => openInSource(mediaId)} />
      <${IconButton} icon="x" size="sm" title="Unlink from this shot (the video stays in the bin)" onClick=${unlink} />
      <${IconButton} icon="trash" size="sm" kind="danger" title="Delete this video (undo with Ctrl+Z)" onClick=${() => removeFromBin([mediaId])} />
    </div>
  </div>`;
}

function OfferBanner({ shot }) {
  const offers = useStore(promptsUi, (s) => s.offers[shot.id] || []);
  if (!offers.length) return null;
  const accept = async () => {
    setUi((s) => ({ offers: { ...s.offers, [shot.id]: [] } }));
    await linkCandidates(offers.map((candidate) => ({ shotId: shot.id, candidate })));
  };
  const dismiss = () => setUi((s) => ({ offers: { ...s.offers, [shot.id]: [] } }));
  return html`<div class="pr-offer" role="status">
    <div class="pr-offer-thumbs">
      ${offers.slice(0, 4).map((c) => (c.pageItem?.thumbUrl ? html`<img key=${c.key} src=${c.pageItem.thumbUrl} alt="" />` : html`<span key=${c.key} class="pr-offer-ph"><${Icon} name="film" size=${12} /></span>`))}
    </div>
    <span class="pr-offer-text">${pluralize(offers.length, 'new video')} on grok.com ${offers.length === 1 ? 'matches' : 'match'} this prompt</span>
    <span class="spacer"></span>
    <${Button} size="sm" kind="ghost" onClick=${dismiss}>Dismiss<//>
    <${Button} size="sm" kind="primary" icon="link" onClick=${accept}>Link<//>
  </div>`;
}

/** What "Assemble" will do with this shot's takes, in words. */
function takesHint(shot, takes, media) {
  const used = S.effectiveTake({ media }, shot);
  const number = (id) => takes.indexOf(id) + 1;
  if (!used) return { text: 'The takes failed to download — retry them in the Clips tab, or link other clips.', warn: true };
  if (shot.chosenTake && shot.chosenTake !== used) return { text: `The chosen take failed to download — “Assemble” uses take ${number(used)} instead. Retry it in the Clips tab, or choose another take.`, warn: true };
  if (shot.chosenTake) return { text: 'The chosen take is used by “Assemble”.' };
  return { text: `No take chosen yet — “Assemble” uses take ${number(used)}. Click a take to choose it.` };
}

export function TakesSection({ shot }) {
  const media = useProject((p) => p.media);
  const takes = S.validTakes({ media }, shot);
  const autoLink = useStore(prefsStore, (p) => p.autoLink);
  const connected = usePage((s) => s.connected);
  const inBox = useShotInBox(shot);
  const waiting = !inBox && shot.status === 'sent' && !takes.length;
  const hint = takes.length ? takesHint(shot, takes, media) : null;
  return html`<${PrSection} id="takes" title="Takes" icon="film" count=${takes.length || null}
    actions=${html`<${IconButton} icon="link" size="sm" title="Link clips from the bin" onClick=${() => setUi({ dialog: { type: 'link', shotId: shot.id } })} />`}
  >
    <${OfferBanner} shot=${shot} />
    ${takes.length
      ? html`<div class="pr-takes-grid">
          ${takes.map((id, i) => html`<${TakeCard} key=${id} shot=${shot} mediaId=${id} index=${i} chosen=${shot.chosenTake === id} />`)}
        </div>
        <div class=${cx('pr-takes-hint', 'tiny', hint.warn ? 'is-warn' : 'muted')}>${hint.text}</div>`
      : html`<div class=${cx('pr-takes-empty', (waiting || inBox) && 'is-waiting')}>
          <${Icon} name=${inBox ? 'inbox' : waiting ? 'clock' : 'film'} size=${18} />
          <div>
            ${inBox
              ? html`<b>In Grok’s prompt box.</b> Press <b>Generate</b> (or Grok’s own button) to start it — the new videos ${autoLink ? 'are linked here automatically' : 'will be offered here'}.`
              : waiting
                ? html`<b>Waiting for Grok…</b> New videos whose prompt matches this shot ${autoLink ? 'are linked here automatically' : 'will be offered here'}.`
                : html`No takes yet. ${connected ? 'Send the shot to Grok' : 'Open grok.com and send the shot'} — matching videos are linked here. You can also drop clips from the bin onto the shot card.`}
          </div>
        </div>`}
    <div class="pr-takes-tools">
      <${Button} size="sm" kind="ghost" icon="link" onClick=${() => setUi({ dialog: { type: 'link', shotId: shot.id } })}>Link from bin…<//>
      <span class="spacer"></span>
      <${Toggle} checked=${autoLink} onChange=${(v) => setPrefs({ autoLink: v })} label="Auto-link new videos" title="Link new grok.com videos whose prompt matches a sent shot" />
    </div>
  <//>`;
}

/** Bin picker to link takes by hand; likely matches (prompt similarity) first. */
export function LinkTakesDialog({ shotId, onClose }) {
  const shot = useProject((p) => S.findShot(p, shotId));
  const items = useProject((p) => p.mediaOrder.map((id) => p.media[id]).filter((m) => m && m.kind !== 'audio'));
  const [sel, setSel] = useState([]);
  const [search, setSearch] = useState('');
  const ref = useMemo(() => (shot ? expandPrompt(shot.sentText || shot.prompt).text : ''), [shot?.id]);
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((m) => !q || `${m.name} ${m.prompt || ''}`.toLowerCase().includes(q))
      .map((m) => ({ m, score: ref && m.prompt ? promptSimilarity(ref, m.prompt) : 0 }))
      .sort((a, b) => b.score - a.score || b.m.addedAt - a.m.addedAt);
  }, [items, search, ref]);
  if (!shot) return null;
  const linked = new Set(shot.takes || []);
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const done = () => {
    const n = sel.length ? linkTakesByHand(shotId, sel) : 0;
    if (n) toast(`Linked ${pluralize(n, 'take')}`, { kind: 'success' });
    onClose();
  };
  return html`<${Modal} title="Link takes from the bin" width=${760} onClose=${onClose} class="pr-dialog"
    footer=${html`<span class="muted small">${sel.length ? `${sel.length} selected` : 'Pick the clips generated for this shot'}</span><span class="spacer"></span>
      <${Button} kind="ghost" onClick=${onClose}>Cancel<//><${Button} kind="primary" icon="link" disabled=${!sel.length} onClick=${done} data-testid="pr-link-done">Link ${sel.length || ''}<//>`}
  >
    <div class="pr-link-tools">
      <label class="pr-search"><${Icon} name="search" size=${14} /><input type="search" placeholder="Search clips by name or prompt" value=${search} onInput=${(e) => setSearch(e.currentTarget.value)} /></label>
    </div>
    ${!items.length
      ? html`<${EmptyState} icon="film" title="The bin is empty" compact=${true}>Collect Grok videos in the Clips tab first (or import files), then link them here.<//>`
      : html`<div class="pr-link-grid">
          ${list.map(
            ({ m, score }) => html`<button type="button" key=${m.id} class=${cx('pr-link-card', sel.includes(m.id) && 'is-selected', linked.has(m.id) && 'is-linked')} disabled=${linked.has(m.id)} onClick=${() => toggle(m.id)} data-media-id=${m.id}>
              <span class="pr-link-media"><${TakeThumb} mediaId=${m.id} />${sel.includes(m.id) && html`<span class="pr-link-check"><${Icon} name="check" size=${12} /></span>`}</span>
              <span class="pr-link-name">${m.name}</span>
              ${linked.has(m.id) ? html`<span class="pr-link-score">linked</span>` : score >= 0.5 ? html`<span class="pr-link-score is-match">${Math.round(score * 100)}% match</span>` : null}
            </button>`,
          )}
        </div>`}
  <//>`;
}
