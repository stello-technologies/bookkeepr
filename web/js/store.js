'use strict';
/* Where the phone keeps its copy of the books: IndexedDB in the browser, plain memory in tests.
   Same small interface for both: all / put / putMany / getMeta / setMeta / clear. */
(function () {
  const KINDS = ['parties', 'items', 'entries'];
  const copy = (x) => JSON.parse(JSON.stringify(x));

  function memory() {
    const data = { parties: new Map(), items: new Map(), entries: new Map() };
    let meta = new Map();
    return {
      async all(kind) { return [...data[kind].values()].map(copy); },
      async put(kind, rec) { data[kind].set(rec.id, copy(rec)); },
      async putMany(kind, recs) { recs.forEach((r) => data[kind].set(r.id, copy(r))); },
      async del(kind, id) { data[kind].delete(id); },
      async getMeta(key) { return meta.has(key) ? copy(meta.get(key)) : null; },
      async setMeta(key, value) { meta.set(key, copy(value)); },
      async clear() { KINDS.forEach((k) => data[k].clear()); meta = new Map(); },
    };
  }

  const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

  async function open(name) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        KINDS.forEach((k) => req.result.createObjectStore(k, { keyPath: 'id' }));
        req.result.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.onversionchange = () => db.close(); // lets drop() delete this copy even while the app has it open
    return {
      async all(kind) { return wrap(db.transaction(kind).objectStore(kind).getAll()); },
      async put(kind, rec) { const tx = db.transaction(kind, 'readwrite'); tx.objectStore(kind).put(rec); await done(tx); },
      async putMany(kind, recs) { const tx = db.transaction(kind, 'readwrite'); recs.forEach((r) => tx.objectStore(kind).put(r)); await done(tx); },
      async del(kind, id) { const tx = db.transaction(kind, 'readwrite'); tx.objectStore(kind).delete(id); await done(tx); },
      async getMeta(key) { const r = await wrap(db.transaction('meta').objectStore('meta').get(key)); return r ? r.value : null; },
      async setMeta(key, value) { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key, value }); await done(tx); },
      async clear() { const tx = db.transaction([...KINDS, 'meta'], 'readwrite'); [...KINDS, 'meta'].forEach((k) => tx.objectStore(k).clear()); await done(tx); },
      close() { db.close(); },
    };
  }

  /** Delete a phone's copy completely (sign-out, or removed from the business). */
  const drop = (name) => new Promise((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });

  globalThis.Store = { memory, open, drop };
})();
