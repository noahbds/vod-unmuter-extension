const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = { enabled: true, badge: true, recolor: true, saveAudio: true, saveMode: 'whole', keepDays: 60, saveQuality: 'high', maxStorageMB: 1000, autoOpenTab: true };
const NUMBERS = ['keepDays', 'maxStorageMB'];
const TWITCH_TABS = ['https://www.twitch.tv/*', 'https://m.twitch.tv/*'];
const $ = (id) => document.getElementById(id);

const QUALITY_HELP = {
  original: 'Lossless: 1.1 to 2.4 MB per muted minute, depending on the stream',
  high: '96 kbps, about 0.75 MB per muted minute',
  small: '64 kbps, about 0.5 MB per muted minute',
};
const MODE_HELP = {
  whole: 'Every muted part that can still be unmuted, in the background',
  watched: 'Only the parts you actually play: less download, but unwatched parts are lost',
};

// ------------------------------------------------------------------ settings
async function loadSettings() {
  const settings = await api.storage.sync.get(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    const el = $(key);
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = String(settings[key]);
    el.addEventListener('change', async () => {
      const value = el.type === 'checkbox' ? el.checked
        : NUMBERS.includes(key) ? Number(el.value) : el.value;
      await api.storage.sync.set({ [key]: value });
      if (el.hasAttribute('data-reload')) $('note').hidden = false;
      refreshDependents();
      if (NUMBERS.includes(key)) setTimeout(loadSaved, 300); // old saves may be removed
    });
  }
  refreshDependents();
}

function refreshDependents() {
  const on = $('saveAudio').checked;
  document.querySelectorAll('[data-needs="saveAudio"]').forEach((row) => {
    row.classList.toggle('off', !on);
    row.querySelectorAll('select, input, button').forEach((s) => { s.disabled = !on; });
  });
  $('saveModeHelp').textContent = MODE_HELP[$('saveMode').value];
  $('saveQualityHelp').textContent = QUALITY_HELP[$('saveQuality').value];
}

// ---------------------------------------------------------------- saved audio
// Saved audio lives in twitch.tv's own storage, so ask an open Twitch tab.
async function ask(action, vodKey) {
  const tabs = await api.tabs.query({ url: TWITCH_TABS });
  if (!tabs.length) return { noTab: true };
  tabs.sort((a, b) => (b.active - a.active) || (a.url.includes('www.') ? -1 : 1));
  for (const tab of tabs) {
    try {
      const reply = await api.tabs.sendMessage(tab.id, { vu: 'storage', action, vodKey }, { frameId: 0 });
      if (reply && !reply.error) return reply;
    } catch (e) { /* tab not ready: try the next one */ }
  }
  return { error: true };
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v);
  });
  children.flat(Infinity).forEach((c) => c != null && node.append(c instanceof Node ? c : String(c)));
  return node;
}

function render(reply) {
  const box = $('saved');
  box.replaceChildren();
  $('deleteAll').hidden = true;

  if (reply.noTab) {
    box.append(el('p', { class: 'muted' }, 'Open any Twitch page to see and manage saved audio.'));
    return;
  }
  if (reply.error) {
    box.append(el('p', { class: 'muted' }, 'Could not reach the Twitch tab. Reload it and try again.'));
    return;
  }
  const vods = (reply.vods || []).sort((a, b) => b.savedAt - a.savedAt);
  if (!vods.length) {
    box.append(el('p', { class: 'muted' }, $('saveAudio').checked
      ? 'Nothing saved yet. Open a VOD within a day of the stream and its muted parts are saved automatically.'
      : 'Nothing saved.'));
    return;
  }
  for (const v of vods) {
    box.append(el('div', { class: 'vod' },
      el('div', null,
        el('b', null, v.channel || 'Unknown channel'),
        el('small', null, ` · streamed ${v.streamedAt ? day(v.streamedAt) : '?'}`),
        el('br'),
        el('small', null, `${v.segments} segments · ${mb(v.bytes)} · saved ${day(v.savedAt)}`)),
      el('button', {
        type: 'button', class: 'icon', title: 'Delete this saved audio', 'aria-label': `Delete saved audio for ${v.channel}`,
        onclick: async () => render(await ask('delete', v.vod)),
      }, '✕')));
  }
  const total = vods.reduce((n, v) => n + v.bytes, 0);
  const limit = Number($('maxStorageMB').value) * 1e6;
  box.append(el('div', { class: 'total' },
    el('b', null, mb(total)), ` for ${vods.length} VOD${vods.length > 1 ? 's' : ''}`,
    limit ? ` · limit ${limit >= 1e9 ? limit / 1e9 + ' GB' : mb(limit)}` : ' · no limit'));
  if (limit) {
    const pct = Math.min(100, Math.round((total / limit) * 100));
    box.append(el('div', { class: 'meter', role: 'img', 'aria-label': `${pct}% of the storage limit used` },
      el('div', { style: `width:${pct}%` })));
  }
  $('deleteAll').hidden = false;
}

