// Variations generator: pick builder fields to vary and their options (preset chips or your own), preview the count,
// and create one new shot per combination right after the current shot. A hand-written prompt is kept (only the varied
// phrases change); a prompt composed from the builder fields is recomposed (variationPrompt in prompts/variations.js).
import { html, useState, useMemo } from '../../../vendor/preact-htm.mjs';
import { useLibrary, useStore } from '../hooks.js';
import { Icon, Button, NumberField, toast, cx } from '../kit.js';
import { projectStore } from '../../core/store.js';
import { pluralize } from '../../core/utils.js';
import * as S from '../../prompts/shots.js';
import { BUILDER_FIELDS, orderFor } from '../../prompts/compose.js';
import { presetGroupsFor } from '../../prompts/presets.js';
import { variations, countVariations, variationPrompt } from '../../prompts/variations.js';
import { PrSection } from './common.js';
import { prefsStore, selectShot, flushPending } from './state.js';

const VARY_FIELDS = BUILDER_FIELDS.filter((f) => !['subject', 'action', 'extra'].includes(f.key));
const MAX = 50;

export function VariationsSection({ shot }) {
  const custom = useLibrary((l) => l.presets);
  const order = useStore(prefsStore, (p) => p.order);
  const [keys, setKeys] = useState([]);
  const [opts, setOpts] = useState({});
  const [limit, setLimit] = useState(12);
  const [draft, setDraft] = useState({});
  const count = countVariations(keys, opts);
  const willCreate = Math.min(count, limit);
  const sample = useMemo(() => variations(shot.fields || {}, keys, opts, 3), [shot.fields, keys, opts]);

  const toggleKey = (k) => setKeys((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  const toggleOpt = (k, text) => setOpts((o) => ({ ...o, [k]: (o[k] || []).includes(text) ? o[k].filter((x) => x !== text) : [...(o[k] || []), text] }));
  const addOwn = (k) => {
    const t = (draft[k] || '').trim();
    if (!t) return;
    setOpts((o) => ({ ...o, [k]: [...new Set([...(o[k] || []), t])] }));
    setDraft((d) => ({ ...d, [k]: '' }));
  };

  const promptFor = (v, base = shot) => variationPrompt(base, v, orderFor(order));
  /** Short chip label for a chosen option (titles stay readable), else the option text itself. */
  const labelFor = (key, text) => {
    const hit = presetGroupsFor(key, custom).flatMap((g) => g.items).find((it) => it.text === text);
    const l = hit ? hit.label : text;
    return l.length > 32 ? `${l.slice(0, 31)}…` : l;
  };

  const create = () => {
    flushPending(); // a prompt edit still being typed belongs to the base
    const p = projectStore.get();
    const src = S.findShot(p, shot.id) || shot;
    const list = variations(src.fields || {}, keys, opts, limit);
    if (!list.length) return;
    const idx = S.shotIndex(p, shot.id);
    const base = src.title || `Shot ${idx + 1}`;
    let ids = [];
    projectStore.update(
      (q) => {
        const r = S.addShots(
          q,
          list.map((v) => ({
            title: `${base} · ${keys.filter((k) => v.changes[k]).map((k) => labelFor(k, v.changes[k])).join(' · ')}`,
            fields: v.fields,
            prompt: promptFor(v, src).prompt,
            ingredientIds: shot.ingredientIds || [],
            duration: shot.duration,
            mode: shot.mode,
            notes: shot.notes,
          })),
          idx + 1,
        );
        ids = r.ids;
        return r.project;
      },
      { label: `Create ${pluralize(list.length, 'variation')}` },
    );
    if (ids[0]) selectShot(ids[0]);
    toast(`Created ${pluralize(ids.length, 'variation')} after shot ${idx + 1}`, { kind: 'success', action: { label: 'Undo', run: () => projectStore.undo() } });
    setOpts({});
    setKeys([]);
  };

  return html`<${PrSection} id="variations" title="Variations" icon="shuffle">
    <div class="pr-var-intro muted small">Generate several versions of this shot — e.g. 3 camera moves × 2 lighting setups = 6 shots to send and compare.</div>
    <div class="pr-var-keys">
      ${VARY_FIELDS.map((f) => html`<button type="button" key=${f.key} class=${cx('chip', keys.includes(f.key) && 'is-active')} onClick=${() => toggleKey(f.key)}>${f.label}</button>`)}
    </div>
    ${keys.map((k) => {
      const field = BUILDER_FIELDS.find((f) => f.key === k);
      const chosen = opts[k] || [];
      const presets = presetGroupsFor(k, custom).flatMap((g) => g.items);
      const own = chosen.filter((t) => !presets.some((p) => p.text === t));
      return html`<div class="pr-var-field" key=${k}>
        <div class="pr-var-field-head"><b>${field.label}</b><span class="muted tiny">${chosen.length} selected</span></div>
        <div class="pr-chips">
          ${[...own.map((t) => ({ label: t, text: t })), ...presets].map((it) => {
            const on = chosen.includes(it.text);
            return html`<button type="button" key=${it.text} class=${cx('chip', 'pr-chip', on && 'is-active')} title=${it.text} onClick=${() => toggleOpt(k, it.text)}>${on && html`<${Icon} name="check" size=${11} />`}${it.label}</button>`;
          })}
        </div>
        <div class="pr-var-own">
          <input class="text-field" type="text" placeholder=${`Your own ${field.label.toLowerCase()}…`} value=${draft[k] || ''} onInput=${(e) => setDraft((d) => ({ ...d, [k]: e.currentTarget.value }))} onKeyDown=${(e) => e.key === 'Enter' && addOwn(k)} />
          <${Button} size="sm" onClick=${() => addOwn(k)}>Add<//>
        </div>
      </div>`;
    })}
    ${sample.length > 0 &&
    (() => {
      const ex = promptFor(sample[0]);
      return html`<div class="pr-var-sample">
        <div class="pr-var-sample-label">Example <span class="pr-var-base">${ex.base === 'fields' ? '· rebuilt from the builder fields' : '· your prompt, with the varied phrases'}</span></div>
        <div class="pr-var-sample-text">${ex.prompt}</div>
      </div>`;
    })()}
    <div class="pr-var-foot">
      <span class="muted small">${count ? `${count} combination${count > 1 ? 's' : ''}${count > limit ? ` · a varied ${limit} will be created` : ''}` : keys.length ? 'Choose options for each field' : 'Choose fields to vary'}</span>
      <span class="spacer"></span>
      <label class="pr-var-limit muted small">Max <${NumberField} value=${limit} min=${1} max=${MAX} width=${58} onChange=${(v) => setLimit(Math.round(v))} /></label>
      <${Button} size="sm" kind="primary" icon="shuffle" disabled=${!willCreate} onClick=${create} data-testid="pr-var-create">Create ${willCreate || ''} shot${willCreate === 1 ? '' : 's'}<//>
    </div>
  <//>`;
}
