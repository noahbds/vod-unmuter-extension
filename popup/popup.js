const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = { enabled: true, badge: true, recolor: true, saveAudio: true, saveMode: 'whole', keepDays: 60, saveQuality: 'high', maxStorageMB: 1000 };
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
    row.querySelectorAll('select').forEach((s) => { s.disabled = !on; });
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

loadSettings();
loadSaved();
