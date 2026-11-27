// Hook module (page and player worker): see src/hook.js.

import { settings } from '../shared/state.js';
import { log } from '../shared/logger.js';
import { adtsInfo, muxAdts, packetsToAdts, splitAdts } from '../media/adts-muxer.js';
import { inflate } from '../media/aac-compression.js';
import { audioRange, idb, recBytes, vodInfo } from './idb.js';
import { expireGone } from './gone-cache.js';

export async function loadSavedNums(vod) {
  try {
    const keys = await idb('audio', 'readonly', (audio, out) => {
      const r = audio.getAllKeys(audioRange(vod));
      r.onsuccess = () => { out.value = r.result; };
    });
    return new Set((keys || []).map((k) => Number(String(k).split('|')[1])));
  } catch (e) { return new Set(); }
}

// What spliceAudio needs, from a saved record.
export async function recordToAudio(rec) {
  if (!rec) return null;
  if (!rec.fmt) return { type: rec.type, pts: rec.pts, packets: rec.packets };
  if (rec.fmt === 'deflate') return { type: rec.type, pts: rec.pts, packets: rec.packed ? await inflate(rec.data) : rec.data };
  if (rec.fmt === 'adts') {
    const bytes = rec.packed ? await inflate(rec.data) : rec.data;
    const frames = splitAdts(bytes);
    return frames.length ? { type: 0x0f, pts: rec.pts, packets: muxAdts(frames, rec.pts, adtsInfo(frames[0]).sampleRate) } : null;
  }
  if (rec.fmt === 'aac') {
    const frames = splitAdts(rec.data);
    return frames.length ? { type: 0x0f, pts: rec.pts, packets: muxAdts(frames, rec.pts, adtsInfo(frames[0]).sampleRate) } : null;
  }
  return null;
}

// The AAC frames of a saved record and their start time (90 kHz): what an
// MP4 VOD's saved copy becomes (see adtsToMp4Audio).
export async function recordToFrames(rec) {
  if (!rec) return null;
  if (rec.fmt === 'adts' || rec.fmt === 'aac') {
    const frames = splitAdts(rec.fmt === 'adts' && rec.packed ? await inflate(rec.data) : rec.data);
    return frames.length ? { pts: rec.pts, frames } : null;
  }
  const audio = await recordToAudio(rec);
  if (!audio || audio.type !== 0x0f) return null;
  const frames = splitAdts(packetsToAdts(audio.packets));
  return frames.length ? { pts: audio.pts, frames } : null;
}

export async function loadRecord(vod, num) {
  try {
    return await idb('audio', 'readonly', (audio, out) => {
      const r = audio.get(vod + '|' + num);
      r.onsuccess = () => { out.value = r.result; };
    });
  } catch (e) { return null; }
}
export const loadSaved = async (vod, num) => recordToAudio(await loadRecord(vod, num));

let cachedTotalBytes = null;
let cachedTotalAt = 0;
export function invalidateSavedTotal() { cachedTotalBytes = null; cachedTotalAt = 0; }

// Adds a segment (or replaces it, for compression) and keeps the VOD's
// totals up to date. `onQuotaExceeded(vod)` is called if storage is full.
export async function putRecord(vod, num, rec, replace, onQuotaExceeded) {
  const bytes = recBytes(rec);
  try {
    let delta = 0;
    const res = await idb(['audio', 'vods'], 'readwrite', (store, vods, out) => {
      const key = vod + '|' + num;
      const old = store.get(key);
      old.onsuccess = () => {
        if (old.result !== undefined && !replace) return;
        const before = old.result ? recBytes(old.result) : 0;
        delta = bytes - before;
        store.put(rec, key);
        const v = vods.get(vod);
        v.onsuccess = () => {
          const info = v.result || Object.assign({ vod, savedAt: Date.now(), segments: 0, bytes: 0 }, vodInfo(vod));
          if (!old.result) info.segments++;
          info.bytes += delta;
          vods.put(info);
          out.value = info;
        };
      };
    });
    if (res && cachedTotalBytes !== null) cachedTotalBytes = Math.max(0, cachedTotalBytes + delta);
    return res;
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      // The browser's storage for twitch.tv is full (disk nearly full, or
      // the browser's own limit): stop saving instead of failing on every
      // segment, and say so in the panel.
      noteStorageFull(e);
      if (onQuotaExceeded) onQuotaExceeded(vod);
    } else log('warn', `could not save the sound of part ${num} of VOD ${vod}`, e);
    return null;
  }
}
export let storageFull = false;
// The browser's storage for twitch.tv is full: said once, not on every write.
export function noteStorageFull(e) {
  if (!storageFull) log('warn', 'browser storage for twitch.tv is full: saving stopped', e);
  storageFull = true;
}

