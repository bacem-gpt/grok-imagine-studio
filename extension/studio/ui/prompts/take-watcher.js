// Take watcher: links new grok.com videos (and Grok clips that reach the bin) whose prompt matches a sent shot, or
// offers them for confirmation when auto-link is off. Module-level so it runs from boot, not only while the Prompts
// tab is open. Every candidate is decided once (state.js markHandled): linked, offered, dismissed or unlinked media
// are never linked again automatically — not after an Unlink, an undo/redo or a reload.
import { projectStore, pageStore } from '../../core/store.js';
import { collectPageItems } from '../../core/app-state.js';
import { pluralize, throttle } from '../../core/utils.js';
import { toast } from '../kit.js';
import * as S from '../../prompts/shots.js';
import { matchTakes, pageCandidates, binCandidates } from '../../prompts/match.js';
import { setUi, prefsStore, selectShot, isHandled, markHandled, mediaKeys } from './state.js';

/** Every decision key a candidate is known by (its own key, its bin media, the bin media's grok.com item). */
function candidateKeys(c, project) {
  const m = c.mediaId ? project.media[c.mediaId] : null;
  return [c.key, c.pageItem ? `page:${c.pageItem.key}` : null, ...mediaKeys(m)].filter(Boolean);
}

/**
 * Links matched candidates to their shots, importing grok.com items into the bin first. A generation is ONE undo
 * step: new bin items are added by importPageItems ("Add to bin") and their links ride along with that step
 * (history: false right after it, so undo removes both); links to media that were already in the bin form their own
 * "Link new take" step. Returns the number of links made.
 * @param {Array<{shotId: string, candidate: object}>} pairs
 */
export async function linkCandidates(pairs) {
  if (!pairs.length) return 0;
  const before = projectStore.get();
  const pageItems = pairs.filter((x) => !x.candidate.mediaId && x.candidate.pageItem).map((x) => x.candidate.pageItem);
  const imported = pageItems.length ? await collectPageItems(pageItems) : [];
  const byKey = new Map(pageItems.map((it, i) => [it.key, imported[i]]));
  const now = projectStore.get();
  const links = pairs
    .map(({ shotId, candidate }) => ({ shotId, mediaId: candidate.mediaId || byKey.get(candidate.pageItem?.key) }))
    .filter((l) => l.mediaId && now.media[l.mediaId] && S.findShot(now, l.shotId));
  if (!links.length) return 0;
  markHandled(links.flatMap((l) => mediaKeys(now.media[l.mediaId])));
  const fresh = links.filter((l) => !before.media[l.mediaId]);
  const known = links.filter((l) => before.media[l.mediaId]);
  if (fresh.length) projectStore.update((q) => S.linkTakes(q, fresh), { history: false });
  if (known.length) projectStore.update((q) => S.linkTakes(q, known), { label: known.length > 1 ? 'Link new takes' : 'Link new take' });
  return links.length;
}

let busy = false;
let again = false;

async function run() {
  if (busy) {
    again = true;
    return;
  }
  const p = projectStore.get();
  if (!p) return;
  const shots = S.getShots(p).filter((s) => s.sentAt);
  if (!shots.length) return;
  const cands = [...pageCandidates(pageStore.get().items, p), ...binCandidates(p)].filter((c) => !candidateKeys(c, p).some(isHandled));
  if (!cands.length) return;
  // A page item already in the bin is the same candidate as its bin entry: keep one.
  const seenMedia = new Set();
  const unique = cands.filter((c) => (c.mediaId ? !seenMedia.has(c.mediaId) && seenMedia.add(c.mediaId) : true));
  const matches = matchTakes({ shots, candidates: unique });
  if (!matches.length) return;
  markHandled(matches.flatMap((m) => candidateKeys(m.candidate, p)));
  if (!prefsStore.get().autoLink) {
    setUi((s) => {
      const offers = { ...s.offers };
      for (const m of matches) offers[m.shotId] = [...(offers[m.shotId] || []).filter((c) => c.key !== m.candidate.key), m.candidate];
      return { offers };
    });
    return;
  }
  busy = true;
  try {
    const n = await linkCandidates(matches);
    if (n) {
      const first = matches[0].shotId;
      const idx = S.shotIndex(projectStore.get(), first);
      const shotsHit = new Set(matches.map((m) => m.shotId)).size;
      toast(shotsHit > 1 ? `Linked ${pluralize(n, 'new take')} to ${shotsHit} shots` : `Linked ${pluralize(n, 'new take')} to shot ${idx + 1}`, {
        kind: 'success',
        action: { label: 'Show', run: () => selectShot(first, { reveal: true }) },
      });
    }
  } catch (e) {
    console.warn('[gis] auto-link failed', e);
    toast(`Couldn't link the new takes: ${e.message || e}`, { kind: 'error' });
  } finally {
    busy = false;
    if (again) {
      again = false;
      check();
    }
  }
}

const check = throttle(() => {
  run().catch((e) => console.warn('[gis] take watcher failed', e));
}, 800);

pageStore.subscribe(check);
projectStore.subscribe(check);
