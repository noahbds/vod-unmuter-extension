// Page only: runs outside installUnmuteHook, so it is never sent to the
// player worker. `hookSource` is the code to prepend (see src/hook.js).
//
// 2) Get the same hook to run first inside Twitch's player worker. (The
//    player binds `self.fetch` when it starts, so the hook must already be
//    in place: it is prepended to the worker's code.) Two ways, because
//    other extensions (ad blockers, etc.) also replace `Worker`, and
//    depending on which loads first, theirs can start the player without
//    going through ours:
//    a. when the player's code is put in a Blob (Twitch, and most
//       extensions, create the worker from a Blob): works whatever the
//       order of the extensions;
//    b. when a Worker is created from anything else.
export function hookPlayerWorkers(hookSource) {
  const MARK = '__vodUnmuterHooked';
  const isPlayerWorkerCode = (text) => /amazon-ivs-wasmworker|wasmworker\.min/.test(text);

  // The text of Blobs made from strings, remembered so that (b) doesn't have
  // to read a worker's code back with a synchronous request (slow, and a
  // console warning in Firefox).
  const blobText = new WeakMap(); // Blob -> its text
  const urlText = new Map();      // blob: URL -> its text

  const OriginalBlob = window.Blob;
  window.Blob = class extends OriginalBlob {
    constructor(parts, options) {
      let text = null;
      try {
        if (Array.isArray(parts) && parts.length && parts.every((p) => typeof p === 'string')) {
          text = parts.join('');
          if (isPlayerWorkerCode(text) && !text.includes(MARK)) { parts = [hookSource].concat(parts); text = hookSource + text; }
        }
      } catch (e) { text = null; /* leave it as it was */ }
      super(parts, options);
      if (text !== null) blobText.set(this, text);
    }
  };

  const originalCreateURL = URL.createObjectURL;
  const originalRevokeURL = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    const url = originalCreateURL.call(URL, obj);
    try { if (obj && blobText.has(obj)) urlText.set(url, blobText.get(obj)); } catch (e) { /* ignore */ }
    return url;
  };
  URL.revokeObjectURL = function (url) {
    urlText.delete(url);
    return originalRevokeURL.call(URL, url);
  };

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
            let text = urlText.get(src);
            if (text === undefined) {
              // A Blob we didn't see being made: read its code back.
              const xhr = new XMLHttpRequest();
              xhr.open('GET', src, false);
              xhr.overrideMimeType('text/javascript'); // (else Firefox tries to parse it as XML)
              xhr.send();
              text = xhr.responseText;
            }
            // Already hooked by (a)? Then leave it alone.
            code = text.includes(MARK) ? null : hookSource + text;
          } else {
            code = hookSource + 'importScripts(' + JSON.stringify(new URL(src, location.href).href) + ');';
          }
          if (code) finalURL = URL.createObjectURL(new OriginalBlob([code], { type: 'text/javascript' }));
        }
      } catch (e) {
        console.warn('[VOD Unmuter] could not wrap worker, using the original', e);
        finalURL = scriptURL;
      }
      super(finalURL, options);
    }
  };
}
