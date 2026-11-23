// Runs in the extension's isolated world. Three jobs:
//  - hand the popup's settings to the page scripts (hook.js / ui.js);
//  - relay the popup's "saved audio" requests (list / delete) to the page,
//    because saved audio lives in twitch.tv's own browser storage;
//  - run auto-saves asked for by the background script (background.js).
(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const DEFAULTS = { enabled: true, badge: true, recolor: true, saveAudio: true, saveMode: 'whole', keepDays: 60, saveQuality: 'high', maxStorageMB: 1000, debug: false, autoChannels: [] };

  async function send() {
    let settings = DEFAULTS;
    try { settings = await api.storage.sync.get(DEFAULTS); } catch (e) { /* use defaults */ }
    let version = '';
    try { version = api.runtime.getManifest().version; } catch (e) { /* ignore */ }
    window.postMessage({ source: 'vod-unmuter-bridge', settings: Object.assign({}, settings, { version }) }, location.origin);
  }

  // The counter's panel offers to auto-save the channel of a VOD whose
  // originals are already gone.
  async function addAutoChannel(login) {
    if (!/^[a-z0-9_]{2,25}$/.test(login)) return;
    const { autoChannels } = await api.storage.sync.get({ autoChannels: [] });
    if (!autoChannels.includes(login)) await api.storage.sync.set({ autoChannels: autoChannels.concat(login) });
    try { await api.runtime.sendMessage({ vu: 'autoCheckNow' }); } catch (e) { /* background asleep */ }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'vod-unmuter-page') return;
    if (ev.data.type === 'getSettings') send();
    if (ev.data.type === 'addAutoChannel' && typeof ev.data.login === 'string') addAutoChannel(ev.data.login.toLowerCase());
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

  // A copy of the saved-VOD list in the extension's storage, so the menu can
  // show it even when no Twitch tab is open (the audio itself stays here).
  function cacheList(reply) {
    if (!reply || !Array.isArray(reply.vods) || location.hostname !== 'www.twitch.tv') return;
    const vods = reply.vods.map((v) => ({ vod: v.vod, channel: v.channel, streamedAt: v.streamedAt, savedAt: v.savedAt,
      segments: v.segments, bytes: v.bytes, muted: v.muted, restorable: v.restorable, pinned: !!v.pinned }));
    api.storage.local.set({ savedCache: { at: Date.now(), vods, quota: reply.quota || null } }).catch(() => {});
  }
  if (location.hostname === 'www.twitch.tv') setTimeout(() => askPage({ action: 'list' }, 8000).then(cacheList), 4000);

  let autoBusy = false;
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return undefined;

    // Popup: list / delete saved audio.
    if (msg.vu === 'storage') {
      askPage({ action: msg.action, vodKey: msg.vodKey, channel: msg.channel, pinned: msg.pinned }, msg.action === 'diag' ? 4000 : 8000)
        .then((reply) => { cacheList(reply); sendResponse(reply); });
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
