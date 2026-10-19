// IndexedDB persistence (extension origin). Stores:
//   projects : project JSON (keyPath 'id')
//   blobs    : media & ingredient binaries, keyed by media/ingredient id
//   thumbs   : derived previews keyed by media/ingredient id: {thumb: Blob, strip: Blob|null, stripCount, peaks: Float32Array|null}
//   kv       : small documents (library, meta), out-of-line keys

const DB_NAME = 'grok-imagine-studio';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('[gis] IndexedDB upgrade blocked by another studio window');
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then((r) => {
      result = r;
    }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

/**
 * Atomic read-modify-write: fn(current) runs synchronously inside one readwrite transaction (so two windows can never
 * interleave a read and a write); it returns the value to store (or undefined to keep the current one).
 */
function update(storeName, key, fn, outOfLine) {
  return tx(storeName, 'readwrite', (st) =>
    new Promise((resolve, reject) => {
      const req = st.get(key);
      req.onsuccess = () => {
        try {
          const next = fn(req.result);
          if (next === undefined) return resolve(req.result);
          if (outOfLine) st.put(next, key);
          else st.put(next);
          resolve(next);
        } catch (e) {
          reject(e);
        }
      };
      req.onerror = () => reject(req.error);
    }),
  );
}

const get = (s, key) => tx(s, 'readonly', (st) => reqToPromise(st.get(key)));
const ORPHANS_KEY = 'meta:gcOrphans'; // {key: ms when storage cleanup first found it unreferenced}

// Binaries written in this window recently: a storage cleanup (here or in another window) must not delete a file
// whose project / library entry is not saved yet.
const recentWrites = new Map(); // key -> ms
const RECENT_MS = 120000;
function noteWrite(key) {
  const now = Date.now();
  recentWrites.set(key, now);
  for (const [k, at] of recentWrites) if (now - at > RECENT_MS) recentWrites.delete(k);
}

/**
 * Pure: what a storage cleanup does. keys: stored binary keys; keep: referenced keys; record: {key: firstSeenOrphanAt}
 * from the previous sweeps. A key is deleted once it has been unreferenced for graceMs (0 = right away); the
 * returned record holds the keys still waiting.
 */
export function planGarbage({ keys, keep, record = {}, now = Date.now(), graceMs = 0 }) {
  const keepSet = keep instanceof Set ? keep : new Set(keep);
  const remove = [];
  const next = {};
  for (const k of new Set(keys)) {
    if (keepSet.has(k)) continue;
    const since = Number.isFinite(record[k]) ? record[k] : now;
    if (now - since >= graceMs) remove.push(k);
    else next[k] = since;
  }
  return { remove, record: next };
}
const put = (s, value, key) => tx(s, 'readwrite', (st) => reqToPromise(key === undefined ? st.put(value) : st.put(value, key)));
const del = (s, key) => tx(s, 'readwrite', (st) => reqToPromise(st.delete(key)));

export const db = {
  open: openDb,

  // projects
  getProject: (id) => get('projects', id),
  putProject: (project) => put('projects', project),
  /** fn(stored) -> project to store; runs atomically (see update()). */
  updateProject: (id, fn) => update('projects', id, fn, false),
  deleteProject: (id) => del('projects', id),
  async listProjects() {
    const all = await tx('projects', 'readonly', (st) => reqToPromise(st.getAll()));
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  // binaries
  getBlob: (key) => get('blobs', key),
  putBlob: (key, blob) => {
    noteWrite(key);
    return put('blobs', blob, key);
  },
  /** Keys of binaries / previews this window wrote in the last two minutes (see storage cleanup). */
  recentKeys: () => [...recentWrites.keys()],
  deleteBlob: (key) => del('blobs', key),
  async hasBlob(key) {
    const k = await tx('blobs', 'readonly', (st) => reqToPromise(st.getKey(key)));
    return k !== undefined;
  },
  listBlobKeys: () => tx('blobs', 'readonly', (st) => reqToPromise(st.getAllKeys())),

  // derived previews
  getThumbs: (key) => get('thumbs', key),
  putThumbs: (key, value) => {
    noteWrite(key);
    return put('thumbs', value, key);
  },
  deleteThumbs: (key) => del('thumbs', key),

  // small documents
  kvGet: (key) => get('kv', key),
  kvSet: (key, value) => put('kv', value, key),
  kvUpdate: (key, fn) => update('kv', key, fn, true),
  kvDelete: (key) => del('kv', key),

  async estimate() {
    try {
      return await navigator.storage.estimate();
    } catch {
      return { usage: 0, quota: 0 };
    }
  },

  /**
   * Deletes binaries and previews nothing references any more. With graceMs, a file is deleted only once it has
   * stayed unreferenced that long (first sightings are remembered across sweeps and windows). Keys written by this
   * window in the last two minutes are always kept. Returns {removed, bytes, waiting}.
   */
  async collectGarbage(referencedKeys, { graceMs = 0 } = {}) {
    const keep = new Set([...referencedKeys, ...recentWrites.keys()]);
    const [blobKeys, thumbKeys, record] = await Promise.all([
      this.listBlobKeys(),
      tx('thumbs', 'readonly', (st) => reqToPromise(st.getAllKeys())),
      this.kvGet(ORPHANS_KEY).catch(() => null),
    ]);
    const plan = planGarbage({ keys: [...blobKeys, ...thumbKeys], keep, record: record || {}, graceMs });
    let bytes = 0;
    for (const k of plan.remove) {
      const blob = await this.getBlob(k).catch(() => null);
      bytes += blob?.size || 0;
      await this.deleteBlob(k).catch(() => {});
      await this.deleteThumbs(k).catch(() => {});
    }
    await this.kvSet(ORPHANS_KEY, plan.record).catch(() => {});
    return { removed: plan.remove.filter((k) => blobKeys.includes(k)).length, bytes, waiting: Object.keys(plan.record).length };
  },
};
