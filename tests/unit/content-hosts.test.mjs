// Unit tests for the grok.com content script's cross-tab coordination (content/hosts.js) and the page side of the
// studio channel (content/server.js), with in-memory stand-ins for chrome.storage, Web Locks and MessagePorts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hosts, pickHost } from '../../extension/content/hosts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** chrome.storage.local + chrome.storage.onChanged shared by several "tabs" (change events are async like Chrome's). */
function fakeStorage() {
  const data = new Map();
  const listeners = new Set();
  const emit = (changes) => setTimeout(() => listeners.forEach((fn) => fn(changes, 'local')), 1);
  const storage = {
    data,
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data.get(k), newValue: structuredClone(v) };
        data.set(k, structuredClone(v));
      }
      emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: data.get(k) };
        data.delete(k);
      }
      if (Object.keys(changes).length) emit(changes);
    },
  };
  const onChanged = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
  return { storage, onChanged };
}

/** Minimal Web Locks (exclusive locks, FIFO per name). */
function fakeLocks() {
  const held = new Map(); // name -> true
  const queues = new Map(); // name -> [grant]
  const pump = (name) => {
    if (held.has(name)) return;
    const next = queues.get(name)?.shift();
    if (next) next();
  };
  return {
    held,
    request(name, opts, cb) {
      return new Promise((resolve, reject) => {
        const grant = () => {
          held.set(name, true);
          Promise.resolve()
            .then(() => cb({ name }))
            .then(resolve, reject)
            .finally(() => {
              held.delete(name);
              pump(name);
            });
        };
        if (!queues.has(name)) queues.set(name, []);
        queues.get(name).push(grant);
        pump(name);
      });
    },
    async query() {
      return { held: [...held.keys()].map((name) => ({ name, mode: 'exclusive' })), pending: [] };
    },
  };
}

function world() {
  const { storage, onChanged } = fakeStorage();
  const locks = fakeLocks();
  const tab = (onRelay) => new Hosts({ storage, onChanged, locks, onRelay });
  return { storage, locks, tab };
}

test('pickHost prefers an open panel, then a standalone tab, then the most recently active; skips itself', () => {
  const hosts = [
    { id: 'self', kind: 'embedded', open: true, ready: true, activeAt: 99 },
    { id: 'a', kind: 'embedded', open: false, ready: true, activeAt: 50 },
    { id: 'b', kind: 'embedded', open: false, ready: true, activeAt: 70 },
    { id: 'c', kind: 'tab', open: false, ready: true, activeAt: 10 },
    { id: 'd', kind: 'embedded', open: true, ready: false, activeAt: 80 },
  ];
  assert.equal(pickHost(hosts, 'self').id, 'c', 'standalone tab beats hidden embedded studios');
  assert.equal(pickHost(hosts, 'self', { needReady: false }).id, 'd', 'an open panel wins when booting hosts count');
  assert.equal(pickHost(hosts.filter((h) => h.id !== 'c'), 'self').id, 'b', 'most recently active');
  assert.equal(pickHost([{ id: 'self', kind: 'embedded', ready: true }], 'self'), null);
  assert.equal(pickHost([{ id: 'x', kind: 'weird', ready: true }, null], 'self'), null);
  assert.equal(pickHost(null, 'self'), null);
});

test('hosts: a hosting tab is visible to others, relays reach it and are cleaned up', async () => {
  const w = world();
  const got = [];
  const a = w.tab((name, payload) => {
    got.push({ name, payload });
    return { ok: true };
  });
  const b = w.tab(() => ({ ok: false }));
  assert.deepEqual(await b.liveHosts(), [], 'nobody hosts yet');
  await a.setHosting({ kind: 'embedded', ready: true, open: false, activeAt: 5 });
  const live = await b.liveHosts();
  assert.equal(live.length, 1);
  assert.deepEqual({ id: live[0].id, kind: live[0].kind, ready: live[0].ready, open: live[0].open }, { id: a.id, kind: 'embedded', ready: true, open: false });
  assert.equal(pickHost(live, b.id).id, a.id);
  const res = await b.relay(a.id, 'page.add', { items: [{ key: 'video:1' }], target: 'bin' }, 1000);
  assert.deepEqual(res, { ok: true, error: null });
  assert.deepEqual(got, [{ name: 'page.add', payload: { items: [{ key: 'video:1' }], target: 'bin' } }]);
  await sleep(20);
  assert.deepEqual([...w.storage.data.keys()].filter((k) => k.includes('relay')), [], 'relay and ack keys removed');
  // A handler error is reported back, not thrown.
  const c = w.tab(() => {
    throw new Error('boom');
  });
  await c.setHosting({ kind: 'tab', ready: true });
  assert.deepEqual(await b.relay(c.id, 'page.add', {}, 1000), { ok: false, error: 'boom' });
  a.destroy();
  b.destroy();
  c.destroy();
});

