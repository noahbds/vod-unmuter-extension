// Hook module (page and player worker): see src/hook.js.

import { log } from '../shared/logger.js';

// ------------------------------------------------------------ saved audio
// IndexedDB for twitch.tv, shared by the page and the player worker.
//   audio: "<vod folder>|<segment number>" -> { type, pts, packets }
//   vods:  { vod, channel, streamedAt, savedAt, segments, bytes }
export let dbPromise = null;
export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = scope.indexedDB.open('vod-unmuter', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('audio');
        req.result.createObjectStore('vods', { keyPath: 'vod' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => { log('warn', 'saving is unavailable: browser storage (IndexedDB) is blocked here, e.g. in a private window', e); return null; });
  }
  return dbPromise;
}

export async function idb(stores, mode, work) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const out = {};
    work(...[].concat(stores).map((s) => tx.objectStore(s)), out);
    tx.oncomplete = () => resolve(out.value);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const audioRange = (vod) => IDBKeyRange.bound(vod + '|', vod + '|\uffff');

export function vodInfo(vod) {
  // Twitch folders look like "<hash>_<channel>_<stream id>_<unix time>".
  const parts = vod.split('_');
  const time = Number(parts[parts.length - 1]);
  return {
    channel: parts.length >= 4 ? parts.slice(1, -2).join('_') : '',
    streamedAt: time > 1e9 ? time * 1000 : null,
  };
}

// ---- deleted originals ---------------------------------------------------
// Once Twitch deletes an original file it never comes back, so every
// "file not found" is remembered per VOD: opening the VOD again skips those
// checks and shows the result almost at once. Kept in a separate database
// so the saved-audio one never needs an upgrade.
//   gone: { vod, updated, files: { "<quality>/<suffix>": [segment numbers] } }

export let goneDbPromise = null;
export function openGoneDb() {
  if (!goneDbPromise) {
    goneDbPromise = new Promise((resolve, reject) => {
      const req = scope.indexedDB.open('vod-unmuter-gone', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('gone', { keyPath: 'vod' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return goneDbPromise;
}
export async function goneTx(mode, work) {
  const db = await openGoneDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('gone', mode);
    const out = {};
    work(tx.objectStore('gone'), out);
    tx.oncomplete = () => resolve(out.value);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// ---- compression ------------------------------------------------------
// A saved segment is one of:
//   { fmt: 'deflate', type, pts, data, packed }  audio packets, lossless
//   { fmt: 'aac', type, pts, kbps, data }        sound re-encoded to AAC
//                                                (ADTS frames), smaller
//   { type, pts, packets }                       older: uncompressed packets
export const recBytes = (rec) => (rec.data || rec.packets).byteLength;
