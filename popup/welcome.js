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
  try {
    const ok = typeof AudioEncoder === 'function' && (await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000, aac: { format: 'adts' } })).supported;
    $('firefoxNote').hidden = !!ok;
  } catch (e) { $('firefoxNote').hidden = false; }
})();
showChannels();
