// Background script (service worker in Chrome, event page in Firefox).
//
// Auto-save: every 20 minutes, look at the channels in the popup's auto-save
// list. For each VOD that is live or ended less than 36 hours ago (Twitch
// deletes the originals within about a day), ask a twitch.tv tab to save its
// muted parts. If no Twitch tab is open, open a small one in the background
// (twitch.tv/robots.txt), and close it when done.
//
// The saving itself happens in the page (hook.js), because saved audio lives
// in twitch.tv's browser storage and subscriber-only VODs need the viewer's
// Twitch login.
const api = globalThis.browser || globalThis.chrome;

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Twitch's public web client id
const ALARM = 'vu-autosave';
const EVERY_MINUTES = 20;
const WINDOW_HOURS = 36;      // after this, Twitch has deleted the originals
const RETRY_MINUTES = 15;     // don't redo a VOD more often than this
const BUSY_MINUTES = 45;      // safety: forget a run that never reported back
const MUTE_LATE_HOURS = 12;   // keep checking unmuted VODs this long after the stream
const DEFAULTS = { saveAudio: true, autoChannels: [], autoOpenTab: true };
const EMPTY_STATE = { vods: {}, channels: {}, lastRun: null, note: '' };

// ------------------------------------------------------------------ schedule
function schedule() {
  api.alarms.create(ALARM, { periodInMinutes: EVERY_MINUTES, delayInMinutes: 1 });
}
api.runtime.onInstalled.addListener((details) => {
  schedule();
  // First install: explain what the extension can and can't do, before
  // anyone is disappointed by an old VOD that stays muted.
  if (details && details.reason === 'install') api.tabs.create({ url: api.runtime.getURL('popup/welcome.html') }).catch(() => {});
});
api.runtime.onStartup.addListener(schedule);
api.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) check(false); });

// ------------------------------------------------------------------ state
async function getState() {
  const { autoState } = await api.storage.local.get({ autoState: EMPTY_STATE });
  return Object.assign({}, EMPTY_STATE, autoState);
}
const setState = (autoState) => api.storage.local.set({ autoState });

// Results arrive in quick succession: apply state changes one at a time, or
// they overwrite each other.
let stateQueue = Promise.resolve();
function updateState(change) {
  const run = stateQueue.then(async () => {
    const state = await getState();
    await change(state);
    await setState(state);
  });
  stateQueue = run.catch(() => {});
  return run;
}
const session = api.storage.session || api.storage.local; // survives the worker sleeping

async function gql(query) {
  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': CLIENT_ID },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error('Twitch answered ' + r.status);
  return r.json();
}

// VODs of the auto-save channels that may still have originals to save.
async function findWork(channels, state, force) {
  const now = Date.now();
  const work = [];
  for (const login of channels) {
    const ch = state.channels[login] || (state.channels[login] = {});
    try {
      const r = await gql(`query { user(login: ${JSON.stringify(login)}) {
        displayName videos(first: 5, type: ARCHIVE, sort: TIME) { edges { node { id title createdAt lengthSeconds status } } } } }`);
      const user = r.data && r.data.user;
      if (!user) throw new Error('channel not found');
      ch.name = user.displayName || login;
      ch.lastCheck = now;
      ch.error = null;
      for (const { node: v } of user.videos.edges) {
        const live = v.status === 'RECORDING';
        const endedAt = new Date(v.createdAt).getTime() + v.lengthSeconds * 1000;
        if (!live && now - endedAt > WINDOW_HOURS * 36e5) continue;
        const rec = state.vods[v.id] || (state.vods[v.id] = { channel: login, createdAt: v.createdAt });
        Object.assign(rec, { title: v.title, live, endedAt: live ? null : endedAt });
        if (rec.done) continue;
        if (!force && rec.lastRun && now - rec.lastRun < RETRY_MINUTES * 6e4) continue;
        work.push(v.id);
      }
    } catch (e) {
      ch.lastCheck = now;
      ch.error = e.message || String(e);
    }
  }
  // Forget VODs older than Twitch's 60-day limit.
  for (const [id, v] of Object.entries(state.vods)) {
    if (now - new Date(v.createdAt).getTime() > 61 * 864e5) delete state.vods[id];
  }
  return work;
}

// ------------------------------------------------------------------ tabs
const TWITCH_TABS = ['https://www.twitch.tv/*'];

