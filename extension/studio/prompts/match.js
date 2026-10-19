// Take matching: decides which newly generated grok.com media belong to which sent shot, by comparing the media's
// prompt with the prompt text that was sent (Grok may echo it verbatim, truncate it, or lightly rewrite it).
// Pure: no DOM.

import { contentWords, normalizeForMatch } from './text.js';

export const DEFAULT_MATCH_THRESHOLD = 0.6;
/**
 * Media first seen up to this long before the send was recorded still counts (sentAt is stamped when grok.com
 * confirms the insert, a moment after the submit). A generation can't exist before its prompt was submitted, so
 * anything older is an earlier video and is never linked.
 */
export const DEFAULT_SLACK_MS = 3_000;

/**
 * Similarity of two prompts in 0..1. Blends the overlap coefficient (robust to truncation / added words) with the
 * Jaccard index (penalises very different lengths). Identical normalised text scores 1.
 */
export function promptSimilarity(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = contentWords(a);
  const B = contentWords(b);
  if (!A.length || !B.length) return 0;
  const setB = new Set(B);
  let inter = 0;
  for (const w of A) if (setB.has(w)) inter++;
  const overlap = inter / Math.min(A.length, B.length);
  const jaccard = inter / (A.length + B.length - inter);
  let score = 0.6 * overlap + 0.4 * jaccard;
  // Very short prompts need (almost) all their words to match.
  if (Math.min(A.length, B.length) <= 3 && overlap < 1) score *= 0.6;
  // One text being a prefix of the other (Grok truncating long prompts) is strong evidence.
  if (na.length >= 24 && nb.length >= 24 && (na.startsWith(nb.slice(0, 60)) || nb.startsWith(na.slice(0, 60)))) score = Math.max(score, 0.85);
  return Math.round(score * 1000) / 1000;
}

/**
 * Pairs candidate media with sent shots.
 * @param {{
 *   shots: Array<{id, sentAt, sentText, prompt, mode?}>,
 *   candidates: Array<{key, kind, prompt, seenAt}>,   // page items or bin media (seenAt = first detection / addedAt)
 *   threshold?: number, slackMs?: number, kinds?: string[]
 * }} args
 * @returns {Array<{shotId: string, candidate: object, score: number}>}  best shot per candidate (ties -> latest send)
 */
export function matchTakes({ shots = [], candidates = [], threshold = DEFAULT_MATCH_THRESHOLD, slackMs = DEFAULT_SLACK_MS, kinds = null } = {}) {
  const sent = shots.filter((s) => s && s.sentAt && (s.sentText || s.prompt));
  if (!sent.length) return [];
  const out = [];
  for (const c of candidates) {
    if (!c || !c.prompt) continue;
    const seen = Number(c.seenAt) || 0;
    let best = null;
    for (const s of sent) {
      const wantKinds = kinds || (s.mode === 'image' ? ['image'] : ['video']);
      if (c.kind && !wantKinds.includes(c.kind)) continue;
      if (seen && seen < s.sentAt - slackMs) continue;
      const score = promptSimilarity(c.prompt, s.sentText || s.prompt);
      if (score < threshold) continue;
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && s.sentAt > best.sentAt)) best = { shotId: s.id, score, sentAt: s.sentAt };
    }
    if (best) out.push({ shotId: best.shotId, candidate: c, score: best.score });
  }
  return out;
}

/** Candidates from grok.com PageMedia items not yet in the bin (or in the bin but unlinked). */
export function pageCandidates(items, project) {
  const byKey = new Map();
  for (const id of project?.mediaOrder || []) {
    const m = project.media[id];
    if (m?.pageKey) byKey.set(m.pageKey, m);
  }
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it?.key || !it.prompt) continue;
    const inBin = byKey.get(it.key);
    if (inBin?.shotId) continue;
    out.push({ key: `page:${it.key}`, kind: it.kind, prompt: it.prompt, seenAt: it.seenAt || 0, pageItem: it, mediaId: inBin?.id || null });
  }
  return out;
}

/** Candidates from bin media that came from Grok, carry a prompt and aren't linked to a shot yet. */
export function binCandidates(project) {
  const out = [];
  for (const id of project?.mediaOrder || []) {
    const m = project.media[id];
    if (!m || m.shotId || !m.prompt || m.origin !== 'grok') continue;
    out.push({ key: `media:${id}`, kind: m.kind, prompt: m.prompt, seenAt: m.addedAt || 0, mediaId: id });
  }
  return out;
}
