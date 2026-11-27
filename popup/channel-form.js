// Shared by popup/popup.js and popup/welcome.js: parses one or more Twitch
// channel inputs ("name", "@name", twitch.tv links, or comma/newline lists),
// checks them in one batched GQL request, and probes WebCodecs AAC support.
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

function parseChannelLogin(raw) {
  const text = String(raw || '').trim();
  const login = (text.match(/twitch\.tv\/([A-Za-z0-9_]+)/) || [null, text.replace(/^@/, '')])[1].toLowerCase();
  return /^[a-z0-9_]{2,25}$/.test(login) ? login : null;
}

function parseChannelLogins(raw) {
  const tokens = String(raw || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const valid = [];
  const invalid = [];
  for (const tok of tokens) {
    const login = parseChannelLogin(tok);
    if (!login) invalid.push(tok);
    else if (!valid.includes(login)) valid.push(login);
  }
  return { valid, invalid };
}

async function checkTwitchChannels(logins) {
  if (!logins.length) return { found: [], missing: [] };
  try {
    const query = 'query {\n' + logins.map((l, i) => `u${i}: user(login: ${JSON.stringify(l)}) { login }`).join('\n') + '\n}';
    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST', headers: { 'Client-ID': TWITCH_CLIENT_ID },
      body: JSON.stringify({ query }),
    }).then((x) => x.json());
    if (!r || !r.data) return { found: logins, missing: [] };
    const found = [], missing = [];
    logins.forEach((l, i) => (r.data['u' + i] ? found : missing).push(l));
    return { found, missing };
  } catch (e) {
    return { found: logins, missing: [] }; // offline: add them anyway
  }
}

async function checkAacSupport() {
  if (typeof AudioEncoder !== 'function') return false;
  const base = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 };
  for (const cfg of [Object.assign({}, base, { aac: { format: 'adts' } }), base]) {
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return true; } catch (e) { /* try next */ }
  }
  return false;
}

function bindChannelForm({ api, form, input, error, onAdded }) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const { valid, invalid } = parseChannelLogins(input.value);
    if (!valid.length) {
      error.textContent = 'That doesn\'t look like a Twitch channel name.';
      error.hidden = false;
      return;
    }
    const { found, missing } = await checkTwitchChannels(valid);
    if (found.length) {
      const { autoChannels } = await api.storage.sync.get({ autoChannels: [] });
      const merged = [...new Set(autoChannels.concat(found))];
      if (merged.length !== autoChannels.length) await api.storage.sync.set({ autoChannels: merged });
      if (onAdded) onAdded(found[0]);
      api.runtime.sendMessage({ vu: 'autoCheckNow' }).catch(() => {});
    }
    if (missing.length || invalid.length) {
      const bad = missing.concat(invalid);
      error.textContent = bad.length === 1 ? `No Twitch channel called "${bad[0]}".` : `Not found on Twitch: ${bad.join(', ')}.`;
      error.hidden = false;
      if (found.length) input.value = bad.join(', ');
      return;
    }
    input.value = '';
  });
}

globalThis.TWITCH_CLIENT_ID = TWITCH_CLIENT_ID;
globalThis.parseChannelLogin = parseChannelLogin;
globalThis.parseChannelLogins = parseChannelLogins;
globalThis.checkTwitchChannels = checkTwitchChannels;
globalThis.checkAacSupport = checkAacSupport;
globalThis.bindChannelForm = bindChannelForm;
