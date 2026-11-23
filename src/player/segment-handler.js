// Hook module (page and player worker): see src/hook.js.

import { isMiss, jobName, requestFor, SUFFIXES } from '../shared/constants.js';
import { known, realFetch, saveMode, segments, settings } from '../shared/state.js';
import { log } from '../shared/logger.js';
import { extractAudio, spliceAudio } from '../media/transport-stream.js';
import { markMissing } from '../storage/gone-cache.js';
import { loadSaved } from '../storage/saved-audio.js';
import { donorSources, probe, urlFor } from '../recovery/probe-resolver.js';
import { jobOf, jobs, noteActivity, scheduleResult } from '../recovery/recovery-state.js';
import { retryUnknown } from '../recovery/scan-scheduler.js';
import { saveFromBytes } from '../recovery/save-compress-jobs.js';
import { handleOther } from './playlist-handler.js';

// ------------------------------------------------------------ segments
export const segmentResponse = (body) =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp2t' } });

// Downloads the muted segment and puts `audio` into it.
export async function spliced(seg, input, init, audio) {
  const muted = await realFetch.call(scope, requestFor(seg.urls.muted, input), init);
  if (!muted.ok) return { res: muted, ok: false };
  const mb = new Uint8Array(await muted.arrayBuffer());
  const out = audio && spliceAudio(mb, audio);
  return { res: segmentResponse(out || mb), ok: !!out };
}

export async function fetchSegment(seg, input, init) {
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
      if (isMiss(r.status)) markMissing(url, jobOf(url)); else uncertain = true;
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

export function confirm(seg, source) {
  const changed = seg.source !== source;
  seg.source = source;
  seg.confirmed = true;
  if (changed && seg.job.finished) scheduleResult(seg.job);
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
