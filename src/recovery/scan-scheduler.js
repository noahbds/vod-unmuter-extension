// Hook module (page and player worker): see src/hook.js.

import { jobName, MAX_PARALLEL, SAMPLE_SIZE, SKIP_REST_AFTER_H } from '../shared/constants.js';
import { saveMode } from '../shared/state.js';
import { log } from '../shared/logger.js';
import { vodInfo } from '../storage/idb.js';
import { flushGone, loadGone } from '../storage/gone-cache.js';
import { listSaved, loadSavedNums, updateVodInfo } from '../storage/saved-audio.js';
import { resolveSegment, setResult } from './probe-resolver.js';
import { isCurrent, jobs, sendResult, sendState, throttledProgress } from './recovery-state.js';
import { dropBehind, maybeSaveAll, scheduleCompress } from './save-compress-jobs.js';

// Once a VOD is checked, its saved record learns how much of it was muted
// and could be restored, so the menu can say "182 / 204 saved" and why.
export function noteVodTotals(job) {
  if (job.skipped && !job.saved.size) return;
  updateVodInfo(job.vodKey, {
    muted: job.segs.length,
    restorable: job.segs.filter((x) => x.source).length,
    checkedAt: Date.now(),
  });
}

// A small pool of workers, each finishing one segment before taking the next.
// A paused job (a quality the player isn't playing) stops taking segments
// and waits until it's played again.
export async function checkSegments(job, order, sample) {
  let next = 0;
  const worker = async () => {
    while (next < order.length) {
      if ((sample && job.skipRest) || job.paused) break;
      const s = order[next++];
      try { await resolveSegment(s); } catch (e) { log('warn', `${jobName(job)}: checking segment ${s.num} failed`, e); }
      job.done++;
      if (s.source) job.found++;
      if (sample && sample.has(s)) {
        job.sample.done++;
        if (s.source) job.sample.found++;
        if (!s.source && s.unknown) job.sample.unknown = (job.sample.unknown || 0) + 1;
        if (job.sample.done === job.sample.size && !job.sample.found && !job.sample.unknown &&
            job.endedAt && Date.now() - job.endedAt > SKIP_REST_AFTER_H * 36e5) job.skipRest = true;
      }
      throttledProgress(job);
    }
  };
  for (;;) {
    await Promise.all(Array.from({ length: MAX_PARALLEL }, worker));
    if (next >= order.length || (sample && job.skipRest) || !job.paused) break;
    await new Promise((resolve) => { job.onResume = resolve; });
  }
  flushGone();
}

// New muted segments in a VOD that is still recording.
export async function checkMore(job, segs) {
  await checkSegments(job, segs, null);
  sendResult(job);
  noteVodTotals(job);
  // Save the new ones too (or right after a save that is running now).
  if (job.saving) job.saveAgain = true;
  else job.savedAll = false;
  if (isCurrent(job)) maybeSaveAll(job);
}

export async function checkAll(job) {
  job.saved = await loadSavedNums(job.vodKey);
  job.cachedGone = await loadGone(job);
  // Furthest position reached in this VOD before ("Parts ahead of me").
  try {
    const info = (await listSaved(true)).find((v) => v.vod === job.vodKey);
    if (info && info.behind) job.behind = info.behind;
  } catch (e) { /* none */ }
  if (job.behind && saveMode() === 'unplayed' && !job.auto) dropBehind(job, []);
  const info = vodInfo(job.vodKey);
  if (info.streamedAt) job.endedAt = info.streamedAt + job.total * 1000;
  sendState(job);

  // A sample spread over the whole VOD is checked first, for an early
  // verdict; then everything else in playback order. A small pool of
  // workers each finishes one segment before taking the next.
  const n = job.segs.length;
  const sample = new Set();
  for (let i = 0; i < Math.min(SAMPLE_SIZE, n); i++) sample.add(job.segs[Math.floor(((i + 0.5) * n) / Math.min(SAMPLE_SIZE, n))]);
  const order = [...sample].concat(job.segs.filter((s) => !sample.has(s)));
  job.sample = { size: sample.size, done: 0, found: 0 };
  await checkSegments(job, order, sample);
  if (job.skipRest) {
    // Old VOD, nothing left in the sample: only the saved copy counts.
    let skipped = 0;
    for (const s of job.segs) {
      if (s.source !== undefined || s.confirmed) continue;
      if (job.saved.has(s.num)) setResult(s, 'saved');
      else { s.source = null; s.skippedCheck = true; skipped++; }
    }
    job.skipped = skipped;
    job.done = job.segs.length;
  }
  job.finished = true;
  noteVodTotals(job);
  const restored = sendResult(job);
  const unknown = job.segs.filter((x) => !x.source && x.unknown).length;
  const gone = job.segs.length - restored - unknown;
  log('info', `${jobName(job)}: ${restored}/${job.segs.length} muted segments can be unmuted` +
    (gone ? ` · ${gone} deleted in every quality` + (job.skipped ? ` (${job.skipped} not checked one by one: old VOD)` : '') : '') +
    (unknown ? ` · ${unknown} not checked yet (network problem, will retry)` : ''));
  if (isCurrent(job)) { maybeSaveAll(job); scheduleCompress(job); }
  retryUnknown(job, 1);
}

// Segments that couldn't be checked because of network problems are
// checked again later (30 s, 2 min, 5 min).
export function retryUnknown(job, attempt) {
  const todo = () => job.segs.filter((x) => !x.source && x.unknown && !x.confirmed);
  if (!todo().length || attempt > 3 || job.retryTimer) return;
  job.retryTimer = setTimeout(async () => {
    job.retryTimer = null;
    if (!jobs.includes(job)) return;
    const segs = todo();
    if (!segs.length) return;
    log('info', `retrying ${segs.length} segment(s) that couldn't be checked (network problem)`);
    await checkSegments(job, segs, null);
    sendResult(job);
    if (isCurrent(job)) maybeSaveAll(job);
    retryUnknown(job, attempt + 1);
  }, [0, 30e3, 120e3, 300e3][attempt]);
}
