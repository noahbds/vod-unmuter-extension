// Hook module (page and player worker): see src/hook.js.

import { FALLBACK_DIRS, fileLabel, fmtTime, isMiss, jobName, MAX_PARALLEL, partName, prettyQuality, SAVE_PARALLEL, sleep, SUFFIXES } from '../shared/constants.js';
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
// For the logs, each answer is noted in `answers` (url -> { tries: [200,
// 404, 503 or 'network error'], ms }) until the check that asked reads it.
export const answers = new Map();
export async function probeOnce(url) {
  const note = { tries: [], ms: 0 };
  answers.set(url, note);
  if (answers.size > 500) answers.delete(answers.keys().next().value); // the player's own probes are never read back
  for (let attempt = 0; attempt < 3; attempt++) {
    if (known.has(url)) return known.get(url);
    const ctrl = new AbortController();
    const t0 = Date.now();
    try {
      const r = await realFetch.call(scope, url, { cache: 'no-store', signal: ctrl.signal });
      ctrl.abort(); // never download the body, found or not
      note.ms += Date.now() - t0;
      note.tries.push(r.status);
      if (r.ok) { known.set(url, true); return true; }
      if (isMiss(r.status)) { markMissing(url, jobOf(url)); return false; }
    } catch (e) { ctrl.abort(); note.ms += Date.now() - t0; note.tries.push('network error'); /* network hiccup: retry */ }
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
// `tried` (optional) gets each file asked: { source, found, remembered,
// tries, ms } (remembered: answered from memory or the deleted-files cache,
// no request; tries: the HTTP status of each try; ms: time spent on them).
async function ask(seg, source, tried) {
  const url = urlFor(seg, source);
  const remembered = known.has(url);
  const found = await probe(url);
  const note = answers.get(url);
  answers.delete(url);
  if (tried) tried.push({ source, found, remembered, tries: note ? note.tries : [], ms: note ? note.ms : 0 });
  return found;
}
export async function findOwn(seg, tried) {
  for (const sfx of SUFFIXES) {
    const found = await ask(seg, sfx, tried);
    if (found) return sfx;
    if (found === null) seg.unknown = true;
  }
  return null;
}
export async function findDonor(seg, dirs, tried) {
  for (const source of donorSources(seg, dirs)) {
    const found = await ask(seg, source, tried);
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
// `report` (optional) gets what was found, to be logged with the check's
// summary (see scan-scheduler.js); without it, it is logged at once.
export async function resolveSegment(s, report) {
  const started = Date.now();
  const tried = [];
  s.unknown = false;
  setResult(s, await findOwn(s, tried));
  if (!s.confirmed && !s.source) {
    if (s.job.saved.has(s.num)) setResult(s, 'saved');
    else setResult(s, await findDonor(s, undefined, tried));
  }
  const entry = { seg: s, verdict: checkVerdict(s), asked: describeTried(s.job, tried), ms: Date.now() - started, requestMs: tried.reduce((n, t) => n + t.ms, 0) };
  if (report) report.push(entry);
  else log('debug', `${jobName(s.job)}: ${describeChecks([entry])[0]}`);
}

// Check results as log lines, in VOD order. Neighbouring parts with the same
// result and the same answers make one line: "parts 576–612 (1:36:10–
// 1:42:20, 37 parts): …".
export function describeChecks(entries) {
  const sorted = entries.slice().sort((a, b) => a.seg.num - b.seg.num);
  const runs = [];
  for (const e of sorted) {
    const last = runs[runs.length - 1];
    if (last && e.seg.num === last.to.seg.num + 1 && e.verdict === last.from.verdict && e.asked === last.from.asked) {
      last.to = e;
      last.all.push(e);
    } else runs.push({ from: e, to: e, all: [e] });
  }
  return runs.map(({ from, to, all }) => {
    const where = all.length === 1 ? partName(from.seg)
      : `parts ${from.seg.num}–${to.seg.num} (${fmtTime(from.seg.start)}–${fmtTime(to.seg.start + to.seg.duration)}, ${all.length} parts)`;
    return `${where}: ${from.verdict} · asked: ${from.asked} · ${describeTime(all)}`;
  });
}

// How long checking took, and how much of it was spent waiting for one of
// the MAX_PARALLEL request slots (the rest of the VOD is checked at the
// same time) rather than on the requests themselves.
export function describeTime(entries) {
  const ms = (n) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
  const total = entries.map((e) => e.ms);
  const lo = Math.min(...total), hi = Math.max(...total);
  const waited = entries.reduce((n, e) => n + Math.max(0, e.ms - e.requestMs), 0);
  const all = entries.reduce((n, e) => n + e.ms, 0);
  const span = ms(lo) === ms(hi) ? ms(hi) : `${ms(lo)}–${ms(hi)}`;
  return `took ${span}` + (all > 200 && waited / all > 0.5 ? ` (mostly waiting for a free request slot: ${MAX_PARALLEL} at a time)` : '');
}

// What resolveSegment concluded, in words.
export function checkVerdict(s) {
  const how = s.confirmed ? ' (already settled by playback)' : '';
  if (s.source === 'saved') return `will play the ${fileLabel(s.job, 'saved')}${how}`;
  if (s.source && s.source.includes('/')) return `restored: sound from the ${fileLabel(s.job, s.source)}, spliced into the ${prettyQuality(s.job.dir)} video${how}`;
  if (s.source) return `restored: plays the ${fileLabel(s.job, s.source)}${how}`;
  const reason = reasonOf(s);
  if (reason === 'network') return 'not settled: a file could not be checked (network or server error), will retry';
  if (reason === 'gone') return `stays muted: Twitch deleted the original in every quality${how}`;
  return `stays muted (${reason})${how}`;
}

// "Source original file: deleted (404), Source "-unmuted" backup: no answer
// (503, 503, network error), 720p60 original file: found (200)". Times are
// left out so that parts with the same answers can share a line.
export function describeTried(job, tried) {
  if (!tried.length) return 'nothing (answered by the saved copy or playback)';
  return tried.map((t) => {
    const what = t.found ? 'found' : t.found === false ? 'deleted' : 'no answer';
    const why = t.remembered ? 'remembered' : t.tries && t.tries.length ? t.tries.join(', ') : 'asked by another check';
    return `${fileLabel(job, t.source)}: ${what} (${why})`;
  }).join(', ');
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
