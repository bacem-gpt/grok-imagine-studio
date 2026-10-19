// MediaThumb: the bin thumbnail used across the studio. Poster image with hover-scrub over the filmstrip (the mouse x
// picks the frame cell), duration badge, kind icon, flag badge, an "On timeline" chip (with the count when used more
// than once), waveform for audio, and loading / error overlays (with Retry). Reusable by any tab:
//   <${MediaThumb} mediaId=${id} />                       fills its parent (give the parent a size / aspect-ratio)
//   props: scrub (hover filmstrip), fit 'cover'|'contain', class, showFlag, showKind, showDuration, showUsage,
//          badges (extra badges after the kind / flag ones), onScrub(fraction|null) — while scrubbing, the position
//          (0..1) of the frame on screen.
import { html, useState, useEffect, useRef } from '../../../vendor/preact-htm.mjs';
import { getPreviews, getPeaks, retryMedia, onMediaEvent } from '../../core/media.js';
import { formatDuration, clamp } from '../../core/utils.js';
import { useProject } from '../hooks.js';
import { Icon, Spinner, toast, cx } from '../kit.js';
import { mediaUsageCounts, stripCell } from './bin-logic.js';

const KIND_ICON = { video: 'film', image: 'image', audio: 'music' };
const STAGE_LABEL = { download: 'Downloading…', probe: 'Analyzing…', previews: 'Making previews…' };

