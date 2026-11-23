const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = { enabled: true, badge: true, recolor: true, saveAudio: true, saveMode: 'whole', keepDays: 60, saveQuality: 'high', maxStorageMB: 1000, autoOpenTab: true, debug: false, notify: false };
const NUMBERS = ['keepDays', 'maxStorageMB'];
const TWITCH_TABS = ['https://www.twitch.tv/*', 'https://m.twitch.tv/*'];
const $ = (id) => document.getElementById(id);

const QUALITY_HELP = {
  original: 'Lossless, 1.1–2.4 MB per muted minute',
  high: '96 kbps, ≈ 0.75 MB per muted minute',
  small: '64 kbps, ≈ 0.5 MB per muted minute',
};
const MODE_HELP = {
  whole: 'Every muted part, in the background',
  unplayed: 'Parts behind where you are are removed: rewinding may be muted',
};

// ------------------------------------------------------------------ tabs
// The last tab is remembered (a per-viewer convenience: fine to lose).
function showTab(name) {
  for (const b of document.querySelectorAll('nav [role=tab]')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $('panel-' + b.dataset.tab).hidden = !on;
  }
  try { localStorage.setItem('vu-tab', name); } catch (e) { /* storage blocked */ }
}
document.querySelectorAll('nav [role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.querySelector('nav').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('nav [role=tab]')];
  const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  showTab(next.dataset.tab); next.focus();
});
$('statusDot').addEventListener('click', () => showTab('help'));
let firstTab = 'settings';
try { firstTab = localStorage.getItem('vu-tab') || 'settings'; } catch (e) { /* storage blocked */ }
showTab(document.getElementById('panel-' + firstTab) ? firstTab : 'settings');

// ------------------------------------------------------------------ settings
let settingsReady;
const settingsLoaded = new Promise((resolve) => { settingsReady = resolve; });
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
  // "Parts I play" was replaced by "Parts I haven't played".
  if (settings.saveMode === 'watched') {
    $('saveMode').value = 'unplayed';
    await api.storage.sync.set({ saveMode: 'unplayed' });
  }
  refreshDependents();
  settingsReady();
}

// Firefox has no AAC encoder: High and Small can't be made there.
let aac = true;
(async () => {
  try {
    aac = typeof AudioEncoder === 'function' && !!(await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000, aac: { format: 'adts' } })).supported;
  } catch (e) { aac = false; }
  await settingsLoaded;
  if (!aac) {
    // High and Small can't be made here: use Original, and say why.
    for (const o of $('saveQuality').options) {
      if (o.value === 'original') continue;
      o.textContent += ' (not in this browser)';
      o.disabled = true;
    }
    if ($('saveQuality').value !== 'original') {
      $('saveQuality').value = 'original';
      await api.storage.sync.set({ saveQuality: 'original' });
    }
  }
  refreshDependents();
})();

function refreshDependents() {
  const on = $('saveAudio').checked;
  document.querySelectorAll('[data-needs="saveAudio"]').forEach((row) => {
    row.classList.toggle('off', !on);
    row.querySelectorAll('select, input, button').forEach((s) => { s.disabled = !on; });
  });
  document.querySelectorAll('[data-off="saveAudio"]').forEach((x) => { x.hidden = on; });
  $('saveModeHelp').textContent = MODE_HELP[$('saveMode').value];
  $('saveQualityHelp').textContent = !aac
    ? 'Lossless (this browser can\'t compress), 1.1–2.4 MB per muted minute'
    : QUALITY_HELP[$('saveQuality').value];
}

