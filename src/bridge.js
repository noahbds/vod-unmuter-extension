// Runs in the extension's isolated world. Reads the popup settings from
// extension storage and hands them to the page scripts (hook.js / ui.js).
(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const DEFAULTS = { enabled: true, badge: true, recolor: true };

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
})();
