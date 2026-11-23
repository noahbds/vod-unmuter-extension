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
    const WHERE = IS_PAGE ? 'page' : 'player';
    // Each copy of the hook has an id: another extension can start a second
    // player worker, and the UI must follow the copy that really plays.
    const INSTANCE = Math.random().toString(36).slice(2, 10);
    const PLAYING_MS = 10 * 60 * 1000; // "playing" = downloaded a segment of it in the last 10 min
    // Twitch's video servers refuse the original files of muted parts (403)
    // to requests from the embedded player and the mobile site, while serving
    // them to www.twitch.tv (measured: same file, only the Origin differs).
    // Pages can't change their Origin, so there the extension doesn't check
    // anything (it would wrongly find everything "deleted"); it tells the user
    // to open the VOD on www.twitch.tv instead.
    let ORIGIN = '';
    try { ORIGIN = scope.location.origin; } catch (e) { /* ignore */ }
    const RESTRICTED = /^https:\/\/(player|m)\.twitch\.tv$/.test(ORIGIN);

    // ---- logging -----------------------------------------------------------
    // One logger for everything: levels error / warn / info / debug (debug
    // only with the popup's "Debug logging" switch). The last 150 lines are
    // kept in memory for the diagnostic report. URLs are shortened to their
    // last path parts, without their query (no tokens).
    const LOG_KEEP = 150;
    const logLines = [];
    const shortUrl = (text) => String(text).replace(/https?:\/\/[^\s"']+/g, (u) => {
      const path = u.split(/[?#]/)[0].split('/').filter(Boolean);
      return path.length > 3 ? '…/' + path.slice(-3).join('/') : path.slice(1).join('/') || u.split('?')[0];
    });
    const describeArg = (a) => {
      if (a instanceof Error || (a && a.name && a.message)) return `${a.name}: ${a.message}`;
      if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    };
    function log(level, ...args) {
      const where = typeof args[0] === 'string' && args[0].startsWith('@') ? args.shift().slice(1) : WHERE;
      if (level === 'debug' && !(typeof settings !== 'undefined' && settings.debug)) return;
      const text = shortUrl(args.map(describeArg).join(' '));
      logLines.push({ t: Date.now(), where, level, text });
      if (logLines.length > LOG_KEEP) logLines.shift();
      try { (console[level === 'info' ? 'log' : level] || console.log)(`${TAG} · ${where}: ${text}`); } catch (e) { /* no console */ }
    }
    // Short name of a job for log lines: "<channel> · <quality>".
    const jobName = (job) => `${job.vodKey.split('_').slice(1, -2).join('_') || job.vodKey.slice(0, 8)} · ${job.dir}`;
    const SUFFIXES = ['.ts', '-unmuted.ts']; // where the original audio can live
    const MUTED_RE = /^(.*?)(\d+)-muted\.ts(\?.*)?$/;
    const MAX_PARALLEL = 48;   // background checks (tiny requests, HTTP/2; measured: 14 s -> 10 s)
    const SAVE_PARALLEL = 8;    // background downloads for saving (measured: 76 s -> 32 s for 253)
    // Used only if the master playlist was not seen. Best quality first.
    const FALLBACK_DIRS = ['chunked', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30'];

    const realFetch = scope.fetch;
    let settings = { enabled: true, saveAudio: true, saveMode: 'whole', keepDays: 60, saveQuality: 'high', maxStorageMB: 1000, debug: false };
    // "whole": save every muted part. "unplayed": save the parts not watched
    // yet, and drop a part's saved copy once it has been watched through.
    // (Older versions had "watched"; it now means "unplayed".)
    const saveMode = () => (settings.saveMode === 'whole' ? 'whole' : 'unplayed');
    const AHEAD_MIN_PLAY = 20; // seconds of playback before a new position counts
    const isBehind = (job, s) => !!job.behind && s.start + s.duration <= job.behind;
    // Not worth saving now: behind the confirmed position, or behind where the
    // player is right now (if you rewind, those parts are saved then).
    const notAhead = (job, s) => isBehind(job, s) || (job.position !== undefined && s.start + s.duration <= job.position);
    const POSITION_WAIT_MS = 15000; // "ahead of me" waits this long for the player's position

    // "Parts ahead of me" mode: removes the saved copies of the parts behind
    // the furthest position reached in this VOD, and of `watched` parts.
    async function dropBehind(job, watched) {
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

    let channel = null;
    try { channel = new BroadcastChannel(CHANNEL); } catch (e) { /* unsupported */ }
    // The channel is shared by every twitch.tv tab: each message says which
    // tab it comes from, so a tab's counter only shows its own VOD.
    const TAB = scope.__vodUnmuterTab || '';
    const post = (msg) => { try { channel && channel.postMessage(Object.assign({ tab: TAB }, msg)); } catch (e) { /* ignore */ } };

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
      return audioPid >= 0 ? { audioPid, audioType, pts, pmtPid } : null;
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
      let start = 0; // audio may only come after the stream table (PAT/PMT)
      for (let o = 0; o + PKT <= target.length; o += PKT) {
        const pid = ((target[o + 1] & 0x1f) << 8) | target[o + 2];
        if (pid === t.audioPid) {
          if (firstCC < 0) firstCC = target[o + 3] & 0x0f;
        } else {
          keep.push(o);
          if (pid === t.pmtPid && !start) start = keep.length;
        }
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
      // Spread the audio evenly between the target's other packets, starting
      // right after the stream table so players know it's audio.
      const span = Math.max(1, keep.length - start);
      for (let i = 0; i < keep.length; i++) {
        while (i >= start && a < count && a / count <= (i - start) / span) putAudio();
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
        }).catch((e) => { log('warn', 'saving is unavailable: browser storage (IndexedDB) is blocked here, e.g. in a private window', e); return null; });
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

    const audioRange = (vod) => IDBKeyRange.bound(vod + '|', vod + '|\uffff');

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

    // ---- deleted originals ---------------------------------------------------
    // Once Twitch deletes an original file it never comes back, so every
    // "file not found" is remembered per VOD: opening the VOD again skips those
    // checks and shows the result almost at once. Kept in a separate database
    // so the saved-audio one never needs an upgrade.
    //   gone: { vod, updated, files: { "<quality>/<suffix>": [segment numbers] } }
    const GONE_KEEP_DAYS = 90;
    let goneDbPromise = null;
    function openGoneDb() {
      if (!goneDbPromise) {
        goneDbPromise = new Promise((resolve, reject) => {
          const req = scope.indexedDB.open('vod-unmuter-gone', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('gone', { keyPath: 'vod' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }).catch(() => null);
      }
      return goneDbPromise;
    }
    async function goneTx(mode, work) {
      const db = await openGoneDb();
      if (!db) return null;
      return new Promise((resolve, reject) => {
        const tx = db.transaction('gone', mode);
        const out = {};
        work(tx.objectStore('gone'), out);
        tx.oncomplete = () => resolve(out.value);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    }

    const GONE_RE = /^([^/?]+)\/(\d+)(\.ts|-unmuted\.ts)(?:\?.*)?$/;
    const goneQueue = new Map(); // vod folder -> { "<quality>/<suffix>" -> Set(numbers) }
    let goneTimer = null;

    // A file answered "not found": remember it (in memory and on disk).
    function markMissing(url) {
      known.set(url, false);
      const job = jobs.find((j) => url.startsWith(j.vodBase));
      if (!job || job.live) return;
      const m = url.slice(job.vodBase.length).match(GONE_RE);
      if (!m) return;
      if (!goneQueue.has(job.vodKey)) goneQueue.set(job.vodKey, new Map());
      const files = goneQueue.get(job.vodKey);
      const k = m[1] + '/' + m[3];
      if (!files.has(k)) files.set(k, new Set());
      files.get(k).add(Number(m[2]));
      if (!goneTimer) goneTimer = setTimeout(flushGone, 3000);
    }

    async function flushGone() {
      clearTimeout(goneTimer);
      goneTimer = null;
      const batch = [...goneQueue];
      goneQueue.clear();
      if (!batch.length) return;
      try {
        await goneTx('readwrite', (store) => {
          for (const [vod, files] of batch) {
            const r = store.get(vod);
            r.onsuccess = () => {
              const rec = r.result || { vod, files: {} };
              for (const [k, nums] of files) {
                const all = new Set(rec.files[k] || []);
                for (const n of nums) all.add(n);
                rec.files[k] = [...all].sort((a, b) => a - b);
              }
              rec.updated = Date.now();
              store.put(rec);
            };
          }
        });
      } catch (e) { log('debug', 'could not remember deleted files (only a speed-up)', e); }
    }

    // Marks this job's known-deleted files before checking starts.
    async function loadGone(job) {
      let rec = null;
      try {
        rec = await goneTx('readonly', (store, out) => {
          const r = store.get(job.vodKey);
          r.onsuccess = () => { out.value = r.result; };
        });
      } catch (e) { return 0; }
      if (!rec || !rec.files) return 0;
      let count = 0;
      for (const [k, nums] of Object.entries(rec.files)) {
        const slash = k.indexOf('/');
        const dir = k.slice(0, slash), sfx = k.slice(slash + 1);
        const set = new Set(nums);
        for (const seg of job.segs) {
          if (!set.has(seg.num)) continue;
          known.set(job.vodBase + dir + '/' + seg.num + sfx + seg.query, false);
          count++;
        }
      }
      return count;
    }

    async function clearGone(vod) {
      try {
        await goneTx('readwrite', (store) => { if (vod) store.delete(vod); else store.clear(); });
      } catch (e) { /* ignore */ }
    }

    async function expireGone() {
      const limit = Date.now() - GONE_KEEP_DAYS * 864e5;
      try {
        await goneTx('readwrite', (store) => {
          const r = store.openCursor();
          r.onsuccess = () => {
            const c = r.result;
            if (!c) return;
            if (!(c.value.updated > limit)) c.delete();
            c.continue();
          };
        });
      } catch (e) { /* ignore */ }
    }

    // ---- compression ------------------------------------------------------
    // A saved segment is one of:
    //   { fmt: 'deflate', type, pts, data, packed }  audio packets, lossless
    //   { fmt: 'aac', type, pts, kbps, data }        sound re-encoded to AAC
    //                                                (ADTS frames), smaller
    //   { type, pts, packets }                       older: uncompressed packets
    const recBytes = (rec) => (rec.data || rec.packets).byteLength;
    const concat = (parts) => {
      const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
      let w = 0;
      for (const b of parts) { out.set(b, w); w += b.length; }
      return out;
    };

    async function pipeBytes(bytes, stream) {
      return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
    }
    async function deflate(bytes) {
      try { return { data: await pipeBytes(bytes, new CompressionStream('deflate-raw')), packed: true }; }
      catch (e) { return { data: bytes, packed: false }; }
    }
    const inflate = (bytes) => pipeBytes(bytes, new DecompressionStream('deflate-raw'));

    // AAC frames (ADTS) carried by a segment's audio packets.
    function packetsToAdts(packets) {
      const parts = [];
      let started = false;
      for (let o = 0; o + 188 <= packets.length; o += 188) {
        const afc = (packets[o + 3] >> 4) & 3;
        if (!(afc & 1)) continue;
        let p = o + 4 + ((afc & 2) ? 1 + packets[o + 4] : 0);
        if (packets[o + 1] & 0x40) { p += 9 + packets[p + 8]; started = true; } // skip the PES header
        if (started && p < o + 188) parts.push(packets.subarray(p, o + 188));
      }
      return concat(parts);
    }
    function splitAdts(es) {
      const frames = [];
      for (let i = 0; i + 7 <= es.length;) {
        if (es[i] !== 0xff || (es[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
        const len = ((es[i + 3] & 3) << 11) | (es[i + 4] << 3) | (es[i + 5] >> 5);
        if (len < 7 || i + len > es.length) break;
        frames.push(es.subarray(i, i + len));
        i += len;
      }
      return frames;
    }
    const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const adtsInfo = (f) => ({ sampleRate: ADTS_RATES[(f[2] >> 2) & 0xf] || 48000, channels: (((f[2] & 1) << 2) | (f[3] >> 6)) || 2 });

    // AAC frames -> MPEG-TS audio packets (PID 0x100; spliceAudio renumbers it).
    function muxAdts(frames, pts, sampleRate) {
      const PER_PES = 4;
      const ticks = (1024 * 90000) / sampleRate; // 90 kHz clock per AAC frame
      const packets = [];
      let cc = 0;
      for (let i = 0; i < frames.length; i += PER_PES) {
        const payload = concat(frames.slice(i, i + PER_PES));
        const t = Math.round(pts + i * ticks) % 8589934592;
        const hi = Math.floor(t / 1073741824) & 7, lo = t % 1073741824;
        const len = 8 + payload.length;
        const pes = concat([new Uint8Array([0, 0, 1, 0xc0, len > 0xffff ? 0 : len >> 8, len > 0xffff ? 0 : len & 0xff,
          0x80, 0x80, 5, 0x21 | (hi << 1), (lo >> 22) & 0xff, (((lo >> 15) & 0x7f) << 1) | 1, (lo >> 7) & 0xff, ((lo & 0x7f) << 1) | 1]), payload]);
        for (let o = 0; o < pes.length;) {
          const pkt = new Uint8Array(188);
          const left = pes.length - o;
          pkt[0] = 0x47;
          pkt[1] = (o === 0 ? 0x40 : 0) | 0x01;
          pkt[2] = 0x00;
          if (left >= 184) {
            pkt[3] = 0x10 | cc;
            pkt.set(pes.subarray(o, o + 184), 4);
            o += 184;
          } else {
            pkt[3] = 0x30 | cc; // adaptation field = stuffing
            const af = 183 - left;
            pkt[4] = af;
            if (af > 0) { pkt[5] = 0; pkt.fill(0xff, 6, 5 + af); }
            pkt.set(pes.subarray(o), 5 + af);
            o = pes.length;
          }
          cc = (cc + 1) & 0x0f;
          packets.push(pkt);
        }
      }
      return concat(packets);
    }

    // What spliceAudio needs, from a saved record.
    async function recordToAudio(rec) {
      if (!rec) return null;
      if (!rec.fmt) return { type: rec.type, pts: rec.pts, packets: rec.packets };
      if (rec.fmt === 'deflate') return { type: rec.type, pts: rec.pts, packets: rec.packed ? await inflate(rec.data) : rec.data };
      if (rec.fmt === 'aac') {
        const frames = splitAdts(rec.data);
        return frames.length ? { type: 0x0f, pts: rec.pts, packets: muxAdts(frames, rec.pts, adtsInfo(frames[0]).sampleRate) } : null;
      }
      return null;
    }

    async function loadRecord(vod, num) {
      try {
        return await idb('audio', 'readonly', (audio, out) => {
          const r = audio.get(vod + '|' + num);
          r.onsuccess = () => { out.value = r.result; };
        });
      } catch (e) { return null; }
    }
    const loadSaved = async (vod, num) => recordToAudio(await loadRecord(vod, num));

    // Adds a segment (or replaces it, for compression) and keeps the VOD's
    // totals up to date.
    async function putRecord(vod, num, rec, replace) {
      const bytes = recBytes(rec);
      try {
        return await idb(['audio', 'vods'], 'readwrite', (store, vods, out) => {
          const key = vod + '|' + num;
          const old = store.get(key);
          old.onsuccess = () => {
            if (old.result !== undefined && !replace) return;
            const before = old.result ? recBytes(old.result) : 0;
            store.put(rec, key);
            const v = vods.get(vod);
            v.onsuccess = () => {
              const info = v.result || Object.assign({ vod, savedAt: Date.now(), segments: 0, bytes: 0 }, vodInfo(vod));
              if (!old.result) info.segments++;
              info.bytes += bytes - before;
              vods.put(info);
              out.value = info;
            };
          };
        });
      } catch (e) {
        if (e && e.name === 'QuotaExceededError') {
          // The browser's storage for twitch.tv is full (disk nearly full, or
          // the browser's own limit): stop saving instead of failing on every
          // segment, and say so in the panel.
          if (!storageFull) log('warn', 'browser storage for twitch.tv is full: saving stopped', e);
          storageFull = true;
          for (const j of jobs) if (j.vodKey === vod) { j.limitReached = true; j.storageFull = true; scheduleResult(j); }
        } else log('warn', 'could not save audio', e);
        return null;
      }
    }
    let storageFull = false;

    // ---- re-encoding (saving step 2, "High" / "Small" quality) --------------
    // Uses WebCodecs. Each segment is encoded with the end of the previous
    // segment in front of it and then cut exactly at its own start: AAC
    // encoders add ~44 ms of silence at the start of every encode, which
    // would otherwise leave a gap every 10 seconds.
    const KBPS = { high: 96, small: 64 };
    const delays = new Map(); // "rate|channels|kbps" -> encoder delay in samples, or null
    const codecsAvailable = () => typeof scope.AudioEncoder === 'function' && typeof scope.AudioDecoder === 'function';
    // Can this browser make AAC at all? (Firefox can't.) Told to the UI, so it
    // doesn't promise compressed saves that won't happen.
    let aacSupported = null;
    (async () => {
      try {
        aacSupported = codecsAvailable() && !!(await scope.AudioEncoder.isConfigSupported({
          codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000, aac: { format: 'adts' } })).supported;
      } catch (e) { aacSupported = false; }
    })();

    async function decodeFrames(frames, info) {
      const out = Array.from({ length: info.channels }, () => []);
      let failed = null;
      const dec = new scope.AudioDecoder({
        output: (a) => {
          for (let c = 0; c < info.channels; c++) {
            const b = new Float32Array(a.numberOfFrames);
            a.copyTo(b, { planeIndex: c, format: 'f32-planar' });
            out[c].push(b);
          }
          a.close();
        },
        error: (e) => { failed = e; },
      });
      dec.configure({ codec: 'mp4a.40.2', sampleRate: info.sampleRate, numberOfChannels: info.channels });
      frames.forEach((f, i) => dec.decode(new scope.EncodedAudioChunk({
        type: 'key', timestamp: Math.round((i * 1024 * 1e6) / info.sampleRate), data: f,
      })));
      await dec.flush();
      dec.close();
      if (failed) throw failed;
      return out.map((parts) => {
        const ch = new Float32Array(parts.reduce((n, b) => n + b.length, 0));
        let w = 0;
        for (const b of parts) { ch.set(b, w); w += b.length; }
        return ch;
      });
    }

    async function encodePcm(chans, info, kbps) {
      const frames = [];
      let failed = null;
      const enc = new scope.AudioEncoder({
        output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); frames.push(b); },
        error: (e) => { failed = e; },
      });
      enc.configure({ codec: 'mp4a.40.2', sampleRate: info.sampleRate, numberOfChannels: info.channels, bitrate: kbps * 1000, aac: { format: 'adts' } });
      const n = chans[0].length;
      const planar = new Float32Array(n * info.channels);
      chans.forEach((c, i) => planar.set(c, i * n));
      enc.encode(new scope.AudioData({ format: 'f32-planar', sampleRate: info.sampleRate, numberOfFrames: n, numberOfChannels: info.channels, timestamp: 0, data: planar }));
      await enc.flush();
      enc.close();
      if (failed) throw failed;
      return frames;
    }

    // The encoder's start-up delay differs between systems (2112 samples on
    // macOS): measure it once by encoding noise and finding where it lands.
    async function encoderDelay(info, kbps) {
      const key = info.sampleRate + '|' + info.channels + '|' + kbps;
      if (delays.has(key)) return delays.get(key);
      let delay = null;
      try {
        const cfg = { codec: 'mp4a.40.2', sampleRate: info.sampleRate, numberOfChannels: info.channels, bitrate: kbps * 1000, aac: { format: 'adts' } };
        const dcfg = { codec: 'mp4a.40.2', sampleRate: info.sampleRate, numberOfChannels: info.channels };
        if (codecsAvailable() && (await scope.AudioEncoder.isConfigSupported(cfg)).supported &&
            (await scope.AudioDecoder.isConfigSupported(dcfg)).supported) {
          let seed = 12345;
          const noise = new Float32Array(info.sampleRate);
          // Low-passed noise: never repeats (no false matches) and AAC encodes
          // it faithfully enough to find the shift reliably.
          let y = 0;
          for (let i = 0; i < noise.length; i++) {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
            y = 0.9 * y + 0.2 * (seed / 4294967296 - 0.5);
            noise[i] = y;
          }
          const out = (await decodeFrames(await encodePcm(Array(info.channels).fill(noise), info, kbps), info))[0];
          let best = -1, bestLag = 0;
          const from = 8192, to = Math.min(from + 16384, noise.length - 8192);
          for (let lag = 0; lag < 6144; lag++) { // real encoders: ~1000-2200 samples
            let c = 0, a = 0, b = 0;
            for (let i = from; i < to; i += 2) { const x = noise[i], y = out[i + lag] || 0; c += x * y; a += x * x; b += y * y; }
            const r = c / Math.sqrt(a * b || 1);
            if (r > best) { best = r; bestLag = lag; }
          }
          if (best > 0.8) delay = bestLag;
        }
      } catch (e) { delay = null; }
      delays.set(key, delay);
      if (delay === null) log('info', 'this browser has no AAC encoder: saved audio stays lossless (1.1 to 2.4 MB per muted minute)');
      return delay;
    }

    // prevTail: the decoded end of the previous segment (or null = silence).
    async function reencode(prevTail, cur, info, kbps, delay, frameCount) {
      const K = Math.ceil(delay / 1024) + 1;
      const lead = 1024 * K - delay; // samples placed before the segment start
      const n = cur[0].length;
      const input = cur.map((ch, c) => {
        const x = new Float32Array(lead + n);
        const prev = prevTail && prevTail[c];
        if (prev && prev.length) x.set(prev.subarray(Math.max(0, prev.length - lead)), lead - Math.min(lead, prev.length));
        x.set(ch, lead);
        return x;
      });
      const frames = await encodePcm(input, info, kbps);
      const keep = frames.slice(K, K + frameCount); // output frame K starts exactly at the segment start
      return keep.length >= frameCount - 2 ? concat(keep) : null;
    }

    // Removes one part's saved copy and keeps the VOD's totals right.
    async function deleteSavedSegment(vod, num) {
      try {
        await idb(['audio', 'vods'], 'readwrite', (audio, vods) => {
          const key = vod + '|' + num;
          const old = audio.get(key);
          old.onsuccess = () => {
            if (!old.result) return;
            audio.delete(key);
            const v = vods.get(vod);
            v.onsuccess = () => {
              if (!v.result) return;
              v.result.segments = Math.max(0, v.result.segments - 1);
              v.result.bytes = Math.max(0, v.result.bytes - recBytes(old.result));
              vods.put(v.result); // kept even when empty: it remembers the position ("Parts ahead of me")
            };
          };
        });
      } catch (e) { log('warn', 'could not remove a watched part\'s saved copy', e); }
    }

    async function deleteSavedVod(vod) {
      await idb(['audio', 'vods'], 'readwrite', (audio, vods) => {
        audio.delete(audioRange(vod));
        vods.delete(vod);
      });
    }

    // Changes fields of a saved VOD's record (not its audio). Returns false
    // when the VOD has nothing saved.
    async function updateVodInfo(vod, fields) {
      try {
        return await idb('vods', 'readwrite', (vods, out) => {
          const r = vods.get(vod);
          r.onsuccess = () => {
            if (!r.result) { out.value = false; return; }
            vods.put(Object.assign(r.result, fields));
            out.value = true;
          };
        });
      } catch (e) { log('warn', 'could not update saved VOD info', e); return false; }
    }

    // Once a VOD is checked, its saved record learns how much of it was muted
    // and could be restored, so the menu can say "182 / 204 saved" and why.
    function noteVodTotals(job) {
      if (job.skipped && !job.saved.size) return;
      updateVodInfo(job.vodKey, {
        muted: job.segs.length,
        restorable: job.segs.filter((x) => x.source).length,
        checkedAt: Date.now(),
      });
    }

    // Saved VODs (records left with no part, which only remember a position,
    // are left out unless `all`).
    async function listSaved(all) {
      const list = (await idb('vods', 'readonly', (vods, out) => {
        const r = vods.getAll();
        r.onsuccess = () => { out.value = r.result; };
      })) || [];
      return all ? list : list.filter((v) => v.segments > 0);
    }

    async function expireSaved(keepDays) {
      expireGone();
      if (!keepDays) return; // 0 = keep forever
      const limit = Date.now() - keepDays * 864e5;
      for (const v of await listSaved(true)) if (v.savedAt < limit && !v.pinned) await deleteSavedVod(v.vod);
    }

    // ---- backup files ------------------------------------------------------
    // One file holds any number of saved VODs:
    //   "VODUNMUTER-BACKUP\n"  then a 4-byte little-endian header length,
    //   the header (JSON), then the raw audio bytes the header points to.
    // Binary fields of a record are written as { $bin: [offset, length] }.
    const BACKUP_MAGIC = 'VODUNMUTER-BACKUP\n';
    const BACKUP_FORMAT = 1;
    const AUDIO_KEY_RE = /^([A-Za-z0-9_-]+)\|(\d+)$/;

    async function exportSaved(vodKeys) {
      const vods = (await listSaved()).filter((v) => !vodKeys || vodKeys.includes(v.vod));
      const header = { format: BACKUP_FORMAT, app: 'Twitch VOD Unmuter', exported: Date.now(), vods, audio: [] };
      const blobs = [];
      let offset = 0;
      for (const v of vods) {
        const { keys, values } = (await idb('audio', 'readonly', (audio, out) => {
          const k = audio.getAllKeys(audioRange(v.vod));
          const r = audio.getAll(audioRange(v.vod));
          r.onsuccess = () => { out.value = { keys: k.result, values: r.result }; };
        })) || { keys: [], values: [] };
        const parts = [];
        keys.forEach((key, i) => {
          const rec = {};
          for (const [name, value] of Object.entries(values[i] || {})) {
            if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
              const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
              rec[name] = { $bin: [offset, bytes.byteLength] };
              parts.push(bytes);
              offset += bytes.byteLength;
            } else rec[name] = value;
          }
          header.audio.push({ key, rec });
        });
        blobs.push(new Blob(parts)); // one VOD at a time, so the browser can keep it on disk
      }
      const head = new TextEncoder().encode(JSON.stringify(header));
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, head.byteLength, true);
      const blob = new Blob([BACKUP_MAGIC, len, head].concat(blobs), { type: 'application/octet-stream' });
      return { blob, vods: vods.length, segments: header.audio.length, bytes: offset };
    }

    async function readBackupHeader(file) {
      const magicLen = BACKUP_MAGIC.length;
      const start = new Uint8Array(await file.slice(0, magicLen + 4).arrayBuffer());
      if (new TextDecoder().decode(start.subarray(0, magicLen)) !== BACKUP_MAGIC) throw new Error('This is not a VOD Unmuter backup file.');
      const headLen = new DataView(start.buffer).getUint32(magicLen, true);
      const head = JSON.parse(new TextDecoder().decode(await file.slice(magicLen + 4, magicLen + 4 + headLen).arrayBuffer()));
      if (!head || head.format !== BACKUP_FORMAT || !Array.isArray(head.vods) || !Array.isArray(head.audio)) {
        throw new Error('This backup was made by a newer version of the extension, or is damaged.');
      }
      return { head, dataStart: magicLen + 4 + headLen };
    }

    // Adds what is in the file. Segments already saved here are kept as they are.
    async function importSaved(file, onProgress) {
      const { head, dataStart } = await readBackupHeader(file);
      const vodMeta = new Map(head.vods.filter((v) => v && typeof v.vod === 'string').map((v) => [v.vod, v]));
      const result = { vods: new Set(), added: 0, skipped: 0, bytes: 0 };
      const BATCH = 40;
      for (let i = 0; i < head.audio.length; i += BATCH) {
        // Read the bytes first: an IndexedDB transaction can't wait for file reads.
        const batch = [];
        for (const entry of head.audio.slice(i, i + BATCH)) {
          const m = entry && typeof entry.key === 'string' && entry.key.match(AUDIO_KEY_RE);
          if (!m || !entry.rec || typeof entry.rec !== 'object') { result.skipped++; continue; }
          const rec = {};
          for (const [name, value] of Object.entries(entry.rec)) {
            if (value && Array.isArray(value.$bin)) {
              const [off, len] = value.$bin;
              rec[name] = new Uint8Array(await file.slice(dataStart + off, dataStart + off + len).arrayBuffer());
              if (rec[name].byteLength !== len) throw new Error('The backup file is incomplete.');
            } else rec[name] = value;
          }
          if (!(rec.data instanceof Uint8Array || rec.packets instanceof Uint8Array)) { result.skipped++; continue; }
          batch.push({ key: entry.key, vod: m[1], rec });
        }
        await idb(['audio', 'vods'], 'readwrite', (audio, vods) => {
          const totals = new Map(); // vod -> { segments, bytes } added in this batch
          let pendingChecks = batch.length;
          const finish = () => {
            for (const [vod, add] of totals) {
              const r = vods.get(vod);
              r.onsuccess = () => {
                const meta = vodMeta.get(vod) || {};
                const info = r.result || Object.assign(vodInfo(vod), {
                  channel: meta.channel || vodInfo(vod).channel, streamedAt: meta.streamedAt || vodInfo(vod).streamedAt,
                  vod, savedAt: Date.now(), segments: 0, bytes: 0, // "saved" = imported now, so it isn't expired at once
                });
                info.segments += add.segments;
                info.bytes += add.bytes;
                vods.put(info);
              };
            }
          };
          if (!pendingChecks) return;
          for (const item of batch) {
            const k = audio.getKey(item.key);
            k.onsuccess = () => {
              if (k.result === undefined) {
                audio.put(item.rec, item.key);
                if (!totals.has(item.vod)) totals.set(item.vod, { segments: 0, bytes: 0 });
                const t = totals.get(item.vod);
                t.segments++;
                t.bytes += recBytes(item.rec);
                result.added++;
                result.bytes += recBytes(item.rec);
              } else result.skipped++;
              result.vods.add(item.vod);
              if (--pendingChecks === 0) finish();
            };
          }
        });
        if (onProgress) onProgress(Math.min(i + BATCH, head.audio.length), head.audio.length);
      }
      for (const vod of result.vods) post({ type: 'savedChanged', vodKey: vod });
      return { vods: result.vods.size, added: result.added, skipped: result.skipped, bytes: result.bytes };
    }

    // Only the page instance manages the database for the popup / UI.
    if (IS_PAGE) {
      scope.__vodUnmuterStore = {
        list: listSaved, remove: deleteSavedVod, expire: expireSaved,
        exportSaved, importSaved, readBackupHeader, clearGone,
        pin: (vod, pinned) => updateVodInfo(vod, { pinned: !!pinned }),
      };
    }
    if (IS_PAGE) scope.__vodUnmuterAuto = { save: (vodId) => autoSave(vodId) };

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
          ctrl.abort(); // never download the body, found or not
          if (r.ok) { known.set(url, true); return true; }
          if (isMiss(r.status)) { markMissing(url); return false; }
        } catch (e) { ctrl.abort(); /* network hiccup: retry */ }
        await sleep(300 * (attempt + 1));
      }
      // Timeouts and server errors (5xx) don't mean the file was deleted:
      // answer "unknown", never remembered, so it is asked again later.
      return null;
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
    // Other qualities to borrow sound from, best first. Measured: audio_only,
    // 480p and up all carry the same sound as Source (identical bytes), and
    // audio_only is by far the smallest download; 360p and 160p have much
    // lower-bitrate sound (~67 and ~50 kbps), so they come last.
    const donorDirs = (job) => saveDirs(job).filter((d) => d !== job.dir);
    // Other qualities: only the original file name. Twitch's "-unmuted"
    // backup has never turned up in another quality in our tests, and checking
    // it would double the requests.
    function donorSources(seg, dirs) {
      return (dirs || donorDirs(seg.job)).map((dir) => dir + '/.ts');
    }

    function urlFor(seg, source) {
      const slash = source.indexOf('/');
      if (slash < 0) return seg.urls[source];
      return seg.job.vodBase + source.slice(0, slash) + '/' + seg.num + source.slice(slash + 1) + seg.query;
    }

    // Both return the first source found, or null. `seg.unknown` is set when
    // a file couldn't be checked (network problem), so "not found" isn't sure.
    async function findOwn(seg) {
      for (const sfx of SUFFIXES) {
        const found = await probe(urlFor(seg, sfx));
        if (found) return sfx;
        if (found === null) seg.unknown = true;
      }
      return null;
    }
    async function findDonor(seg, dirs) {
      for (const source of donorSources(seg, dirs)) {
        const found = await probe(urlFor(seg, source));
        if (found) return source;
        if (found === null) seg.unknown = true;
      }
      return null;
    }

    function setResult(seg, source) {
      if (!seg.confirmed) seg.source = source;
    }

    // Every muted segment is checked on its own: Twitch deletes originals in a
    // scattered way (holes inside kept stretches and survivors inside deleted
    // ones), so guessing from a few segments was wrong on real VODs.
    // Order: same quality, saved copy, other qualities.
    async function resolveSegment(s) {
      s.unknown = false;
      setResult(s, await findOwn(s));
      if (!s.confirmed && !s.source) {
        if (s.job.saved.has(s.num)) setResult(s, 'saved');
        else setResult(s, await findDonor(s));
      }
      log('debug', `${jobName(s.job)}: segment ${s.num}: ${s.source ? 'sound from ' + s.source : reasonOf(s)}`);
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

    // Why a muted segment is (still) muted, for the UI and the logs:
    //   'restored'  it isn't: its sound was found
    //   'checking'  not checked yet
    //   'network'   couldn't be checked (timeouts, server errors): retried
    //   'skipped'   not checked one by one: old VOD, nothing left in a sample
    //   'splice'    sound found but it didn't fit (timing): kept muted
    //   'damaged'   the saved copy couldn't be used
    //   'gone'      Twitch deleted the original in every quality
    function reasonOf(seg) {
      if (seg.source) return 'restored';
      if (seg.reason) return seg.reason;
      if (seg.unknown) return 'network';
      if (seg.skippedCheck) return 'skipped';
      if (seg.source === undefined) return 'checking';
      return 'gone';
    }

    function buildRanges(segs) {
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
    const jobs = [];
    let currentJob = null;
    let noneCurrent = false; // the player moved to a VOD with nothing muted
    // In the player, a VOD whose playlist was just loaded counts as playing
    // until segments say otherwise. The page copy only sees playlists that
    // something else in the page fetched (e.g. another extension), so there a
    // VOD counts only once its video is really downloaded from the page.
    const isCurrent = (job) => !job.auto &&
      (currentJob || (noneCurrent || IS_PAGE ? null : jobs.filter((j) => !j.auto).pop())) === job;

    // The player opened another VOD (Twitch changes pages without reloading).
    // `job` is that VOD's job, or null when it has nothing muted: tell the UI
    // to drop the previous VOD's counter and seek bar colors.
    function switchVod(vodBase, job) {
      if (IS_PAGE) return; // the page copy doesn't play: playlists it sees say nothing about the player
      const before = currentJob || (noneCurrent ? null : jobs.filter((j) => !j.auto).pop());
      if (!before || before.vodBase === vodBase) return;
      post({ type: 'none', vod: before.vod, instance: INSTANCE });
      if (job) { makeCurrent(job); sendState(job); } else { currentJob = null; noneCurrent = true; }
    }

    // Called for the player's requests: the quality whose segments it
    // downloads is the one being played (playlists alone don't count: the
    // player may load several when adapting quality).
    function noteActivity(url) {
      if (!/\.ts(\?|$)/.test(url)) return;
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
    function sendResult(job, checking) {
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
          type: checking ? 'checking' : 'result', key: job.key, vod: job.vod, vodKey: job.vodKey,
          instance: INSTANCE, playing: !!job.lastSegmentAt && Date.now() - job.lastSegmentAt < PLAYING_MS,
          done: job.done, found: job.found, sample: job.sample || null, allGoneAfterH: ALL_GONE_AFTER_H,
          quality: prettyQuality(job.dir), total: job.total,
          muted: job.segs.length, restored, fromOther, fromSaved, mutedSeconds, restoredSeconds,
          skipped: job.skipped || 0, unknown,
          reasons: job.segs.reduce((m, x) => { const r = reasonOf(x); m[r] = (m[r] || 0) + 1; return m; }, {}),
          checkedQualities: allDirs(job).concat(allDirs(job).includes('audio_only') ? [] : ['audio_only']).map(prettyQuality),
          channel: job.vodKey.split('_').slice(1, -2).join('_'), endedAt: job.endedAt || null, sampleSize: job.sample ? job.sample.size : 0,
          ranges: buildRanges(job.segs),
          save: {
            enabled: !!settings.saveAudio, mode: settings.saveMode,
            saved, savable: restored, active: job.saving,
            bytes: job.savedBytes, savedAt: job.savedAt, paused: job.noSave,
            quality: settings.saveQuality, aac: aacSupported, limitReached: !!job.limitReached, storageFull: !!job.storageFull, maxMB: Number(settings.maxStorageMB) || 0,
            compressing: job.compressing ? { done: job.compressDone, total: job.compressTotal } : null,
          },
        });
      }
      return restored;
    }

    function sendState(job) {
      sendResult(job, !job.finished);
    }

    function throttledProgress(job) {
      if (job.progressTimer) return;
      job.progressTimer = setTimeout(() => { job.progressTimer = null; if (!job.finished) sendState(job); }, 250);
    }

    function scheduleResult(job) {
      clearTimeout(job.resultTimer);
      job.resultTimer = setTimeout(() => sendResult(job), 400);
    }

    const SAMPLE_SIZE = 24;
    // Twitch deletes original files 13 to 32 hours after the stream ends
    // (measured on 81 VODs), so this is a hint for the early verdict.
    const ALL_GONE_AFTER_H = 32;
    // Past this, with nothing found in the sample, the rest isn't checked one
    // by one: none of the 71 VODs we measured that ended more than 32 hours
    // ago had any original left. A part that is played is still checked then.
    const SKIP_REST_AFTER_H = 36;

    // A small pool of workers, each finishing one segment before taking the next.
    // A paused job (a quality the player isn't playing) stops taking segments
    // and waits until it's played again.
    async function checkSegments(job, order, sample) {
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

    // New muted segments in a VOD that is still recording.
    async function checkMore(job, segs) {
      await checkSegments(job, segs, null);
      sendResult(job);
      noteVodTotals(job);
      // Save the new ones too (or right after a save that is running now).
      if (job.saving) job.saveAgain = true;
      else job.savedAll = false;
      if (isCurrent(job)) maybeSaveAll(job);
    }

    async function checkAll(job) {
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
    function retryUnknown(job, attempt) {
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

    // ------------------------------------------------------------ saving
    function noteSaved(job, info) {
      if (!info) return;
      // Keep every quality of this VOD in sync.
      for (const j of jobs) {
        if (j.vodKey !== job.vodKey) continue;
        j.savedBytes = info.bytes;
        j.savedAt = info.savedAt;
      }
      if (job.finished) scheduleResult(job);
    }

    // Storage limit: delete the oldest other saves first; if this VOD alone
    // doesn't fit, stop saving it.
    async function makeRoom(job, incoming) {
      const maxMB = Number(settings.maxStorageMB) || 0;
      if (!maxMB) return true;
      const limit = maxMB * 1e6;
      const all = await listSaved();
      let total = all.reduce((n, v) => n + v.bytes, 0) + incoming;
      if (total <= limit) return true;
      for (const v of all.filter((x) => x.vod !== job.vodKey && !x.pinned).sort((a, b) => a.savedAt - b.savedAt)) {
        if (total <= limit) break;
        await deleteSavedVod(v.vod);
        total -= v.bytes;
        log('info', `storage limit: deleted the oldest saved VOD (${v.channel || v.vod})`);
      }
      return total <= limit;
    }

    // Saves run one at a time, so the storage limit is checked against
    // what's really on disk.
    let saveQueue = Promise.resolve();
    const serially = (task) => {
      const run = saveQueue.then(task, task);
      saveQueue = run.catch(() => {});
      return run;
    };

    async function saveFromBytes(seg, bytes) {
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
        return putRecord(job.vodKey, seg.num, { fmt: 'deflate', type: audio.type, pts: audio.pts, data: packed.data, packed: packed.packed }, false);
      });
      if (!info) return;
      for (const j of jobs) if (j.vodKey === job.vodKey) j.saved.add(seg.num);
      noteSaved(job, info);
    }

    // Which quality to download for saving: the smallest file that still has
    // full-quality sound (see donorDirs).
    function saveDirs(job) {
      const height = (d) => (d === 'chunked' ? 1e4 : parseInt(d, 10) || 0);
      const dirs = allDirs(job).filter((d) => d !== 'audio_only');
      const good = dirs.filter((d) => height(d) >= 480).sort((a, b) => height(a) - height(b));
      const low = dirs.filter((d) => height(d) < 480).sort((a, b) => height(b) - height(a));
      return ['audio_only', ...good, ...low];
    }

    // Save every muted part that can still be unmuted, in the background
    // ("unplayed" mode: except the parts already watched).
    async function maybeSaveAll(job, force) {
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
              if (!r.ok) { if (isMiss(r.status)) markMissing(url); continue; }
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
    function scheduleCompress(job) {
      clearTimeout(job.compressTimer);
      job.compressTimer = setTimeout(() => compressJob(job), 15000);
    }

    // The end of segment num-1, for a seamless join: from the saved copy if
    // there is one, or from Twitch (segments before a muted part play
    // normally, so they still exist), or silence.
    async function leadInFrames(job, num, cache) {
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
    function compressJob(job) {
      if (!settings.saveAudio || job.noSave || !job.saved.size) return Promise.resolve();
      if (job.compressPromise) { job.compressAgain = true; return job.compressPromise; }
      job.compressAgain = false;
      job.compressPromise = runCompress(job).finally(() => { job.compressPromise = null; });
      return job.compressPromise.then(() => (job.compressAgain ? compressJob(job) : undefined));
    }

    async function runCompress(job) {
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
            noteSaved(job, await putRecord(job.vodKey, num, next, true));
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

    // ------------------------------------------------------------ auto-save
    // Saves a VOD's muted parts without playing it (for the channels in the
    // popup's auto-save list). Runs in a twitch.tv page, because that's where
    // saved audio lives and where the viewer is logged in.
    async function autoSave(vodId) {
      const out = { vodId: String(vodId), ok: false };
      let job = null;
      try {
        const headers = { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko' };
        // Subscriber-only VODs need the viewer's Twitch login, exactly like the
        // player sends it. It only ever goes to Twitch.
        const login = (scope.document.cookie.match(/(?:^|;\s*)auth-token=([^;]+)/) || [])[1];
        if (login) headers.Authorization = 'OAuth ' + decodeURIComponent(login);
        const gql = await realFetch.call(scope, 'https://gql.twitch.tv/gql', {
          method: 'POST', headers,
          body: JSON.stringify({
            query: 'query($id: ID!) { videoPlaybackAccessToken(id: $id, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }',
            variables: { id: String(vodId) },
          }),
        }).then((r) => r.json());
        const tok = gql && gql.data && gql.data.videoPlaybackAccessToken;
        if (!tok) throw new Error('Twitch did not give access to this VOD');
        const masterUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?sig=${tok.signature}` +
          `&token=${encodeURIComponent(tok.value)}&allow_source=true&allow_audio_only=true&player_backend=mediaplayer`;
        const mr = await realFetch.call(scope, masterUrl);
        if (!mr.ok) {
          throw new Error(mr.status === 403
            ? 'subscriber-only: log in to Twitch with an account subscribed to this channel'
            : `Twitch answered ${mr.status}`);
        }
        const master = await mr.text();
        readMaster(master, masterUrl);
        const first = master.split('\n').map((l) => l.trim()).find((l) => l && l[0] !== '#' && !l.includes('/audio_only/'));
        if (!first) throw new Error('no video in this VOD');
        const mediaUrl = new URL(first, masterUrl).href;
        const text = await realFetch.call(scope, mediaUrl).then((r) => r.text());
        out.muted = (text.match(/-muted\.ts/g) || []).length;
        if (!out.muted) { out.ok = true; out.restorable = 0; out.saved = 0; return out; }

        job = rewritePlaylist(text, mediaUrl, true).job;
        out.vodKey = job.vodKey;
        await job.checked;
        await maybeSaveAll(job, true);
        await compressJob(job);
        out.restorable = job.segs.filter((s) => s.source).length;
        out.saved = job.segs.filter((s) => job.saved.has(s.num)).length;
        out.bytes = job.savedBytes;
        out.limitReached = job.limitReached;
        out.ok = true;
        log('info', '@auto-save', `VOD ${vodId}: ${out.saved}/${out.restorable} restorable muted segments saved` +
          (out.muted > out.restorable ? ` (${out.muted - out.restorable} already deleted by Twitch)` : ''));
      } catch (e) {
        out.error = (e && e.message) || String(e);
        log('warn', '@auto-save', `VOD ${vodId}:`, out.error);
      } finally {
        // Forget it, so the next run starts fresh and memory is freed.
        if (job) {
          jobs.splice(jobs.indexOf(job), 1);
          for (const s of job.segs) segments.delete(s.urls['.ts']);
        }
      }
      return out;
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

    // `existing`: the job made from an earlier copy of this playlist. A VOD that
    // is still recording keeps growing, so new muted segments are added to it.
    function rewritePlaylist(text, playlistUrl, auto, existing) {
      const clean = playlistUrl.split('?')[0];
      const base = clean.slice(0, clean.lastIndexOf('/') + 1);
      const vodBase = base.slice(0, base.lastIndexOf('/', base.length - 2) + 1);
      const vodKey = vodBase.slice(vodBase.lastIndexOf('/', vodBase.length - 2) + 1, -1);
      const job = existing || {
        key: base,                                      // one per quality
        vod: vodBase,                                   // same for every quality
        vodKey,                                         // folder name, used for saving
        dir: base.slice(vodBase.length, -1),
        base, vodBase, total: 0, segs: [], done: 0, found: 0, finished: false,
        saved: new Set(), savedBytes: 0, savedAt: null, saving: false, savedAll: false, noSave: false,
        limitReached: false, compressing: false, compressDone: 0, compressTotal: 0,
      };
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
          log('info', `${jobName(job)}: Twitch changed the muted parts: ${removed} no longer muted, ${added.length} newly muted, ${kept.length} now`);
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
      if (sibling) Object.assign(job, { savedBytes: sibling.savedBytes, savedAt: sibling.savedAt, noSave: sibling.noSave });
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
      let uncertain = false; // a file couldn't be checked (network problem)

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
            if (settings.saveAudio && !job.noSave && !job.saved.has(seg.num) && saveMode() === 'whole') {
              r.clone().arrayBuffer().then((b) => saveFromBytes(seg, new Uint8Array(b))).catch(() => {});
            }
            return r;
          }
          if (isMiss(r.status)) markMissing(url); else uncertain = true;
          try { r.body && r.body.cancel(); } catch (e) { /* ignore */ }
        } catch (e) {
          if (aborted()) throw e;
          uncertain = true;
        }
      }

      // b. A copy saved on this computer earlier.
      if (job.saved.has(seg.num)) {
        try {
          const audio = await loadSaved(job.vodKey, seg.num);
          if (audio) {
            const { res, ok } = await spliced(seg, input, init, audio);
            if (ok) { confirm(seg, 'saved'); return res; }
            if (res.ok) {
              seg.reason = 'damaged';
              log('warn', `${jobName(job)}: segment ${seg.num}: the saved copy couldn't be used, kept muted`);
              confirm(seg, null);
              return res;
            }
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
      if (found.includes(null)) uncertain = true;
      if (donor) {
        try {
          const other = await realFetch.call(scope, requestFor(urlFor(seg, donor), input), init);
          if (other.ok) {
            const ob = new Uint8Array(await other.arrayBuffer());
            const audio = extractAudio(ob);
            const { res, ok } = await spliced(seg, input, init, audio);
            if (ok) {
              confirm(seg, donor);
              if (settings.saveAudio && !job.noSave && !job.saved.has(seg.num) && saveMode() === 'whole') saveFromBytes(seg, ob);
              return res;
            }
            if (res.ok) {
              seg.reason = 'splice';
              log('warn', `${jobName(job)}: segment ${seg.num}: sound found in ${donor.split('/')[0]} but its timing didn't match, kept muted`);
              confirm(seg, null);
              return res;
            }
          } else {
            if (!isMiss(other.status)) uncertain = true;
            try { other.body && other.body.cancel(); } catch (e) { /* ignore */ }
          }
        } catch (e) {
          if (aborted()) throw e;
          uncertain = true;
        }
      }

      // d. Nothing found: play the muted file. If that may be only a network
      //    problem, don't settle it: it's checked again later.
      if (uncertain) {
        if (!seg.source) { seg.unknown = true; if (job.finished) { scheduleResult(job); retryUnknown(job, 1); } }
      } else confirm(seg, null);
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
          const before = settings;
          settings = Object.assign({}, settings, m.settings);
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
            try { await deleteSavedVod(m.vodKey); } catch (e) { log('warn', 'could not delete saved audio', e); }
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
          let idb = null;
          try { idb = !!(await openDb()); } catch (e) { idb = false; }
          post({
            type: 'diag-reply', id: m.id, where: WHERE, origin: ORIGIN, logs: logLines.slice(-60),
            info: {
              idb, aac: aacSupported, restricted: RESTRICTED, storageFull,
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

    // ------------------------------------------------------------ fetch hook
    const restrictedNoted = new Set();
    async function handleOther(input, init, url) {
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
            if (currentJob === entry.job) currentJob = null;
            return res;
          }
          switchVod(vodBase, null);
          return res;
        }
        if (RESTRICTED) {
          const muted = (text.match(/-muted\.ts/g) || []).length;
          if (!restrictedNoted.has(vodBase)) { restrictedNoted.add(vodBase); log('info', `${muted} muted segments: Twitch only gives the original sound to www.twitch.tv, not to ${ORIGIN}`); }
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
        log('error', 'could not rewrite the playlist: this VOD plays muted as usual', e);
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

    scope.__vodUnmuterDebug = { jobs, renditions, scanTs, extractAudio, spliceAudio, listSaved, loadRecord, recordToAudio, muxAdts, splitAdts, packetsToAdts, encoderDelay };
  }

  // 1) Hook the page itself (in case the player ever runs without a worker).
  // Id of this tab, shared with the copies of the hook in its player workers
  // (prepended to their code below) and with ui.js.
  window.__vodUnmuterTab = window.__vodUnmuterTab || Math.random().toString(36).slice(2, 10);
  installUnmuteHook(window);

  // 2) Get the same hook to run first inside Twitch's player worker. (The
  //    player binds `self.fetch` when it starts, so the hook must already be
  //    in place: it is prepended to the worker's code.) Two ways, because
  //    other extensions (ad blockers, etc.) also replace `Worker`, and
  //    depending on which loads first, theirs can start the player without
  //    going through ours:
  //    a. when the player's code is put in a Blob (Twitch, and most
  //       extensions, create the worker from a Blob): works whatever the
  //       order of the extensions;
  //    b. when a Worker is created from anything else.
  const hookSource = 'self.__vodUnmuterTab = ' + JSON.stringify(window.__vodUnmuterTab) + ';\n' +
    '(' + installUnmuteHook.toString() + ')(self);\n';
  const MARK = '__vodUnmuterHooked';
  const isPlayerWorkerCode = (text) => /amazon-ivs-wasmworker|wasmworker\.min/.test(text);

  // The text of Blobs made from strings, remembered so that (b) doesn't have
  // to read a worker's code back with a synchronous request (slow, and a
  // console warning in Firefox).
  const blobText = new WeakMap(); // Blob -> its text
  const urlText = new Map();      // blob: URL -> its text

  const OriginalBlob = window.Blob;
  window.Blob = class extends OriginalBlob {
    constructor(parts, options) {
      let text = null;
      try {
        if (Array.isArray(parts) && parts.length && parts.every((p) => typeof p === 'string')) {
          text = parts.join('');
          if (isPlayerWorkerCode(text) && !text.includes(MARK)) { parts = [hookSource].concat(parts); text = hookSource + text; }
        }
      } catch (e) { text = null; /* leave it as it was */ }
      super(parts, options);
      if (text !== null) blobText.set(this, text);
    }
  };

  const originalCreateURL = URL.createObjectURL;
  const originalRevokeURL = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    const url = originalCreateURL.call(URL, obj);
    try { if (obj && blobText.has(obj)) urlText.set(url, blobText.get(obj)); } catch (e) { /* ignore */ }
    return url;
  };
  URL.revokeObjectURL = function (url) {
    urlText.delete(url);
    return originalRevokeURL.call(URL, url);
  };

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
            let text = urlText.get(src);
            if (text === undefined) {
              // A Blob we didn't see being made: read its code back.
              const xhr = new XMLHttpRequest();
              xhr.open('GET', src, false);
              xhr.overrideMimeType('text/javascript'); // (else Firefox tries to parse it as XML)
              xhr.send();
              text = xhr.responseText;
            }
            // Already hooked by (a)? Then leave it alone.
            code = text.includes(MARK) ? null : hookSource + text;
          } else {
            code = hookSource + 'importScripts(' + JSON.stringify(new URL(src, location.href).href) + ');';
          }
          if (code) finalURL = URL.createObjectURL(new OriginalBlob([code], { type: 'text/javascript' }));
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
    if (request.action === 'diag') {
      return window.__vodUnmuterDiag ? window.__vodUnmuterDiag() : { text: 'The extension\'s page script is not loaded.', problems: ['page script not loaded'] };
    }
    if (request.action === 'autosave') {
      const auto = window.__vodUnmuterAuto;
      return auto ? auto.save(request.vodId) : { vodId: request.vodId, ok: false, error: 'unavailable' };
    }
    if (request.action === 'delete' && request.vodKey) await forget(request.vodKey);
    else if (request.action === 'deleteAll') for (const v of await store.list()) await forget(v.vod);
    else if (request.action === 'deleteChannel' && request.channel) {
      for (const v of await store.list()) if (v.channel === request.channel && !v.pinned) await forget(v.vod);
    } else if (request.action === 'pin' && request.vodKey) await store.pin(request.vodKey, request.pinned);
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
