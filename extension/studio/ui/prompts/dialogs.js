// Prompts tab dialogs: paste-list import with live preview, "Assemble timeline", and the batch queue runner.
import { html, useState, useMemo, useEffect, useRef } from '../../../vendor/preact-htm.mjs';
import { useProject, useStore, usePage } from '../hooks.js';
import { Icon, Button, Modal, Select, Segmented, Toggle, NumberField, ProgressBar, EmptyState, toast, cx } from '../kit.js';
import * as M from '../../core/model.js';
import { pluralize, formatDuration } from '../../core/utils.js';
import { bridge } from '../../core/bridge.js';
import { REQ } from '../../../shared/protocol.js';
import * as S from '../../prompts/shots.js';
import { parsePromptListDetailed, FORMAT_LABELS } from '../../prompts/lists.js';
import { queueProgress } from '../../prompts/queue.js';
import { TakeThumb } from './common.js';
import { promptsUi, importItems, prefsStore, setPrefs, assembleFromShots, queueStore, queueRunner, startQueue, selectShot } from './state.js';

// ---------------------------------------------------------------------------------------------------------
// Paste list
// ---------------------------------------------------------------------------------------------------------

const EXAMPLE = `1. Wide shot of a lone rider cresting a dune at dawn, dust trailing behind
2. Close-up: the rider's eyes narrowing against the wind, golden backlight
3. **The City** — a drone sweeps over an abandoned desert city`;

