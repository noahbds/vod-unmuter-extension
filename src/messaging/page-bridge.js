// Page only: runs outside installUnmuteHook, so it is never sent to the
// player worker.
const CHANNEL_NAME = 'vod-unmuter';

// 3) Talk to the extension (bridge.js, isolated world): settings go to every
//    hook instance and the UI; the popup's storage requests are answered
//    here, since only the page can reach twitch.tv's saved audio.
export function startPageBridge() {
  let lastSettings = null;
  let relay = null;
  try { relay = new BroadcastChannel(CHANNEL_NAME); } catch (e) { /* unsupported */ }
  if (relay) {
    relay.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'hello' && lastSettings) {
        relay.postMessage({ type: 'settings', settings: lastSettings });
      }
    });
  }

  async function answerStorage(request) {
    const store = window.__vodUnmuterStore;
    if (!store) return { error: 'unavailable' };
    const forgetMany = async (keys) => {
      if (!keys.length) return;
      if (relay) for (const vodKey of keys) relay.postMessage({ type: 'deleteSaved', vodKey });
      await (store.removeMany ? store.removeMany(keys) : Promise.all(keys.map((k) => store.remove(k))));
    };
    if (request.action === 'diag') {
      return window.__vodUnmuterDiag ? window.__vodUnmuterDiag() : { text: 'The extension\'s page script is not loaded.', problems: ['page script not loaded'] };
    }
    if (request.action === 'compress') {
      const stats = await store.compressSaved(request.vodKeys || null, request.quality);
      let usage = null;
      try { usage = await navigator.storage.estimate(); } catch (e) { /* ignore */ }
      return { vods: await store.list(), quota: usage && usage.quota, compressed: stats };
    }
    if (request.action === 'autosave') {
      const auto = window.__vodUnmuterAuto;
      return auto ? auto.save(request.vodId, request.meta || request.title) : { vodId: request.vodId, ok: false, error: 'unavailable' };
    }
    if (request.action === 'delete' && request.vodKey) await forgetMany([request.vodKey]);
    else if (request.action === 'deleteBatch' && Array.isArray(request.vodKeys)) await forgetMany(request.vodKeys);
    else if (request.action === 'deleteAll') await forgetMany((await store.list()).map((v) => v.vod));
    else if (request.action === 'deleteChannel' && request.channel) {
      await forgetMany((await store.list()).filter((v) => v.channel === request.channel && !v.pinned).map((v) => v.vod));
    } else if (request.action === 'pin' && request.vodKey) {
      await store.pin(request.vodKey, request.pinned);
      if (relay) relay.postMessage({ type: 'pinState', vodKey: request.vodKey, pinned: !!request.pinned });
    }
    let usage = null;
    try { usage = await navigator.storage.estimate(); } catch (e) { /* ignore */ }
    return { vods: await store.list(), quota: usage && usage.quota };
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'vod-unmuter-bridge') return;
    if (ev.data.settings) {
      lastSettings = ev.data.settings;
      if (relay) relay.postMessage({ type: 'settings', settings: lastSettings });
    }
    if (ev.data.request) {
      let reply;
      try { reply = await answerStorage(ev.data.request); } catch (e) { reply = { error: String(e) }; }
      window.postMessage({ source: 'vod-unmuter-page', type: 'storageReply', id: ev.data.request.id, reply }, location.origin);
    }
  });
  window.postMessage({ source: 'vod-unmuter-page', type: 'getSettings' }, '*');
}
