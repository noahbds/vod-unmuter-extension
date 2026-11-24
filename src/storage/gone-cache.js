// Hook module (page and player worker): see src/hook.js.

import { known } from '../shared/state.js';
import { log } from '../shared/logger.js';
import { goneTx } from './idb.js';

export const GONE_KEEP_DAYS = 90;

export const GONE_RE = /^([^/?]+)\/(\d+)(\.ts|-unmuted\.ts|\.mp4|-unmuted\.mp4)(?:\?.*)?$/;
export const goneQueue = new Map(); // vod folder -> { "<quality>/<suffix>" -> Set(numbers) }
export let goneTimer = null;

// A file answered "not found": remember it (in memory and on disk). `job`
// is the job of the VOD the file is in (jobOf(url)), if there is one.
export function markMissing(url, job) {
  known.set(url, false);
  if (!job || job.live) return;
  const m = url.slice(job.vodBase.length).match(GONE_RE);
  if (!m) return;
  if (!goneQueue.has(job.vodKey)) goneQueue.set(job.vodKey, new Map());
  const files = goneQueue.get(job.vodKey);
  const k = m[1] + '/' + m[3];
  if (!files.has(k)) files.set(k, new Set());
  files.get(k).add(Number(m[2]));
  if (!goneTimer) goneTimer = setTimeout(flushGone, 3000);
}

export async function flushGone() {
  clearTimeout(goneTimer);
  goneTimer = null;
  const batch = [...goneQueue];
  goneQueue.clear();
  if (!batch.length) return;
  try {
    await goneTx('readwrite', (store) => {
      for (const [vod, files] of batch) {
        const r = store.get(vod);
        r.onsuccess = () => {
          const rec = r.result || { vod, files: {} };
          for (const [k, nums] of files) {
            const all = new Set(rec.files[k] || []);
            for (const n of nums) all.add(n);
            rec.files[k] = [...all].sort((a, b) => a - b);
          }
          rec.updated = Date.now();
          store.put(rec);
        };
      }
    });
  } catch (e) { log('debug', 'could not remember deleted files (only a speed-up)', e); }
}

// Marks this job's known-deleted files before checking starts.
export async function loadGone(job) {
  let rec = null;
  try {
    rec = await goneTx('readonly', (store, out) => {
      const r = store.get(job.vodKey);
      r.onsuccess = () => { out.value = r.result; };
    });
  } catch (e) { return 0; }
  if (!rec || !rec.files) return 0;
  let count = 0;
  for (const [k, nums] of Object.entries(rec.files)) {
    const slash = k.indexOf('/');
    const dir = k.slice(0, slash), sfx = k.slice(slash + 1);
    const set = new Set(nums);
    for (const seg of job.segs) {
      if (!set.has(seg.num)) continue;
      known.set(job.vodBase + dir + '/' + seg.num + sfx + seg.query, false);
      count++;
    }
  }
  return count;
}

export async function clearGone(vod) {
  try {
    await goneTx('readwrite', (store) => { if (vod) store.delete(vod); else store.clear(); });
  } catch (e) { /* ignore */ }
}

export async function expireGone() {
  const limit = Date.now() - GONE_KEEP_DAYS * 864e5;
  try {
    await goneTx('readwrite', (store) => {
      const r = store.openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        if (!(c.value.updated > limit)) c.delete();
        c.continue();
      };
    });
  } catch (e) { /* ignore */ }
}
