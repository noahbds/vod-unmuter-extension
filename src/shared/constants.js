// Hook module (page and player worker): see src/hook.js. Pure: no state, no browser APIs.

export const TAG = '[VOD Unmuter]';
export const CHANNEL = 'vod-unmuter';

export const PLAYING_MS = 10 * 60 * 1000; // "playing" = downloaded a segment of it in the last 10 min

// Short name of a job for log lines: "<channel> · <quality>".
export const jobName = (job) => `${job.vodKey.split('_').slice(1, -2).join('_') || job.vodKey.slice(0, 8)} · ${job.dir}`;
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
