// Hook module (page and player worker): see src/hook.js.

import { ALL_GONE_AFTER_H, parseVodKey, PLAYING_MS, prettyQuality } from '../shared/constants.js';
import { dirExts, INSTANCE, IS_PAGE, known, mp4Dirs, mp4Inits, playlists, post, renditions, segments, settings, vodIdsByBase } from '../shared/state.js';
import { aacSupported } from '../media/aac-compression.js';
import { allDirs } from './probe-resolver.js';
import { maybeSaveAll } from './save-compress-jobs.js';

// ------------------------------------------------------------ reporting
// Where a segment's audio comes from, for the UI:
//   kind: 'original'     the original file of the quality being watched
//         'backup'       Twitch's "-unmuted" file of that quality
//         'saved'        a copy saved on this computer earlier
//         'other'        the original file of another quality (audio only)
//         'other-backup' the "-unmuted" file of another quality (audio only)
export function describe(seg) {
  if (seg.source === 'saved') return { kind: 'saved', quality: '' };
  const slash = seg.source.indexOf('/');
  const file = slash < 0 ? seg.source : seg.source.slice(slash + 1);
  const backup = file === '-unmuted.ts';
  if (slash < 0) return { kind: backup ? 'backup' : 'original', quality: prettyQuality(seg.job.dir) };
  return { kind: backup ? 'other-backup' : 'other', quality: prettyQuality(seg.source.slice(0, slash)) };
}

// Why a muted segment is (still) muted, for the UI and the logs:
//   'restored'  it isn't: its sound was found
//   'checking'  not checked yet
//   'network'   couldn't be checked (timeouts, server errors): retried
//   'skipped'   not checked one by one: old VOD, nothing left in a sample
//   'splice'    sound found but it didn't fit (timing): kept muted
//   'damaged'   the saved copy couldn't be used
//   'gone'      Twitch deleted the original in every quality
export function reasonOf(seg) {
  if (seg.source) return 'restored';
  if (seg.reason) return seg.reason;
  if (seg.unknown) return 'network';
  if (seg.skippedCheck) return 'skipped';
  if (seg.source === undefined) return 'checking';
  return 'gone';
}

export function buildRanges(segs) {
  const ranges = [];
  let cur = null;
  for (const s of segs) {
    const restored = !!s.source;
    const reason = reasonOf(s);
    // Ranges split where the color changes: restored / waiting / muted.
    const kind = restored ? 'ok' : reason === 'checking' ? 'pending' : reason === 'network' ? 'wait' : 'no';
    const contiguous = cur && Math.abs(cur.end - s.start) < 0.5 && cur.kind === kind;
    if (!contiguous) {
      cur = { start: s.start, end: s.start, segments: 0, restored, kind, sources: new Map(), reasons: {}, saved: 0, removedWatched: 0 };
      ranges.push(cur);
    }
    cur.end = s.start + s.duration;
    cur.segments++;
    if (!restored) cur.reasons[reason] = (cur.reasons[reason] || 0) + 1;
    if (s.job.saved.has(s.num)) cur.saved++;
    if (s.removedAfterWatch === 'behind') cur.removedBehind = (cur.removedBehind || 0) + 1;
    else if (s.removedAfterWatch) cur.removedWatched++;
    if (s.source) {
      const d = describe(s);
      const k = d.kind + '|' + d.quality;
      if (!cur.sources.has(k)) cur.sources.set(k, Object.assign(d, { segments: 0 }));
      cur.sources.get(k).segments++;
    }
  }
  return ranges.map((r) => ({
    start: r.start, end: r.end, segments: r.segments, restored: r.restored, kind: r.kind,
    sources: [...r.sources.values()].sort((a, b) => b.segments - a.segments),
    reasons: r.reasons, saved: r.saved, removedWatched: r.removedWatched, removedBehind: r.removedBehind || 0,
  }));
}

// Twitch keeps a separate copy of the VOD per quality, so only report the
// quality the player is actually downloading segments from.
export const jobs = [];
// The job of the VOD a file URL belongs to (the first one, if several
// qualities of it are open).
export const jobOf = (url) => jobs.find((j) => url.startsWith(j.vodBase));
export let currentJob = null;
let noneCurrent = false; // the player moved to a VOD with nothing muted
// In the player, a VOD whose playlist was just loaded counts as playing
// until segments say otherwise. The page copy only sees playlists that
// something else in the page fetched (e.g. another extension), so there a
// VOD counts only once its video is really downloaded from the page.
export const isCurrent = (job) => !job.auto &&
  (currentJob || (noneCurrent || IS_PAGE ? null : jobs.filter((j) => !j.auto).pop())) === job;

const MAX_KEPT_VODS = 3;

// Frees memory held for a VOD folder (playlists, known URLs, MP4 init buffers,
// segment hooks, and idle jobs). Active saving/compressing jobs are never touched.
export function evictVodState(vodBase, forceJob) {
  if (!vodBase) return;
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    if (j.vodBase !== vodBase) continue;
    if (j !== forceJob && (!j.finished || j.saving || j.compressing || j === currentJob)) return;
  }
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    if (j.vodBase !== vodBase) continue;
    clearTimeout(j.retryTimer);
    clearTimeout(j.progressTimer);
    clearTimeout(j.resultTimer);
    clearTimeout(j.compressTimer);
    clearTimeout(j.positionTimer);
    for (const s of j.segs) segments.delete(s.urls['.ts']);
    jobs.splice(i, 1);
  }
  for (const k of playlists.keys()) if (k.startsWith(vodBase)) playlists.delete(k);
  for (const k of known.keys()) if (k.startsWith(vodBase)) known.delete(k);
  for (const k of mp4Inits.keys()) if (k.startsWith(vodBase)) mp4Inits.delete(k);
  for (const k of dirExts.keys()) if (k.startsWith(vodBase)) dirExts.delete(k);
  renditions.delete(vodBase);
  vodIdsByBase.delete(vodBase);
  mp4Dirs.delete(vodBase);
}