// Removes saved copies in one transaction and keeps the VOD's totals right.
export async function deleteSavedSegments(vod, nums) {
  if (!nums || !nums.length) return;
  try {
    let removedBytes = 0;
    await idb(['audio', 'vods'], 'readwrite', (audio, vods) => {
      let remaining = nums.length;
      let removedCount = 0;
      const done = () => {
        if (!removedCount) return;
        const v = vods.get(vod);
        v.onsuccess = () => {
          if (!v.result) return;
          v.result.segments = Math.max(0, v.result.segments - removedCount);
          v.result.bytes = Math.max(0, v.result.bytes - removedBytes);
          vods.put(v.result); // kept even when empty: it remembers the position ("Parts ahead of me")
        };
      };
      for (const num of nums) {
        const key = vod + '|' + num;
        const old = audio.get(key);
        old.onsuccess = () => {
          if (old.result) {
            audio.delete(key);
            removedCount++;
            removedBytes += recBytes(old.result);
          }
          if (--remaining === 0) done();
        };
      }
    });
    if (cachedTotalBytes !== null) cachedTotalBytes = Math.max(0, cachedTotalBytes - removedBytes);
  } catch (e) { log('warn', `could not remove saved copies (${nums.length} part(s)) of VOD ${vod}`, e); }
}

export async function deleteSavedVods(vodList) {
  if (!vodList || !vodList.length) return;
  invalidateSavedTotal();
  await idb(['audio', 'vods'], 'readwrite', (audio, vods) => {
    for (const vod of vodList) {
      audio.delete(audioRange(vod));
      vods.delete(vod);
    }
  });
}

export const deleteSavedVod = (vod) => deleteSavedVods([vod]);

// Changes fields of a saved VOD's record (not its audio). Returns false
// when the VOD has nothing saved.
export async function updateVodInfo(vod, fields) {
  try {
    return await idb('vods', 'readwrite', (vods, out) => {
      const r = vods.get(vod);
      r.onsuccess = () => {
        if (!r.result) { out.value = false; return; }
        vods.put(Object.assign(r.result, fields));
        out.value = true;
      };
    });
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') noteStorageFull(e); // e.g. the position, every second: said once
    else log('warn', `could not update ${Object.keys(fields).join(', ')} of saved VOD ${vod}`, e);
    return false;
  }
}

// Saved VODs (records left with no part, which only remember a position,
// are left out unless `all`).
export async function listSaved(all) {
  const list = (await idb('vods', 'readonly', (vods, out) => {
    const r = vods.getAll();
    r.onsuccess = () => { out.value = r.result; };
  })) || [];
  return all ? list : list.filter((v) => v.segments > 0);
}

export async function expireSaved(keepDays) {
  expireGone();
  if (!keepDays) return; // 0 = keep forever
  const limit = Date.now() - keepDays * 864e5;
  const expired = (await listSaved(true)).filter((v) => v.savedAt < limit && !v.pinned).map((v) => v.vod);
  if (expired.length) await deleteSavedVods(expired);
}

// Storage limit: delete the oldest other saves first; if this VOD alone
// doesn't fit, stop saving it.
export async function makeRoom(job, incoming) {
  const maxMB = Number(settings.maxStorageMB) || 0;
  if (!maxMB) return true;
  const limit = maxMB * 1e6;
  if (cachedTotalBytes !== null && Date.now() - cachedTotalAt < 30000 && cachedTotalBytes + incoming <= limit) return true;
  const all = await listSaved();
  const baseTotal = all.reduce((n, v) => n + v.bytes, 0);
  cachedTotalBytes = baseTotal;
  cachedTotalAt = Date.now();
  let total = baseTotal + incoming;
  if (total <= limit) return true;
  for (const v of all.filter((x) => x.vod !== job.vodKey && !x.pinned).sort((a, b) => a.savedAt - b.savedAt)) {
    if (total <= limit) break;
    await deleteSavedVod(v.vod);
    total -= v.bytes;
    log('info', `storage limit (${maxMB} MB) reached: deleted the oldest saved VOD to make room: ${v.channel || v.vod}${v.streamedAt ? ' ' + new Date(v.streamedAt).toISOString().slice(0, 10) : ''}, ${v.segments} parts, ${(v.bytes / 1e6).toFixed(1)} MB`);
  }
  return total <= limit;
}
