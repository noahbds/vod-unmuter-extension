// Hook module (page and player worker): see src/hook.js.

import { fmtTime, jobName, MAX_PARALLEL, partName, SAMPLE_SIZE, SKIP_REST_AFTER_H, stretches } from '../shared/constants.js';
import { saveMode, settings } from '../shared/state.js';
import { log, logGroup } from '../shared/logger.js';
import { vodInfo } from '../storage/idb.js';
import { flushGone, loadGone } from '../storage/gone-cache.js';
import { listSaved, loadSavedNums, updateVodInfo } from '../storage/saved-audio.js';
import { describeChecks, resolveSegment, setResult } from './probe-resolver.js';
import { describe, isCurrent, jobs, sendResult, sendState, throttledProgress } from './recovery-state.js';
import { dropBehind, maybeSaveAll, scheduleCompress } from './save-compress-jobs.js';

// Once a VOD is checked, its saved record learns how much of it was muted
// and could be restored (plus its Twitch id and title when known), so the menu
// can say "182 / 204 saved", why, and link to the VOD.
export function noteVodTotals(job) {
  if (job.skipped && !job.saved.size) return;
  const fields = {
    muted: job.segs.length,
    restorable: job.segs.filter((x) => x.source).length,
    checkedAt: Date.now(),
  };
  if (job.vodId) fields.vodId = job.vodId;
  if (job.title) fields.title = job.title;
  if (job.channel) fields.channel = job.channel;
  if (job.streamedAt) fields.streamedAt = job.streamedAt;
  updateVodInfo(job.vodKey, fields);
}

// Picks the next segment to check: once the initial spread sample is done,
// segments at or ahead of the viewer's playhead come first, then wrap around.
export function pickNextSegment(pool, position) {
  if (!pool.length) return null;
  if (position !== undefined && Number.isFinite(position)) {
    const idx = pool.findIndex((s) => s.start + s.duration >= position);
    if (idx >= 0) return pool.splice(idx, 1)[0];
  }
  return pool.shift();
}

