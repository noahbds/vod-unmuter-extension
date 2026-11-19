const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = { enabled: true, badge: true, recolor: true };

(async () => {
  const settings = await api.storage.sync.get(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    const box = document.getElementById(key);
    box.checked = !!settings[key];
    box.addEventListener('change', async () => {
      await api.storage.sync.set({ [key]: box.checked });
      // The audio hook applies when the playlist loads; the UI updates live.
      if (key === 'enabled') document.getElementById('note').hidden = false;
    });
  }
})();
