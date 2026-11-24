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
//
// The code is split into modules (src/shared, src/media, src/storage,
// src/recovery, src/player, src/messaging). This file is the template that
// puts them together: `node build.mjs` replaces each "// @include" line with
// that module (without its import/export keywords), so the extension loads
// ONE plain script, dist/*/src/hook.js. Nothing is minified or renamed.
(() => {
  'use strict';
  if (window.__vodUnmuterLoaded) return;
  window.__vodUnmuterLoaded = true;

  // ---------------------------------------------------------------------------
  // Self-contained: it is also stringified and injected into Twitch's video
  // player Web Worker, which is where playlists and segments are downloaded.
  // Every module included here shares this one function scope.
  // ---------------------------------------------------------------------------
  function installUnmuteHook(scope) {
    if (scope.__vodUnmuterHooked) return;
    scope.__vodUnmuterHooked = true;

    // @include shared/constants.js
    // @include shared/state.js
    // @include shared/logger.js
    // @include media/transport-stream.js
    // @include media/adts-muxer.js
    // @include media/aac-compression.js
    // @include media/fragmented-mp4.js
    // @include storage/idb.js
    // @include storage/gone-cache.js
    // @include storage/saved-audio.js
    // @include recovery/probe-resolver.js
    // @include recovery/recovery-state.js
    // @include recovery/scan-scheduler.js
    // @include recovery/save-compress-jobs.js
    // @include player/playlist-handler.js
    // @include player/channel-handler.js
    // @include player/segment-handler.js

    // Only the page uses these (the popup's saved list, backups, auto-save):
    // they are cut out of the copy sent to the player worker (see below).
    /* vu:page-only:start */
    // @include storage/backup.js
    // @include recovery/auto-save.js
    /* vu:page-only:end */

    scope.__vodUnmuterDebug = { jobs, renditions, scanTs, extractAudio, spliceAudio, readMp4Init, extractMp4Audio, spliceMp4Audio, mp4AudioToAdts, adtsToMp4Audio, recordToFrames, listSaved, loadRecord, recordToAudio, muxAdts, splitAdts, packetsToAdts, encoderDelay };
  }

  // 1) Hook the page itself (in case the player ever runs without a worker).
  // Id of this tab, shared with the copies of the hook in its player workers
  // (prepended to their code below) and with ui.js.
  window.__vodUnmuterTab = window.__vodUnmuterTab || Math.random().toString(36).slice(2, 10);
  installUnmuteHook(window);

  // The player worker's copy: the same function without its page-only part,
  // and this tab's id.
  const workerHook = installUnmuteHook.toString()
    .replace(/\/\* vu:page-only:start \*\/[\s\S]*?\/\* vu:page-only:end \*\//g, '');
  const hookSource = 'self.__vodUnmuterTab = ' + JSON.stringify(window.__vodUnmuterTab) + ';\n' +
    '(' + workerHook + ')(self);\n';

  // @include player/worker-injection.js
  hookPlayerWorkers(hookSource);

  // @include messaging/page-bridge.js
  startPageBridge();
})();
