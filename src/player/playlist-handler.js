// Hook module (page and player worker): see src/hook.js.

import { HAS_MUTED_RE, jobName, MUTED_RE } from '../shared/constants.js';
import { INSTANCE, IS_PAGE, mp4Dirs, ORIGIN, playlists, post, realFetch, renditions, RESTRICTED, segments, settings, vodIdsByBase } from '../shared/state.js';
import { log, shortUrl } from '../shared/logger.js';
import { currentJob, forgetCurrent, jobs, scheduleResult, sendState, switchVod } from '../recovery/recovery-state.js';
import { checkAll, checkMore } from '../recovery/scan-scheduler.js';

// ------------------------------------------------------------ playlists
export function readMaster(text, masterUrl) {
  if (/\/v\d+\/playlist\//.test(String(masterUrl || ''))) return; // stitched ad playlist, not a VOD
  const byVod = new Map();
  const mp4ByVod = new Map();
  // "/vod/123.m3u8", or "/vod/v2/123.m3u8" (Twitch's player since late 2026).
  const idMatch = String(masterUrl || '').match(/\/vod\/(?:v\d+\/)?(\d+)\.m3u8/);
  let nextMp4 = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '#') {
      if (line.startsWith('#EXT-X-STREAM-INF:')) nextMp4 = /CODECS="[^"]*(?:hev1|hvc1|av01)/i.test(line);
      continue;
    }
    try {
      const u = new URL(line, masterUrl).href.split('?')[0];
      const dirEnd = u.lastIndexOf('/');
      const vodEnd = u.lastIndexOf('/', dirEnd - 1);
      const vodBase = u.slice(0, vodEnd + 1);
      const dir = u.slice(vodEnd + 1, dirEnd);
      if (!byVod.has(vodBase)) byVod.set(vodBase, []);
      if (!byVod.get(vodBase).includes(dir)) byVod.get(vodBase).push(dir);
      if (nextMp4) {
        if (!mp4ByVod.has(vodBase)) mp4ByVod.set(vodBase, new Set());
        mp4ByVod.get(vodBase).add(dir);
      }
    } catch (e) { /* ignore */ }
    nextMp4 = false;
  }
  for (const [vodBase, dirs] of byVod) {
    renditions.set(vodBase, dirs);
    if (idMatch) vodIdsByBase.set(vodBase, idMatch[1]);
  }
  for (const [vodBase, set] of mp4ByVod) {
    if (!mp4Dirs.has(vodBase)) mp4Dirs.set(vodBase, new Set());
    for (const d of set) mp4Dirs.get(vodBase).add(d);
  }
  for (const [vodBase, dirs] of byVod) {
    post({ type: 'master', vodBase, dirs, vodId: idMatch ? idMatch[1] : null, mp4: mp4ByVod.has(vodBase) ? [...mp4ByVod.get(vodBase)] : [] });
  }
  log('debug', `master playlist${idMatch ? ' of VOD ' + idMatch[1] : ''}: ${[...byVod.values()].flat().join(', ') || 'no qualities'}`);
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
    base, vodBase, total: 0, segs: [], byNum: new Map(), done: 0, found: 0, finished: false,
    saved: new Set(), savedBytes: 0, savedAt: null, saving: false, savedAll: false, noSave: false,
    limitReached: false, compressing: false, compressDone: 0, compressTotal: 0,
  };
  if (!job.byNum) job.byNum = new Map(job.segs.map((x) => [x.num, x]));
  if (!job.vodId && vodIdsByBase.has(vodBase)) job.vodId = vodIdsByBase.get(vodBase);
  // Still recording: no end marker yet. Its newest files may not be in
  // every quality yet, so "not found" isn't remembered for good.
  job.live = !text.includes('#EXT-X-ENDLIST');

  const added = [];
  const lines = text.split('\n');
  let time = 0;
  let duration = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) { duration = parseFloat(line.slice(8)) || 0; continue; }
    if (line.startsWith('#EXT-X-MAP:')) {
      // MP4 VOD: its init file, named the same in every quality ("init-0.mp4").
      const uri = (line.match(/URI="([^"]+)"/) || [])[1];
      if (uri) { const u = new URL(uri, playlistUrl); job.initName = u.pathname.slice(u.pathname.lastIndexOf('/') + 1) + u.search; }
      continue;
    }
    if (!line || line[0] === '#') continue;
    const m = line.match(MUTED_RE);
    if (m) {
      const segNum = Number(m[2]);
      let seg = job.byNum.get(segNum);
      if (seg) {
        seg.start = time;
        seg.duration = duration;
      } else {
        // MP4 VOD (HEVC/AV1): "123-muted.mp4". Same names, ".mp4" ending.
        const ext = '.' + m[3];
        if (ext === '.mp4') {
          job.mp4 = true;
          if (!mp4Dirs.has(vodBase)) mp4Dirs.set(vodBase, new Set());
          mp4Dirs.get(vodBase).add(job.dir);
        }
        const at = (suffix) => new URL(m[1] + m[2] + suffix + (m[4] || ''), playlistUrl).href;
        seg = {
          job, num: segNum, query: m[4] || '', start: time, duration,
          urls: { '.ts': at(ext), '-unmuted.ts': at('-unmuted' + ext), muted: at('-muted' + ext) },
          source: undefined, confirmed: false,
        };
        job.segs.push(seg);
        job.byNum.set(segNum, seg);
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
      for (const x of job.segs) if (!stillMuted.has(x.num)) { segments.delete(x.urls['.ts']); job.byNum.delete(x.num); }
      job.segs = kept;
      job.done = kept.filter((x) => x.source !== undefined).length;
      job.found = kept.filter((x) => x.source).length;
      log('info', `${jobName(job)}: Twitch changed the muted parts: ${removed} no longer muted, ${added.length} newly muted, ${kept.length} muted now`);
      scheduleResult(job);
    }
  }
  if (!job.segs.length) return null;
  job.total = time;
  const out = { text: lines.join('\n'), raw: job.live ? text : null, job };
  if (existing) {
    if (added.length) {
      job.segs.sort((a, b) => a.num - b.num);
      job.checked = Promise.resolve(job.checked).then(() => checkMore(job, added));
    }
    return out;
  }
  // Another quality of this VOD may already know its saved size.
  const sibling = jobs.find((j) => j.vodKey === vodKey);
  if (sibling) Object.assign(job, { savedBytes: sibling.savedBytes, savedAt: sibling.savedAt, noSave: sibling.noSave, pinned: !!sibling.pinned, forceSave: !!sibling.forceSave, vodId: job.vodId || sibling.vodId || null, title: job.title || sibling.title || '', channel: job.channel || sibling.channel || '', streamedAt: job.streamedAt || sibling.streamedAt || null });
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
const restrictedNoted = new Set();
const unmutedNoted = new Set(); // VOD folders already logged as "no muted parts"
export async function handleOther(input, init, url) {
  const res = await realFetch.call(scope, input, init);
  if (!settings.enabled || !url || !/\.m3u8(\?|$)/.test(url)) return res;
  if (!res.ok) {
    // e.g. 403 for a sub-only VOD: another extension may answer instead.
    log('debug', `playlist request refused (${res.status}): ${url}`);
    return res;
  }
  try {
    const playlistUrl = res.url || url;
    let entry = playlists.get(playlistUrl);
    const text = await res.clone().text();
    if (text.includes('#EXT-X-STREAM-INF')) { readMaster(text, playlistUrl); return res; }
    const clean = playlistUrl.split('?')[0];
    const vodBase = clean.slice(0, clean.lastIndexOf('/', clean.lastIndexOf('/') - 1) + 1);
    if (!HAS_MUTED_RE.test(text)) {
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
      if (!IS_PAGE && !unmutedNoted.has(vodBase) && text.includes('#EXTINF')) {
        // Said once per VOD: if Twitch shows muted parts anyway, this line
        // tells a bug report what the playlist looked like.
        unmutedNoted.add(vodBase);
        const files = text.split('\n').map((l) => l.trim()).filter((l) => l && l[0] !== '#');
        log('info', `playlist ${playlistUrl}: no muted part in it (${files.length} files, e.g. ${files.slice(0, 2).map(shortUrl).join(', ') || 'none'})`);
      }
      switchVod(vodBase, null);
      return res;
    }
    if (RESTRICTED) {
      const muted = (text.match(/-muted\.(ts|mp4)/g) || []).length;
      if (!restrictedNoted.has(vodBase)) { restrictedNoted.add(vodBase); log('info', `VOD ${vodBase}: ${muted} muted parts not checked: Twitch only gives their original sound to www.twitch.tv, not to ${ORIGIN}`); }
      post({ type: 'restricted', vod: vodBase, muted, origin: ORIGIN });
      return res;
    }
    if (!entry || ((entry.job.live || !text.includes('#EXT-X-ENDLIST')) && entry.raw !== text)) {
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
    if ((init && init.signal && init.signal.aborted) || (e && e.name === 'AbortError')) return res;
    log('error', `could not rewrite the playlist ${url}: this VOD plays muted as usual`, e);
    return res;
  }
}
