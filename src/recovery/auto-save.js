// Hook module, page only (cut out of the player worker's copy): see src/hook.js.

import { IS_PAGE, realFetch, segments } from '../shared/state.js';
import { log } from '../shared/logger.js';
import { jobs } from './recovery-state.js';
import { compressJob, maybeSaveAll } from './save-compress-jobs.js';
import { readMaster, rewritePlaylist } from '../player/playlist-handler.js';

if (IS_PAGE) scope.__vodUnmuterAuto = { save: (vodId, title) => autoSave(vodId, title) };

// ------------------------------------------------------------ auto-save
// Saves a VOD's muted parts without playing it (for the channels in the
// popup's auto-save list). Runs in a twitch.tv page, because that's where
// saved audio lives and where the viewer is logged in.
export async function autoSave(vodId, title) {
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
    job.vodId = String(vodId);
    if (title) job.title = String(title);
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
