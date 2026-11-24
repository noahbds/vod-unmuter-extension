// UI module (page MAIN world): see src/ui.js.
// Diagnostic report builder and self-check for bug reports.

import { agoText, h } from './dom.js';
import { settings, ui } from './state.js';

export function browserName(uaString) {
  const ua = uaString || (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const m = ua.match(/Firefox\/([\d.]+)/) || ua.match(/Edg\/([\d.]+)/) || ua.match(/Chrome\/([\d.]+)/);
  const name = /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : 'Chrome';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'other';
  return `${name} ${m ? m[1].split('.')[0] : '?'} (${os})`;
}

export function collectReplies(timeoutMs) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const replies = [];
    const listen = (ev) => {
      const d = ev.data;
      if (d && d.type === 'diag-reply' && d.id === id && (!d.tab || d.tab === window.__vodUnmuterTab)) replies.push(d);
    };
    const ch = new BroadcastChannel('vod-unmuter');
    ch.addEventListener('message', listen);
    ch.postMessage({ type: 'diag-request', id });
    setTimeout(() => { ch.close(); resolve(replies); }, timeoutMs);
  });
}

export async function buildDiag() {
  const replies = await collectReplies(700);
  const player = replies.filter((r) => r.where === 'player');
  const all = replies.map((r) => r.info);
  const problems = [];
  const notes = [];
  if (!settings.enabled) problems.push('"Restore muted audio" is turned off');
  if (all.some((i) => i.idb === false)) problems.push('browser storage (IndexedDB) is blocked here, e.g. a private window: nothing can be saved');
  if (all.some((i) => i.storageFull)) problems.push('browser storage for twitch.tv is full: saving stopped');
  if (ui.state && ui.state.type === 'unreachable') problems.push('couldn\'t reach Twitch\'s player on this page');
  if (ui.vodId && !player.length && !(ui.state && ui.state.type === 'restricted')) problems.push('the extension isn\'t running inside Twitch\'s player on this page');
  if (all.some((i) => i.restricted)) notes.push('embedded player or mobile site: Twitch only gives the original sound to www.twitch.tv');
  if (all.some((i) => i.aac === false)) notes.push('this browser can\'t compress saved audio (no AAC encoder): saves stay lossless');
  const st = ui.state || {};
  const reasons = st.reasons ? Object.entries(st.reasons).map(([k, v]) => `${k} ${v}`).join(', ') : '';
  const sv = st.save || {};
  const host = typeof location !== 'undefined' ? location.hostname : 'www.twitch.tv';
  const lines = [
    '### VOD Unmuter diagnostic report',
    `- Version: ${settings.version || '?'} · ${browserName()} · ${new Date().toISOString()}`,
    `- Page: ${host}${ui.vodId ? ' · VOD ' + ui.vodId : ''}`,
    `- Settings: restore ${settings.enabled ? 'on' : 'off'}, saving ${settings.saveAudio ? 'on' : 'off'} (${settings.saveMode}, ${settings.saveQuality}, limit ${settings.maxStorageMB} MB, keep ${settings.keepDays} days), ` +
      `counter ${settings.badge ? 'on' : 'off'}, green bar ${settings.recolor ? 'on' : 'off'}, skip muted ${settings.skipMuted ? 'on' : 'off'}, debug ${settings.debug ? 'on' : 'off'}, ${(settings.autoChannels || []).length} auto-save channel(s)`,
    st.type === 'result'
      ? `- Result: ${st.quality} · ${st.restored}/${st.muted} unmuted · ${reasons}` + (st.endedAt ? ` · stream ended ${agoText(Date.now() - st.endedAt)}` : '') +
        ` · saved ${sv.saved || 0}/${sv.savable || 0}` + (sv.limitReached ? ' (limit reached)' : '')
      : `- State: ${st.type || 'nothing from the player yet'}`,
    `- Extension parts answering: ${replies.map((r) => r.where).join(', ') || 'none'}`,
    ...replies.flatMap((r) => r.info.jobs.map((j) => `  - ${r.where} job ${j.name}${j.auto ? ' (auto-save)' : ''}${j.current ? ' (playing)' : ''}${j.paused ? ' (paused)' : ''}: ` +
      `${j.muted} muted, ${Object.entries(j.reasons).map(([k, v]) => `${k} ${v}`).join(', ')}, saved ${j.saved}`)),
    `- Self-check: ${problems.length ? problems.join('; ') : 'OK'}` + (notes.length ? ` (notes: ${notes.join('; ')})` : ''),
    '',
    '```',
    ...replies.flatMap((r) => r.logs).sort((a, b) => a.t - b.t).slice(-80)
      .map((l) => `${new Date(l.t).toISOString().slice(11, 19)} ${l.level.padEnd(5)} ${l.where}: ${l.text}`),
    '```',
  ];
  return { text: lines.join('\n'), problems, notes };
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
  const ta = h('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

export function diagButton() {
  const b = h('button', {
    class: 'vu-link', onclick: async (e) => {
      e.stopPropagation();
      b.textContent = 'Preparing…';
      const { text } = await buildDiag();
      b.textContent = (await copyText(text)) ? 'Copied ✓ paste it in a GitHub issue' : 'Couldn\'t copy (see console)';
      if (b.textContent.startsWith('Couldn')) console.log('[VOD Unmuter] · page: the browser refused to copy the diagnostic report to the clipboard; here it is, to copy by hand:\n\n' + text);
    },
  }, 'Copy diagnostic report');
  return b;
}
