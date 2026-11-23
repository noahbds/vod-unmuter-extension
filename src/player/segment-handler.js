// Hook module (page and player worker): see src/hook.js.

import { fileLabel, isMiss, jobName, partName, prettyQuality, requestFor, SUFFIXES } from '../shared/constants.js';
import { known, realFetch, saveMode, segments, settings } from '../shared/state.js';
import { describeArg, log } from '../shared/logger.js';
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
  // For the debug log: what was tried before the answer, and how long it took.
  const t0 = Date.now();
  const steps = [];
  const played = (how) => log('debug', `${jobName(job)}: playing ${partName(seg)}: ${how}` +
    (steps.length ? ` · before that: ${steps.join(', ')}` : '') + ` · answered the player in ${Date.now() - t0} ms`);

  // a. Same quality: just serve the original file (and save its sound).
  const own = seg.source && !seg.source.includes('/') && seg.source !== 'saved'
    ? [seg.source].concat(SUFFIXES.filter((s) => s !== seg.source)) : SUFFIXES;
  for (const sfx of own) {
    const url = seg.urls[sfx];
    if (known.get(url) === false) { steps.push(`${fileLabel(job, sfx)}: known as deleted, not asked`); continue; }
    try {
      const r = await realFetch.call(scope, requestFor(url, input), init);
      if (r.ok) {
        known.set(url, true);
        confirm(seg, sfx);
        const save = settings.saveAudio && !job.noSave && !job.saved.has(seg.num) && saveMode() === 'whole';
        if (save) r.clone().arrayBuffer().then((b) => saveFromBytes(seg, new Uint8Array(b))).catch(() => {});
        played(`the ${fileLabel(job, sfx)} (${r.status}), as it is` + (save ? '; its sound is being saved' : ''));
        return r;
      }
      steps.push(`${fileLabel(job, sfx)}: ${isMiss(r.status) ? 'deleted' : 'no answer'} (${r.status})`);
      if (isMiss(r.status)) markMissing(url, jobOf(url)); else uncertain = true;
      try { r.body && r.body.cancel(); } catch (e) { /* ignore */ }
    } catch (e) {
      if (aborted()) throw e;
      steps.push(`${fileLabel(job, sfx)}: no answer (${describeArg(e)})`);
      uncertain = true;
    }
  }

  // b. A copy saved on this computer earlier.
  if (job.saved.has(seg.num)) {
    try {
      const audio = await loadSaved(job.vodKey, seg.num);
      if (audio) {
        const { res, ok } = await spliced(seg, input, init, audio);
        if (ok) { confirm(seg, 'saved'); played(`the ${fileLabel(job, 'saved')}, spliced into the muted ${prettyQuality(job.dir)} file`); return res; }
        if (res.ok) {
          seg.reason = 'damaged';
          log('warn', `${jobName(job)}: ${partName(seg)}: the copy saved on this computer could not be spliced in (damaged, or another version of the VOD), plays muted`);
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
  steps.push(`other qualities asked at once: ${donors.map((s, i) => `${prettyQuality(s.split('/')[0])} ${found[i] ? 'found' : found[i] === false ? 'deleted' : 'no answer'}`).join(', ')}`);
  if (donor) {
    try {
      const other = await realFetch.call(scope, requestFor(urlFor(seg, donor), input), init);
      if (other.ok) {
        const ob = new Uint8Array(await other.arrayBuffer());
        const audio = extractAudio(ob);
        const { res, ok } = await spliced(seg, input, init, audio);
        if (ok) {
          confirm(seg, donor);
          const save = settings.saveAudio && !job.noSave && !job.saved.has(seg.num) && saveMode() === 'whole';
          if (save) saveFromBytes(seg, ob);
          played(`the sound of the ${fileLabel(job, donor)} (${(ob.byteLength / 1e6).toFixed(1)} MB downloaded), spliced into the muted ${prettyQuality(job.dir)} file` + (save ? '; its sound is being saved' : ''));
          return res;
        }
        if (res.ok) {
          seg.reason = 'splice';
          log('warn', `${jobName(job)}: ${partName(seg)}: sound found in the ${fileLabel(job, donor)}, but its timing didn't match the ${prettyQuality(job.dir)} video (over 0.1 s apart, or another audio format), plays muted`);
          confirm(seg, null);
          return res;
        }
      } else {
        steps.push(`downloading the ${fileLabel(job, donor)} failed (${other.status})`);
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
  played(uncertain ? 'the muted file: some files could not be checked (network or server errors), checked again later'
    : 'the muted file: Twitch deleted its sound in every quality' + (job.saved.has(seg.num) ? ' and the saved copy could not be used' : ' and there is no saved copy'));
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