// A small pool of workers, each finishing one segment before taking the next.
// A paused job (a quality the player isn't playing) stops taking segments
// and waits until it's played again.
// `report` (optional) collects each part's result for the logs.
async function checkSegments(job, order, sample, report) {
  const sampleQueue = sample ? order.filter((s) => sample.has(s)) : [];
  const restQueue = sample ? order.filter((s) => !sample.has(s)) : order.slice();
  const take = () => (sampleQueue.length ? sampleQueue.shift() : pickNextSegment(restQueue, job.position));
  const worker = async () => {
    for (;;) {
      if ((sample && job.skipRest) || job.paused) break;
      const s = take();
      if (!s) break;
      try { await resolveSegment(s, report); } catch (e) { log('warn', `${jobName(job)}: checking ${partName(s)} failed, it stays muted for now`, e); }
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
    if ((!sampleQueue.length && !restQueue.length) || (sample && job.skipRest) || !job.paused) break;
    await new Promise((resolve) => { job.onResume = resolve; });
  }
  flushGone();
}

// New muted segments in a VOD that is still recording.
export async function checkMore(job, segs) {
  const started = Date.now();
  const report = [];
  await checkSegments(job, segs, null, report);
  const restored = segs.filter((s) => s.source).length;
  logChecks(job, `${segs.length} newly muted part(s) (the VOD is still recording): ${restored} can be unmuted` +
    (restored < segs.length ? ` · not yet: ${stretches(segs.filter((s) => !s.source))}` : '') + ` · checked in ${seconds(started)}`, report);
  sendResult(job);
  noteVodTotals(job);
  // Save the new ones too (or right after a save that is running now).
  if (job.saving) job.saveAgain = true;
  else job.savedAll = false;
  if (isCurrent(job)) maybeSaveAll(job);
}

export async function checkAll(job) {
  const started = Date.now();
  job.saved = await loadSavedNums(job.vodKey);
  job.cachedGone = await loadGone(job);
  // Furthest position reached in this VOD before ("Parts ahead of me"), and
  // the size/date of audio already saved on disk for it.
  try {
    const info = (await listSaved(true)).find((v) => v.vod === job.vodKey);
    if (info) {
      if (info.behind) job.behind = info.behind;
      if (info.bytes) job.savedBytes = info.bytes;
      if (info.savedAt) job.savedAt = info.savedAt;
      if (info.pinned) job.pinned = true;
    }
  } catch (e) { /* none */ }
  if (job.behind && saveMode() === 'unplayed' && !job.auto) dropBehind(job, []);
  const info = vodInfo(job.vodKey);
  const streamedAt = job.streamedAt || info.streamedAt;
  if (streamedAt) job.endedAt = streamedAt + job.total * 1000;
  sendState(job);

  // A sample spread over the whole VOD is checked first, for an early
  // verdict; then everything else in playback order. A small pool of
  // workers each finishes one segment before taking the next.
  const n = job.segs.length;
  const sample = new Set();
  for (let i = 0; i < Math.min(SAMPLE_SIZE, n); i++) sample.add(job.segs[Math.floor(((i + 0.5) * n) / Math.min(SAMPLE_SIZE, n))]);
  const order = [...sample].concat(job.segs.filter((s) => !sample.has(s)));
  job.sample = { size: sample.size, done: 0, found: 0 };
  log('info', `${jobName(job)}: checking ${n} muted parts (${fmtTime(job.segs.reduce((t, s) => t + s.duration, 0))} of a ${fmtTime(job.total)} VOD)` +
    ` · ${job.saved.size} saved on this computer · ${job.cachedGone} files already known as deleted` +
    ` · first a sample of ${sample.size} spread over the VOD, then the rest in playback order` +
    (job.mp4 ? ' · MP4 VOD (HEVC/AV1)' : '') +
    (job.paused ? ' · paused until the player plays this quality' : '') + (job.auto ? ' · for auto-save' : ''));
  const report = [];
  await checkSegments(job, order, sample, report);
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
  logChecks(job, `${checkSummary(job, restored, gone, unknown)} · checked in ${seconds(started)}`, report);
  if (isCurrent(job)) { maybeSaveAll(job); scheduleCompress(job); }
  retryUnknown(job, 1);
}

// The end of a VOD's check, in words: how much is muted, what can be
// unmuted and from where, and why the rest can't.
export function checkSummary(job, restored, gone, unknown) {
  const muted = job.segs.reduce((n, s) => n + s.duration, 0);
  const from = {};
  for (const s of job.segs) if (s.source) { const k = describe(s).kind; from[k] = (from[k] || 0) + 1; }
  const NAMES = { original: 'original files', backup: '"-unmuted" backups', other: 'other qualities', 'other-backup': 'other qualities\' backups', saved: 'saved copies' };
  const sources = Object.entries(from).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} from ${NAMES[k]}`).join(', ');
  return `${restored}/${job.segs.length} muted parts can be unmuted` + (sources ? ` (${sources})` : '') +
    ` · ${fmtTime(muted)} muted in a ${fmtTime(job.total)} VOD` +
    (gone ? ` · ${gone} stay muted, deleted by Twitch in every quality: ${stretches(job.segs.filter((s) => !s.source && !s.unknown))}` +
      (job.skipped ? ` (${job.skipped} of them not checked one by one: old VOD, nothing left in a sample of ${job.sample.size})` : '') : '') +
    (unknown ? ` · ${unknown} not checked yet (network or server errors), retried in 30 s: ${stretches(job.segs.filter((s) => !s.source && s.unknown))}` : '') +
    (job.cachedGone ? ` · ${job.cachedGone} files already known as deleted (no request)` : '');
}

const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

// A check's summary, with each part's result under it (Debug logging only):
// one collapsed group in the console.
function logChecks(job, summary, report) {
  const lines = settings.debug && report.length
    ? ['("remembered": known from an earlier check or from the deleted-files cache, so no request was sent)'].concat(describeChecks(report))
    : [];
  logGroup('info', `${jobName(job)}: ${summary}`, lines);
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
    log('info', `${jobName(job)}: retrying ${segs.length} muted part(s) that couldn't be checked (network or server errors), try ${attempt} of 3: ${stretches(segs)}`);
    const started = Date.now();
    const report = [];
    await checkSegments(job, segs, null, report);
    const restored = segs.filter((s) => s.source).length;
    const still = segs.filter((s) => !s.source && s.unknown);
    logChecks(job, `retry ${attempt} of 3: ${restored} of ${segs.length} can be unmuted now, ${segs.length - restored - still.length} deleted by Twitch` +
      (still.length ? `, ${still.length} still unanswered` + (attempt < 3 ? ` (next try in ${[0, 30, 120, 300][attempt + 1] / 60} min)` : ' (no more tries: they play muted unless playback finds their sound)') : '') +
      ` · ${seconds(started)}`, report);
    sendResult(job);
    if (isCurrent(job)) maybeSaveAll(job);
    retryUnknown(job, attempt + 1);
  }, [0, 30e3, 120e3, 300e3][attempt]);
}
