// SPDX-License-Identifier: MIT — part of nostaljibox-player/shared, usable outside the GPL player.
// IndexedDB storage: game metadata ("games") and ROM bytes ("roms") live in separate stores so
// listing the library never loads ROM data. "kv" holds the 1.x single-ROM data for migration.
const DB_NAME = "nekketsu";
const STORES = ["kv", "games", "roms"];

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const req = fn(d.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
export const getAll = (store) => tx(store, "readonly", (s) => s.getAll());
export const put = (store, key, value) => tx(store, "readwrite", (s) => s.put(value, key));
export const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
