// Batch queue runner: sends shots to Grok one after another, optionally waiting for each generation, with
// pause / resume / stop. Pure logic (timers and side effects are injected), so it is unit-testable without a browser.
//
//   const runner = createQueueRunner({
//     send: async (shotId) => {...},                         // insert (+ submit) the shot on grok.com; throw on failure
//     waitForResult: async (shotId, {since, timeoutMs, signal}) => 'done' | 'timeout',   // optional
//     sleep: (ms, signal) => Promise,                        // optional, defaults to setTimeout (abortable)
//     onChange: (state) => {},
//   });
//   runner.start(['sht_1', 'sht_2'], {delayMs: 4000, waitForGeneration: true, timeoutMs: 180000});
//   runner.pause(); runner.resume(); runner.stop();
//
// State: {status: 'idle'|'running'|'paused'|'done'|'stopped', index, items: [{shotId, status, error, startedAt,
// finishedAt}], options}. Item status: 'queued' | 'sending' | 'waiting' | 'done' | 'timeout' | 'error' | 'skipped'.
// Pause takes effect between steps (an in-flight send/wait completes; the next shot is not sent until resume).
// Stop aborts waits and delays immediately. Three consecutive send errors stop the run.

export const MAX_CONSECUTIVE_ERRORS = 3;

/** Abortable sleep. Resolves early (no rejection) when the signal aborts. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

const initialState = () => ({ status: 'idle', index: 0, items: [], options: null, startedAt: null, finishedAt: null, error: null });

/**
 * Creates a queue runner.
 * @param {{send: Function, waitForResult?: Function, sleep?: Function, onChange?: Function, now?: Function}} deps
 */
export function createQueueRunner({ send, waitForResult = null, sleep = abortableSleep, onChange = () => {}, now = () => Date.now() } = {}) {
  let state = initialState();
  let controller = null;
  let resumeWaiters = [];
  let runId = 0;

  const emit = () => {
    try {
      onChange(state);
    } catch {
      /* listener errors must not break the run */
    }
  };
  const set = (patch) => {
    state = { ...state, ...patch };
    emit();
  };
  const setItem = (i, patch) => {
    const items = state.items.slice();
    items[i] = { ...items[i], ...patch };
    set({ items });
  };
  const releaseWaiters = () => {
    const w = resumeWaiters;
    resumeWaiters = [];
    w.forEach((fn) => fn());
  };
  const waitWhilePaused = () =>
    state.status === 'paused' ? new Promise((resolve) => resumeWaiters.push(resolve)) : Promise.resolve();

  async function run(myRun) {
    const signal = controller.signal;
    const opts = state.options;
    let consecutiveErrors = 0;
    for (let i = state.index; i < state.items.length; i++) {
      await waitWhilePaused();
      if (signal.aborted || myRun !== runId) return;
      set({ index: i });
      const item = state.items[i];
      if (item.status !== 'queued') continue;
      const startedAt = now();
      setItem(i, { status: 'sending', startedAt, error: null });
      try {
        await send(item.shotId);
        consecutiveErrors = 0;
      } catch (e) {
        if (myRun !== runId) return;
        consecutiveErrors++;
        setItem(i, { status: 'error', error: String(e?.message || e), finishedAt: now() });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          set({ status: 'stopped', finishedAt: now(), error: `Stopped after ${consecutiveErrors} failed sends: ${String(e?.message || e)}` });
          return;
        }
        continue;
      }
      if (signal.aborted || myRun !== runId) return;
      let result = 'done';
      if (opts.waitForGeneration && waitForResult) {
        setItem(i, { status: 'waiting' });
        try {
          result = (await waitForResult(item.shotId, { since: startedAt, timeoutMs: opts.timeoutMs, signal })) || 'done';
        } catch (e) {
          result = signal.aborted ? 'stopped' : 'timeout';
        }
        if (signal.aborted || myRun !== runId) {
          if (myRun === runId) setItem(i, { status: 'skipped', finishedAt: now() });
          return;
        }
      }
      setItem(i, { status: result === 'timeout' ? 'timeout' : 'done', finishedAt: now() });
      const more = state.items.slice(i + 1).some((it) => it.status === 'queued');
      if (more && opts.delayMs > 0) {
        await sleep(opts.delayMs, signal);
        if (signal.aborted || myRun !== runId) return;
      }
    }
    if (myRun === runId) set({ status: 'done', finishedAt: now(), index: state.items.length });
  }

  const api = {
    getState: () => state,
    /** Starts a new run (stops any current one). */
    start(shotIds, { delayMs = 5000, waitForGeneration = true, timeoutMs = 180000 } = {}) {
      api.stop({ silent: true });
      const list = (Array.isArray(shotIds) ? shotIds : []).filter(Boolean);
      runId++;
      controller = new AbortController();
      state = {
        ...initialState(),
        status: list.length ? 'running' : 'done',
        items: list.map((shotId) => ({ shotId, status: 'queued', error: null, startedAt: null, finishedAt: null })),
        options: { delayMs: Math.max(0, Number(delayMs) || 0), waitForGeneration: !!waitForGeneration, timeoutMs: Math.max(1000, Number(timeoutMs) || 180000) },
        startedAt: now(),
        finishedAt: list.length ? null : now(),
      };
      emit();
      const promise = list.length ? run(runId) : Promise.resolve();
      return promise.catch((e) => set({ status: 'stopped', error: String(e?.message || e), finishedAt: now() }));
    },
    pause() {
      if (state.status !== 'running') return false;
      set({ status: 'paused' });
      return true;
    },
    resume() {
      if (state.status !== 'paused') return false;
      set({ status: 'running' });
      releaseWaiters();
      return true;
    },
    /** Stops the run: queued items become 'skipped'. */
    stop({ silent = false } = {}) {
      if (state.status !== 'running' && state.status !== 'paused') return false;
      runId++;
      controller?.abort();
      const items = state.items.map((it) => (it.status === 'queued' || it.status === 'waiting' || it.status === 'sending' ? { ...it, status: 'skipped', finishedAt: now() } : it));
      state = { ...state, status: 'stopped', items, finishedAt: now() };
      releaseWaiters();
      if (!silent) emit();
      return true;
    },
    /** Clears a finished run. */
    reset() {
      if (state.status === 'running' || state.status === 'paused') return false;
      state = initialState();
      emit();
      return true;
    },
  };
  return api;
}

/** Progress summary of a runner state: {done, total, failed, current}. */
export function queueProgress(state) {
  const items = state?.items || [];
  const finished = items.filter((it) => ['done', 'timeout', 'error', 'skipped'].includes(it.status)).length;
  return {
    done: finished,
    total: items.length,
    failed: items.filter((it) => it.status === 'error' || it.status === 'timeout').length,
    current: items.find((it) => it.status === 'sending' || it.status === 'waiting') || null,
  };
}
