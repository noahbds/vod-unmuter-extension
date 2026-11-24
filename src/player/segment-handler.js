// Hook module (page and player worker): see src/hook.js.

import { fileLabel, isMiss, jobName, notAhead, partName, prettyQuality, requestFor, SUFFIXES } from '../shared/constants.js';
import { known, realFetch, saveMode, savingOn, segments } from '../shared/state.js';
import { describeArg, log } from '../shared/logger.js';
import { extractAudio, spliceAudio } from '../media/transport-stream.js';
import { adtsToMp4Audio, extractMp4Audio, spliceMp4Audio } from '../media/fragmented-mp4.js';
import { markMissing } from '../storage/gone-cache.js';
import { loadRecord, loadSaved, recordToFrames } from '../storage/saved-audio.js';
import { donorSources, loadInit, probe, urlFor } from '../recovery/probe-resolver.js';
import { jobOf, jobs, noteActivity, scheduleResult } from '../recovery/recovery-state.js';
import { retryUnknown } from '../recovery/scan-scheduler.js';
import { saveFromBytes } from '../recovery/save-compress-jobs.js';
import { handleOther } from './playlist-handler.js';

// ------------------------------------------------------------ segments
export const segmentResponse = (body, type = 'video/mp2t') =>
  new Response(body, { status: 200, headers: { 'Content-Type': type } });

// In "Whole VOD" mode, or in "Parts ahead of me" once the player's position is
// known and this part is ahead of it, save the sound from the bytes just fetched.
export const canSaveFetched = (seg) =>
  !!(savingOn(seg.job) && !seg.job.saved.has(seg.num) &&
    (saveMode() === 'whole' || (seg.job.position !== undefined && !seg.played && !notAhead(seg.job, seg))));

// Downloads the muted segment and puts `audio` into it (MP4 VOD: `ownInit`
// is the init file of the quality being watched).
export async function spliced(seg, input, init, audio, ownInit) {
  const muted = await realFetch.call(scope, requestFor(seg.urls.muted, input), init);
  if (!muted.ok) return { res: muted, ok: false };
  const mb = new Uint8Array(await muted.arrayBuffer());
  if (seg.job.mp4) {
    const out = audio && ownInit && spliceMp4Audio(mb, ownInit, audio);
    return { res: segmentResponse(out || mb, 'video/mp4'), ok: !!out };
  }
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
        const save = canSaveFetched(seg);
        if (save) r.clone().arrayBuffer().then((b) => saveFromBytes(seg, new Uint8Array(b), job.dir)).catch(() => {});
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
      let audio, ownInit = null;
      if (job.mp4) {
        ownInit = await loadInit(job, job.dir);
        const saved = ownInit && await recordToFrames(await loadRecord(job.vodKey, seg.num));
        audio = saved && adtsToMp4Audio(saved.frames, saved.pts, ownInit);
      } else audio = await loadSaved(job.vodKey, seg.num);
      if (audio) {
        const { res, ok } = await spliced(seg, input, init, audio, ownInit);
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
  if (donors.length) steps.push(`other qualities asked at once: ${donors.map((s, i) => `${prettyQuality(s.split('/')[0])} ${found[i] ? 'found' : found[i] === false ? 'deleted' : 'no answer'}`).join(', ')}`);
  if (donor) {
    try {
      const other = await realFetch.call(scope, requestFor(urlFor(seg, donor), input), init);
      if (other.ok) {
        const ob = new Uint8Array(await other.arrayBuffer());
        let audio, ownInit = null;
        if (job.mp4) {
          const inits = await Promise.all([loadInit(job, job.dir), loadInit(job, donor.split('/')[0])]);
          ownInit = inits[0];
          audio = inits[1] && extractMp4Audio(ob, inits[1]);
        } else audio = extractAudio(ob);
        const { res, ok } = await spliced(seg, input, init, audio, ownInit);
        if (ok) {
          confirm(seg, donor);
          const save = canSaveFetched(seg);
          if (save) saveFromBytes(seg, ob, donor.split('/')[0]);
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
