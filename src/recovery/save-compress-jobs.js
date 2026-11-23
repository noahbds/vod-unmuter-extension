// Hook module (page and player worker): see src/hook.js.

import { fileLabel, fmtTime, isBehind, isMiss, jobName, notAhead, partName, partOf, POSITION_WAIT_MS, prettyQuality, SAVE_PARALLEL, stretches, SUFFIXES } from '../shared/constants.js';
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
    log('info', `${jobName(job)}: removed the saved copies of ${drop.length} part(s) you watched or skipped (furthest position ${fmtTime(job.behind || 0)}; "Parts ahead of me")`);
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
      log('debug', `${jobName(job)}: saving waits up to ${POSITION_WAIT_MS / 1000} s for the player's position ("Parts ahead of me": nothing behind you is downloaded)`);
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
  const started = Date.now();
  const before = { parts: job.saved.size, bytes: job.savedBytes || 0 };
  const from = {}; // quality -> parts saved from it
  const failed = [];
  let passed = 0;
  // Saving already stopped (storage full or limit): this pass changes nothing, so it isn't logged.
  const quiet = job.limitReached;
  if (!quiet) log('info', `${jobName(job)}: saving the sound of ${todo.length} muted part(s)` +
    (ahead ? ` ahead of you ("Parts ahead of me"${job.position !== undefined ? `, from ${fmtTime(job.position)}` : ''})` : ' ("Every muted part")') +
    ` · downloading from ${prettyQuality(dirs[0])} first (smallest file with full-quality sound), ${SAVE_PARALLEL} at a time`);
  await Promise.all(todo.map((seg) => saveLimited(async () => {
    if (!settings.saveAudio || job.noSave || job.limitReached || job.saved.has(seg.num)) return;
    if (skip(seg)) { passed++; return; } // the player moved past it meanwhile
    for (const dir of dirs) {
      for (const sfx of SUFFIXES) {
        const url = urlFor(seg, dir + '/' + sfx);
        if (known.get(url) === false) continue;
        try {
          const r = await realFetch.call(scope, url, { cache: 'no-store' });
          if (!r.ok) { if (isMiss(r.status)) markMissing(url, jobOf(url)); continue; }
          known.set(url, true);
          await saveFromBytes(seg, new Uint8Array(await r.arrayBuffer()));
          if (job.saved.has(seg.num)) from[prettyQuality(dir)] = (from[prettyQuality(dir)] || 0) + 1;
          return;
        } catch (e) { log('debug', `${jobName(job)}: saving ${partName(seg)}: downloading the ${fileLabel(job, dir + '/' + sfx)} failed, trying the next file`, e); }
      }
    }
    if (!job.saved.has(seg.num)) failed.push(seg);
  })));
  const added = job.saved.size - before.parts;
  if (!quiet || added) log('info', `${jobName(job)}: saved ${added} of ${todo.length} part(s) in ${((Date.now() - started) / 1000).toFixed(1)} s` +
    (added ? ` (${Object.entries(from).map(([q, n]) => `${n} from ${q}`).join(', ')}), +${(((job.savedBytes || 0) - before.bytes) / 1e6).toFixed(1)} MB lossless, ${job.saved.size} parts and ${((job.savedBytes || 0) / 1e6).toFixed(1)} MB saved for this VOD now` : '') +
    (passed ? ` · ${passed} skipped: you played past them meanwhile` : '') +
    (job.limitReached ? ` · stopped: ${job.storageFull ? 'no room left in the browser (see the warning)' : `the storage limit (${settings.maxStorageMB} MB) is reached`}` : '') +
    (failed.length && !job.limitReached ? ` · not saved (no quality could be downloaded): ${stretches(failed)}` : '') +
    (job.saved.size ? ' · compressing comes next' : ''));
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
  const started = Date.now();
  const count = { aac: 0, deflate: 0, already: 0, kept: 0, failed: 0 };
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
      if (rec.fmt === 'aac') { cache.num = null; count.already++; continue; } // already re-encoded once
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
          } catch (e) { count.failed++; log('warn', `${jobName(job)}: compressing the saved copy of ${partOf(job, num)} to AAC ${kbps} kbps failed, it stays lossless`, e); }
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
        count[next.fmt]++;
        noteSaved(job, await putRecord(job.vodKey, num, next, true, storageFullFor));
      } else count.kept++;
    }
  } finally {
    job.compressing = false;
    scheduleResult(job);
  }
  const changed = count.aac + count.deflate;
  if (changed || count.failed) {
    log('info', `${jobName(job)}: compressed ${changed} saved part(s) in ${((Date.now() - started) / 1000).toFixed(1)} s, ${(freed / 1e6).toFixed(1)} MB freed` +
      ` (${[count.aac && `${count.aac} re-encoded to AAC ${kbps} kbps`, count.deflate && `${count.deflate} packed losslessly`].filter(Boolean).join(', ')})` +
      ` · ${((job.savedBytes || 0) / 1e6).toFixed(1)} MB saved for this VOD now` +
      (count.already ? ` · ${count.already} were already AAC` : '') +
      (count.kept ? ` · ${count.kept} kept as they were (${kbps ? 'no AAC encoder, or not smaller' : '"Original" quality: lossless only'})` : '') +
      (count.failed ? ` · ${count.failed} failed, kept lossless` : ''));
  }
  // Compression may have made room to save the rest.
  if (job.limitReached && freed > 0) {
    job.limitReached = false;
    job.savedAll = false;
    maybeSaveAll(job);
  }
}
