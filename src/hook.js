// Runs in the page's own JavaScript world (MAIN) at document_start.
//
// How it works:
//  1. When Twitch loads a VOD playlist, every muted segment ("123-muted.ts")
//     is rewritten to the original file name ("123.ts"). The playlist is
//     returned right away, so the video starts with no delay.
//  2. When the player downloads one of those segments, the hook tries, in
//     order:
//       a. the original file in the quality being watched ("123.ts", then
//          Twitch's backup "123-unmuted.ts");
//       b. a copy of the sound saved earlier on this computer (see 4.);
//       c. the original file in ANOTHER quality (Twitch keeps one copy per
//          quality and deletes them separately). Only its audio is used: it is
//          spliced into the muted segment of the quality being watched, so the
//          video quality never changes;
//       d. the muted file, so playback never breaks.
//  3. In the background it checks every muted segment so the on-screen UI
//     (ui.js) can show how many were unmuted, via a BroadcastChannel.
//  4. Twitch deletes the originals about a day after a stream ends. While they
//     still exist, the hook saves just their sound (about 200 KB per 10 s) in
//     the browser's storage for twitch.tv (IndexedDB), so the VOD stays
//     unmuted after Twitch deletes them.
(() => {
  'use strict';
  if (window.__vodUnmuterLoaded) return;
  window.__vodUnmuterLoaded = true;

  const CHANNEL_NAME = 'vod-unmuter';

  // ---------------------------------------------------------------------------
  // Self-contained: it is also stringified and injected into Twitch's video
  // player Web Worker, which is where playlists and segments are downloaded.
  // ---------------------------------------------------------------------------
  function installUnmuteHook(scope) {
    if (scope.__vodUnmuterHooked) return;
    scope.__vodUnmuterHooked = true;

    const TAG = '[VOD Unmuter]';
    const CHANNEL = 'vod-unmuter';
    const IS_PAGE = typeof scope.document !== 'undefined'; // vs. the player worker
    const SUFFIXES = ['.ts', '-unmuted.ts']; // where the original audio can live
    const MUTED_RE = /^(.*?)(\d+)-muted\.ts(\?.*)?$/;
    const MAX_PARALLEL = 12;   // background checks
    const SAVE_PARALLEL = 3;   // background downloads for saving
    // Used only if the master playlist was not seen. Best quality first.
    const FALLBACK_DIRS = ['chunked', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30'];

    const realFetch = scope.fetch;
    let settings = { enabled: true, saveAudio: true, saveMode: 'whole', keepDays: 60 };

    let channel = null;
    try { channel = new BroadcastChannel(CHANNEL); } catch (e) { /* unsupported */ }
    const post = (msg) => { try { channel && channel.postMessage(msg); } catch (e) { /* ignore */ } };

    const known = new Map();       // file URL -> true (exists) / false (gone)
    const pending = new Map();     // file URL -> Promise<boolean>
    const segments = new Map();    // rewritten segment URL -> muted segment record
    const playlists = new Map();   // playlist URL -> { text, job }
    const renditions = new Map();  // VOD folder URL -> quality dirs, best first

    const isMiss = (status) => status === 403 || status === 404 || status === 410;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const requestFor = (url, input) =>
      (typeof input === 'string' || input instanceof URL || !input) ? url : new Request(url, input);
    const prettyQuality = (dir) => (dir === 'chunked' ? 'Source' : dir);

    // ------------------------------------------------------------ MPEG-TS
    // Finds the audio stream of a .ts segment and the timestamp it starts at.
    function scanTs(buf) {
      const PKT = 188;
      if (buf.length < PKT || buf[0] !== 0x47) return null;
      let pmtPid = -1, audioPid = -1, audioType = -1, pts = -1;
      for (let o = 0; o + PKT <= buf.length && pts < 0; o += PKT) {
        if (buf[o] !== 0x47) return null;
        if (!(buf[o + 1] & 0x40)) continue; // only packets that start a unit
        const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
        const afc = (buf[o + 3] >> 4) & 3;
        if (!(afc & 1)) continue;
        let p = o + 4 + ((afc & 2) ? 1 + buf[o + 4] : 0);
        if (pid === 0 && pmtPid < 0) {
          p += 1 + buf[p];
          const secLen = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
          for (let q = p + 8; q < p + 3 + secLen - 4; q += 4) {
            if (((buf[q] << 8) | buf[q + 1]) !== 0) { pmtPid = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3]; break; }
          }
        } else if (pid === pmtPid && audioPid < 0) {
          p += 1 + buf[p];
          const secLen = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
          const infoLen = ((buf[p + 10] & 0x0f) << 8) | buf[p + 11];
          for (let q = p + 12 + infoLen; q < p + 3 + secLen - 4;) {
            const type = buf[q];
            const esLen = ((buf[q + 3] & 0x0f) << 8) | buf[q + 4];
            if (type === 0x0f || type === 0x11) { audioPid = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2]; audioType = type; break; }
            q += 5 + esLen;
          }
        } else if (pid === audioPid && buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1 && (buf[p + 7] & 0x80)) {
          pts = ((buf[p + 9] >> 1) & 7) * 1073741824 +
            ((buf[p + 10] << 22) | ((buf[p + 11] >> 1) << 15) | (buf[p + 12] << 7) | (buf[p + 13] >> 1));
        }
      }
      return audioPid >= 0 ? { audioPid, audioType, pts } : null;
    }

    // The audio packets of a segment: what gets saved, and what gets spliced.
    function extractAudio(buf) {
      const PKT = 188;
      const info = scanTs(buf);
      if (!info) return null;
      const offsets = [];
      for (let o = 0; o + PKT <= buf.length; o += PKT) {
        if ((((buf[o + 1] & 0x1f) << 8) | buf[o + 2]) === info.audioPid) offsets.push(o);
      }
      if (!offsets.length) return null;
      const packets = new Uint8Array(offsets.length * PKT);
      offsets.forEach((o, i) => packets.set(buf.subarray(o, o + PKT), i * PKT));
      return { type: info.audioType, pts: info.pts, packets };
    }

    // Keeps every packet of `target` (video, metadata) but replaces its audio
    // with `audio` (from extractAudio): the same segment from another quality,
    // or a saved copy.
    function spliceAudio(target, audio) {
      const PKT = 188;
      const t = scanTs(target);
      if (!t || !audio || t.audioType !== audio.type) return null;
      // Same segment? Audio must start at the same time (within 0.1 s).
      if (t.pts >= 0 && audio.pts >= 0 && Math.abs(t.pts - audio.pts) > 9000) return null;
      const src = audio.packets;
      const count = Math.floor(src.length / PKT);
      if (!count) return null;

      const keep = [];
      let firstCC = -1;
      for (let o = 0; o + PKT <= target.length; o += PKT) {
        if ((((target[o + 1] & 0x1f) << 8) | target[o + 2]) === t.audioPid) {
          if (firstCC < 0) firstCC = target[o + 3] & 0x0f;
        } else keep.push(o);
      }
      const ccShift = firstCC < 0 ? 0 : (firstCC - (src[3] & 0x0f) + 16) % 16;

      const out = new Uint8Array((keep.length + count) * PKT);
      let w = 0, a = 0;
      const putAudio = () => {
        out.set(src.subarray(a * PKT, a * PKT + PKT), w);
        a++;
        out[w + 1] = (out[w + 1] & 0xe0) | (t.audioPid >> 8);
        out[w + 2] = t.audioPid & 0xff;
        out[w + 3] = (out[w + 3] & 0xf0) | (((out[w + 3] & 0x0f) + ccShift) % 16);
        w += PKT;
      };
      // Spread the audio evenly between the target's other packets.
      for (let i = 0; i < keep.length; i++) {
        while (a < count && a / count <= i / keep.length) putAudio();
        out.set(target.subarray(keep[i], keep[i] + PKT), w);
        w += PKT;
      }
      while (a < count) putAudio();
      return out;
    }

    // ------------------------------------------------------------ saved audio
    // IndexedDB for twitch.tv, shared by the page and the player worker.
    //   audio: "<vod folder>|<segment number>" -> { type, pts, packets }
    //   vods:  { vod, channel, streamedAt, savedAt, segments, bytes }
    let dbPromise = null;
    function openDb() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = scope.indexedDB.open('vod-unmuter', 1);
          req.onupgradeneeded = () => {
            req.result.createObjectStore('audio');
            req.result.createObjectStore('vods', { keyPath: 'vod' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }).catch((e) => { console.warn(TAG, 'saving is unavailable (browser storage blocked)', e); return null; });
      }
      return dbPromise;
    }

    async function idb(stores, mode, work) {
      const db = await openDb();
      if (!db) return null;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        const out = {};
        work(...[].concat(stores).map((s) => tx.objectStore(s)), out);
        tx.oncomplete = () => resolve(out.value);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    }

    const audioRange = (vod) => IDBKeyRange.bound(vod + '|', vod + '|￿');

    function vodInfo(vod) {
      // Twitch folders look like "<hash>_<channel>_<stream id>_<unix time>".
      const parts = vod.split('_');
      const time = Number(parts[parts.length - 1]);
      return {
        channel: parts.length >= 4 ? parts.slice(1, -2).join('_') : '',
        streamedAt: time > 1e9 ? time * 1000 : null,
      };
    }

    async function loadSavedNums(vod) {
      try {
        const keys = await idb('audio', 'readonly', (audio, out) => {
          const r = audio.getAllKeys(audioRange(vod));
          r.onsuccess = () => { out.value = r.result; };
        });
        return new Set((keys || []).map((k) => Number(String(k).split('|')[1])));
      } catch (e) { return new Set(); }
    }

    async function loadSaved(vod, num) {
      try {
        return await idb('audio', 'readonly', (audio, out) => {
          const r = audio.get(vod + '|' + num);
          r.onsuccess = () => { out.value = r.result; };
        });
      } catch (e) { return null; }
    }

    async function storeAudio(vod, num, audio) {
      const bytes = audio.packets.byteLength;
      try {
        return await idb(['audio', 'vods'], 'readwrite', (store, vods, out) => {
          const key = vod + '|' + num;
          const exists = store.getKey(key);
          exists.onsuccess = () => {
            if (exists.result !== undefined) return;
            store.put({ type: audio.type, pts: audio.pts, packets: audio.packets }, key);
            const v = vods.get(vod);
            v.onsuccess = () => {
              const rec = v.result || Object.assign({ vod, savedAt: Date.now(), segments: 0, bytes: 0 }, vodInfo(vod));
              rec.segments++;
              rec.bytes += bytes;
              vods.put(rec);
              out.value = rec;
            };
          };
        });
      } catch (e) {
        console.warn(TAG, 'could not save audio (storage full?)', e);
        return null;
      }
    }

    async function deleteSavedVod(vod) {
      await idb(['audio', 'vods'], 'readwrite', (audio, vods) => {
        audio.delete(audioRange(vod));
        vods.delete(vod);
      });
    }

    async function listSaved() {
      return (await idb('vods', 'readonly', (vods, out) => {
        const r = vods.getAll();
        r.onsuccess = () => { out.value = r.result; };
      })) || [];
    }

    async function expireSaved(keepDays) {
      if (!keepDays) return; // 0 = keep forever
      const limit = Date.now() - keepDays * 864e5;
      for (const v of await listSaved()) if (v.savedAt < limit) await deleteSavedVod(v.vod);
    }

    // Only the page instance manages the database for the popup / UI.
    if (IS_PAGE) scope.__vodUnmuterStore = { list: listSaved, remove: deleteSavedVod, expire: expireSaved };

    // ------------------------------------------------------------ probing
    function makeLimiter(max) {
      let active = 0;
      const waiting = [];
      return (task) => new Promise((resolve, reject) => {
        const run = () => {
          active++;
          task().then(resolve, reject).finally(() => {
            active--;
            const next = waiting.shift();
            if (next) next();
          });
        };
        if (active < max) run(); else waiting.push(run);
      });
    }
    const limited = makeLimiter(MAX_PARALLEL);
    const saveLimited = makeLimiter(SAVE_PARALLEL);

    // HEAD requests are unreliable on Twitch's CDN (they sometimes fail CORS
    // even for files that exist), so probe with GET and abort the body.
    async function probeOnce(url) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (known.has(url)) return known.get(url);
        const ctrl = new AbortController();
        try {
          const r = await realFetch.call(scope, url, { cache: 'no-store', signal: ctrl.signal });
          ctrl.abort();
          if (r.ok) { known.set(url, true); return true; }
          if (isMiss(r.status)) { known.set(url, false); return false; }
        } catch (e) { ctrl.abort(); /* network hiccup: retry */ }
        await sleep(300 * (attempt + 1));
      }
      return false;
    }

    // urgent = the player is waiting for it: skip the background queue.
    function probe(url, urgent) {
      if (known.has(url)) return Promise.resolve(known.get(url));
      if (!pending.has(url)) {
        const p = urgent ? probeOnce(url) : limited(() => probeOnce(url));
        pending.set(url, p);
        p.finally(() => pending.delete(url));
      }
      return pending.get(url);
    }

    // A "source" is where a muted segment's audio comes from:
    //   ".ts" / "-unmuted.ts"                same quality
    //   "saved"                              copy saved on this computer
    //   "720p60/.ts", "720p60/-unmuted.ts"   another quality (audio only)
    const allDirs = (job) => renditions.get(job.vodBase) || FALLBACK_DIRS;
    const donorDirs = (job) => allDirs(job).filter((d) => d !== job.dir && d !== 'audio_only');
    function donorSources(seg) {
      const list = [];
      for (const dir of donorDirs(seg.job)) for (const sfx of SUFFIXES) list.push(dir + '/' + sfx);
      return list;
    }
    function urlFor(seg, source) {
      const slash = source.indexOf('/');
      if (slash < 0) return seg.urls[source];
      return seg.job.vodBase + source.slice(0, slash) + '/' + seg.num + source.slice(slash + 1) + seg.query;
    }

    async function findOwn(seg) {
      for (const sfx of SUFFIXES) if (await probe(urlFor(seg, sfx))) return sfx;
      return null;
    }
    async function findDonor(seg) {
      for (const source of donorSources(seg)) if (await probe(urlFor(seg, source))) return source;
      return null;
    }

    function setResult(seg, source) {
      if (!seg.confirmed) seg.source = source;
    }

    // A run of consecutive muted segments.
    // Same quality: Twitch keeps or deletes these in whole blocks, so check
    // the first and last; if they agree, assume the whole run matches.
    // Saved copies and other qualities are checked segment by segment.
    async function resolveRun(segs) {
      const first = await findOwn(segs[0]);
      const last = segs.length > 1 ? await findOwn(segs[segs.length - 1]) : first;
      if (first && first === last) segs.forEach((s) => setResult(s, first));
      else if (!first && !last && segs.length > 2 && !(await findOwn(segs[segs.length >> 1]))) {
        segs.forEach((s) => setResult(s, null));
      } else {
        await Promise.all(segs.map(async (s) => setResult(s, await findOwn(s))));
      }
      await Promise.all(segs.map(async (s) => {
        if (s.confirmed || s.source) return;
        if (s.job.saved.has(s.num)) setResult(s, 'saved');
        else setResult(s, await findDonor(s));
      }));
    }

    // ------------------------------------------------------------ reporting
    // Where a segment's audio comes from, for the UI:
    //   kind: 'original'     the original file of the quality being watched
    //         'backup'       Twitch's "-unmuted" file of that quality
    //         'saved'        a copy saved on this computer earlier
    //         'other'        the original file of another quality (audio only)
    //         'other-backup' the "-unmuted" file of another quality (audio only)
    function describe(seg) {
      if (seg.source === 'saved') return { kind: 'saved', quality: '' };
      const slash = seg.source.indexOf('/');
      const file = slash < 0 ? seg.source : seg.source.slice(slash + 1);
      const backup = file === '-unmuted.ts';
      if (slash < 0) return { kind: backup ? 'backup' : 'original', quality: prettyQuality(seg.job.dir) };
      return { kind: backup ? 'other-backup' : 'other', quality: prettyQuality(seg.source.slice(0, slash)) };
    }

    function buildRanges(segs) {
      const ranges = [];
      let cur = null;
      for (const s of segs) {
        const restored = !!s.source;
        const contiguous = cur && Math.abs(cur.end - s.start) < 0.5 && cur.restored === restored;
        if (!contiguous) {
          cur = { start: s.start, end: s.start, segments: 0, restored, sources: new Map() };
          ranges.push(cur);
        }
        cur.end = s.start + s.duration;
        cur.segments++;
        if (s.source) {
          const d = describe(s);
          const k = d.kind + '|' + d.quality;
          if (!cur.sources.has(k)) cur.sources.set(k, Object.assign(d, { segments: 0 }));
          cur.sources.get(k).segments++;
        }
      }
      return ranges.map((r) => ({
        start: r.start, end: r.end, segments: r.segments, restored: r.restored,
        sources: [...r.sources.values()].sort((a, b) => b.segments - a.segments),
      }));
    }

    // Twitch keeps a separate copy of the VOD per quality, so only report the
    // quality the player is actually downloading segments from.
    const jobs = [];
    let currentJob = null;
    const isCurrent = (job) => (currentJob || jobs[jobs.length - 1]) === job;

    function noteActivity(url) {
      for (const job of jobs) {
        if (url.startsWith(job.base)) {
          if (currentJob !== job) {
            currentJob = job;
            sendState(job);
            maybeSaveAll(job);
          }
          return;
        }
      }
    }

    function sendResult(job) {
      let restored = 0, fromOther = 0, fromSaved = 0, mutedSeconds = 0, restoredSeconds = 0, saved = 0;
      for (const s of job.segs) {
        mutedSeconds += s.duration;
        if (job.saved.has(s.num)) saved++;
        if (!s.source) continue;
        restored++;
        restoredSeconds += s.duration;
        if (s.source === 'saved') fromSaved++;
        else if (s.source.includes('/')) fromOther++;
      }
      if (isCurrent(job)) {
        post({
          type: 'result', key: job.key, vod: job.vod, vodKey: job.vodKey,
          quality: prettyQuality(job.dir), total: job.total,
          muted: job.segs.length, restored, fromOther, fromSaved, mutedSeconds, restoredSeconds,
          ranges: buildRanges(job.segs),
          save: {
            enabled: !!settings.saveAudio, mode: settings.saveMode,
            saved, savable: restored, active: job.saving,
            bytes: job.savedBytes, savedAt: job.savedAt, paused: job.noSave,
          },
        });
      }
      return restored;
    }

    function sendState(job) {
      if (job.finished) sendResult(job);
      else if (isCurrent(job)) {
        post({ type: 'checking', key: job.key, vod: job.vod, quality: prettyQuality(job.dir), muted: job.segs.length, done: job.done });
      }
    }

    function throttledProgress(job) {
      if (job.progressTimer) return;
      job.progressTimer = setTimeout(() => { job.progressTimer = null; if (!job.finished) sendState(job); }, 250);
    }

    function scheduleResult(job) {
      clearTimeout(job.resultTimer);
      job.resultTimer = setTimeout(() => sendResult(job), 400);
    }

    async function checkAll(job) {
      job.saved = await loadSavedNums(job.vodKey);
      sendState(job);
      const runs = [];
      for (const s of job.segs) {
        const run = runs[runs.length - 1];
        if (run && run[run.length - 1].num + 1 === s.num) run.push(s); else runs.push([s]);
      }
      await Promise.all(runs.map(async (run) => {
        await resolveRun(run);
        job.done += run.length;
        throttledProgress(job);
      }));
      job.finished = true;
      const restored = sendResult(job);
      console.log(`${TAG} [${prettyQuality(job.dir)}] ${restored}/${job.segs.length} muted segments can be unmuted` +
        (restored < job.segs.length ? ' (the rest is deleted in every quality)' : ''));
      if (isCurrent(job)) maybeSaveAll(job);
    }

    // ------------------------------------------------------------ saving
    function noteSaved(job, num, rec) {
      if (!rec) return;
      // Keep every quality of this VOD in sync.
      for (const j of jobs) {
        if (j.vodKey !== job.vodKey) continue;
        j.saved.add(num);
        j.savedBytes = rec.bytes;
        j.savedAt = rec.savedAt;
      }
      if (job.finished) scheduleResult(job);
    }

    async function saveFromBytes(seg, bytes) {
      const job = seg.job;
      if (!settings.saveAudio || job.noSave || job.saved.has(seg.num)) return;
      const audio = extractAudio(bytes);
      if (audio) noteSaved(job, seg.num, await storeAudio(job.vodKey, seg.num, audio));
    }

    // "Whole VOD" mode: save every muted part that can still be unmuted, not
    // just the ones played. Downloads the smallest quality that has the
    // original (the sound is the same in all of them).
    async function maybeSaveAll(job) {
      if (!settings.saveAudio || settings.saveMode !== 'whole' || job.noSave) return;
      if (!job.finished || job.saving || job.savedAll) return;
      const todo = job.segs.filter((s) => s.source && s.source !== 'saved' && !job.saved.has(s.num));
      if (!todo.length) { job.savedAll = true; return; }
      job.saving = true;
      sendResult(job);
      const dirs = ['audio_only'].concat(allDirs(job).filter((d) => d !== 'audio_only').reverse());
      await Promise.all(todo.map((seg) => saveLimited(async () => {
        if (!settings.saveAudio || job.noSave || job.saved.has(seg.num)) return;
        for (const dir of dirs) {
          for (const sfx of SUFFIXES) {
            const url = urlFor(seg, dir + '/' + sfx);
            if (known.get(url) === false) continue;
            try {
              const r = await realFetch.call(scope, url, { cache: 'no-store' });
              if (!r.ok) { if (isMiss(r.status)) known.set(url, false); continue; }
              known.set(url, true);
              await saveFromBytes(seg, new Uint8Array(await r.arrayBuffer()));
              return;
            } catch (e) { /* try the next one */ }
          }
        }
      })));
      job.saving = false;
      job.savedAll = true;
      sendResult(job);
    }

    // ------------------------------------------------------------ playlists
    function readMaster(text, masterUrl) {
      const byVod = new Map();
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
      for (const [vodBase, dirs] of byVod) renditions.set(vodBase, dirs);
    }

    function rewritePlaylist(text, playlistUrl) {
      const clean = playlistUrl.split('?')[0];
      const base = clean.slice(0, clean.lastIndexOf('/') + 1);
      const vodBase = base.slice(0, base.lastIndexOf('/', base.length - 2) + 1);
      const vodKey = vodBase.slice(vodBase.lastIndexOf('/', vodBase.length - 2) + 1, -1);
      const job = {
        key: base,                                      // one per quality
        vod: vodBase,                                   // same for every quality
        vodKey,                                         // folder name, used for saving
        dir: base.slice(vodBase.length, -1),
        base, vodBase, total: 0, segs: [], done: 0, finished: false,
        saved: new Set(), savedBytes: 0, savedAt: null, saving: false, savedAll: false, noSave: false,
      };

      const lines = text.split('\n');
      let time = 0;
      let duration = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) { duration = parseFloat(line.slice(8)) || 0; continue; }
        if (!line || line[0] === '#') continue;
        const m = line.match(MUTED_RE);
        if (m) {
          const at = (suffix) => new URL(m[1] + m[2] + suffix + (m[3] || ''), playlistUrl).href;
          const seg = {
            job, num: Number(m[2]), query: m[3] || '', start: time, duration,
            urls: { '.ts': at('.ts'), '-unmuted.ts': at('-unmuted.ts'), muted: at('-muted.ts') },
            source: undefined, confirmed: false,
          };
          job.segs.push(seg);
          lines[i] = seg.urls['.ts'];
          segments.set(seg.urls['.ts'], seg);
        }
        time += duration;
        duration = 0;
      }
      if (!job.segs.length) return null;
      job.total = time;
      // Another quality of this VOD may already know its saved size.
      const sibling = jobs.find((j) => j.vodKey === vodKey);
      if (sibling) Object.assign(job, { savedBytes: sibling.savedBytes, savedAt: sibling.savedAt, noSave: sibling.noSave });
      jobs.push(job);
      checkAll(job);
      return { text: lines.join('\n'), job };
    }

    // ------------------------------------------------------------ segments
    const segmentResponse = (body) =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp2t' } });

    // Downloads the muted segment and puts `audio` into it.
    async function spliced(seg, input, init, audio) {
      const muted = await realFetch.call(scope, requestFor(seg.urls.muted, input), init);
      if (!muted.ok) return { res: muted, ok: false };
      const mb = new Uint8Array(await muted.arrayBuffer());
      const out = audio && spliceAudio(mb, audio);
      return { res: segmentResponse(out || mb), ok: !!out };
    }

    async function fetchSegment(seg, input, init) {
      const job = seg.job;
      const aborted = () => init && init.signal && init.signal.aborted;

      // a. Same quality: just serve the original file (and save its sound).
      const own = seg.source && !seg.source.includes('/') && seg.source !== 'saved'
        ? [seg.source].concat(SUFFIXES.filter((s) => s !== seg.source)) : SUFFIXES;
      for (const sfx of own) {
        const url = seg.urls[sfx];
        if (known.get(url) === false) continue;
        try {
          const r = await realFetch.call(scope, requestFor(url, input), init);
          if (r.ok) {
            known.set(url, true);
            confirm(seg, sfx);
            if (settings.saveAudio && !job.noSave && !job.saved.has(seg.num)) {
              r.clone().arrayBuffer().then((b) => saveFromBytes(seg, new Uint8Array(b))).catch(() => {});
            }
            return r;
          }
          if (isMiss(r.status)) known.set(url, false);
          try { r.body && r.body.cancel(); } catch (e) { /* ignore */ }
        } catch (e) {
          if (aborted()) throw e;
        }
      }

      // b. A copy saved on this computer earlier.
      if (job.saved.has(seg.num)) {
        try {
          const audio = await loadSaved(job.vodKey, seg.num);
          if (audio) {
            const { res, ok } = await spliced(seg, input, init, audio);
            if (ok) { confirm(seg, 'saved'); return res; }
            if (res.ok) { confirm(seg, null); return res; }
          }
        } catch (e) {
          if (aborted()) throw e;
        }
      }

      // c. Another quality still has the original: borrow its audio.
      const donors = donorSources(seg);
      if (seg.source && seg.source.includes('/')) donors.unshift(seg.source);
      const found = await Promise.all(donors.map((s) => probe(urlFor(seg, s), true)));
      const donor = donors[found.indexOf(true)];
      if (donor) {
        try {
          const other = await realFetch.call(scope, requestFor(urlFor(seg, donor), input), init);
          if (other.ok) {
            const ob = new Uint8Array(await other.arrayBuffer());
            const audio = extractAudio(ob);
            const { res, ok } = await spliced(seg, input, init, audio);
            if (ok) {
              confirm(seg, donor);
              if (settings.saveAudio && !job.noSave && !job.saved.has(seg.num)) saveFromBytes(seg, ob);
              return res;
            }
            if (res.ok) { confirm(seg, null); return res; }
          } else {
            try { other.body && other.body.cancel(); } catch (e) { /* ignore */ }
          }
        } catch (e) {
          if (aborted()) throw e;
        }
      }

      // d. Nothing left: play the muted file.
      confirm(seg, null);
      return realFetch.call(scope, requestFor(seg.urls.muted, input), init);
    }

    function confirm(seg, source) {
      const changed = seg.source !== source;
      seg.source = source;
      seg.confirmed = true;
      if (changed && seg.job.finished) scheduleResult(seg.job);
    }

    // ------------------------------------------------------------ messages
    if (channel) {
      channel.addEventListener('message', async (ev) => {
        const m = ev.data;
        if (!m) return;
        if (m.type === 'settings' && m.settings) {
          const wasSaving = settings.saveAudio;
          settings = Object.assign({}, settings, m.settings);
          if (IS_PAGE) expireSaved(Number(settings.keepDays) || 0).catch(() => {});
          for (const job of jobs) {
            if (settings.saveAudio && !wasSaving) job.savedAll = false;
            if (job.finished && isCurrent(job)) { sendResult(job); maybeSaveAll(job); }
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
            try { await deleteSavedVod(m.vodKey); } catch (e) { /* ignore */ }
          }
          for (const job of jobs) if (job.vodKey === m.vodKey && job.finished) sendResult(job);
        } else if (m.type === 'saveNow' && m.vodKey) {
          for (const job of jobs) {
            if (job.vodKey !== m.vodKey) continue;
            job.noSave = false;
            job.savedAll = false;
          }
          for (const job of jobs) {
            if (job.vodKey !== m.vodKey || !isCurrent(job)) continue;
            if (settings.saveMode === 'whole') maybeSaveAll(job);
            else sendResult(job);
          }
        }
      });
      post({ type: 'hello' });
    }

    // ------------------------------------------------------------ fetch hook
    async function handleOther(input, init, url) {
      const res = await realFetch.call(scope, input, init);
      if (!settings.enabled || !url || !res.ok || !/\.m3u8(\?|$)/.test(url)) return res;
      try {
        const playlistUrl = res.url || url;
        let entry = playlists.get(playlistUrl);
        if (entry) {
          sendState(entry.job);
        } else {
          const text = await res.clone().text();
          if (text.includes('#EXT-X-STREAM-INF')) { readMaster(text, playlistUrl); return res; }
          if (!text.includes('-muted.ts')) return res;
          entry = rewritePlaylist(text, playlistUrl);
          if (!entry) return res;
          playlists.set(playlistUrl, entry);
        }
        const out = new Response(entry.text, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
        Object.defineProperty(out, 'url', { value: res.url });
        return out;
      } catch (e) {
        console.warn(TAG, 'could not patch playlist', e);
        return res;
      }
    }

    scope.fetch = function (input, init) {
      const url = typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : input && input.url;
      if (url && jobs.length) noteActivity(url);
      const seg = url && segments.get(url);
      if (seg) return fetchSegment(seg, input, init);
      return handleOther(input, init, url);
    };

    scope.__vodUnmuterDebug = { jobs, renditions, scanTs, extractAudio, spliceAudio, listSaved };
  }

  // 1) Hook the page itself (in case the player ever runs without a worker).
  installUnmuteHook(window);

  // 2) Wrap Worker so the same hook runs first inside Twitch's player worker.
  //    (The player binds `self.fetch` when it starts, so the hook must already
  //    be in place: that's why it is prepended to the worker's code.)
  const hookSource = '(' + installUnmuteHook.toString() + ')(self);\n';
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    constructor(scriptURL, options) {
      let finalURL = scriptURL;
      try {
        const isModule = options && options.type === 'module';
        const src = scriptURL instanceof URL ? scriptURL.href : String(scriptURL);
        if (!isModule) {
          let code;
          if (src.startsWith('blob:')) {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', src, false); // read the original blob's code
            xhr.send();
            code = hookSource + xhr.responseText;
          } else {
            code = hookSource + 'importScripts(' + JSON.stringify(new URL(src, location.href).href) + ');';
          }
          finalURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        }
      } catch (e) {
        console.warn('[VOD Unmuter] could not wrap worker, using the original', e);
        finalURL = scriptURL;
      }
      super(finalURL, options);
    }
  };

  // 3) Talk to the extension (bridge.js, isolated world): settings go to every
  //    hook instance and the UI; the popup's storage requests are answered
  //    here, since only the page can reach twitch.tv's saved audio.
  let lastSettings = null;
  let relay = null;
  try { relay = new BroadcastChannel(CHANNEL_NAME); } catch (e) { /* unsupported */ }
  if (relay) {
    relay.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'hello' && lastSettings) {
        relay.postMessage({ type: 'settings', settings: lastSettings });
      }
    });
  }

  async function answerStorage(request) {
    const store = window.__vodUnmuterStore;
    if (!store) return { error: 'unavailable' };
    const forget = async (vodKey) => {
      if (relay) relay.postMessage({ type: 'deleteSaved', vodKey }); // live player state
      await store.remove(vodKey);
    };
    if (request.action === 'delete' && request.vodKey) await forget(request.vodKey);
    else if (request.action === 'deleteAll') for (const v of await store.list()) await forget(v.vod);
    let usage = null;
    try { usage = await navigator.storage.estimate(); } catch (e) { /* ignore */ }
    return { vods: await store.list(), quota: usage && usage.quota };
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'vod-unmuter-bridge') return;
    if (ev.data.settings) {
      lastSettings = ev.data.settings;
      if (relay) relay.postMessage({ type: 'settings', settings: lastSettings });
    }
    if (ev.data.request) {
      let reply;
      try { reply = await answerStorage(ev.data.request); } catch (e) { reply = { error: String(e) }; }
      window.postMessage({ source: 'vod-unmuter-page', type: 'storageReply', id: ev.data.request.id, reply }, location.origin);
    }
  });
  window.postMessage({ source: 'vod-unmuter-page', type: 'getSettings' }, '*');
})();
