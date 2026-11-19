// Runs in the page's own JavaScript world (MAIN) at document_start.
//
// How it works:
//  1. When Twitch loads a VOD playlist, every muted segment ("123-muted.ts")
//     is rewritten to the original file name ("123.ts"). The playlist is
//     returned right away, so the video starts with no delay.
//  2. When the player downloads one of those segments, the hook tries, in
//     order:
//       a. the original file in the quality being watched ("123.ts", then
//          "123-unmuted.ts");
//       b. the original file in ANOTHER quality (Twitch keeps one copy per
//          quality and deletes them separately). Only its audio is used: it is
//          spliced into the muted segment of the quality being watched, so the
//          video quality never changes;
//       c. the muted file, so playback never breaks.
//  3. In the background it checks every muted segment so the on-screen UI
//     (ui.js) can show how many were unmuted, via a BroadcastChannel.
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
    const SUFFIXES = ['.ts', '-unmuted.ts']; // where the original audio can live
    const MUTED_RE = /^(.*?)(\d+)-muted\.ts(\?.*)?$/;
    const MAX_PARALLEL = 12;
    // Used only if the master playlist was not seen. Best quality first.
    const FALLBACK_DIRS = ['chunked', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30'];

    const realFetch = scope.fetch;
    let settings = { enabled: true };

    let channel = null;
    try { channel = new BroadcastChannel(CHANNEL); } catch (e) { /* unsupported */ }
    const post = (msg) => { try { channel && channel.postMessage(msg); } catch (e) { /* ignore */ } };
    if (channel) {
      channel.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m && m.type === 'settings' && m.settings) settings = Object.assign({}, settings, m.settings);
      });
      post({ type: 'hello' });
    }

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

    // Keeps every packet of `target` (video, metadata) but replaces its audio
    // with the audio of `donor`: the same segment in another quality.
    function transplantAudio(target, donor) {
      const PKT = 188;
      const t = scanTs(target), d = scanTs(donor);
      if (!t || !d || t.audioType !== d.audioType) return null;
      // Same segment? Audio must start at the same time (within 0.1 s).
      if (t.pts >= 0 && d.pts >= 0 && Math.abs(t.pts - d.pts) > 9000) return null;
      const pidOf = (buf, o) => ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];

      const keep = [];
      let firstCC = -1;
      for (let o = 0; o + PKT <= target.length; o += PKT) {
        if (pidOf(target, o) === t.audioPid) { if (firstCC < 0) firstCC = target[o + 3] & 0x0f; } else keep.push(o);
      }
      const audio = [];
      for (let o = 0; o + PKT <= donor.length; o += PKT) {
        if (pidOf(donor, o) === d.audioPid) audio.push(o);
      }
      if (!audio.length) return null;
      const ccShift = firstCC < 0 ? 0 : (firstCC - (donor[audio[0] + 3] & 0x0f) + 16) % 16;

      const out = new Uint8Array((keep.length + audio.length) * PKT);
      let w = 0, a = 0;
      const putAudio = () => {
        const o = audio[a++];
        out.set(donor.subarray(o, o + PKT), w);
        out[w + 1] = (out[w + 1] & 0xe0) | (t.audioPid >> 8);
        out[w + 2] = t.audioPid & 0xff;
        out[w + 3] = (out[w + 3] & 0xf0) | (((out[w + 3] & 0x0f) + ccShift) % 16);
        w += PKT;
      };
      for (let i = 0; i < keep.length; i++) {
        while (a < audio.length && a / audio.length <= i / keep.length) putAudio();
        out.set(target.subarray(keep[i], keep[i] + PKT), w);
        w += PKT;
      }
      while (a < audio.length) putAudio();
      return out;
    }

    // ------------------------------------------------------------ probing
    let active = 0;
    const waiting = [];
    function limited(task) {
      return new Promise((resolve, reject) => {
        const run = () => {
          active++;
          task().then(resolve, reject).finally(() => {
            active--;
            const next = waiting.shift();
            if (next) next();
          });
        };
        if (active < MAX_PARALLEL) run(); else waiting.push(run);
      });
    }

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

    // A "source" is where a muted segment's audio can come from:
    //   ".ts" / "-unmuted.ts"            same quality
    //   "720p60/.ts", "720p60/-unmuted.ts"  another quality (audio only)
    function donorDirs(job) {
      const dirs = renditions.get(job.vodBase) || FALLBACK_DIRS;
      return dirs.filter((d) => d !== job.dir && d !== 'audio_only');
    }
    function sourcesFor(seg) {
      const list = SUFFIXES.slice();
      for (const dir of donorDirs(seg.job)) for (const sfx of SUFFIXES) list.push(dir + '/' + sfx);
      return list;
    }
    function urlFor(seg, source) {
      const slash = source.indexOf('/');
      if (slash < 0) return seg.urls[source];
      return seg.job.vodBase + source.slice(0, slash) + '/' + seg.num + source.slice(slash + 1) + seg.query;
    }

    async function findSource(seg, donorsOnly) {
      for (const source of sourcesFor(seg)) {
        if (donorsOnly ? !source.includes('/') : source.includes('/')) continue;
        if (await probe(urlFor(seg, source))) return source;
      }
      return null;
    }
    const findOwn = (seg) => findSource(seg, false);
    const findDonor = (seg) => findSource(seg, true);

    function setResult(seg, source) {
      if (!seg.confirmed) seg.source = source;
    }

    // A run of consecutive muted segments.
    // Same quality: Twitch keeps or deletes these in whole blocks, so check
    // the first and last; if they agree, assume the whole run matches.
    // Other qualities lose segments in a patchier way, so every segment that
    // is still muted is checked one by one.
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
        if (!s.confirmed && !s.source) setResult(s, await findDonor(s));
      }));
    }

    // ------------------------------------------------------------ reporting
    // Where a segment's audio comes from, for the UI:
    //   kind: 'original'     the original file of the quality being watched
    //         'backup'       Twitch's "-unmuted" file of that quality
    //         'other'        the original file of another quality (audio only)
    //         'other-backup' the "-unmuted" file of another quality (audio only)
    function describe(seg) {
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
          if (currentJob !== job) { currentJob = job; sendState(job); }
          return;
        }
      }
    }

    function sendResult(job) {
      let restored = 0, fromOther = 0, mutedSeconds = 0, restoredSeconds = 0;
      for (const s of job.segs) {
        mutedSeconds += s.duration;
        if (!s.source) continue;
        restored++;
        restoredSeconds += s.duration;
        if (s.source.includes('/')) fromOther++;
      }
      if (isCurrent(job)) {
        post({
          type: 'result', key: job.key, vod: job.vod, quality: prettyQuality(job.dir), total: job.total,
          muted: job.segs.length, restored, fromOther, mutedSeconds, restoredSeconds,
          ranges: buildRanges(job.segs),
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
      job.resultTimer = setTimeout(() => sendResult(job), 500);
    }

    async function checkAll(job) {
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
        (restored < job.segs.length ? ' (Twitch deleted the rest in every quality)' : ''));
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
      const job = {
        key: base,                                      // one per quality
        vod: vodBase,                                   // same for every quality
        dir: base.slice(vodBase.length, -1),
        base, vodBase, total: 0, segs: [], done: 0, finished: false,
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
      jobs.push(job);
      checkAll(job);
      return { text: lines.join('\n'), job };
    }

    // ------------------------------------------------------------ segments
    const segmentResponse = (body) =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp2t' } });

    async function fetchSegment(seg, input, init) {
      const sources = sourcesFor(seg);
      // Best guess first if the background check already found one.
      if (seg.source) sources.unshift(seg.source);

      // a. Same quality: just serve the original file.
      for (const source of sources) {
        if (source.includes('/')) continue;
        const url = urlFor(seg, source);
        if (known.get(url) === false) continue;
        try {
          const r = await realFetch.call(scope, requestFor(url, input), init);
          if (r.ok) { known.set(url, true); confirm(seg, source); return r; }
          if (isMiss(r.status)) known.set(url, false);
          try { r.body && r.body.cancel(); } catch (e) { /* ignore */ }
        } catch (e) {
          if (init && init.signal && init.signal.aborted) throw e;
        }
      }

      // b. Another quality still has the original: borrow its audio.
      const donors = sources.filter((s) => s.includes('/'));
      const found = await Promise.all(donors.map((s) => probe(urlFor(seg, s), true)));
      const donor = donors[found.indexOf(true)];
      if (donor) {
        try {
          const [muted, other] = await Promise.all([
            realFetch.call(scope, requestFor(seg.urls.muted, input), init),
            realFetch.call(scope, requestFor(urlFor(seg, donor), input), init),
          ]);
          if (muted.ok && other.ok) {
            const [mb, ob] = await Promise.all([muted.arrayBuffer(), other.arrayBuffer()]);
            const out = transplantAudio(new Uint8Array(mb), new Uint8Array(ob));
            confirm(seg, out ? donor : null);
            return segmentResponse(out || mb);
          }
          try { other.body && other.body.cancel(); } catch (e) { /* ignore */ }
          if (muted.ok) { confirm(seg, null); return muted; }
        } catch (e) {
          if (init && init.signal && init.signal.aborted) throw e;
        }
      }

      // c. Nothing left: play the muted file.
      confirm(seg, null);
      return realFetch.call(scope, requestFor(seg.urls.muted, input), init);
    }

    function confirm(seg, source) {
      const changed = seg.source !== source;
      seg.source = source;
      seg.confirmed = true;
      if (changed && seg.job.finished) scheduleResult(seg.job);
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

    scope.__vodUnmuterDebug = { jobs, renditions, transplantAudio, scanTs };
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

  // 3) Relay settings from the extension (bridge.js, isolated world) to every
  //    hook instance and to the UI.
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
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'vod-unmuter-bridge') return;
    lastSettings = ev.data.settings;
    if (relay) relay.postMessage({ type: 'settings', settings: lastSettings });
  });
  window.postMessage({ source: 'vod-unmuter-page', type: 'getSettings' }, '*');
})();
