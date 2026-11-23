// Hook module (page and player worker): see src/hook.js. Pure: no state, no browser APIs.

export const TAG = '[VOD Unmuter]';
export const CHANNEL = 'vod-unmuter';

export const PLAYING_MS = 10 * 60 * 1000; // "playing" = downloaded a segment of it in the last 10 min

// For log lines. A job: "<channel> <stream day> · <quality>", e.g.
// "squeezie 2026-11-22 · Source". A muted part: its number and where it is in
// the VOD, e.g. "part 242 (40:20–40:30)".
export const jobName = (job) => {
  const t = Number(job.vodKey.split('_').pop());
  const day = t > 1e9 ? ' ' + new Date(t * 1000).toISOString().slice(0, 10) : '';
  return `${job.vodKey.split('_').slice(1, -2).join('_') || job.vodKey.slice(0, 8)}${day} · ${prettyQuality(job.dir)}`;
};
export const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  const two = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
};
export const partName = (seg) => `part ${seg.num} (${fmtTime(seg.start)}–${fmtTime(seg.start + seg.duration)})`;
// Where some parts are, as stretches of the VOD: "2:06:31–2:09:11 (6 parts),
// 5:00:00–5:00:10 (1 part)", at most `max` of them.
export const stretches = (segs, max = 6) => {
  const runs = [];
  for (const s of segs.slice().sort((a, b) => a.start - b.start)) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(last.end - s.start) < 0.5) { last.end = s.start + s.duration; last.n++; } else runs.push({ start: s.start, end: s.start + s.duration, n: 1 });
  }
  const text = runs.slice(0, max).map((r) => `${fmtTime(r.start)}–${fmtTime(r.end)} (${r.n} part${r.n > 1 ? 's' : ''})`).join(', ');
  return runs.length > max ? `${text} and ${runs.length - max} more stretches` : text;
};
// The same for a part known only by its number.
export const partOf = (job, num) => {
  const seg = job.segs.find((s) => s.num === num);
  return seg ? partName(seg) : `part ${num}`;
};
// A file a muted part's sound can come from, e.g. 'Source original file',
// '720p60 "-unmuted" backup' (source: see probe-resolver.js).
export const fileLabel = (job, source) => {
  if (source === 'saved') return 'copy saved on this computer';
  const slash = source.indexOf('/');
  const dir = slash < 0 ? job.dir : source.slice(0, slash);
  const file = slash < 0 ? source : source.slice(slash + 1);
  return `${prettyQuality(dir)} ${file === '-unmuted.ts' ? '"-unmuted" backup' : 'original file'}`;
};
export const SUFFIXES = ['.ts', '-unmuted.ts']; // where the original audio can live
export const MUTED_RE = /^(.*?)(\d+)-muted\.ts(\?.*)?$/;
export const MAX_PARALLEL = 48;   // background checks (tiny requests, HTTP/2; measured: 14 s -> 10 s)
export const SAVE_PARALLEL = 8;    // background downloads for saving (measured: 76 s -> 32 s for 253)
// Used only if the master playlist was not seen. Best quality first.
export const FALLBACK_DIRS = ['chunked', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30'];

export const AHEAD_MIN_PLAY = 20; // seconds of playback before a new position counts
export const isBehind = (job, s) => !!job.behind && s.start + s.duration <= job.behind;
// Not worth saving now: behind the confirmed position, or behind where the
// player is right now (if you rewind, those parts are saved then).
export const notAhead = (job, s) => isBehind(job, s) || (job.position !== undefined && s.start + s.duration <= job.position);
export const POSITION_WAIT_MS = 15000; // "ahead of me" waits this long for the player's position

export const isMiss = (status) => status === 403 || status === 404 || status === 410;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const requestFor = (url, input) =>
  (typeof input === 'string' || input instanceof URL || !input) ? url : new Request(url, input);
export const prettyQuality = (dir) => (dir === 'chunked' ? 'Source' : dir);

export const SAMPLE_SIZE = 24;
// Twitch deletes original files 13 to 32 hours after the stream ends
// (measured on 81 VODs), so this is a hint for the early verdict.
export const ALL_GONE_AFTER_H = 32;
// Past this, with nothing found in the sample, the rest isn't checked one
// by one: none of the 71 VODs we measured that ended more than 32 hours
// ago had any original left. A part that is played is still checked then.
export const SKIP_REST_AFTER_H = 36;