test('hosts: relays to a tab that never answers time out; metadata updates are written once', async () => {
  const w = world();
  const a = w.tab(() => ({ ok: true }));
  const t0 = Date.now();
  assert.deepEqual(await a.relay('nobody', 'page.add', {}, 60), { ok: false, error: 'timeout' });
  assert.ok(Date.now() - t0 >= 55);
  let writes = 0;
  const set = w.storage.set.bind(w.storage);
  w.storage.set = (obj) => {
    if (Object.keys(obj).some((k) => k.startsWith('gis:host:'))) writes++;
    return set(obj);
  };
  await a.setHosting({ kind: 'embedded', ready: false, open: false, activeAt: 1 });
  await a.setHosting({ kind: 'embedded', ready: false, open: false, activeAt: 1 });
  assert.equal(writes, 1, 'unchanged metadata is not rewritten');
  await a.setHosting({ kind: 'embedded', ready: true, open: false, activeAt: 1 });
  assert.equal(writes, 2);
  a.destroy();
});

test('hosts: ending hosting releases the lock and removes the metadata; destroy() does too', async () => {
  const w = world();
  const a = w.tab();
  const b = w.tab();
  await a.setHosting({ kind: 'embedded', ready: true });
  assert.equal((await b.liveHosts()).length, 1);
  await a.setHosting(null);
  await sleep(5);
  assert.deepEqual(await b.liveHosts(), []);
  assert.equal([...w.storage.data.keys()].some((k) => k.startsWith('gis:host:')), false);
  // Hosting ended before the lock was granted: the late grant is released at once.
  const blocker = w.locks.request(`gis-host:${a.id}`, {}, () => sleep(30));
  const p = a.setHosting({ kind: 'tab', ready: true });
  await a.setHosting(null);
  await blocker;
  await p;
  await sleep(5);
  assert.equal(w.locks.held.has(`gis-host:${a.id}`), false, 'no lock left behind');
  await b.setHosting({ kind: 'tab', ready: true });
  b.destroy();
  await sleep(5);
  assert.deepEqual(await a.liveHosts(), [], 'a destroyed tab no longer hosts');
});

test('hosts: elect() runs one tab at a time, so only the first one becomes the host', async () => {
  const w = world();
  const tabs = [w.tab(), w.tab(), w.tab()];
  const became = [];
  await Promise.all(
    tabs.map((t) =>
      t.elect(async () => {
        if (pickHost(await t.liveHosts(), t.id, { needReady: false })) return;
        await sleep(10); // creating the frame takes a moment
        await t.setHosting({ kind: 'embedded', ready: false });
        became.push(t.id);
      }),
    ),
  );
  assert.deepEqual(became, [tabs[0].id]);
  // An error inside fn propagates (fn is not run twice).
  let runs = 0;
  await assert.rejects(
    tabs[1].elect(() => {
      runs++;
      throw new Error('fn failed');
    }),
    /fn failed/,
  );
  assert.equal(runs, 1);
  tabs.forEach((t) => t.destroy());
});

test('hosts: without Web Locks or storage everything degrades to "no other host"', async () => {
  const h = new Hosts({ storage: null, locks: null, onChanged: null });
  assert.equal(h.available, false);
  assert.deepEqual(await h.liveHosts(), []);
  assert.deepEqual(await h.relay('x', 'page.add', {}), { ok: false, error: 'unavailable' });
  assert.equal(await h.elect(() => 42), 42);
  await h.setHosting({ kind: 'embedded' });
  h.destroy();
});

// -----------------------------------------------------------------------------------------------------------
// server.js
// -----------------------------------------------------------------------------------------------------------

globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage: async () => undefined,
  },
};
const { Server } = await import('../../extension/content/server.js');
const { EVT, HANDSHAKE_ACK } = await import('../../extension/shared/protocol.js');

