// Hook module (page and player worker): see src/hook.js.

import { isBehind, isMiss, jobName, notAhead, POSITION_WAIT_MS, SUFFIXES } from '../shared/constants.js';
import { known, realFetch, saveMode, settings } from '../shared/state.js';
import { log } from '../shared/logger.js';
import { extractAudio } from '../media/transport-stream.js';
import { adtsInfo, packetsToAdts, splitAdts } from '../media/adts-muxer.js';
import { decodeFrames, deflate, encoderDelay, KBPS, reencode } from '../media/aac-compression.js';
import { recBytes } from '../storage/idb.js';
import { markMissing } from '../storage/gone-cache.js';
import { deleteSavedSegment, loadRecord, loadSaved, makeRoom, putRecord, recordToAudio } from '../storage/saved-audio.js';
import { saveDirs, saveLimited, urlFor } from './probe-resolver.js';
import { jobOf, jobs, scheduleResult, sendResult } from './recovery-state.js';

// "Parts ahead of me" mode: removes the saved copies of the parts behind
// the furthest position reached in this VOD, and of `watched` parts.
export async function dropBehind(job, watched) {
  const drop = job.segs.filter((s) => job.saved.has(s.num) && (isBehind(job, s) || (watched || []).includes(s)));
  for (const s of drop) {
    await deleteSavedSegment(job.vodKey, s.num);
    for (const j of jobs) {
      if (j.vodKey !== job.vodKey) continue;
      j.saved.delete(s.num);
      for (const x of j.segs) if (x.num === s.num) x.removedAfterWatch = isBehind(job, s) && !s.played ? 'behind' : 'watched';
    }
  }
  if (drop.length) {
    log('info', `${jobName(job)}: removed ${drop.length} saved part(s) behind where you are`);
    scheduleResult(job);
  }
}

// ------------------------------------------------------------ saving
export function noteSaved(job, info) {
  if (!info) return;
  // Keep every quality of this VOD in sync.
  for (const j of jobs) {
    if (j.vodKey !== job.vodKey) continue;
    j.savedBytes = info.bytes;
    j.savedAt = info.savedAt;
  }
  if (job.finished) scheduleResult(job);
}

// Saves run one at a time, so the storage limit is checked against
// what's really on disk.
export let saveQueue = Promise.resolve();
export const serially = (task) => {
  const run = saveQueue.then(task, task);
  saveQueue = run.catch(() => {});
  return run;
};

// The browser's storage for twitch.tv is full (see putRecord): every
// quality of this VOD stops saving, and its panel says why.
export function storageFullFor(vod) {
  for (const j of jobs) if (j.vodKey === vod) { j.limitReached = true; j.storageFull = true; scheduleResult(j); }
}

export async function saveFromBytes(seg, bytes) {
  const job = seg.job;
  if (!settings.saveAudio || job.noSave || job.limitReached || job.saved.has(seg.num)) return;
  const audio = extractAudio(bytes);
  if (!audio) return;
  const info = await serially(async () => {
    if (job.limitReached || job.saved.has(seg.num)) return null;
    const packed = await deflate(audio.packets);
    if (!(await makeRoom(job, packed.data.byteLength))) {
      job.limitReached = true;
      scheduleResult(job);
      return null;
    }
    return putRecord(job.vodKey, seg.num, { fmt: 'deflate', type: audio.type, pts: audio.pts, data: packed.data, packed: packed.packed }, false, storageFullFor);
  });
  if (!info) return;
  for (const j of jobs) if (j.vodKey === job.vodKey) j.saved.add(seg.num);
  noteSaved(job, info);
}

// Save every muted part that can still be unmuted, in the background
// ("unplayed" mode: except the parts already watched).
export async function maybeSaveAll(job, force) {
  if (!settings.saveAudio || job.noSave) return;
  if (!job.finished || job.saving || job.savedAll) return;
  const ahead = saveMode() === 'unplayed';
  // "Ahead of me" in the player: wait for its position first, so nothing
  // behind it is ever downloaded (auto-save has no player: no wait).
  if (ahead && !job.auto && job.position === undefined && !job.positionTimedOut) {
    if (!job.positionTimer) {
      job.positionTimer = setTimeout(() => { job.positionTimedOut = true; maybeSaveAll(job); }, POSITION_WAIT_MS);
    }
    return;
  }
  const skip = (s) => ahead && (s.played || notAhead(job, s));
  const todo = job.segs.filter((s) => s.source && s.source !== 'saved' && !job.saved.has(s.num) && !skip(s));
  // Nearest first, from where the player is.
  if (ahead && job.position !== undefined) todo.sort((a, b) => a.start - b.start);
  if (!todo.length) { job.savedAll = true; compressJob(job); return; }
  job.saving = true;
  sendResult(job);
  const dirs = saveDirs(job);
  await Promise.all(todo.map((seg) => saveLimited(async () => {
    if (!settings.saveAudio || job.noSave || job.limitReached || job.saved.has(seg.num)) return;
    if (skip(seg)) return; // the player moved past it meanwhile
    for (const dir of dirs) {
      for (const sfx of SUFFIXES) {
        const url = urlFor(seg, dir + '/' + sfx);
        if (known.get(url) === false) continue;
        try {
          const r = await realFetch.call(scope, url, { cache: 'no-store' });
          if (!r.ok) { if (isMiss(r.status)) markMissing(url, jobOf(url)); continue; }
          known.set(url, true);
          await saveFromBytes(seg, new Uint8Array(await r.arrayBuffer()));
          return;
        } catch (e) { log('debug', `${jobName(job)}: saving segment ${seg.num} from ${dir} failed, trying the next quality`, e); }
      }
    }
  })));
  job.saving = false;
  job.savedAll = !job.limitReached;
  sendResult(job);
  if (job.saveAgain && !job.limitReached) {
    job.saveAgain = false;
    job.savedAll = false;
    return maybeSaveAll(job, force);
  }
  compressJob(job);
}