/** Preview object URLs for a media id; never returns another id's previews while the new ones load. */
export function usePreviews(mediaId, enabled = true) {
  const [state, setState] = useState({ id: null, previews: null });
  useEffect(() => {
    if (!mediaId || !enabled) return undefined;
    let alive = true;
    const load = () =>
      getPreviews(mediaId)
        .then((p) => alive && setState({ id: mediaId, previews: p }))
        .catch(() => alive && setState({ id: mediaId, previews: null }));
    load();
    const off = onMediaEvent((e) => {
      if (e.id === mediaId && e.type === 'ready') load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [mediaId, enabled]);
  return state.id === mediaId ? state.previews : null;
}

/** Latest processing stage ('download' | 'probe' | 'previews') of a media item while it loads. */
function useMediaStage(mediaId, loading) {
  const [stage, setStage] = useState(null);
  useEffect(() => {
    if (!loading) return undefined;
    setStage(null);
    return onMediaEvent((e) => {
      if (e.id === mediaId && e.type === 'progress') setStage(e.stage || null);
    });
  }, [mediaId, loading]);
  return loading ? stage : null;
}

/** Draws min/max peak pairs (see media.js getPeaks) into a canvas as a centred waveform. */
export function drawPeaks(canvas, peaks, { color = '#3ddc97', gain = 0.92 } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const n = peaks ? peaks.length / 2 : 0;
  if (!n) return;
  const mid = h / 2;
  ctx.fillStyle = color;
  for (let x = 0; x < w; x++) {
    const s = Math.floor((x / w) * n);
    const e = Math.max(s + 1, Math.floor(((x + 1) / w) * n));
    let mn = 1;
    let mx = -1;
    for (let i = s; i < e && i < n; i++) {
      if (peaks[2 * i] < mn) mn = peaks[2 * i];
      if (peaks[2 * i + 1] > mx) mx = peaks[2 * i + 1];
    }
    if (mn > mx) continue;
    const y1 = mid - mx * mid * gain;
    const y2 = mid - mn * mid * gain;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

/** Waveform of an audio item (peaks are only requested once the media is ready: earlier calls would cache "no audio"). */
export function Waveform({ mediaId, ready, color = '#3ddc97', class: klass = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ready || !mediaId) return undefined;
    let alive = true;
    getPeaks(mediaId)
      .then((peaks) => {
        if (alive && peaks && ref.current) drawPeaks(ref.current, peaks, { color });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mediaId, ready, color]);
  return html`<canvas class=${cx('clips-wave', klass)} width="320" height="96" ref=${ref} aria-hidden="true"></canvas>`;
}

async function retry(e, id) {
  e.stopPropagation();
  try {
    const ok = await retryMedia(id);
    if (!ok) toast('Still could not load this media. The link may have expired: re-open the post on grok.com, or import the file.', { kind: 'error', duration: 6000 });
  } catch (err) {
    toast(`Retry failed: ${err.message || err}`, { kind: 'error' });
  }
}

export function MediaThumb({
  mediaId,
  scrub = true,
  fit = 'cover',
  class: klass = '',
  showFlag = false,
  showKind = true,
  showDuration = true,
  showUsage = true,
  badges = null,
  onScrub = null,
}) {
  const media = useProject((p) => p.media[mediaId] || null);
  const usage = useProject((p) => (showUsage ? mediaUsageCounts(p).get(mediaId) || 0 : 0));
  const status = media?.status || 'error';
  const loading = status === 'pending' || status === 'loading';
  const previews = usePreviews(mediaId, !!media && status !== 'error');
  const stage = useMediaStage(mediaId, loading);
  const [hover, setHover] = useState(null); // {cell, frac}
  const [failedSrc, setFailedSrc] = useState(null); // a thumb URL that failed to load (compared, never reset)

  if (!media) {
    return html`<div class=${cx('clips-thumb', 'is-missing', klass)}><div class="clips-thumb-status"><${Icon} name="alert" size=${16} /><span>Missing</span></div></div>`;
  }
  const kind = media.kind;
  const stripCount = previews?.strip ? previews.stripCount || 0 : 0;
  const canScrub = scrub && kind === 'video' && stripCount > 0 && status === 'ready';
  const onMove = (e) => {
    if (!canScrub || e.pointerType === 'touch') return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const frac = clamp(x / Math.max(1, r.width), 0, 1);
    const cell = stripCell(x, r.width, stripCount);
    setHover((h) => (h && h.cell === cell && Math.abs(h.frac - frac) < 0.004 ? h : { cell, frac }));
    onScrub?.((cell + 0.5) / stripCount); // the filmstrip cell samples the middle of its slice
  };
  const onLeave = () => {
    if (!hover) return;
    setHover(null);
    onScrub?.(null);
  };
  const scrubbing = canScrub && hover;
  const stripPos = stripCount > 1 && hover ? (hover.cell / (stripCount - 1)) * 100 : 0;
  const thumb = previews?.thumb && previews.thumb !== failedSrc ? previews.thumb : null;

  return html`<div
    class=${cx('clips-thumb', `is-${kind}`, `fit-${fit}`, scrubbing && 'is-scrubbing', status === 'error' && 'is-error', loading && 'is-loading', klass)}
    onPointerMove=${onMove}
    onPointerLeave=${onLeave}
  >
    ${thumb
      ? html`<img class="clips-thumb-img" src=${thumb} alt="" loading="lazy" draggable="false" onError=${() => setFailedSrc(thumb)} />`
      : kind === 'audio'
        ? html`<${Waveform} mediaId=${mediaId} ready=${status === 'ready'} />`
        : html`<div class="clips-thumb-placeholder">${status === 'ready' && html`<${Icon} name=${KIND_ICON[kind] || 'film'} size=${22} />`}</div>`}
    ${scrubbing &&
    html`<div class="clips-thumb-strip" style=${`background-image:url("${previews.strip}");background-size:${stripCount * 100}% 100%;background-position:${stripPos}% 0`}></div>
      <div class="clips-thumb-scrubline" style=${`width:${hover.frac * 100}%`}></div>`}
    <div class="clips-thumb-tl">
      ${showKind && html`<span class=${cx('clips-thumb-kind', `is-${kind}`)} title=${kind}><${Icon} name=${KIND_ICON[kind] || 'film'} size=${11} /></span>`}
      ${showFlag && media.flag === 'pick' && html`<span class="clips-thumb-flag is-pick" title="Picked"><${Icon} name="check" size=${11} /></span>`}
      ${showFlag && media.flag === 'reject' && html`<span class="clips-thumb-flag is-reject" title="Rejected"><${Icon} name="x" size=${11} /></span>`}
      ${badges}
    </div>
    ${usage > 0 &&
    html`<span class=${cx('clips-thumb-used', usage > 1 && 'is-multi')} title=${usage > 1 ? `On the timeline ${usage} times` : 'On the timeline'}>
      <span class="clips-thumb-used-label">On timeline</span><span class="clips-thumb-used-n">${usage}×</span>
    </span>`}
    ${showDuration && kind !== 'image' && media.duration > 0 && html`<span class="clips-thumb-dur">${formatDuration(media.duration)}</span>`}
    ${loading &&
    html`<div class="clips-thumb-status">
      <${Spinner} size=${18} />
      <span>${status === 'pending' ? 'Queued…' : STAGE_LABEL[stage] || 'Loading…'}</span>
    </div>`}
    ${status === 'error' &&
    html`<div class="clips-thumb-status is-error" title=${media.error || 'Could not load this media'}>
      <${Icon} name="alert" size=${16} />
      <span>Couldn't load</span>
      <button type="button" class="clips-thumb-retry" onClick=${(e) => retry(e, mediaId)} onDblClick=${(e) => e.stopPropagation()}>
        <${Icon} name="refresh" size=${12} /><span>Retry</span>
      </button>
    </div>`}
  </div>`;
}
