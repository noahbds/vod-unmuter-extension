// Hook module (page and player worker): see src/hook.js.

import { AHEAD_MIN_PLAY, jobName } from '../shared/constants.js';
import { channel, IS_PAGE, ORIGIN, post, RESTRICTED, saveMode, settings, TAB, updateSettings, WHERE } from '../shared/state.js';
import { log, logLines } from '../shared/logger.js';
import { aacSupported } from '../media/aac-compression.js';
import { openDb } from '../storage/idb.js';
import { deleteSavedVod, expireSaved, loadSavedNums, storageFull, updateVodInfo } from '../storage/saved-audio.js';
import { setResult } from '../recovery/probe-resolver.js';
import { currentJob, isCurrent, jobs, reasonOf, scheduleResult, sendResult } from '../recovery/recovery-state.js';
import { compressJob, dropBehind, maybeSaveAll } from '../recovery/save-compress-jobs.js';

// ------------------------------------------------------------ messages
if (channel) {
  channel.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'settings' && m.settings) {
      const before = updateSettings(m.settings);
      const changed = Object.keys(settings).filter((k) => k in before && JSON.stringify(settings[k]) !== JSON.stringify(before[k]));
      if (changed.length) log('debug', `settings: ${changed.map((k) => `${k} ${JSON.stringify(before[k])} → ${JSON.stringify(settings[k])}`).join(', ')}`);
      if (IS_PAGE) expireSaved(Number(settings.keepDays) || 0).catch(() => {});
      for (const job of jobs) {
        if (settings.saveAudio && !before.saveAudio) job.savedAll = false;
        if (Number(settings.maxStorageMB) !== Number(before.maxStorageMB)) { job.limitReached = false; job.savedAll = false; }
        if (job.finished && isCurrent(job)) {
          sendResult(job);
          maybeSaveAll(job);
          if (settings.saveQuality !== before.saveQuality) compressJob(job);
        }
      }
    } else if (m.type === 'deleteSaved' && m.vodKey) {
      // Every instance forgets it; the page instance deletes it from disk.
      for (const job of jobs) {
        if (job.vodKey !== m.vodKey) continue;
        job.noSave = true; // don't save it again right away this session
        job.saved.clear();
        job.savedBytes = 0;
        job.savedAt = null;
        for (const s of job.segs) if (s.source === 'saved') { s.source = null; s.confirmed = false; }
      }
      if (IS_PAGE) {
        log('info', `deleting the saved sound of VOD ${m.vodKey} (asked from the menu)`);
        try { await deleteSavedVod(m.vodKey); } catch (e) { log('warn', `could not delete the saved sound of VOD ${m.vodKey}`, e); }
      }
      for (const job of jobs) if (job.vodKey === m.vodKey && job.finished) sendResult(job);
    } else if (m.type === 'position' && m.tab === TAB && typeof m.t === 'number') {
      // Where the player is (sent every second, even paused).
      const job = currentJob;
      if (!job || job.auto) return;
      const prev = job.position;
      job.position = m.t;
      clearTimeout(job.positionTimer);
      // First position known, or rewound: parts ahead may need saving.
      if (saveMode() === 'unplayed' && (prev === undefined || m.t < prev - 15)) {
        job.savedAll = false;
        maybeSaveAll(job);
      }
    } else if (m.type === 'played' && m.tab === TAB && typeof m.from === 'number' && typeof m.to === 'number') {
      // The player went from m.from to m.to (seconds of the VOD).
      const job = currentJob;
      if (!job || job.auto) return;
      // A part watched (almost) entirely counts as played.
      const done = [];
      for (const s of job.segs) {
        const overlap = Math.min(m.to, s.start + s.duration) - Math.max(m.from, s.start);
        if (overlap <= 0 || s.played) continue;
        s.playedSeconds = (s.playedSeconds || 0) + overlap;
        if (s.playedSeconds < s.duration - 1) continue;
        s.played = true;
        done.push(s);
      }
      // "Ahead of me": after 20 s of continuous playback, everything before
      // the position (minus those 20 s) is behind you, watched or skipped.
      const run = job.run && Math.abs(m.from - job.run.end) <= 1.5 ? job.run : (job.run = { start: m.from, end: m.from });
      run.end = m.to;
      if (run.end - run.start >= AHEAD_MIN_PLAY) {
        const pos = run.end - AHEAD_MIN_PLAY;
        if (pos > (job.behind || 0)) {
          job.behind = pos;
          updateVodInfo(job.vodKey, { behind: pos });
        }
      }
      if (saveMode() === 'unplayed') await dropBehind(job, done);
    } else if (m.type === 'diag-request' && m.id) {
      // Diagnostic report (ui.js): this instance's log and self-check.
      let idbOk = null;
      try { idbOk = !!(await openDb()); } catch (e) { idbOk = false; }
      post({
        type: 'diag-reply', id: m.id, where: WHERE, origin: ORIGIN, logs: logLines.slice(-60),
        info: {
          idb: idbOk, aac: aacSupported, restricted: RESTRICTED, storageFull,
          jobs: jobs.map((j) => ({
            name: jobName(j), auto: !!j.auto, current: isCurrent(j), paused: !!j.paused, finished: j.finished, live: !!j.live,
            muted: j.segs.length, saved: j.saved.size, limitReached: !!j.limitReached,
            reasons: j.segs.reduce((acc, x) => { const r = reasonOf(x); acc[r] = (acc[r] || 0) + 1; return acc; }, {}),
          })),
        },
      });
    } else if (m.type === 'savedChanged' && m.vodKey) {
      // Audio was imported from a backup: use it for segments still muted.
      for (const job of jobs) {
        if (job.vodKey !== m.vodKey) continue;
        job.saved = await loadSavedNums(job.vodKey);
        job.savedAll = false;
        for (const s of job.segs) if (!s.source && job.saved.has(s.num)) setResult(s, 'saved');
        if (job.finished) scheduleResult(job);
      }
    } else if (m.type === 'saveNow' && m.vodKey) {
      for (const job of jobs) {
        if (job.vodKey !== m.vodKey) continue;
        job.noSave = false;
        job.savedAll = false;
      }
      for (const job of jobs) {
        if (job.vodKey !== m.vodKey || !isCurrent(job)) continue;
        maybeSaveAll(job);
      }
    }
  });
  post({ type: 'hello', where: WHERE });
}