// ---- saving step 2: compress what was saved ------------------------------
export function scheduleCompress(job) {
  clearTimeout(job.compressTimer);
  job.compressTimer = setTimeout(() => compressJob(job), 15000);
}

// The end of segment num-1, for a seamless join: from the saved copy if
// there is one, or from Twitch (segments before a muted part play
// normally, so they still exist), or silence.
export async function leadInFrames(job, num, cache) {
  if (cache.num === num - 1 && cache.frames) return cache.frames.slice(-8);
  const muted = job.segs.find((s) => s.num === num - 1);
  if (muted) {
    if (!job.saved.has(num - 1)) return [];
    const audio = await loadSaved(job.vodKey, num - 1);
    return audio ? splitAdts(packetsToAdts(audio.packets)).slice(-8) : [];
  }
  for (const dir of saveDirs(job)) {
    try {
      const r = await realFetch.call(scope, job.vodBase + dir + '/' + (num - 1) + '.ts');
      if (!r.ok) continue;
      const audio = extractAudio(new Uint8Array(await r.arrayBuffer()));
      if (audio) return splitAdts(packetsToAdts(audio.packets)).slice(-8);
    } catch (e) { /* try the next quality */ }
  }
  return [];
}

// One compression run at a time per VOD; a request during a run queues
// one more run (for segments saved meanwhile). Resolves when done.
export function compressJob(job) {
  if (!settings.saveAudio || job.noSave || !job.saved.size) return Promise.resolve();
  if (job.compressPromise) { job.compressAgain = true; return job.compressPromise; }
  job.compressAgain = false;
  job.compressPromise = runCompress(job).finally(() => { job.compressPromise = null; });
  return job.compressPromise.then(() => (job.compressAgain ? compressJob(job) : undefined));
}

export async function runCompress(job) {
  const kbps = KBPS[settings.saveQuality];
  job.compressing = true;
  job.compressDone = 0;
  job.compressTotal = job.saved.size;
  scheduleResult(job); // show "Compressing…" right away, not after the first 10
  let freed = 0;
  try {
    const nums = [...job.saved].sort((a, b) => a - b);
    job.compressTotal = nums.length;
    job.compressDone = 0;
    const cache = { num: null, frames: null };
    for (const num of nums) {
      if (!settings.saveAudio || job.noSave) break;
      job.compressDone++;
      if (job.compressDone % 10 === 0) scheduleResult(job);
      const rec = await loadRecord(job.vodKey, num);
      if (!rec) continue;
      if (rec.fmt === 'aac') { cache.num = null; continue; } // already re-encoded once
      const audio = await recordToAudio(rec);
      if (!audio) continue;
      let next = null;
      if (kbps) {
        const frames = splitAdts(packetsToAdts(audio.packets));
        const info = frames.length && adtsInfo(frames[0]);
        const delay = info ? await encoderDelay(info, kbps) : null;
        if (delay !== null) {
          try {
            const lead = await leadInFrames(job, num, cache);
            const pcm = await decodeFrames(lead.concat(frames), info);
            const skip = lead.length * 1024;
            const data = await reencode(lead.length ? pcm.map((c) => c.subarray(0, skip)) : null,
              pcm.map((c) => c.subarray(skip)), info, kbps, delay, frames.length);
            if (data) next = { fmt: 'aac', type: 0x0f, pts: audio.pts, kbps, data };
          } catch (e) { log('warn', `${jobName(job)}: compressing segment ${num} failed, kept lossless`, e); }
          cache.num = num;
          cache.frames = frames;
        }
      }
      // Lossless fallback (or "Original" quality): only old uncompressed saves change.
      if (!next && !rec.fmt) {
        const packed = await deflate(rec.packets);
        next = { fmt: 'deflate', type: rec.type, pts: rec.pts, data: packed.data, packed: packed.packed };
      }
      if (next && recBytes(next) < recBytes(rec)) {
        freed += recBytes(rec) - recBytes(next);
        noteSaved(job, await putRecord(job.vodKey, num, next, true, storageFullFor));
      }
    }
  } finally {
    job.compressing = false;
    scheduleResult(job);
  }
  // Compression may have made room to save the rest.
  if (job.limitReached && freed > 0) {
    job.limitReached = false;
    job.savedAll = false;
    maybeSaveAll(job);
  }
}
