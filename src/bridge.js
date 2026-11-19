// Runs in the extension's isolated world. Two jobs:
//  - hand the popup's settings to the page scripts (hook.js / ui.js);
//  - relay the popup's "saved audio" requests (list / delete) to the page,
//    because saved audio lives in twitch.tv's own browser storage.
(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const DEFAULTS = { enabled: true, badge: true, recolor: true, saveAudio: true, saveMode: 'whole', keepDays: 60 };

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

  if (window !== window.top) return; // only the main page answers the popup
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.vu !== 'storage') return undefined;
    const id = Math.random().toString(36).slice(2);
    const done = (reply) => {
      window.removeEventListener('message', onReply);
      clearTimeout(timer);
      sendResponse(reply);
    };
    const onReply = (ev) => {
      const d = ev.data;
      if (ev.source === window && d && d.source === 'vod-unmuter-page' && d.type === 'storageReply' && d.id === id) done(d.reply);
    };
    const timer = setTimeout(() => done({ error: 'timeout' }), 8000);
    window.addEventListener('message', onReply);
    window.postMessage({ source: 'vod-unmuter-bridge', request: { id, action: msg.action, vodKey: msg.vodKey } }, location.origin);
    return true; // answer asynchronously
  });
})();
