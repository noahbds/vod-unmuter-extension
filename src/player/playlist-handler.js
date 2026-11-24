// Hook module (page and player worker): see src/hook.js.

import { jobName, MUTED_RE } from '../shared/constants.js';
import { INSTANCE, IS_PAGE, ORIGIN, playlists, post, realFetch, renditions, RESTRICTED, segments, settings, vodIdsByBase } from '../shared/state.js';
import { log } from '../shared/logger.js';
import { currentJob, forgetCurrent, jobs, scheduleResult, sendState, switchVod } from '../recovery/recovery-state.js';
import { checkAll, checkMore } from '../recovery/scan-scheduler.js';

// ------------------------------------------------------------ playlists
export function readMaster(text, masterUrl) {
  const byVod = new Map();
  const idMatch = String(masterUrl || '').match(/\/vod\/(\d+)\.m3u8/);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    try {
      const u = new URL(line, masterUrl).href.split('?')[0];
      const dirEnd = u.lastIndexOf('/');
      const vodEnd = u.lastIndexOf('/', dirEnd - 1);
      const vodBase = u.slice(0, vodEnd + 1);
      const dir = u.slice(vodEnd + 1, dirEnd);
      if (!byVod.has(vodBase)) byVod.set(vodBase, []);
      if (!byVod.get(vodBase).includes(dir)) byVod.get(vodBase).push(dir);
    } catch (e) { /* ignore */ }
  }
  for (const [vodBase, dirs] of byVod) {
    renditions.set(vodBase, dirs);
    if (idMatch) vodIdsByBase.set(vodBase, idMatch[1]);
  }
}

// `existing`: the job made from an earlier copy of this playlist. A VOD that
// is still recording keeps growing, so new muted segments are added to it.
export function rewritePlaylist(text, playlistUrl, auto, existing) {
  const clean = playlistUrl.split('?')[0];
  const base = clean.slice(0, clean.lastIndexOf('/') + 1);
  const vodBase = base.slice(0, base.lastIndexOf('/', base.length - 2) + 1);
  const vodKey = vodBase.slice(vodBase.lastIndexOf('/', vodBase.length - 2) + 1, -1);
  const job = existing || {
    key: base,                                      // one per quality
    vod: vodBase,                                   // same for every quality
    vodKey,                                         // folder name, used for saving
    vodId: vodIdsByBase.get(vodBase) || null,       // Twitch VOD id, when known
    title: '',
    dir: base.slice(vodBase.length, -1),
    base, vodBase, total: 0, segs: [], done: 0, found: 0, finished: false,
    saved: new Set(), savedBytes: 0, savedAt: null, saving: false, savedAll: false, noSave: false,
    limitReached: false, compressing: false, compressDone: 0, compressTotal: 0,
  };
  if (!job.vodId && vodIdsByBase.has(vodBase)) job.vodId = vodIdsByBase.get(vodBase);
  // Still recording: no end marker yet. Its newest files may not be in
  // every quality yet, so "not found" isn't remembered for good.
  job.live = !text.includes('#EXT-X-ENDLIST');

  const have = new Map(job.segs.map((x) => [x.num, x]));
  const added = [];
  const lines = text.split('\n');
  let time = 0;
  let duration = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) { duration = parseFloat(line.slice(8)) || 0; continue; }
    if (!line || line[0] === '#') continue;
    const m = line.match(MUTED_RE);
    if (m) {
      let seg = have.get(Number(m[2]));
      if (seg) {
        seg.start = time;
        seg.duration = duration;
      } else {
        const at = (suffix) => new URL(m[1] + m[2] + suffix + (m[3] || ''), playlistUrl).href;
        seg = {
          job, num: Number(m[2]), query: m[3] || '', start: time, duration,
          urls: { '.ts': at('.ts'), '-unmuted.ts': at('-unmuted.ts'), muted: at('-muted.ts') },
          source: undefined, confirmed: false,
        };
        job.segs.push(seg);
        added.push(seg);
        segments.set(seg.urls['.ts'], seg);
      }
      lines[i] = seg.urls['.ts'];
    }
    time += duration;
    duration = 0;
  }
  if (existing) {
    // Twitch reprocesses the muting (while live, and again after the
    // stream): parts that aren't muted any more play normally from
    // Twitch, so they leave the job instead of being counted forever.
    const stillMuted = new Set();
    for (const raw of text.split('\n')) { const m = raw.trim().match(MUTED_RE); if (m) stillMuted.add(Number(m[2])); }
    const kept = job.segs.filter((x) => stillMuted.has(x.num));
    const removed = job.segs.length - kept.length;
    if (removed) {
      for (const x of job.segs) if (!stillMuted.has(x.num)) segments.delete(x.urls['.ts']);
      job.segs = kept;
      job.done = kept.filter((x) => x.source !== undefined).length;
      job.found = kept.filter((x) => x.source).length;
      log('info', `${jobName(job)}: Twitch changed the muted parts: ${removed} no longer muted, ${added.length} newly muted, ${kept.length} muted now`);
      scheduleResult(job);
    }
  }
  if (!job.segs.length) return null;
  job.total = time;
  const out = { text: lines.join('\n'), raw: text, job };
  if (existing) {
    if (added.length) {
      job.segs.sort((a, b) => a.num - b.num);
      job.checked = Promise.resolve(job.checked).then(() => checkMore(job, added));
    }
    return out;
  }
  // Another quality of this VOD may already know its saved size.
  const sibling = jobs.find((j) => j.vodKey === vodKey);
  if (sibling) Object.assign(job, { savedBytes: sibling.savedBytes, savedAt: sibling.savedAt, noSave: sibling.noSave, vodId: job.vodId || sibling.vodId || null, title: job.title || sibling.title || '' });
  job.auto = !!auto;
  // Another quality of this VOD is already being played (the player loads
  // several playlists when it adapts quality): wait until this one is.
  if (!job.auto) {
    const playing = currentJob && !currentJob.auto && currentJob.vodBase === vodBase ? currentJob
      : jobs.filter((j) => !j.auto && j.vodBase === vodBase).pop();
    // In the page copy, nothing is played yet either: don't check twice
    // what the player's own copy checks.
    if (playing || IS_PAGE) job.paused = true;
  }
  jobs.push(job);
  job.checked = checkAll(job);
  return out;
}