export function PasteListModal({ initial, onClose }) {
  const [text, setText] = useState(initial?.text || '');
  const [excluded, setExcluded] = useState(new Set());
  const hasShots = useProject((p) => S.getShots(p).length > 0);
  const hasSelection = useStore(promptsUi, (s) => !!s.selectedId);
  const [position, setPosition] = useState(hasShots ? (hasSelection ? 'after' : 'end') : 'end');
  const connected = usePage((s) => s.connected);
  const taRef = useRef(null);
  const parsed = useMemo(() => parsePromptListDetailed(text), [text]);
  useEffect(() => setExcluded(new Set()), [text]);
  useEffect(() => {
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);
  const chosen = parsed.items.filter((_, i) => !excluded.has(i));
  const toggle = (i) =>
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const pull = async (type) => {
    try {
      if (type === 'clipboard') {
        const t = await navigator.clipboard.readText();
        if (t) setText(t);
        else toast('The clipboard is empty', { kind: 'info' });
        return;
      }
      const res = await bridge.request(type === 'reply' ? REQ.PAGE_LAST_REPLY : REQ.PAGE_SELECTION, {}, { timeout: 10000 });
      if (res?.text?.trim()) setText(res.text);
      else toast(type === 'reply' ? 'No Grok reply found on the page' : 'Nothing is selected on grok.com', { kind: 'warn' });
    } catch (e) {
      toast(type === 'clipboard' ? 'Clipboard access was blocked — paste with Ctrl+V instead' : `Couldn't read grok.com: ${e.message || e}`, { kind: 'error' });
    }
  };
  const doImport = () => {
    if (!chosen.length) return;
    const ids = importItems(chosen, { position });
    toast(`${position === 'replace' ? 'Replaced the list with' : 'Added'} ${pluralize(ids.length, 'shot')}`, { kind: 'success' });
    onClose();
  };
  const footer = html`
    ${hasShots &&
    html`<${Select}
      value=${position}
      onChange=${setPosition}
      title="Where to put the new shots"
      options=${[
        { value: 'after', label: 'After selected shot', disabled: !hasSelection },
        { value: 'end', label: 'At the end' },
        { value: 'replace', label: 'Replace all shots' },
      ]}
    />`}
    <span class="spacer"></span>
    <${Button} kind="ghost" onClick=${onClose}>Cancel<//>
    <${Button} kind=${position === 'replace' ? 'danger' : 'primary'} icon="plus" disabled=${!chosen.length} onClick=${doImport} data-testid="pr-paste-import">
      ${chosen.length ? `Import ${pluralize(chosen.length, 'shot')}` : 'Import'}
    <//>
  `;
  return html`<${Modal} title="Import a prompt list" width=${920} onClose=${onClose} class="pr-dialog pr-paste-dialog" footer=${footer} closeOnBackdrop=${false}>
    ${initial?.source && html`<div class="pr-paste-source"><${Icon} name="inbox" size=${13} /> ${initial.source}</div>`}
    <div class="pr-paste">
      <div class="pr-paste-input">
        <textarea
          ref=${taRef}
          class="text-field pr-paste-text"
          value=${text}
          placeholder=${`Paste prompts here — one per line, numbered, bullets, “Shot 3:” blocks, paragraphs, JSON, CSV or a Markdown table.\n\n${EXAMPLE}`}
          onInput=${(e) => setText(e.currentTarget.value)}
          data-testid="pr-paste-text"
        ></textarea>
        <div class="pr-paste-sources">
          <${Button} size="sm" kind="ghost" icon="copy" onClick=${() => pull('clipboard')}>Clipboard<//>
          <${Button} size="sm" kind="ghost" icon="sparkles" disabled=${!connected} onClick=${() => pull('reply')}>Grok’s last reply<//>
          <${Button} size="sm" kind="ghost" icon="quote" disabled=${!connected} onClick=${() => pull('selection')}>Page selection<//>
        </div>
      </div>
      <div class="pr-paste-preview">
        <div class="pr-paste-summary">
          ${parsed.items.length
            ? html`<b>${pluralize(parsed.items.length, 'shot')}</b><span class="muted"> · ${FORMAT_LABELS[parsed.format]}</span>${excluded.size ? html`<span class="muted"> · ${excluded.size} skipped</span>` : ''}`
            : html`<span class="muted">Nothing detected yet</span>`}
        </div>
        <div class="pr-paste-list" data-testid="pr-paste-preview">
          ${parsed.items.length
            ? parsed.items.map(
                (it, i) => html`<label class=${cx('pr-paste-item', excluded.has(i) && 'is-off')} key=${i}>
                  <input type="checkbox" checked=${!excluded.has(i)} onChange=${() => toggle(i)} />
                  <span class="pr-paste-num">${String(i + 1).padStart(2, '0')}</span>
                  <span class="pr-paste-body">
                    ${it.title && html`<b class="pr-paste-title">${it.title}</b>`}
                    <span class="pr-paste-prompt">${it.prompt}</span>
                    ${(it.duration || it.notes) && html`<span class="pr-paste-meta">${it.duration ? `${it.duration}s` : ''}${it.duration && it.notes ? ' · ' : ''}${it.notes || ''}</span>`}
                  </span>
                </label>`,
              )
            : html`<div class="pr-paste-empty muted small">Each detected prompt becomes a shot. Titles (“Shot 2: The chase — …”, **bold**, headings) and durations are picked up automatically.</div>`}
        </div>
      </div>
    </div>
  <//>`;
}

// ---------------------------------------------------------------------------------------------------------
// Assemble timeline
// ---------------------------------------------------------------------------------------------------------

const TRANSITION_OPTIONS = [{ value: 'cut', label: 'Cut (no transition)' }, ...M.TRANSITIONS.map((t) => ({ value: t.id, label: t.name }))];

export function AssembleDialog({ onClose }) {
  const shots = useProject((p) => S.getShots(p));
  const media = useProject((p) => p.media);
  const clipCount = useProject((p) => p.tracks.video.length);
  const prefs = useStore(prefsStore);
  const [busy, setBusy] = useState(null);
  const approvedOnly = prefs.assembleApproved;
  const plan = S.takesInShotOrder({ shots, media }, { approvedOnly });
  const run = async () => {
    setBusy('Assembling…');
    const res = await assembleFromShots({
      replace: prefs.assembleReplace,
      transition: prefs.assembleTransition === 'cut' ? null : { type: prefs.assembleTransition, duration: M.DEFAULT_TRANSITION_DURATION },
      approvedOnly,
      onWait: (n) => setBusy(`Waiting for ${pluralize(n, 'take')} to finish downloading…`),
    });
    setBusy(null);
    if (res) onClose();
  };
  const total = plan.used.reduce((s, u) => s + (media[u.mediaId]?.duration || (media[u.mediaId]?.kind === 'image' ? M.DEFAULT_IMAGE_DURATION : 0)), 0);
  return html`<${Modal} title="Assemble the timeline from shots" width=${560} onClose=${onClose} class="pr-dialog"
    footer=${html`<span class="muted small">${busy || `${pluralize(plan.used.length, 'clip')} · ≈${formatDuration(total)}`}</span><span class="spacer"></span>
      <${Button} kind="ghost" onClick=${onClose}>Cancel<//>
      <${Button} kind="primary" icon="film" disabled=${!plan.used.length || !!busy} onClick=${run} data-testid="pr-assemble-run">${prefs.assembleReplace ? 'Replace timeline' : 'Add to timeline'}<//>`}
  >
    <div class="pr-asm-list">
      ${shots.map((s, i) => {
        const use = plan.used.find((u) => u.shotId === s.id);
        const skippedForStatus = approvedOnly && s.status !== 'approved';
        const failed = plan.failed.includes(s.id);
        const state = use
          ? use.fallback
            ? `chosen take failed · take ${(s.takes || []).indexOf(use.mediaId) + 1}`
            : s.chosenTake === use.mediaId
              ? 'chosen take'
              : 'first take'
          : skippedForStatus
            ? 'not approved'
            : failed
              ? 'take failed to download'
              : 'no take';
        return html`<div class=${cx('pr-asm-row', !use && 'is-skipped', (failed || use?.fallback) && 'is-warn')} key=${s.id}>
          <span class="pr-asm-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="pr-asm-thumb">${use ? html`<${TakeThumb} mediaId=${use.mediaId} scrub=${false} />` : html`<${Icon} name=${failed ? 'alert' : 'film'} size=${14} />`}</span>
          <span class="pr-asm-name">${s.title || s.prompt || 'Untitled shot'}</span>
          <span class="pr-asm-state" title=${failed ? 'Retry the download in the Clips tab, or link another clip' : ''}>${state}</span>
        </div>`;
      })}
    </div>
    <div class="pr-asm-options">
      <${Segmented}
        value=${prefs.assembleReplace ? 'replace' : 'append'}
        onChange=${(v) => setPrefs({ assembleReplace: v === 'replace' })}
        options=${[
          { value: 'append', label: 'Append to timeline' },
          { value: 'replace', label: `Replace timeline${clipCount ? ` (${clipCount} clips)` : ''}` },
        ]}
      />
      <label class="pr-asm-field"><span class="field-label">Transition between shots</span><${Select} value=${prefs.assembleTransition} options=${TRANSITION_OPTIONS} onChange=${(v) => setPrefs({ assembleTransition: v })} /></label>
      <${Toggle} checked=${approvedOnly} onChange=${(v) => setPrefs({ assembleApproved: v })} label="Only approved shots" />
    </div>
    ${busy && html`<${ProgressBar} indeterminate=${true} />`}
  <//>`;
}

// ---------------------------------------------------------------------------------------------------------
// Batch queue
// ---------------------------------------------------------------------------------------------------------

const ITEM_LABEL = { queued: 'Queued', sending: 'Sending…', waiting: 'Waiting for Grok…', done: 'Sent', timeout: 'Timed out', error: 'Failed', skipped: 'Skipped' };

export function QueueDialog({ onClose }) {
  const shots = useProject((p) => S.getShots(p));
  const q = useStore(queueStore);
  const prefs = useStore(prefsStore);
  const connected = usePage((s) => s.connected);
  const running = q.status === 'running' || q.status === 'paused';
  const [scope, setScope] = useState('drafts');
  const candidates = shots.filter((s) => (s.prompt || '').trim() && (scope === 'all' || s.status === 'draft'));
  const prog = queueProgress(q);
  const byId = new Map(shots.map((s, i) => [s.id, { s, i }]));
  const showRun = running || q.items.length > 0;

  return html`<${Modal} title="Batch send to Grok" width=${600} onClose=${onClose} class="pr-dialog"
    footer=${html`
      ${running
        ? html`${q.status === 'paused' ? html`<${Button} icon="play" onClick=${() => queueRunner.resume()}>Resume<//>` : html`<${Button} icon="pause" onClick=${() => queueRunner.pause()}>Pause<//>`}
          <${Button} kind="danger" icon="x" onClick=${() => queueRunner.stop()}>Stop<//>`
        : q.items.length > 0 && html`<${Button} kind="ghost" onClick=${() => queueRunner.reset()}>Clear results<//>`}
      <span class="spacer"></span>
      <${Button} kind="ghost" onClick=${onClose}>${running ? 'Hide' : 'Close'}<//>
      ${!running && html`<${Button} kind="primary" icon="send" disabled=${!candidates.length || !connected} onClick=${() => startQueue(candidates.map((s) => s.id))} data-testid="pr-queue-start">Start · ${pluralize(candidates.length, 'shot')}<//>`}
    `}
  >
    <div class="pr-queue-warning">
      <${Icon} name="alert" size=${14} />
      <div>
        <b>Automatic sending.</b> Each shot’s prompt (and reference images, if enabled) is inserted into Grok and <b>submitted</b>, one after another,
        ${prefs.queueWait ? ' waiting until a new video shows up' : ''} with a pause in between. Keep the grok.com tab open on Grok Imagine. You can pause or stop at any time.
        Prefer full control? Close this and use <b>Send next</b>.
      </div>
    </div>
    ${!running &&
    html`<div class="pr-queue-form">
      <label class="pr-queue-field"><span class="field-label">Shots</span>
        <${Segmented} value=${scope} onChange=${setScope} options=${[{ value: 'drafts', label: 'Unsent drafts' }, { value: 'all', label: 'All shots' }]} />
      </label>
      <label class="pr-queue-field"><span class="field-label">Pause between shots</span><${NumberField} value=${prefs.queueDelay} min=${0} max=${600} suffix="s" width=${84} onChange=${(v) => setPrefs({ queueDelay: v })} /></label>
      <label class="pr-queue-field"><span class="field-label">Give up waiting after</span><${NumberField} value=${prefs.queueTimeout} min=${10} max=${1800} suffix="s" width=${84} onChange=${(v) => setPrefs({ queueTimeout: v })} /></label>
      <${Toggle} checked=${prefs.queueWait} onChange=${(v) => setPrefs({ queueWait: v })} label="Wait for each video before sending the next shot" />
      <${Toggle} checked=${prefs.attachRefs} onChange=${(v) => setPrefs({ attachRefs: v })} label="Attach reference images" />
      ${!connected && html`<div class="pr-hint is-warn"><${Icon} name="alert" size=${13} /> Open grok.com (Imagine) to run a batch.</div>`}
    </div>`}
    ${showRun &&
    html`<div class="pr-queue-run">
      <div class="pr-queue-run-head">
        <b>${running ? (q.status === 'paused' ? 'Paused' : 'Running') : q.status === 'done' ? 'Finished' : q.status === 'stopped' ? 'Stopped' : 'Batch'}</b>
        <span class="muted"> · ${prog.done}/${prog.total}${prog.failed ? ` · ${prog.failed} need attention` : ''}</span>
      </div>
      <${ProgressBar} value=${prog.total ? prog.done / prog.total : 0} />
      ${q.error && html`<div class="pr-hint is-err"><${Icon} name="alert" size=${13} /> ${q.error}</div>`}
      <div class="pr-queue-items">
        ${q.items.map((it) => {
          const info = byId.get(it.shotId);
          return html`<button type="button" class=${cx('pr-queue-item', `is-${it.status}`)} key=${it.shotId} onClick=${() => info && selectShot(it.shotId)} title=${it.error || ''}>
            <span class="pr-queue-num">${info ? String(info.i + 1).padStart(2, '0') : '—'}</span>
            <span class="pr-queue-name">${info ? info.s.title || info.s.prompt : 'Deleted shot'}</span>
            <span class="pr-queue-state">${it.status === 'sending' || it.status === 'waiting' ? html`<span class="spinner" style="width:11px;height:11px"></span>` : null}${ITEM_LABEL[it.status] || it.status}</span>
          </button>`;
        })}
      </div>
    </div>`}
    ${!showRun && !candidates.length && html`<${EmptyState} compact=${true} icon="send" title="Nothing to send">${scope === 'drafts' ? 'Every shot with a prompt has been sent. Choose “All shots” to send them again.' : 'Write prompts for your shots first.'}<//>`}
  <//>`;
}

