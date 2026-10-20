// Voice-over recording (iMovie's "Record voiceover"): a 3-2-1 count-in on the program monitor, then the microphone is
// recorded with MediaRecorder while the timeline plays from the playhead (the preview can be muted meanwhile so it
// doesn't bleed into the mic). Stop with the REC badge, by pausing playback, or when the sequence ends. The recording
// becomes an audio item in the bin and an audio clip at the start time on a free lane, with "Duck other audio" on.
//
// Inside grok.com the studio is an iframe: the overlay grants it `allow="microphone"`, but the page's own permissions
// policy can still block it — the error toast then offers to open the studio in its own tab, where the mic works.

import { html, useEffect, useState } from '../../../vendor/preact-htm.mjs';
import { createStore, projectStore } from '../../core/store.js';
import * as M from '../../core/model.js';
import { bridge } from '../../core/bridge.js';
import { formatTime } from '../../core/utils.js';
import { pickRecorderMime, recordingExtension, micErrorInfo } from '../../engine/audio-fx.js';
import { useStore } from '../hooks.js';
import { Icon, toast, showMenu } from '../kit.js';
import { setSelection } from './actions.js';

const COUNT_IN = 3;
const PREF_KEY = 'gis:voiceover:mutePreview';

/** {phase: 'idle'|'countdown'|'recording'|'saving', count, start (timeline s), since (performance.now())} */
export const voiceOverStore = createStore({ phase: 'idle', count: 0, start: 0, since: 0 });

let run = null; // the recording in progress: {stream, recorder, chunks, start, mime, cancelled, offState, wasMuted}

