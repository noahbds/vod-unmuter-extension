// First-run page: sets expectations (the 13 to 32 hour window) and lets the
// user add auto-save channels right away.
const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function showChannels() {
  const { autoChannels } = await api.storage.sync.get({ autoChannels: [] });
  $('channels').textContent = autoChannels.length ? `Auto-saving: ${autoChannels.join(', ')}` : 'No channels yet.';
}

$('addChannel').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('channelError');
  err.hidden = true;
  const raw = $('channelInput').value.trim();
  const login = (raw.match(/twitch\.tv\/([A-Za-z0-9_]+)/) || [null, raw.replace(/^@/, '')])[1].toLowerCase();
  if (!/^[a-z0-9_]{2,25}$/.test(login)) { err.textContent = 'That doesn\'t look like a Twitch channel name.'; err.hidden = false; return; }
  try {
    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST', headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko' },
      body: JSON.stringify({ query: `query { user(login: ${JSON.stringify(login)}) { login } }` }),
    }).then((x) => x.json());
    if (!r.data || !r.data.user) { err.textContent = `No Twitch channel called "${login}".`; err.hidden = false; return; }
  } catch (x) { /* offline: add it anyway */ }
  const { autoChannels } = await api.storage.sync.get({ autoChannels: [] });
  if (!autoChannels.includes(login)) await api.storage.sync.set({ autoChannels: autoChannels.concat(login) });
  $('channelInput').value = '';
  showChannels();
  api.runtime.sendMessage({ vu: 'autoCheckNow' }).catch(() => {});
});

(async () => {
  try {
    const ok = typeof AudioEncoder === 'function' && (await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000, aac: { format: 'adts' } })).supported;
    $('firefoxNote').hidden = !!ok;
  } catch (e) { $('firefoxNote').hidden = false; }
})();
showChannels();