async function loadSaved() {
  render(await ask('list'));
}

$('deleteAll').addEventListener('click', async () => {
  if (!confirm('Delete all saved audio? VODs whose originals Twitch already deleted will be muted again.')) return;
  render(await ask('deleteAll'));
});

// Export / import happen on a twitch.tv page, where the saved audio lives.
$('backup').addEventListener('click', () => {
  api.tabs.create({ url: 'https://www.twitch.tv/robots.txt#vod-unmuter-backup' });
  window.close();
});

// ------------------------------------------------------------ auto-save
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 6e4);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

async function renderChannels() {
  const { autoChannels } = await api.storage.sync.get({ autoChannels: [] });
  const { autoState } = await api.storage.local.get({ autoState: { vods: {}, channels: {} } });
  const box = $('channels');
  box.replaceChildren();
  if (!autoChannels.length) {
    box.append(el('p', { class: 'muted' }, 'No channels yet.'));
  }
  for (const login of autoChannels) {
    const ch = autoState.channels[login] || {};
    const vods = Object.entries(autoState.vods || {})
      .filter(([, v]) => v.channel === login)
      .sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt));
    const latest = vods[0] && vods[0][1];
    let status;
    if (ch.error) status = el('small', { class: 'status-bad' }, ch.error);
    else if (!ch.lastCheck) status = el('small', null, 'Not checked yet');
    else if (!latest) status = el('small', null, `No recent VOD · checked ${ago(ch.lastCheck)}`);
    else if (latest.running) status = el('small', { class: 'status-run' }, `Saving ${latest.live ? 'the live stream' : 'the latest VOD'}…`);
    else if (latest.error) status = el('small', { class: 'status-bad' }, latest.error);
    else if (latest.lastRun) {
      status = el('small', { class: latest.saved >= latest.restorable ? 'status-ok' : '' },
        latest.muted ? `${latest.live ? 'Live' : 'Latest VOD'}: ${latest.saved}/${latest.restorable} saved` +
          (latest.muted > latest.restorable ? ` (${latest.muted - latest.restorable} already deleted by Twitch)` : '')
          : `${latest.live ? 'Live' : 'Latest VOD'}: nothing muted`,
        ` · ${ago(latest.lastRun)}`);
    } else status = el('small', null, `Waiting to save · checked ${ago(ch.lastCheck)}`);
    box.append(el('div', { class: 'vod' },
      el('div', null, el('b', null, ch.name || login), el('br'), status),
      el('button', {
        type: 'button', class: 'icon', title: 'Stop auto-saving this channel', 'aria-label': `Remove ${login}`,
        onclick: async () => {
          const { autoChannels: list } = await api.storage.sync.get({ autoChannels: [] });
          await api.storage.sync.set({ autoChannels: list.filter((c) => c !== login) });
        },
      }, '✕')));
  }
  $('autoNote').hidden = !autoState.note;
  $('autoNote').textContent = autoState.note || '';
}

$('addChannel').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('channelError');
  err.hidden = true;
  // Accept "name", "@name" or a twitch.tv link.
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
  api.runtime.sendMessage({ vu: 'autoCheckNow' }).catch(() => {});
});

$('checkNow').addEventListener('click', async () => {
  $('checkNow').disabled = true;
  $('checkNow').textContent = 'Checking…';
  try { await api.runtime.sendMessage({ vu: 'autoCheckNow' }); } catch (e) { /* ignore */ }
  $('checkNow').disabled = false;
  $('checkNow').textContent = 'Check now';
  renderChannels();
});

api.storage.onChanged.addListener((changes) => {
  if (changes.autoState || changes.autoChannels) renderChannels();
});

loadSettings();
loadSaved();
renderChannels();