function pruneOldVods() {
  const seen = [];
  for (let i = jobs.length - 1; i >= 0; i--) {
    const b = jobs[i].vodBase;
    if (b && !seen.includes(b)) seen.push(b);
  }
  for (const b of seen.slice(MAX_KEPT_VODS)) evictVodState(b);
}

// The player opened another VOD (Twitch changes pages without reloading).
// `job` is that VOD's job, or null when it has nothing muted: tell the UI
// to drop the previous VOD's counter and seek bar colors.
export function switchVod(vodBase, job) {
  if (IS_PAGE) return; // the page copy doesn't play: playlists it sees say nothing about the player
  const before = currentJob || (noneCurrent ? null : jobs.filter((j) => !j.auto).pop());
  if (!before || before.vodBase === vodBase) return;
  post({ type: 'none', vod: before.vod, instance: INSTANCE });
  if (job) { makeCurrent(job); sendState(job); } else { currentJob = null; noneCurrent = true; }
  pruneOldVods();
}

// `job` was dropped (Twitch unmuted its VOD): it isn't the current one any more.
export function forgetCurrent(job) {
  if (currentJob === job) currentJob = null;
}

// Called for the player's requests: the quality whose segments it
// downloads is the one being played (playlists alone don't count: the
// player may load several when adapting quality).
export function noteActivity(url) {
  // Numbered media files only: an MP4 VOD's "init-0.mp4" is also fetched to
  // probe a quality (TwitchNoSub does it for every quality), not to play it.
  if (!/\/\d+(-unmuted|-muted)?\.(ts|mp4)(\?|$)/.test(url)) return;
  for (const job of jobs) {
    if (url.startsWith(job.base)) {
      const wasPlaying = job.lastSegmentAt && Date.now() - job.lastSegmentAt < PLAYING_MS;
      job.lastSegmentAt = Date.now();
      if (!wasPlaying && currentJob === job) sendState(job); // tell the UI this copy plays
      if (currentJob !== job) {
        makeCurrent(job);
        sendState(job);
        maybeSaveAll(job);
      }
      return;
    }
  }
}

// `checking`: sent while the check runs, with what is known so far (the
// seek bar and the panel fill in live).
export function sendResult(job, checking) {
  let restored = 0, fromOther = 0, fromSaved = 0, mutedSeconds = 0, restoredSeconds = 0, saved = 0, unknown = 0;
  for (const s of job.segs) {
    mutedSeconds += s.duration;
    if (job.saved.has(s.num)) saved++;
    if (!s.source && s.unknown) unknown++;
    if (!s.source) continue;
    restored++;
    restoredSeconds += s.duration;
    if (s.source === 'saved') fromSaved++;
    else if (s.source.includes('/')) fromOther++;
  }
  if (isCurrent(job)) {
    post({
      type: checking ? 'checking' : 'result', key: job.key, vod: job.vod, vodKey: job.vodKey, vodId: job.vodId || null,
      instance: INSTANCE, playing: !!job.lastSegmentAt && Date.now() - job.lastSegmentAt < PLAYING_MS,
      done: job.done, found: job.found, sample: job.sample || null, allGoneAfterH: ALL_GONE_AFTER_H,
      quality: prettyQuality(job.dir), total: job.total,
      muted: job.segs.length, restored, fromOther, fromSaved, mutedSeconds, restoredSeconds,
      skipped: job.skipped || 0, unknown,
      reasons: job.segs.reduce((m, x) => { const r = reasonOf(x); m[r] = (m[r] || 0) + 1; return m; }, {}),
      mp4: !!job.mp4,
      checkedQualities: allDirs(job).concat(allDirs(job).includes('audio_only') ? [] : ['audio_only']).map(prettyQuality),
      channel: job.channel || parseVodKey(job.vodKey).channel, endedAt: job.endedAt || null, sampleSize: job.sample ? job.sample.size : 0,
      ranges: buildRanges(job.segs),
      save: {
        enabled: !!settings.saveAudio, mode: settings.saveMode, forced: !!job.forceSave, pinned: !!job.pinned,
        saved, savable: restored, active: job.saving,
        bytes: job.savedBytes, savedAt: job.savedAt, paused: job.noSave,
        quality: settings.saveQuality, aac: aacSupported, limitReached: !!job.limitReached, storageFull: !!job.storageFull, maxMB: Number(settings.maxStorageMB) || 0,
        compressing: job.compressing ? { done: job.compressDone, total: job.compressTotal } : null,
      },
    });
  }
  return restored;
}

export function sendState(job) {
  sendResult(job, !job.finished);
}

export function throttledProgress(job) {
  if (job.progressTimer) return;
  job.progressTimer = setTimeout(() => { job.progressTimer = null; if (!job.finished) sendState(job); }, 250);
}

export function scheduleResult(job) {
  clearTimeout(job.resultTimer);
  job.resultTimer = setTimeout(() => sendResult(job), 400);
}

// The player now plays `job`: pause the checks of this VOD's other
// qualities (each quality is a separate copy, so their checks are only
// useful when played) and resume this one.
function makeCurrent(job) {
  currentJob = job;
  noneCurrent = false;
  for (const j of jobs) if (j !== job && !j.auto && j.vodBase === job.vodBase) j.paused = true;
  if (job.paused) {
    job.paused = false;
    if (job.onResume) { const r = job.onResume; job.onResume = null; r(); }
  }
}
