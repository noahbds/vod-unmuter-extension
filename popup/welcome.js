// First-run page: sets expectations (the 13 to 32 hour window) and lets the
// user add auto-save channels right away.
const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function showChannels() {
  const { autoChannels } = await api.storage.sync.get({ autoChannels: [] });
  $('channels').textContent = autoChannels.length ? `Auto-saving: ${autoChannels.join(', ')}` : 'No channels yet.';
}

bindChannelForm({
  api,
  form: $('addChannel'),
  input: $('channelInput'),
  error: $('channelError'),
  onAdded: showChannels,
});

(async () => {
  $('firefoxNote').hidden = await checkAacSupport();
})();
showChannels();
