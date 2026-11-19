// Runs in the extension's isolated world. Three jobs:
//  - hand the popup's settings to the page scripts (hook.js / ui.js);
//  - relay the popup's "saved audio" requests (list / delete) to the page,
//    because saved audio lives in twitch.tv's own browser storage;
//  - run auto-saves asked for by the background script (background.js).
(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const DEFAULTS = { enabled: true, badge: true, recolor: true, saveAudio: true, saveMode: 'whole', keepDays: 60, saveQuality: 'high', maxStorageMB: 1000 };

  async function send() {
    let settings = DEFAULTS;
    try { settings = await api.storage.sync.get(DEFAULTS); } catch (e) { /* use defaults */ }
    window.postMessage({ source: 'vod-unmuter-bridge', settings }, location.origin);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.source === 'vod-unmuter-page' && ev.data.type === 'getSettings') send();
  });
  api.storage.onChanged.addListener((changes, area) => { if (area === 'sync') send(); });
  send();

  if (window !== window.top) return; // only the main page answers the extension

  // Ask the page (MAIN world) something and wait for its answer.
  function askPage(request, timeoutMs) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const done = (reply) => {
        window.removeEventListener('message', onReply);
        clearTimeout(timer);
        resolve(reply);
      };
      const onReply = (ev) => {
        const d = ev.data;
        if (ev.source === window && d && d.source === 'vod-unmuter-page' && d.type === 'storageReply' && d.id === id) done(d.reply);
      };
      const timer = setTimeout(() => done({ error: 'timeout' }), timeoutMs);
      window.addEventListener('message', onReply);
      window.postMessage({ source: 'vod-unmuter-bridge', request: Object.assign({ id }, request) }, location.origin);
    });
  }

  let autoBusy = false;
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return undefined;

    // Popup: list / delete saved audio.
    if (msg.vu === 'storage') {
      askPage({ action: msg.action, vodKey: msg.vodKey }, 8000).then(sendResponse);
      return true; // answer asynchronously
    }

    // Background: save these VODs. Answer at once, then report each VOD and
    // the end as separate messages (saving can take minutes).
    if (msg.vu === 'autosave') {
      if (autoBusy) { sendResponse({ accepted: false, busy: true }); return undefined; }
      autoBusy = true;
      sendResponse({ accepted: true });
      (async () => {
        for (const vodId of msg.vodIds || []) {
          const result = await askPage({ action: 'autosave', vodId }, 30 * 60 * 1000);
          try { await api.runtime.sendMessage({ vu: 'autosaveDone', result: Object.assign({ vodId }, result) }); } catch (e) { /* background asleep */ }
        }
        autoBusy = false;
        try { await api.runtime.sendMessage({ vu: 'autosaveFinished' }); } catch (e) { /* ignore */ }
      })();
      return undefined;
    }
    return undefined;
  });
})();