// ---------------------------------------------------------------- saved audio
// Saved audio lives in twitch.tv's own storage, so ask an open Twitch tab.
// Saved audio is kept per site: it lives on www.twitch.tv.
async function ask(action, vodKey, extra) {
  const tabs = await api.tabs.query({ url: ['https://www.twitch.tv/*'] });
  if (!tabs.length) return { noTab: true };
  tabs.sort((a, b) => b.active - a.active);
  for (const tab of tabs) {
    try {
      const reply = await api.tabs.sendMessage(tab.id, Object.assign({ vu: 'storage', action, vodKey }, extra || {}), { frameId: 0 });
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

const BACKUP_URL = 'https://www.twitch.tv/robots.txt#vod-unmuter-backup';

// One line per VOD: "18 nov. · 94 / 108 parts · 19 MB", plus why the rest
// isn't saved when that's known.
const shortDay = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function vodLines(v) {
  const parts = v.muted ? `${v.segments} / ${v.muted} parts` : `${v.segments} parts`;
  const main = `${v.streamedAt ? shortDay(v.streamedAt) : '?'} · ${parts} · ${mb(v.bytes)}`;
  const why = [];
  if (v.muted) {
    const before = v.muted - (v.restorable || 0);
    const notYet = (v.restorable || 0) - v.segments;
    if (before > 0) why.push(`${before} deleted by Twitch before saving`);
    if (notYet > 0) why.push(`${notYet} not saved yet`);
  }
  return { main, why: why.join(' · ') };
}

function render(reply) {
  const box = $('saved');
  const storage = $('storage');
  box.replaceChildren();
  storage.replaceChildren();
  $('deleteAll').hidden = true;
  $('savedCount').textContent = '';
  const readOnly = !!reply.cached;

  if (reply.noTab && !reply.cached) {
    box.append(el('p', { class: 'muted' }, 'Open www.twitch.tv in a tab to see and manage saved audio.'));
    return;
  }
  if (reply.error) {
    box.append(el('p', { class: 'muted' }, 'Could not reach the Twitch tab. Reload it and try again.'));
    return;
  }
  const vods = (reply.vods || []).sort((a, b) => b.savedAt - a.savedAt);
  $('savedCount').textContent = vods.length ? String(vods.length) : '';

  const total = vods.reduce((n, v) => n + v.bytes, 0);
  const limit = Number($('maxStorageMB').value) * 1e6;
  const pct = limit ? Math.min(100, Math.round((total / limit) * 100)) : 0;
  storage.append(
    el('div', { class: 'line' },
      el('span', null, el('b', null, mb(total)), ` · ${vods.length} VOD${vods.length === 1 ? '' : 's'}`),
      el('span', null, limit ? `limit ${limit >= 1e9 ? limit / 1e9 + ' GB' : mb(limit)}` : 'no limit')),
    limit ? el('div', { class: 'meter', role: 'img', 'aria-label': `${pct}% of the storage limit used` }, el('div', { style: `width:${pct}%` })) : null);
  if (readOnly) box.append(el('p', { class: 'cached' }, `As of ${new Date(reply.at).toLocaleString()}. Open a www.twitch.tv tab to delete, pin or export.`));

  if (!vods.length) {
    box.append(el('p', { class: 'muted' }, $('saveAudio').checked
      ? 'Nothing saved yet. Open a VOD within a day of the stream and its muted parts are saved automatically.'
      : 'Nothing saved.'));
    return;
  }

  // One collapsible group per channel, biggest first; the first one open.
  const groups = new Map();
  for (const v of vods) {
    const k = v.channel || 'Unknown channel';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const ordered = [...groups].sort((a, b) => b[1].reduce((n, v) => n + v.bytes, 0) - a[1].reduce((n, v) => n + v.bytes, 0));
  ordered.forEach(([channel, list], gi) => {
    const bytes = list.reduce((n, v) => n + v.bytes, 0);
    const body = el('div', { class: 'body' });
    for (const v of list) {
      const { main, why } = vodLines(v);
      body.append(el('div', { class: 'item' + (v.pinned ? ' pinned' : '') },
        el('div', { class: 'grow' }, el('div', null, main, v.pinned ? ' · 📌' : ''), why ? el('small', null, why) : null),
        readOnly ? null : el('span', { class: 'buttons' },
          el('button', {
            type: 'button', class: 'icon', title: v.pinned ? 'Unpin: allow automatic deletion again' : 'Pin: never delete it automatically',
            'aria-label': v.pinned ? `Unpin ${channel}'s VOD` : `Pin ${channel}'s VOD`, 'aria-pressed': String(!!v.pinned),
            onclick: async () => render(await ask('pin', v.vod, { pinned: !v.pinned })),
          }, v.pinned ? '📌' : '📍'),
          el('button', {
            type: 'button', class: 'icon', title: 'Export this VOD to a file', 'aria-label': `Export ${channel}'s VOD`,
            onclick: () => { api.tabs.create({ url: `${BACKUP_URL}&vod=${encodeURIComponent(v.vod)}` }); window.close(); },
          }, '⤓'),
          el('button', {
            type: 'button', class: 'icon', title: 'Delete this saved audio', 'aria-label': `Delete saved audio for ${channel}`,
            onclick: async () => render(await ask('delete', v.vod)),
          }, '✕'))));
    }
    if (!readOnly && channel !== 'Unknown channel' && list.length > 1) {
      body.append(el('div', { class: 'group-actions' }, el('button', {
        type: 'button', class: 'link', title: `Delete all saved audio of ${channel} (pinned VODs are kept)`,
        onclick: async () => {
          if (!confirm(`Delete all saved audio of ${channel}? Pinned VODs are kept.`)) return;
          render(await ask('deleteChannel', null, { channel }));
        },
      }, `Delete all ${channel}`)));
    }
    const details = el('details', { class: 'group' },
      el('summary', null, el('span', { class: 'name' }, channel),
        el('small', null, `${list.length} VOD${list.length > 1 ? 's' : ''} · ${mb(bytes)}`)),
      body);
    if (gi === 0 || ordered.length <= 2) details.open = true;
    box.append(details);
  });
  $('deleteAll').hidden = readOnly;
}

async function loadSaved() {
  const reply = await ask('list');
  if (reply.noTab) {
    const { savedCache } = await api.storage.local.get({ savedCache: null });
    if (savedCache) return render(Object.assign({ cached: true }, savedCache));
  }
  render(reply);
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
    else if (latest.error && /subscriber-only/i.test(latest.error)) status = el('small', null, 'Latest VOD is subscriber-only: needs a subscription to save');
    else if (latest.error) status = el('small', { class: 'status-bad' }, latest.error);
    else if (latest.lastRun) {
      status = el('small', { class: latest.saved >= latest.restorable ? 'status-ok' : '' },
        latest.muted ? `${latest.live ? 'Live' : 'Latest VOD'}: ${latest.saved}/${latest.restorable} saved` +
          (latest.muted > latest.restorable ? ` (${latest.muted - latest.restorable} already deleted by Twitch)` : '')
          : `${latest.live ? 'Live' : 'Latest VOD'}: nothing muted`,
        ` · ${ago(latest.lastRun)}`);
    } else status = el('small', null, `Waiting to save · checked ${ago(ch.lastCheck)}`);
    box.append(el('div', { class: 'item' },
      el('div', { class: 'grow' }, el('div', { class: 'title' }, ch.name || login), status),
      el('button', {
        type: 'button', class: 'icon', title: 'Stop auto-saving this channel', 'aria-label': `Remove ${login}`,
        onclick: async () => {
          const { autoChannels: list } = await api.storage.sync.get({ autoChannels: [] });
          await api.storage.sync.set({ autoChannels: list.filter((c) => c !== login) });
        },
      }, '✕')));
  }
  // Channels whose VODs you saved, but that aren't auto-saved: one click to add.
  const { savedCache } = await api.storage.local.get({ savedCache: null });
  const counts = new Map();
  for (const v of (savedCache && savedCache.vods) || []) if (v.channel) counts.set(v.channel, (counts.get(v.channel) || 0) + 1);
  const suggestions = [...counts].filter(([c]) => !autoChannels.includes(c)).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sug = $('suggest');
  sug.replaceChildren();
  sug.hidden = !suggestions.length;
  if (suggestions.length) {
    sug.append(el('small', null, 'You watched VODs of: '));
    for (const [c] of suggestions) {
      sug.append(el('button', {
        type: 'button', class: 'chip', title: `Auto-save ${c}'s next VODs`,
        onclick: async () => {
          const { autoChannels: list } = await api.storage.sync.get({ autoChannels: [] });
          if (!list.includes(c)) await api.storage.sync.set({ autoChannels: list.concat(c) });
          api.runtime.sendMessage({ vu: 'autoCheckNow' }).catch(() => {});
        },
      }, `+ ${c}`));
    }
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

// ------------------------------------------------------------ troubleshooting
// Self-check and diagnostic report: the page part comes from an open Twitch
// tab (twitch.tv's storage, the player), the auto-save part from here.
async function autoSaveReport() {
  const { autoChannels } = await api.storage.sync.get({ autoChannels: [] });
  const { autoState } = await api.storage.local.get({ autoState: { vods: {}, channels: {} } });
  const problems = [];
  const notes = [];
  const lines = [`- Auto-save: ${autoChannels.length} channel(s)` +
    (autoState.lastRun ? `, last run ${new Date(autoState.lastRun).toISOString()}` : ', never run')];
  for (const login of autoChannels) {
    const ch = (autoState.channels || {})[login] || {};
    if (ch.error) problems.push(`auto-save ${login}: ${ch.error}`);
  }
  for (const [id, v] of Object.entries(autoState.vods || {})) {
    if (!autoChannels.includes(v.channel)) continue; // channel removed since
    // Subscriber-only without a subscription is expected: a note, not a problem.
    if (v.error && /subscriber-only/i.test(v.error)) notes.push(`${v.channel}'s latest VOD is subscriber-only: it can't be auto-saved without a subscription`);
    else if (v.error) problems.push(`auto-save VOD ${id} (${v.channel}): ${v.error}`);
    if (v.lastRun) lines.push(`  - VOD ${id} (${v.channel}): ${v.saved || 0}/${v.restorable || 0} saved of ${v.muted || 0} muted${v.error ? ', error: ' + v.error : ''}${v.limitReached ? ', limit reached' : ''}`);
  }
  if (autoState.note) problems.push(autoState.note);
  return { lines, problems, notes };
}

async function selfCheck() {
  const [page, auto] = await Promise.all([ask('diag'), autoSaveReport()]);
  const problems = [...((page && page.problems) || []), ...auto.problems];
  let text = page && page.text ? page.text : `### VOD Unmuter diagnostic report\n- ${page && page.noTab ? 'No Twitch tab open' : 'Couldn\'t reach the Twitch tab'}`;
  text = text.replace('\n\n```', '\n' + auto.lines.join('\n') + '\n\n```');
  if (!text.includes('```')) text += '\n' + auto.lines.join('\n');
  return { text, problems, notes: [...((page && page.notes) || []), ...auto.notes], noTab: page && page.noTab };
}

async function showStatus() {
  const { problems, notes, noTab } = await selfCheck();
  const box = $('status');
  box.className = 'status-box' + (problems.length ? ' bad' : '');
  box.textContent = problems.length
    ? `Status: ${problems.length} problem${problems.length > 1 ? 's' : ''}: ${problems.join('; ')}`
    : `Status: OK${noTab ? ' (open a Twitch tab for a full check)' : ''}` + (notes.length ? `. Note: ${notes.join('; ')}` : '');
  const dot = $('statusDot');
  dot.className = 'status-dot ' + (problems.length ? 'bad' : 'ok');
  dot.title = problems.length ? `${problems.length} problem(s): open Help` : 'Status: OK';
  dot.setAttribute('aria-label', dot.title);
}

$('copyDiag').addEventListener('click', async () => {
  const b = $('copyDiag');
  b.textContent = 'Preparing…';
  const { text } = await selfCheck();
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied ✓'; } catch (e) { b.textContent = 'Couldn\'t copy'; }
  setTimeout(() => { b.textContent = 'Copy report'; }, 3000);
});

loadSettings();
loadSaved();
renderChannels();
showStatus();