// ------------------------------------------------------------ fetch hook
export const restrictedNoted = new Set();
export async function handleOther(input, init, url) {
  const res = await realFetch.call(scope, input, init);
  if (!settings.enabled || !url || !res.ok || !/\.m3u8(\?|$)/.test(url)) return res;
  try {
    const playlistUrl = res.url || url;
    let entry = playlists.get(playlistUrl);
    const text = await res.clone().text();
    if (text.includes('#EXT-X-STREAM-INF')) { readMaster(text, playlistUrl); return res; }
    const clean = playlistUrl.split('?')[0];
    const vodBase = clean.slice(0, clean.lastIndexOf('/', clean.lastIndexOf('/') - 1) + 1);
    if (!text.includes('-muted.ts')) {
      if (entry && jobs.includes(entry.job)) {
        // Twitch unmuted every part of this VOD: forget the old job.
        log('info', `${jobName(entry.job)}: Twitch no longer mutes any part of this VOD`);
        jobs.splice(jobs.indexOf(entry.job), 1);
        for (const x of entry.job.segs) segments.delete(x.urls['.ts']);
        playlists.delete(playlistUrl);
        post({ type: 'none', vod: entry.job.vod, instance: INSTANCE });
        forgetCurrent(entry.job);
        return res;
      }
      switchVod(vodBase, null);
      return res;
    }
    if (RESTRICTED) {
      const muted = (text.match(/-muted\.ts/g) || []).length;
      if (!restrictedNoted.has(vodBase)) { restrictedNoted.add(vodBase); log('info', `VOD ${vodBase}: ${muted} muted parts not checked: Twitch only gives their original sound to www.twitch.tv, not to ${ORIGIN}`); }
      post({ type: 'restricted', vod: vodBase, muted, origin: ORIGIN });
      return res;
    }
    if (!entry || entry.raw !== text) {
      // New, or Twitch's copy changed (a VOD still recording grows).
      entry = rewritePlaylist(text, playlistUrl, false, entry && entry.job);
      if (!entry) return res;
      playlists.set(playlistUrl, entry);
    }
    switchVod(vodBase, entry.job);
    sendState(entry.job);
    const out = new Response(entry.text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    Object.defineProperty(out, 'url', { value: res.url });
    return out;
  } catch (e) {
    log('error', `could not rewrite the playlist ${url}: this VOD plays muted as usual`, e);
    return res;
  }
}
