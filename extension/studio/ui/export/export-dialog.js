// Export dialog: render the sequence to MP4 / WebM, grab a PNG frame at the playhead, or mix the sound down to WAV.
// Flow: settings -> running (stage, %, frames, ETA, live preview, cancel) -> result (preview, download, add to bin)
// or error. The last used settings are remembered per project in project.exportSettings.
import { html, useState, useEffect, useRef, useMemo } from '../../../vendor/preact-htm.mjs';
import { projectStore, uiStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { formatTime, formatDuration, formatBytes, downloadBlob, copyImage, clamp, pluralize } from '../../core/utils.js';
import { addBlobAsMedia, retryMedia } from '../../core/media.js';
import { appEvents } from '../../core/app-state.js';
import { useProject, useEvent } from '../hooks.js';
import { useHotkeys } from '../hotkeys.js';
import { Modal, Button, IconButton, Icon, Select, Segmented, Toggle, TextField, NumberField, TimeField, Field, EmptyState, Kbd, Spinner, ProgressBar, toast, confirmDialog, cx } from '../kit.js';
import {
  getExportCapabilities,
  exportProject,
  exportFrame,
  exportAudioWav,
  exportProblems,
  pictureTail,
  hasAudibleContent,
  videoBitrateFor,
  audioBitrateFor,
  estimateExportBytes,
  evenDimensions,
  resolveRange,
  QUALITY_PRESETS,
  EXPORT_FORMATS,
  CODEC_LABELS,
} from '../../engine/exporter.js';

const FORMATS = [
  { id: 'mp4', icon: 'film', label: 'MP4', sub: 'Video for any player' },
  { id: 'webm', icon: 'film', label: 'WebM', sub: 'Open web video' },
  { id: 'png', icon: 'image', label: 'PNG', sub: 'Frame at playhead' },
  { id: 'wav', icon: 'wave', label: 'WAV', sub: 'Audio mixdown' },
];

const STAGES = {
  prepare: 'Preparing media…',
  audio: 'Mixing audio…',
  video: 'Rendering frames…',
  frame: 'Rendering frame…',
  finalize: 'Finalizing file…',
  done: 'Done',
};
const QUALITY_OPTIONS = Object.values(QUALITY_PRESETS).map((q) => ({ value: q.id, label: q.label }));
const WAV_RATE = 48000;
const MIN_SIZE = 16;
const MAX_SIZE = 7680;
/** Seconds of picture-less ending (music or titles past the last clip) before the summary points it out. */
const TAIL_NOTE_MIN = 1;

const DEFAULTS = Object.freeze({
  format: 'mp4',
  size: 'project', // 'project' | RESOLUTION_PRESETS id | 'custom'
  customW: null,
  customH: null,
  customRatio: null, // width / height kept while the aspect lock is on
  lockAspect: true,
  fps: null, // null = sequence frame rate
  quality: 'high',
  range: 'all', // 'all' | 'markers' | 'custom'
  markerFrom: null,
  markerTo: null,
  rangeStart: null,
  rangeEnd: null,
  includeAudio: true,
  name: null, // custom base file name (null = sequence name)
});

/** Remembered settings merged over defaults, with anything stale or invalid dropped. */
function initialSettings(project) {
  const saved = project.exportSettings && typeof project.exportSettings === 'object' ? project.exportSettings : {};
  const s = { ...DEFAULTS, ...saved };
  if (!EXPORT_FORMATS[s.format]) s.format = DEFAULTS.format;
  if (s.size !== 'project' && s.size !== 'custom' && !M.RESOLUTION_PRESETS.some((p) => p.id === s.size)) s.size = 'project';
  if (!QUALITY_PRESETS[s.quality]) s.quality = DEFAULTS.quality;
  if (!['all', 'markers', 'custom'].includes(s.range)) s.range = 'all';
  if (s.fps != null && !(Number(s.fps) > 0)) s.fps = null;
  if (!(Number(s.customRatio) > 0)) s.customRatio = null;
  if (typeof s.name !== 'string' || !s.name.trim()) s.name = null;
  return s;
}

const baseName = (project, settings) => (settings.name || project.name || 'sequence').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'sequence';
const sortedMarkers = (project) => [...(project.markers || [])].sort((a, b) => a.time - b.time);
const evenSize = (v) => clamp(Math.round(v / 2) * 2, MIN_SIZE, MAX_SIZE);

/** Output frame size for the chosen preset. */
function outputSize(project, s) {
  const { width, height } = project.settings;
  if (s.size === 'custom') return { width: s.customW || width, height: s.customH || height };
  const preset = M.RESOLUTION_PRESETS.find((p) => p.id === s.size);
  return preset ? { width: preset.width, height: preset.height } : { width, height };
}

/** Timeline range for the chosen mode; `arg` is what the exporter takes (null = whole sequence). */
function rangeFor(project, s, duration) {
  if (s.range === 'markers') {
    const ms = sortedMarkers(project);
    if (ms.length >= 2) {
      const a = ms.find((m) => m.id === s.markerFrom) || ms[0];
      const b = ms.find((m) => m.id === s.markerTo) || ms[ms.length - 1];
      const r = resolveRange({ start: Math.min(a.time, b.time), end: Math.max(a.time, b.time) }, duration);
      return { ...r, arg: r };
    }
  }
  if (s.range === 'custom') {
    const r = resolveRange({ start: s.rangeStart ?? 0, end: s.rangeEnd ?? duration }, duration);
    return { ...r, arg: r };
  }
  return { start: 0, end: duration, arg: null };
}

/** Trims the audio so it ends with the last main-track clip (1 s fade-out), as the Edit tab's "Fit to video end". */
function fitAudioToVideoEnd() {
  const before = projectStore.get();
  const after = projectStore.update(
    (p) => {
      const next = M.fitAudioToVideo(p);
      return JSON.stringify(next.tracks.audio) === JSON.stringify(p.tracks.audio) ? p : next;
    },
    { label: 'Fit audio to video' },
  );
  if (after === before) return;
  // Undo only that step: background updates (downloads, remembered export settings) leave the audio track alone.
  const stillFitted = () => projectStore.get().tracks.audio === after.tracks.audio && projectStore.undoLabel() === 'Fit audio to video';
  toast('The audio now ends with the last clip (1 s fade-out)', {
    kind: 'success',
    duration: 8000,
    action: { label: 'Undo', run: () => stillFitted() && projectStore.undo() },
  });
}

/**
 * Summary note for a video export whose end has no picture — music or titles running on past the last clip would
 * otherwise add seconds of plain background colour without warning. Offers to end the export (or the audio) with
 * the last clip. Null when the pictures reach the end of the range (or miss it by under TAIL_NOTE_MIN).
 */
function tailNote(project, layout, range, set) {
  const tail = pictureTail(project, range);
  if (!tail || tail.duration < TAIL_NOTE_MIN) return null;
  const over = [tail.sound && 'sound', tail.titles && 'titles'].filter(Boolean).join(' and ');
  const shows = over ? `only ${over} over the background colour` : 'only the background colour';
  if (!tail.clips) {
    const text = layout.video.length ? `No clips in this range — the video shows ${shows}.` : `There are no clips on the timeline — the video shows ${shows}.`;
    return { kind: 'info', text };
  }
  const actions = [];
  if (layout.audio.some((it) => it.end > layout.videoEnd + 1e-3)) {
    actions.push({ label: 'Fit audio to video', icon: 'arrow-right', title: 'Trim the audio so it ends with the last clip, with a 1 s fade-out (undoable)', onClick: fitAudioToVideoEnd });
  }
  actions.push({
    label: `End at ${formatTime(tail.from)}`,
    icon: 'scissors',
    title: 'Export only up to the last frame of the last clip (Custom range)',
    onClick: () => set({ range: 'custom', rangeStart: range.start, rangeEnd: tail.from }),
  });
  return {
    kind: tail.sound || !tail.titles ? 'warn' : 'info', // titles alone over the end are often a deliberate end card
    text: `The last ${formatDuration(tail.duration)} have no picture — ${shows}.`,
    actions,
  };
}

/** Preview raster for an output aspect ratio: 480 px on the long side. */
function previewSize(aspect) {
  const a = aspect > 0 ? aspect : 16 / 9;
  return a >= 1 ? { width: 480, height: Math.max(2, Math.round(480 / a)) } : { width: Math.max(2, Math.round(480 * a)), height: 480 };
}

/**
 * Small object-URL preview of the composited frame at t (PNG mode), framed like the export (same aspect ratio,
 * so each clip's Fit setting reframes it the same way). Keeps the previous image while rendering.
 */
function useFramePreview(enabled, t, aspect, project) {
  const [state, setState] = useState({ url: null, error: null, loading: false });
  const urlRef = useRef(null);
  useEffect(() => () => urlRef.current && URL.revokeObjectURL(urlRef.current), []);
  useEffect(() => {
    if (!enabled) return undefined;
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(async () => {
      try {
        const box = previewSize(aspect);
        const blob = await exportFrame(project, t, { ...box, type: 'image/jpeg', quality: 0.85, signal: ac.signal });
        if (ac.signal.aborted) return;
        const prev = urlRef.current;
        urlRef.current = URL.createObjectURL(blob);
        setState({ url: urlRef.current, error: null, loading: false });
        if (prev) URL.revokeObjectURL(prev);
      } catch (e) {
        if (!ac.signal.aborted) setState((s) => ({ ...s, error: e.message || String(e), loading: false }));
      }
    }, 180);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [enabled, t, aspect, project]);
  return state;
}

/** Re-renders the calling component every `ms` while mounted (for clocks). */
function useTicker(ms) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// ---------------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------------

function FormatPicker({ value, onChange, caps, frameTime }) {
  const sub = (f) => {
    if (f.id === 'png') return `Frame ${formatTime(frameTime)}`;
    if (!caps || f.id === 'wav') return f.sub;
    const c = caps[f.id];
    if (!c.video) return 'Not supported here';
    return [CODEC_LABELS[c.video], c.audio && CODEC_LABELS[c.audio]].filter(Boolean).join(' + ');
  };
  return html`<div class="ex-formats" role="radiogroup" aria-label="Export format">
    ${FORMATS.map((f) => {
      const unavailable = caps && (f.id === 'mp4' || f.id === 'webm') && !caps[f.id].video;
      return html`<button
        type="button"
        key=${f.id}
        role="radio"
        aria-checked=${value === f.id ? 'true' : 'false'}
        class=${cx('ex-format', value === f.id && 'is-active', unavailable && 'is-unavailable')}
        data-format=${f.id}
        onClick=${() => onChange(f.id)}
      >
        <span class="ex-format-icon"><${Icon} name=${f.icon} size=${16} /></span>
        <span class="ex-format-text">
          <span class="ex-format-label">${f.label}</span>
          <span class="ex-format-sub">${sub(f)}</span>
        </span>
      </button>`;
    })}
  </div>`;
}

function ResolutionField({ project, settings, set }) {
  const { width: pw, height: ph } = project.settings;
  const options = [
    { value: 'project', label: `Sequence · ${pw}×${ph}` },
    ...M.RESOLUTION_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    { value: 'custom', label: 'Custom size…' },
  ];
  const size = outputSize(project, settings);
  // The locked ratio is stored, never re-derived from rounded sizes, so repeated edits don't drift.
  const ratio = settings.customRatio || size.width / size.height || pw / ph || 16 / 9;
  const setW = (w) => set(settings.lockAspect ? { customW: w, customH: evenSize(w / ratio), customRatio: ratio } : { customW: w });
  const setH = (h) => set(settings.lockAspect ? { customH: h, customW: evenSize(h * ratio), customRatio: ratio } : { customH: h });
  const toggleLock = () => set(settings.lockAspect ? { lockAspect: false } : { lockAspect: true, customRatio: size.width / size.height });
  const toCustom = () => {
    const w = settings.customW || size.width;
    const h = settings.customH || size.height;
    set({ size: 'custom', customW: w, customH: h, customRatio: w / h });
  };
  const reshaped = Math.abs(size.width / size.height - pw / ph) > 0.01;
  return html`<${Field}
    label="Resolution"
    hint=${reshaped ? 'Different shape than the sequence — each clip is reframed by its Fit setting.' : null}
  >
    <${Select} value=${settings.size} options=${options} onChange=${(v) => (v === 'custom' ? toCustom() : set({ size: v }))} />
    ${settings.size === 'custom' &&
    html`<div class="ex-custom-size">
      <${NumberField} value=${settings.customW || size.width} min=${MIN_SIZE} max=${MAX_SIZE} step=${2} width=${84} suffix="w" title="Width (px)" onChange=${setW} />
      <span class="ex-times">×</span>
      <${NumberField} value=${settings.customH || size.height} min=${MIN_SIZE} max=${MAX_SIZE} step=${2} width=${84} suffix="h" title="Height (px)" onChange=${setH} />
      <${IconButton}
        icon="link"
        size="sm"
        active=${settings.lockAspect}
        title=${settings.lockAspect ? 'Aspect ratio locked' : 'Aspect ratio unlocked'}
        onClick=${toggleLock}
      />
    </div>`}
  <//>`;
}

function RangeField({ project, settings, set, range, duration, fps }) {
  const markers = sortedMarkers(project);
  const options = [
    { value: 'all', label: 'Whole sequence' },
    ...(markers.length >= 2 ? [{ value: 'markers', label: 'Markers', title: 'Between two timeline markers' }] : []),
    { value: 'custom', label: 'Custom', title: 'Pick start and end times' },
  ];
  const mode = settings.range === 'markers' && markers.length < 2 ? 'all' : settings.range;
  const markerOptions = markers.map((m, i) => ({ value: m.id, label: `${m.label || `Marker ${i + 1}`} · ${formatTime(m.time)}` }));
  const label = html`<span>Range</span><span class="ex-label-aside">${formatTime(range.start)} – ${formatTime(range.end)} · ${formatDuration(range.end - range.start)}</span>`;
  return html`<${Field} label=${label} class="ex-range">
    <${Segmented} value=${mode} options=${options} onChange=${(v) => set({ range: v })} />
    ${mode === 'markers' &&
    html`<div class="ex-range-detail">
      <span class="ex-range-label">From</span>
      <${Select} value=${settings.markerFrom || markers[0].id} options=${markerOptions} onChange=${(v) => set({ markerFrom: v })} />
      <span class="ex-range-label">to</span>
      <${Select} value=${settings.markerTo || markers[markers.length - 1].id} options=${markerOptions} onChange=${(v) => set({ markerTo: v })} />
    </div>`}
    ${mode === 'custom' &&
    html`<div class="ex-range-detail">
      <span class="ex-range-label">From</span>
      <${TimeField} value=${range.start} fps=${fps} min=${0} max=${duration} onChange=${(v) => set({ rangeStart: v, rangeEnd: settings.rangeEnd ?? duration })} />
      <span class="ex-range-label">to</span>
      <${TimeField} value=${range.end} fps=${fps} min=${0} max=${duration} onChange=${(v) => set({ rangeEnd: v, rangeStart: settings.rangeStart ?? 0 })} />
      <${Button} size="sm" kind="ghost" icon="clock" title="Start the range at the playhead" onClick=${() => set({ rangeStart: clamp(uiStore.get().playhead, 0, duration), rangeEnd: settings.rangeEnd ?? duration })}>Playhead<//>
    </div>`}
  <//>`;
}

function FileNameField({ project, settings, set, ext, onEnter }) {
  const [text, setText] = useState(settings.name ?? project.name);
  return html`<${Field} label="File name">
    <div class="ex-filename">
      <${TextField}
        value=${text}
        spellcheck=${false}
        aria-label="File name"
        placeholder=${project.name}
        onInput=${(v) => {
          setText(v);
          set({ name: v.trim() && v.trim() !== project.name ? v.trim() : null });
        }}
        onCommit=${(v) => !v.trim() && setText(project.name)}
        onKeyDown=${(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <span class="ex-ext mono">.${ext}</span>
    </div>
  <//>`;
}

function Note({ kind = 'info', actions = null, children }) {
  return html`<div class=${cx('ex-note', `ex-note-${kind}`)}>
    <${Icon} name=${kind === 'warn' || kind === 'error' ? 'alert' : 'info'} size=${14} />
    ${actions?.length
      ? html`<div class="ex-note-main">
          <span>${children}</span>
          <div class="ex-note-actions">
            ${actions.map((a) => html`<${Button} size="sm" icon=${a.icon} key=${a.label} title=${a.title} onClick=${a.onClick}>${a.label}<//>`)}
          </div>
        </div>`
      : html`<span>${children}</span>`}
  </div>`;
}

function Summary({ chips, notes, loading }) {
  return html`<div class="ex-summary">
    <div class="ex-chips">
      ${chips.filter(Boolean).map((c) => html`<span class=${cx('ex-chip', c.strong && 'is-strong')} key=${c.label} title=${c.title}>${c.icon && html`<${Icon} name=${c.icon} size=${12} />`}${c.label}</span>`)}
      ${loading && html`<span class="ex-chip ex-chip-muted"><${Spinner} size=${11} /> Checking encoders…</span>`}
    </div>
    ${notes.filter(Boolean).map((n) => html`<${Note} kind=${n.kind} actions=${n.actions} key=${n.text}>${n.text}<//>`)}
  </div>`;
}

function ProblemsBanner({ problems }) {
  if (!problems.length) return null;
  const failed = problems.filter((p) => p.status === 'error');
  const waiting = problems.length - failed.length;
  const title = failed.length
    ? `${pluralize(failed.length, 'clip')} failed to download${waiting ? ` · ${waiting} still downloading` : ''}`
    : `Waiting for ${pluralize(waiting, 'clip')} to finish downloading…`;
  const names = [...failed, ...problems.filter((p) => p.status !== 'error')].map((p) => p.name);
  return html`<div class=${cx('ex-banner', failed.length ? 'is-error' : 'is-waiting')}>
    ${failed.length ? html`<${Icon} name="alert" size=${16} />` : html`<${Spinner} size=${15} />`}
    <div class="ex-banner-text">
      <div class="ex-banner-title">${title}</div>
      <div class="ex-banner-body" title=${names.join(', ')}>${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''}</div>
    </div>
    ${failed.length > 0 && html`<${Button} size="sm" icon="refresh" onClick=${() => failed.forEach((p) => retryMedia(p.mediaId))}>Retry<//>`}
  </div>`;
}

function ProgressView({ progress, kind, liveRef, aspect, startedAt }) {
  useTicker(500); // keeps "elapsed" moving even while a stage reports nothing
  const determinate = kind !== 'image';
  const pct = Math.round((progress.progress || 0) * 100);
  const elapsed = Math.max(0, (performance.now() - startedAt) / 1000);
  const showFrames = kind === 'video' && progress.frames > 0 && (progress.stage === 'video' || progress.stage === 'finalize');
  const ar = aspect || 16 / 9;
  const live = previewSize(ar);
  return html`<div class="ex-progress" aria-live="polite">
    ${kind === 'video'
      ? html`<div class="ex-live" style=${`--ar:${ar}`}>
          <canvas ref=${liveRef} width=${live.width} height=${live.height}></canvas>
          <span class="ex-live-badge"><span class="ex-rec-dot"></span>Rendering</span>
        </div>`
      : html`<div class="ex-progress-icon"><${Icon} name=${kind === 'audio' ? 'wave' : 'image'} size=${28} /></div>`}
    <div class="ex-progress-head">
      <span class="ex-stage">${STAGES[progress.stage] || 'Working…'}</span>
      ${determinate && html`<span class="ex-pct">${pct}%</span>`}
    </div>
    <${ProgressBar} value=${progress.progress || 0} indeterminate=${!determinate} />
    <div class="ex-progress-meta">
      ${showFrames && html`<span>Frame ${Math.min(progress.frame, progress.frames)} / ${progress.frames}</span>`}
      <span class="ex-elapsed">${formatDuration(elapsed)} elapsed</span>
      ${progress.eta != null && progress.stage === 'video' && html`<span>~${formatDuration(Math.max(1, progress.eta))} left</span>`}
    </div>
  </div>`;
}

function ResultView({ result, onAnother }) {
  const meta = [
    formatBytes(result.blob.size),
    result.kind !== 'image' && formatTime(result.duration || 0),
    result.width && `${result.width}×${result.height}`,
    result.kind === 'video' && `${result.fps} fps`,
    result.codecs,
  ].filter(Boolean);
  const ar = result.width && result.height ? result.width / result.height : 16 / 9;
  return html`<div class=${cx('ex-result', `ex-result-${result.kind}`)}>
    <div class="ex-result-media" style=${`--ar:${ar}`}>
      ${result.kind === 'video' && html`<video src=${result.url} controls playsinline preload="metadata"></video>`}
      ${result.kind === 'image' && html`<img src=${result.url} alt="Exported frame" />`}
      ${result.kind === 'audio' &&
      html`<div class="ex-audio">
        <div class="ex-audio-icon"><${Icon} name="wave" size=${26} /></div>
        <audio src=${result.url} controls preload="metadata"></audio>
      </div>`}
    </div>
    <div class="ex-result-info">
      <div class="ex-result-title">
        <span class="ex-ok"><${Icon} name="check" size=${13} /></span>
        <span>Export complete</span>
        ${result.ms > 0 && html`<span class="ex-result-time">in ${formatDuration(result.ms / 1000)}</span>`}
        <span class="spacer"></span>
        <${Button} kind="ghost" size="sm" icon="refresh" class="ex-another" onClick=${onAnother}>Export another<//>
      </div>
      <div class="ex-result-name" title=${result.filename}>${result.filename}</div>
      <div class="ex-result-meta">${meta.map((m) => html`<span key=${m}>${m}</span>`)}</div>
    </div>
    ${result.warnings?.length > 0 &&
    html`<div class="ex-result-notes">${result.warnings.map((w, i) => html`<${Note} kind="warn" key=${i}>${w.message}<//>`)}</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------------------------------------

/** Export dialog (mounted by the app shell while uiStore.exportOpen is true). */
export function ExportDialog({ onClose }) {
  const project = useProject((p) => p);
  const [settings, setSettings] = useState(() => initialSettings(projectStore.get()));
  const [frameTime, setFrameTime] = useState(() => uiStore.get().playhead || 0);
  const [phase, setPhase] = useState('settings'); // settings | running | done | error
  const [progress, setProgress] = useState(null);
  const [startedAt, setStartedAt] = useState(0);
  const [stopAsk, setStopAsk] = useState(false); // inline "Stop the export?" while rendering
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [caps, setCaps] = useState(null);
  const [capsError, setCapsError] = useState(null);
  const [saved, setSaved] = useState({ bin: false, download: false });
  const [adding, setAdding] = useState(false);
  const abortRef = useRef(null);
  const liveRef = useRef(null);
  const resultRef = useRef(null);
  resultRef.current = result;

  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const layout = useMemo(() => M.layoutProject(project), [project]);
  const duration = layout.duration;
  const fmt = EXPORT_FORMATS[settings.format];
  const isVideo = fmt.kind === 'video';
  const fps = Number(settings.fps) || project.settings.fps || 30;
  const rawSize = outputSize(project, settings);
  const size = isVideo ? evenDimensions(rawSize.width, rawSize.height) : { width: Math.round(rawSize.width), height: Math.round(rawSize.height) };
  const aspect = size.width / size.height;
  const range = rangeFor(project, settings, duration);
  const span = Math.max(0, range.end - range.start);
  const audible = hasAudibleContent(project, { start: range.start, end: range.end });
  const withAudio = isVideo && settings.includeAudio && audible;
  const pngTime = clamp(frameTime, 0, Math.max(0, duration - 1e-3));
  const problems = useMemo(() => {
    if (settings.format === 'png') return exportProblems(project, { start: pngTime, end: pngTime + 1e-3, audio: false });
    if (settings.format === 'wav') return exportProblems(project, { start: range.start, end: range.end, video: false });
    return exportProblems(project, { start: range.start, end: range.end, audio: settings.includeAudio });
  }, [project, settings.format, settings.includeAudio, range.start, range.end, pngTime]);

  // Encoder capabilities for the chosen size (debounced while typing a custom size).
  const capsKey = `${size.width}x${size.height}@${fps}`;
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      getExportCapabilities({ width: size.width, height: size.height, fps })
        .then((c) => alive && (setCaps(c), setCapsError(null)))
        .catch((e) => alive && setCapsError(e.message || String(e)));
    }, caps ? 250 : 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [capsKey]);

  const preview = useFramePreview(phase === 'settings' && settings.format === 'png' && duration > 0, pngTime, aspect, project);

  // Abort a running export and release the result when the dialog goes away.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (resultRef.current?.url) URL.revokeObjectURL(resultRef.current.url);
    },
    [],
  );

  // The inline stop confirmation only exists while rendering; focus its safe choice when it appears.
  useEffect(() => {
    if (phase !== 'running') setStopAsk(false);
  }, [phase]);
  useEffect(() => {
    if (stopAsk) document.querySelector('.ex-modal .ex-keep')?.focus({ preventScroll: true });
  }, [stopAsk]);

  const fmtCaps = isVideo && caps ? caps[settings.format] : null;
  const videoCodec = fmtCaps?.video ?? null;
  const audioCodec = withAudio ? fmtCaps?.audio ?? null : null;
  const videoBitrate = isVideo ? videoBitrateFor({ ...size, fps, quality: settings.quality }) : 0;
  const audioBitrate = audioBitrateFor(settings.quality);
  const unsupported = isVideo && caps && !videoCodec;
  const canExport = duration > 0 && !problems.length && !unsupported && span > 0;
  const name = baseName(project, settings);
  const filename = `${name}.${fmt.ext}`;

  const startExport = useEvent(async () => {
    if (!canExport || phase === 'running') return;
    const p = projectStore.get();
    const remembered = { ...settings };
    projectStore.update((cur) => ({ ...cur, exportSettings: remembered }), { history: false });
    const ac = new AbortController();
    abortRef.current = ac;
    // Callbacks of a run the user cancelled must not touch the dialog (a new run may already be going).
    const current = () => abortRef.current === ac && !ac.signal.aborted;
    const onProgress = (pr) => current() && setProgress(pr);
    const t0 = performance.now();
    setError(null);
    setStartedAt(t0);
    setProgress({ progress: 0, stage: settings.format === 'png' ? 'frame' : 'prepare', frame: 0, frames: 0, eta: null });
    setPhase('running');
    const warnings = [];
    const onWarning = (w) => warnings.push(w);
    try {
      let out;
      if (settings.format === 'png') {
        const blob = await exportFrame(p, pngTime, { width: size.width, height: size.height, signal: ac.signal });
        out = { blob, kind: 'image', width: size.width, height: size.height, duration: 0 };
      } else if (settings.format === 'wav') {
        const blob = await exportAudioWav(p, { range: range.arg, signal: ac.signal, onProgress, onWarning });
        out = { blob, kind: 'audio', duration: span, codecs: 'PCM 16-bit · 48 kHz stereo' };
      } else {
        const r = await exportProject(p, {
          format: settings.format,
          width: size.width,
          height: size.height,
          fps,
          quality: settings.quality,
          range: range.arg,
          includeAudio: settings.includeAudio,
          signal: ac.signal,
          onProgress,
          onWarning,
          onFrame: (canvas) => {
            const c = liveRef.current;
            if (c && current()) c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
          },
        });
        out = { ...r, kind: 'video', codecs: [CODEC_LABELS[r.videoCodec], r.audioCodec && CODEC_LABELS[r.audioCodec]].filter(Boolean).join(' + ') };
      }
      if (!current()) return; // cancelled meanwhile: the dialog is already back on the settings
      out.filename = filename;
      out.name = name;
      out.warnings = warnings;
      out.url = URL.createObjectURL(out.blob);
      out.ms = performance.now() - t0;
      setSaved({ bin: false, download: false });
      setResult(out);
      setPhase('done');
    } catch (e) {
      if (ac.signal.aborted) return; // cancelExport() already reset the dialog (or it closed)
      console.warn('[gis] export failed', e);
      setError(e?.message || String(e));
      setPhase('error');
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  });

  /** Stops the running export right away; its late callbacks and result are ignored. */
  const cancelExport = () => {
    const ac = abortRef.current;
    if (!ac) return false;
    abortRef.current = null;
    ac.abort();
    setProgress(null);
    setPhase('settings');
    toast('Export cancelled');
    return true;
  };

  const stopAndClose = useEvent(() => {
    if (phase !== 'running' || !cancelExport()) {
      setStopAsk(false);
      return;
    }
    onClose();
  });

  const resetToSettings = () => {
    if (result?.url) URL.revokeObjectURL(result.url);
    setResult(null);
    setError(null);
    setPhase('settings');
  };

  const requestClose = useEvent(async () => {
    if (phase === 'running') {
      setStopAsk(true); // asked inline in the footer, which follows the render live
      return;
    }
    if (phase === 'done' && result?.kind === 'video' && !saved.bin && !saved.download) {
      const discard = await confirmDialog({
        title: 'Discard this export?',
        message: `"${result.filename}" hasn't been downloaded or added to the bin yet.`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep it',
        danger: true,
      });
      if (!discard) return;
    }
    onClose();
  });

  useHotkeys({
    enter: (e) => {
      if (phase !== 'settings' || !canExport) return false;
      const control = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="radio"], [role="tab"], summary') : null;
      if (control) {
        // A focused button or link keeps its own Enter. On a choice (format tile, segmented option) Enter first
        // selects it; on the current choice it starts the export, like Enter in a form.
        const choice = control.matches('[role="radio"], .segmented > button');
        const current = control.getAttribute('aria-checked') === 'true' || control.classList.contains('is-active');
        if (!choice || !current) return false;
      }
      startExport();
      return undefined;
    },
    'mod+enter': () => (phase === 'settings' && canExport ? startExport() : false),
    // Escape answers an open stop question with "keep rendering"; otherwise the modal's Escape closes.
    escape: () => (phase === 'running' && stopAsk ? setStopAsk(false) : false),
  });

  const download = async (saveAs = false) => {
    try {
      await downloadBlob(result.blob, result.filename, { saveAs });
      setSaved((s) => ({ ...s, download: true }));
      if (!saveAs) toast(`Downloading ${result.filename}`, { kind: 'success' });
    } catch (e) {
      const msg = e?.message || String(e);
      if (/cancel/i.test(msg)) return; // the Save As dialog was dismissed
      toast(`Download failed: ${msg}`, { kind: 'error' });
    }
  };

  const addToBin = async () => {
    setAdding(true);
    try {
      const id = await addBlobAsMedia(result.blob, { name: result.name, origin: 'export', kind: result.kind });
      setSaved((s) => ({ ...s, bin: true }));
      toast(`Added "${result.name}" to the bin`, {
        kind: 'success',
        action: {
          label: 'Show',
          run: () => {
            appEvents.emit('source.open', { mediaId: id });
            onClose();
          },
        },
      });
    } catch (e) {
      toast(`Could not add to bin: ${e.message || e}`, { kind: 'error' });
    } finally {
      setAdding(false);
    }
  };

  // ------------------------------------------------------------------------------------------- render

  const title = phase === 'running' ? 'Exporting…' : phase === 'done' ? 'Export ready' : 'Export';

  if (!(duration > 0) && phase === 'settings') {
    // From the Edit tab, "go to the Edit tab" would only close the dialog: point to where clips come from instead.
    const onEdit = uiStore.get().tab === 'edit';
    const goTo = (tab) => {
      uiStore.set((s) => ({ ...s, tab }));
      onClose();
    };
    const action = onEdit
      ? html`<div class="ex-empty-actions">
          <${Button} kind="primary" icon="film" onClick=${() => goTo('clips')}>Collect clips<//>
          <${Button} kind="ghost" onClick=${onClose}>Close<//>
        </div>`
      : html`<${Button} kind="primary" icon="scissors" onClick=${() => goTo('edit')}>Go to the Edit tab<//>`;
    return html`<${Modal} title=${title} width=${560} class="ex-modal" onClose=${onClose}>
      <${EmptyState} icon="film" title="Nothing to export yet" action=${action}>
        ${onEdit
          ? 'Your timeline is empty. Collect your best Grok clips in the Clips tab (or drag them from the bin here onto the timeline), trim them and add music or transitions — then render an MP4 or WebM here, grab a PNG frame, or mix the sound down to WAV.'
          : 'Your timeline is empty. Pick your best Grok clips in the Clips tab, drop them on the timeline in the Edit tab, trim them and add music or transitions — then render an MP4 or WebM here, grab a PNG frame, or mix the sound down to WAV.'}
      <//>
    <//>`;
  }

  let body;
  let footer;
  if (phase === 'running' && progress) {
    body = html`<${ProgressView} progress=${progress} kind=${fmt.kind} liveRef=${liveRef} aspect=${aspect} startedAt=${startedAt} />`;
    footer = stopAsk
      ? html`<div class="ex-stop" role="alert">
            <${Icon} name="alert" size=${16} />
            <span class="ex-stop-text"><strong>Stop the export?</strong><span class="ex-stop-sub">The partial file is discarded.</span></span>
          </div>
          <span class="spacer"></span>
          <${Button} kind="ghost" class="ex-keep" onClick=${() => setStopAsk(false)}>Keep rendering<//>
          <${Button} kind="danger" icon="x" class="ex-stop-btn" onClick=${stopAndClose}>Stop export<//>`
      : html`<span class="ex-footer-hint muted small">${filename}</span><span class="spacer"></span><${Button} kind="danger" icon="x" onClick=${() => cancelExport()}>Cancel export<//>`;
  } else if (phase === 'done' && result) {
    body = html`<${ResultView} result=${result} onAnother=${resetToSettings} />`;
    footer = html`
      ${result.kind === 'image' &&
      html`<${IconButton}
          icon="copy"
          title="Copy image to clipboard"
          kind="solid"
          onClick=${() => copyImage(result.blob).then(() => toast('Frame copied', { kind: 'success' }), (e) => toast(`Copy failed: ${e.message || e}`, { kind: 'error' }))}
        />
        <${IconButton}
          icon="images"
          title="Use as a reference image (Ingredients)"
          kind="solid"
          onClick=${() => {
            appEvents.emit('ingredient.add', { blob: result.blob, name: result.name, origin: 'export', sourceUrl: null });
            toast('Sent to Ingredients', { kind: 'success' });
          }}
        />`}
      <${Button} icon=${saved.bin ? 'check' : 'plus'} disabled=${adding || saved.bin} onClick=${addToBin} class="ex-add-bin">${saved.bin ? 'In bin' : adding ? 'Adding…' : 'Add to bin'}<//>
      <${IconButton} icon="folder" kind="solid" title="Save as… (choose a folder)" onClick=${() => download(true)} />
      <${Button} kind="primary" icon="download" onClick=${() => download(false)} class="ex-download">Download<//>`;
  } else if (phase === 'error') {
    body = html`<div class="ex-error">
      <${EmptyState} icon="alert" title="Export failed" compact=${true}>${error}<//>
    </div>`;
    footer = html`<${Button} kind="ghost" onClick=${resetToSettings}>Back to settings<//><span class="spacer"></span><${Button} kind="primary" icon="refresh" onClick=${startExport}>Try again<//>`;
  } else {
    const chips = [];
    const notes = [];
    if (isVideo) {
      if (videoCodec) chips.push({ label: [CODEC_LABELS[videoCodec], audioCodec && CODEC_LABELS[audioCodec]].filter(Boolean).join(' · '), strong: true, icon: 'film' });
      chips.push({ label: `${size.width}×${size.height}` }, { label: `${fps} fps` }, { label: formatTime(span), icon: 'clock' });
      chips.push({ label: `≈ ${formatBytes(estimateExportBytes({ duration: span, videoBitrate, audioBitrate: audioCodec ? audioBitrate : 0 }))}`, title: 'Estimated file size' });
      if (unsupported) notes.push({ kind: 'error', text: settings.format === 'mp4' ? `This browser can't encode H.264 at ${size.width}×${size.height}. Pick a smaller size or WebM.` : `This browser can't encode WebM video at ${size.width}×${size.height}. Pick a smaller size or MP4.` });
      if (settings.format === 'mp4' && caps && withAudio) {
        if (caps.aacEncoder === 'wasm') notes.push({ kind: 'info', text: 'AAC audio is encoded with the built-in encoder (this browser has no native AAC encoder).' });
        else if (!caps.aacEncoder && audioCodec === 'opus') notes.push({ kind: 'warn', text: 'AAC isn’t available, so this MP4 gets Opus audio. It plays in Chrome, Firefox and VLC; some editors and Apple apps may not. Choose WebM for the widest Opus support.' });
      }
      if (withAudio && caps && !audioCodec) notes.push({ kind: 'warn', text: 'No audio encoder is available — the video will be silent.' });
      if (!audible) notes.push({ kind: 'info', text: 'Nothing on the timeline makes sound in this range — the file will have no audio track.' });
      notes.push(tailNote(project, layout, range, set));
    } else if (settings.format === 'png') {
      chips.push({ label: 'PNG', strong: true, icon: 'image' }, { label: `${size.width}×${size.height}` }, { label: formatTime(pngTime), icon: 'clock' });
    } else {
      chips.push({ label: 'WAV · PCM 16-bit', strong: true, icon: 'wave' }, { label: '48 kHz stereo' }, { label: formatTime(span), icon: 'clock' }, { label: `≈ ${formatBytes(44 + Math.ceil(span * WAV_RATE) * 4)}` });
      if (!audible) notes.push({ kind: 'warn', text: 'Nothing on the timeline makes sound in this range — the WAV will be silent.' });
    }
    if (capsError) notes.push({ kind: 'error', text: `Couldn't check encoders: ${capsError}` });

    body = html`<div class="ex-body">
      <${FormatPicker} value=${settings.format} onChange=${(format) => set({ format })} caps=${caps} frameTime=${pngTime} />
      <${ProblemsBanner} problems=${problems} />
      ${settings.format === 'png' &&
      html`<div class="ex-frame">
        <div class="ex-frame-preview checker" style=${`--ar:${aspect}`}>
          ${preview.url && html`<img src=${preview.url} alt="Frame preview" />`}
          ${preview.loading && !preview.url && html`<${Spinner} size=${20} />`}
          ${preview.error && html`<span class="ex-frame-error small">${preview.error}</span>`}
        </div>
        <div class="ex-grid">
          <${Field} label="Frame">
            <div class="ex-row">
              <${TimeField} value=${pngTime} fps=${fps} min=${0} max=${duration} onChange=${setFrameTime} />
              <${Button} size="sm" kind="ghost" icon="target" title="Use the timeline playhead" onClick=${() => setFrameTime(uiStore.get().playhead || 0)}>Playhead<//>
            </div>
          <//>
          <${ResolutionField} project=${project} settings=${settings} set=${set} />
        </div>
      </div>`}
      ${isVideo &&
      html`<div class="ex-grid">
          <${ResolutionField} project=${project} settings=${settings} set=${set} />
          <${Field} label="Frame rate">
            <${Select}
              value=${String(fps)}
              options=${[...new Set([...M.FPS_PRESETS, project.settings.fps || 30])].sort((a, b) => a - b).map((v) => ({ value: String(v), label: `${v} fps${v === project.settings.fps ? ' (sequence)' : ''}` }))}
              onChange=${(v) => set({ fps: Number(v) === project.settings.fps ? null : Number(v) })}
            />
          <//>
        </div>
        <${Field} label=${html`<span>Quality</span><span class="ex-label-aside" title="Video bitrate">${(videoBitrate / 1e6).toFixed(1)} Mbps video${withAudio ? ` · ${Math.round(audioBitrate / 1000)} kbps audio` : ''}</span>`}>
          <${Segmented} value=${settings.quality} options=${QUALITY_OPTIONS} onChange=${(quality) => set({ quality })} />
        <//>`}
      ${settings.format !== 'png' && html`<${RangeField} project=${project} settings=${settings} set=${set} range=${range} duration=${duration} fps=${fps} />`}
      ${isVideo &&
      html`<div class="ex-audio-toggle">
        <${Toggle}
          checked=${settings.includeAudio && audible}
          disabled=${!audible}
          label="Include audio"
          onChange=${(includeAudio) => set({ includeAudio })}
        />
        <span class="muted small">${audible ? 'Clip sound, music and voice, mixed and limited' : 'No sound on the timeline'}</span>
      </div>`}
      <${FileNameField} project=${project} settings=${settings} set=${set} ext=${fmt.ext} onEnter=${startExport} />
      <${Summary} chips=${chips} notes=${notes} loading=${isVideo && !caps && !capsError} />
    </div>`;
    footer = html`
      <span class="ex-footer-hint muted small"><${Kbd}>Enter<//> to export</span>
      <span class="spacer"></span>
      <${Button} kind="ghost" onClick=${onClose}>Cancel<//>
      <${Button} kind="primary" icon="download" disabled=${!canExport} onClick=${startExport} class="ex-start">
        ${settings.format === 'png' ? 'Export frame' : settings.format === 'wav' ? 'Export audio' : 'Export video'}
      <//>`;
  }

  return html`<${Modal} title=${title} width=${640} class=${cx('ex-modal', `is-${phase}`)} onClose=${requestClose} closeOnBackdrop=${phase !== 'running'} footer=${footer}>
    ${body}
  <//>`;
}