async function waitForLoad(tabId) {
  for (let i = 0; i < 60; i++) {
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// A Twitch tab to save in: an open one, or a small background one we open.
async function pickTab(openIfNone) {
  const { autoTab } = await session.get({ autoTab: null });
  const tabs = await api.tabs.query({ url: TWITCH_TABS });
  const ours = tabs.find((t) => t.id === autoTab);
  if (ours) return { tab: ours, opened: true };
  if (tabs.length) {
    // Prefer a tab the user isn't looking at.
    tabs.sort((a, b) => (a.active - b.active) || (a.audible - b.audible));
    return { tab: tabs[0], opened: false };
  }
  if (!openIfNone) return null;
  const tab = await api.tabs.create({ url: 'https://www.twitch.tv/robots.txt', active: false });
  await session.set({ autoTab: tab.id });
  await waitForLoad(tab.id);
  return { tab, opened: true };
}

async function send(tabId, message) {
  for (let i = 0; i < 10; i++) {
    try {
      return await api.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000)); // the page's scripts may still be loading
    }
  }
  return null;
}

// ------------------------------------------------------------------ check
async function check(force) {
  const settings = await api.storage.sync.get(DEFAULTS);
  if (!settings.saveAudio || !settings.autoChannels.length) return { ok: true, work: 0 };

  const { autoBusyUntil } = await session.get({ autoBusyUntil: 0 });
  if (autoBusyUntil > Date.now()) return { ok: false, busy: true };

  let work = [];
  await updateState(async (state) => {
    work = await findWork(settings.autoChannels, state, force);
    state.lastRun = Date.now();
    state.note = '';
  });
  if (!work.length) return { ok: true, work: 0 };

  const picked = await pickTab(settings.autoOpenTab);
  if (!picked) {
    await updateState((state) => { state.note = 'Waiting for a Twitch tab to be open'; });
    return { ok: false, noTab: true };
  }
  await updateState((state) => { for (const id of work) if (state.vods[id]) state.vods[id].running = true; });
  await session.set({ autoBusyUntil: Date.now() + BUSY_MINUTES * 6e4 });
  const reply = await send(picked.tab.id, { vu: 'autosave', vodIds: work });
  if (!reply || !reply.accepted) {
    await session.set({ autoBusyUntil: 0 });
    await updateState((s) => {
      for (const id of work) if (s.vods[id]) s.vods[id].running = false;
      s.note = reply && reply.busy ? '' : 'Could not reach the Twitch tab';
    });
    return { ok: false };
  }
  return { ok: true, work: work.length };
}

// ------------------------------------------------------------------ results
function recordResult(result) {
  return updateState((state) => {
    const rec = state.vods[result.vodId] || (state.vods[result.vodId] = { channel: '' });
    Object.assign(rec, {
      running: false,
      lastRun: Date.now(),
      muted: result.muted || 0,
      restorable: result.restorable || 0,
      saved: result.saved || 0,
      bytes: result.bytes || 0,
      error: result.ok ? null : result.error || 'failed',
      limitReached: !!result.limitReached,
    });
    // Done once the stream is over and everything still on Twitch is saved
    // (originals only ever disappear, so there's nothing more to get later).
    // Nothing muted yet: Twitch may still mute parts in the hours after the
    // stream, so keep looking for a while (one small playlist request).
    const justEnded = rec.endedAt && Date.now() - rec.endedAt < MUTE_LATE_HOURS * 36e5;
    if (result.ok && !rec.live && rec.saved >= rec.restorable && !(rec.muted === 0 && justEnded)) rec.done = true;
  });
}

async function finished(sender) {
  await session.set({ autoBusyUntil: 0 });
  const { autoTab } = await session.get({ autoTab: null });
  if (sender.tab && sender.tab.id === autoTab) {
    await api.tabs.remove(autoTab).catch(() => {});
    await session.set({ autoTab: null });
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;
  if (msg.vu === 'autosaveDone') { recordResult(msg.result); return undefined; }
  if (msg.vu === 'autosaveFinished') { finished(sender); return undefined; }
  if (msg.vu === 'autoCheckNow') { check(true).then(sendResponse); return true; }
  return undefined;
});

// The tab we opened was closed by hand: forget it.
api.tabs.onRemoved.addListener(async (tabId) => {
  const { autoTab } = await session.get({ autoTab: null });
  if (tabId === autoTab) await session.set({ autoTab: null, autoBusyUntil: 0 });
});
