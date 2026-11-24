// Shared by popup/popup.js and popup/welcome.js: parses a Twitch channel input
// ("name", "@name", or a twitch.tv link), checks that it exists on Twitch, and
// adds it to the auto-save list.
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

function parseChannelLogin(raw) {
  const text = String(raw || '').trim();
  const login = (text.match(/twitch\.tv\/([A-Za-z0-9_]+)/) || [null, text.replace(/^@/, '')])[1].toLowerCase();
  return /^[a-z0-9_]{2,25}$/.test(login) ? login : null;
}

async function checkTwitchChannel(login) {
  try {
    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST', headers: { 'Client-ID': TWITCH_CLIENT_ID },
      body: JSON.stringify({ query: `query { user(login: ${JSON.stringify(login)}) { login } }` }),
    }).then((x) => x.json());
    return !!(r.data && r.data.user);
  } catch (e) {
    return true; // offline: add it anyway
  }
}

function bindChannelForm({ api, form, input, error, onAdded }) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const login = parseChannelLogin(input.value);
    if (!login) {
      error.textContent = 'That doesn\'t look like a Twitch channel name.';
      error.hidden = false;
      return;
    }
    if (!(await checkTwitchChannel(login))) {
      error.textContent = `No Twitch channel called "${login}".`;
      error.hidden = false;
      return;
    }
    const { autoChannels } = await api.storage.sync.get({ autoChannels: [] });
    if (!autoChannels.includes(login)) await api.storage.sync.set({ autoChannels: autoChannels.concat(login) });
    input.value = '';
    if (onAdded) onAdded(login);
    api.runtime.sendMessage({ vu: 'autoCheckNow' }).catch(() => {});
  });
}

globalThis.parseChannelLogin = parseChannelLogin;
globalThis.bindChannelForm = bindChannelForm;
