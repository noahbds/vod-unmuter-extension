// Hook module (page and player worker): see src/hook.js.

import { FALLBACK_DIRS, isMiss, jobName, MAX_PARALLEL, SAVE_PARALLEL, sleep, SUFFIXES } from '../shared/constants.js';
import { known, pending, realFetch, renditions } from '../shared/state.js';
import { log } from '../shared/logger.js';
import { markMissing } from '../storage/gone-cache.js';
import { jobOf, reasonOf } from './recovery-state.js';

// ------------------------------------------------------------ probing
export function makeLimiter(max) {
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
export const limited = makeLimiter(MAX_PARALLEL);
export const saveLimited = makeLimiter(SAVE_PARALLEL);

// HEAD requests are unreliable on Twitch's CDN (they sometimes fail CORS
// even for files that exist), so probe with GET and abort the body.
export async function probeOnce(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (known.has(url)) return known.get(url);
    const ctrl = new AbortController();
    try {
      const r = await realFetch.call(scope, url, { cache: 'no-store', signal: ctrl.signal });
      ctrl.abort(); // never download the body, found or not
      if (r.ok) { known.set(url, true); return true; }
      if (isMiss(r.status)) { markMissing(url, jobOf(url)); return false; }
    } catch (e) { ctrl.abort(); /* network hiccup: retry */ }
    await sleep(300 * (attempt + 1));
  }
  // Timeouts and server errors (5xx) don't mean the file was deleted:
  // answer "unknown", never remembered, so it is asked again later.
  return null;
}

// urgent = the player is waiting for it: skip the background queue.
export function probe(url, urgent) {
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
export const allDirs = (job) => renditions.get(job.vodBase) || FALLBACK_DIRS;
// Other qualities to borrow sound from, best first. Measured: audio_only,
// 480p and up all carry the same sound as Source (identical bytes), and
// audio_only is by far the smallest download; 360p and 160p have much
// lower-bitrate sound (~67 and ~50 kbps), so they come last.
export const donorDirs = (job) => saveDirs(job).filter((d) => d !== job.dir);
// Other qualities: only the original file name. Twitch's "-unmuted"
// backup has never turned up in another quality in our tests, and checking
// it would double the requests.
export function donorSources(seg, dirs) {
  return (dirs || donorDirs(seg.job)).map((dir) => dir + '/.ts');
}

export function urlFor(seg, source) {
  const slash = source.indexOf('/');
  if (slash < 0) return seg.urls[source];
  return seg.job.vodBase + source.slice(0, slash) + '/' + seg.num + source.slice(slash + 1) + seg.query;
}

// Both return the first source found, or null. `seg.unknown` is set when
// a file couldn't be checked (network problem), so "not found" isn't sure.
export async function findOwn(seg) {
  for (const sfx of SUFFIXES) {
    const found = await probe(urlFor(seg, sfx));
    if (found) return sfx;
    if (found === null) seg.unknown = true;
  }
  return null;
}
export async function findDonor(seg, dirs) {
  for (const source of donorSources(seg, dirs)) {
    const found = await probe(urlFor(seg, source));
    if (found) return source;
    if (found === null) seg.unknown = true;
  }
  return null;
}

export function setResult(seg, source) {
  if (!seg.confirmed) seg.source = source;
}

// Every muted segment is checked on its own: Twitch deletes originals in a
// scattered way (holes inside kept stretches and survivors inside deleted
// ones), so guessing from a few segments was wrong on real VODs.
// Order: same quality, saved copy, other qualities.
export async function resolveSegment(s) {
  s.unknown = false;
  setResult(s, await findOwn(s));
  if (!s.confirmed && !s.source) {
    if (s.job.saved.has(s.num)) setResult(s, 'saved');
    else setResult(s, await findDonor(s));
  }
  log('debug', `${jobName(s.job)}: segment ${s.num}: ${s.source ? 'sound from ' + s.source : reasonOf(s)}`);
}

// Which quality to download for saving: the smallest file that still has
// full-quality sound (see donorDirs).
export function saveDirs(job) {
  const height = (d) => (d === 'chunked' ? 1e4 : parseInt(d, 10) || 0);
  const dirs = allDirs(job).filter((d) => d !== 'audio_only');
  const good = dirs.filter((d) => height(d) >= 480).sort((a, b) => height(a) - height(b));
  const low = dirs.filter((d) => height(d) < 480).sort((a, b) => height(b) - height(a));
  return ['audio_only', ...good, ...low];
}