/** Whether the preview is muted while recording (remembered per browser). Default: muted (no feedback loop). */
export function mutePreviewPref() {
  try {
    return localStorage.getItem(PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

function setMutePreviewPref(on) {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    /* not persisted */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openInTab() {
  try {
    chrome.runtime.sendMessage({ gis: 'open-tab' })?.catch?.(() => {});
  } catch {
    toast('Could not open the studio in a tab', { kind: 'error' });
  }
}

function releaseStream(stream) {
  for (const tr of stream?.getTracks?.() || []) tr.stop();
}

/**
 * Starts a voice-over at the playhead: asks for the microphone, counts in 3-2-1 on the monitor, then records while
 * the timeline plays. Resolves once recording has started (or failed).
 */
export async function startVoiceOver(session, { mutePreview = mutePreviewPref() } = {}) {
  if (voiceOverStore.get().phase !== 'idle') return false;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('This browser can’t record audio here', { kind: 'error' });
    return false;
  }
  if (session.isPlaying()) session.pause();
  const start = session.time();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    console.warn('[gis] microphone unavailable', e);
    const info = micErrorInfo(e, { embedded: bridge.mode === 'embedded' });
    toast(info.message, { kind: 'error', duration: 10000, action: info.tab ? { label: 'Open in a tab', run: openInTab } : null });
    return false;
  }
  run = { stream, recorder: null, chunks: [], start, mime: '', cancelled: false, offState: null, wasMuted: null };
  const mine = run;
  for (let n = COUNT_IN; n > 0; n--) {
    voiceOverStore.set({ phase: 'countdown', count: n, start, since: 0 });
    await sleep(1000);
    if (mine.cancelled) return false;
  }
  try {
    mine.mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
    mine.recorder = new MediaRecorder(stream, mine.mime ? { mimeType: mine.mime } : undefined);
  } catch (e) {
    releaseStream(stream);
    run = null;
    voiceOverStore.set({ phase: 'idle', count: 0, start: 0, since: 0 });
    toast(`Could not start recording: ${e.message || e}`, { kind: 'error' });
    return false;
  }
  mine.recorder.ondataavailable = (e) => e.data?.size && mine.chunks.push(e.data);
  mine.recorder.start(250);
  const player = session.player;
  if (mutePreview && player) {
    mine.wasMuted = player.muted;
    player.setMuted(true);
  }
  voiceOverStore.set({ phase: 'recording', count: 0, start, since: performance.now() });
  if (start < session.duration() - 0.05) {
    session.play();
    // Pausing (Space, the play button) or reaching the end of the sequence stops the take.
    mine.offState = session.onState((s) => {
      if (!s.playing && run === mine && voiceOverStore.get().phase === 'recording') stopVoiceOver(session);
    });
  }
  return true;
}

/** Stops the take in progress and adds it to the timeline (discard = throw it away; also cancels a count-in). */
export async function stopVoiceOver(session, { discard = false } = {}) {
  const mine = run;
  if (!mine) return null;
  run = null;
  mine.cancelled = true;
  mine.offState?.();
  if (session.isPlaying()) session.pause();
  if (mine.wasMuted != null) session.player?.setMuted(mine.wasMuted);
  const rec = mine.recorder;
  if (rec && rec.state !== 'inactive') {
    await new Promise((resolve) => {
      rec.onstop = resolve;
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });
  }
  releaseStream(mine.stream);
  if (discard || !rec || !mine.chunks.length) {
    voiceOverStore.set({ phase: 'idle', count: 0, start: 0, since: 0 });
    return null;
  }
  voiceOverStore.set((s) => ({ ...s, phase: 'saving' }));
  try {
    const type = rec.mimeType || mine.mime || 'audio/webm';
    const blob = new Blob(mine.chunks, { type });
    const media = await import('../../core/media.js');
    const name = `Voice-over ${formatTime(mine.start)}.${recordingExtension(type)}`;
    const mediaId = await media.addBlobAsMedia(blob, { name, origin: 'file', kind: 'audio' });
    let id = null;
    projectStore.update(
      (p) => {
        const m = p.media[mediaId];
        if (!m || m.status === 'error') return p;
        const r = M.addAudioClip(p, mediaId, { start: mine.start, label: 'Voice-over' });
        if (!r.id) return p;
        id = r.id;
        return M.updateClip(r.project, r.id, { duck: true, duckAmount: M.DEFAULT_DUCK_AMOUNT });
      },
      { label: 'Add voice-over' },
    );
    if (!id) throw new Error('the recording could not be decoded');
    setSelection([id]);
    toast('Voice-over added — other sound is ducked while it plays', { kind: 'success' });
    return id;
  } catch (e) {
    console.warn('[gis] voice-over failed', e);
    toast(`Could not add the voice-over: ${e.message || e}`, { kind: 'error' });
    return null;
  } finally {
    voiceOverStore.set({ phase: 'idle', count: 0, start: 0, since: 0 });
  }
}

/** The monitor's mic button menu. */
export function voiceOverMenu(e, session) {
  if (voiceOverStore.get().phase !== 'idle') {
    stopVoiceOver(session);
    return;
  }
  const muted = mutePreviewPref();
  showMenu(e, [
    { header: 'Voice-over' },
    { label: `Record from ${formatTime(session.time())}`, icon: 'mic', onClick: () => startVoiceOver(session) },
    { label: 'Mute the preview while recording', checked: muted, onClick: () => setMutePreviewPref(!muted) },
  ]);
}

/** Count-in / REC badge drawn over the program monitor while a voice-over is being recorded. */
export function VoiceOverOverlay({ session }) {
  const st = useStore(voiceOverStore);
  const [, tick] = useState(0);
  useEffect(() => {
    if (st.phase !== 'recording') return undefined;
    const id = setInterval(() => tick((x) => x + 1), 200);
    return () => clearInterval(id);
  }, [st.phase]);
  if (st.phase === 'idle') return null;
  const stop = (e) => {
    e.stopPropagation();
    stopVoiceOver(session, { discard: st.phase === 'countdown' });
  };
  if (st.phase === 'countdown') {
    return html`<div class="mon-vo mon-vo-count" onClick=${(e) => e.stopPropagation()}>
      <div class="mon-vo-num">${st.count}</div>
      <button type="button" class="mon-vo-cancel" onClick=${stop}>Cancel</button>
    </div>`;
  }
  const elapsed = st.since ? (performance.now() - st.since) / 1000 : 0;
  return html`<div class="mon-vo mon-vo-rec" onClick=${(e) => e.stopPropagation()}>
    <span class="mon-vo-dot"></span>
    <span class="mon-vo-label">${st.phase === 'saving' ? 'Saving…' : `REC ${formatTime(elapsed)}`}</span>
    ${st.phase === 'recording' && html`<button type="button" class="mon-vo-stop" title="Stop recording" onClick=${stop}><${Icon} name="pause" size=${12} /> Stop</button>`}
  </div>`;
}