function fakePort() {
  const sent = [];
  return { sent, onmessage: null, start() {}, postMessage: (m) => sent.push(m), deliver(m) { this.onmessage({ data: m }); } };
}

test('server: events wait for the studio acknowledgement, state events coalesce, user actions keep order', () => {
  let frame = true;
  const s = new Server({ hasFrame: () => frame });
  const port = fakePort();
  s.setPort(port);
  let readyCalls = 0;
  s.onReady = () => readyCalls++;
  s.emitPort(EVT.PAGE_MEDIA, { items: [1] });
  s.emitPort(EVT.PAGE_ADD, { items: ['a'] });
  s.emitPort(EVT.PAGE_MEDIA, { items: [1, 2] });
  s.emitPort(EVT.PAGE_ADD, { items: ['b'] });
  assert.equal(port.sent.length, 0, 'nothing before the acknowledgement');
  s.markAcked();
  assert.deepEqual(
    port.sent.map((m) => [m.name, m.payload]),
    [
      [EVT.PAGE_ADD, { items: ['a'] }],
      [EVT.PAGE_MEDIA, { items: [1, 2] }],
      [EVT.PAGE_ADD, { items: ['b'] }],
    ],
  );
  assert.equal(readyCalls, 1);
  assert.equal(s.embeddedConnected, true);
  s.emitPort(EVT.PAGE_NAVIGATED, { url: 'x' });
  assert.equal(port.sent.at(-1).name, EVT.PAGE_NAVIGATED, 'sent right away once ready');
  frame = false;
  s.destroy();
});

test('server: COMPOSER_SUBMITTED is never replayed late or into a studio that does not exist', () => {
  let frame = false;
  const s = new Server({ hasFrame: () => frame });
  s.emitPort(EVT.COMPOSER_SUBMITTED, { text: 'no frame', at: 1 });
  assert.equal(s.queue.length, 0, 'no studio frame: dropped');
  frame = true;
  s.emitPort(EVT.COMPOSER_SUBMITTED, { text: 'booting', at: 2 });
  s.emitPort(EVT.COMPOSER_SUBMITTED, { text: 'stale', at: 3 });
  s.queue[1].at = Date.now() - 31000; // queued half a minute ago
  s.tabStudioSeenAt = Date.now();
  s.emitPort(EVT.COMPOSER_SUBMITTED, { text: 'standalone has it', at: 4 });
  assert.equal(s.queue.length, 2, 'a standalone studio tab already received it');
  s.tabStudioSeenAt = 0;
  const port = fakePort();
  s.setPort(port);
  s.markAcked();
  assert.deepEqual(port.sent.map((m) => m.payload.text), ['booting'], 'stale submissions are dropped at delivery');
  s.destroy();
});

test('server: dropQueued, resetPort and the request round trip over the port', async () => {
  const s = new Server({ hasFrame: () => true });
  const keep = { items: ['keep'] };
  const drop = { items: ['drop'] };
  s.emitPort(EVT.PAGE_ADD, keep);
  s.emitPort(EVT.PAGE_ADD, drop);
  assert.equal(s.dropQueued((q) => q.payload === drop), 1);
  assert.deepEqual(s.queue.map((q) => q.payload), [keep]);
  const port = fakePort();
  s.setPort(port);
  await assert.rejects(s.request('studio.binKeys'), /Studio not open/);
  port.deliver({ kind: 'evt', name: HANDSHAKE_ACK, payload: {} }); // listeners get studio events
  s.markAcked();
  s.handle('page.info', () => ({ url: 'https://grok.com/imagine' }));
  port.deliver({ kind: 'req', id: 7, type: 'page.info', payload: {} });
  await sleep(5);
  assert.deepEqual(port.sent.at(-1), { kind: 'res', id: 7, ok: true, result: { url: 'https://grok.com/imagine' } });
  port.deliver({ kind: 'req', id: 8, type: 'nope', payload: {} });
  await sleep(5);
  assert.equal(port.sent.at(-1).ok, false);
  const pending = s.request('studio.binKeys', {}, 1000);
  const req = port.sent.at(-1);
  port.deliver({ kind: 'res', id: req.id, ok: true, result: { keys: ['video:1'] } });
  assert.deepEqual(await pending, { keys: ['video:1'] });
  const orphan = s.request('studio.binKeys', {}, 1000);
  s.resetPort();
  await assert.rejects(orphan, /Studio closed/);
  assert.equal(s.ready, false);
  s.destroy();
});
