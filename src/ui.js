// Runs in the page's MAIN world. Adds the unmute counter next to the player's
// settings button, recolors the
// seek bar (green = audio restored, red = still muted) and shows details when
// hovering a muted/unmuted part of the seek bar.
(() => {
  'use strict';
  if (window.__vodUnmuterUI) return;
  window.__vodUnmuterUI = true;

  let settings = { enabled: true, badge: true, recolor: true, saveAudio: true, saveMode: 'whole', keepDays: 60, saveQuality: 'high', maxStorageMB: 1000 };
  let state = null;     // latest 'checking' or 'result' message for this VOD
  let version = 0;      // bumped whenever state changes
  let vodId = currentVodId();
  let pinned = false;   // panel kept open by a click
  let vodSince = Date.now();      // when this VOD page was opened
  let playerHellos = 0;           // hook instances inside Twitch's player that said hello
  const UNREACHABLE_AFTER_MS = 12000;
  let mutedSeenSince = 0;
  // The hook copy that really plays this VOD (it downloads its segments).
  // Other copies (e.g. a second player worker started by another extension)
  // may know an older playlist: their messages are ignored once it's known.
  let owner = null;
  let badRangesLogged = false;         // since when Twitch shows muted parts without word from the player

  // ---------------------------------------------------------------- helpers
  function currentVodId() {
    const m = location.pathname.match(/\/videos?\/(\d+)/);
    if (m) return m[1];
    const v = new URLSearchParams(location.search).get('video');
    return v ? v.replace(/^v/, '') : null;
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ------------------------------------------------------------ backup page
  // The popup opens https://www.twitch.tv/robots.txt#vod-unmuter-backup: saved
  // audio lives in twitch.tv's storage, so export and import happen on a
  // twitch.tv page (a popup also can't keep a file picker open in Firefox).
  if (location.hostname === 'www.twitch.tv' && location.pathname === '/robots.txt' &&
      location.hash.startsWith('#vod-unmuter-backup') && window === window.top) {
    const start = () => renderBackupPage().catch((e) => { document.body.textContent = String(e); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    return;
  }

  async function renderBackupPage() {
    const store = window.__vodUnmuterStore;
    document.title = 'Back up saved audio · Twitch VOD Unmuter';
    const css = h('style', null, `
      html, body { margin: 0; background: #0e0e10; color: #efeff1; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
      main { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
      h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 8px; }
      p { margin: 6px 0; } .muted { color: #adadb8; } .bad { color: #f87171; } .ok { color: #22c55e; }
      .card { background: #18181b; border: 1px solid #2f2f35; border-radius: 8px; padding: 16px; }
      label.vod { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid #26262c; }
      label.vod:last-of-type { border-bottom: 0; } label.vod small { display: block; color: #adadb8; }
      button { background: #9146ff; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; }
      button:disabled { opacity: .5; cursor: default; } button.quiet { background: #2f2f35; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center; }
      input[type=file] { color: #adadb8; max-width: 100%; }
    `);
    const mbText = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
    const dayText = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '?');
    const main = h('main');
    document.documentElement.replaceChildren(h('head', null, h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }), css), h('body', null, main));
    document.title = 'Back up saved audio · Twitch VOD Unmuter';

    main.append(h('h1', null, 'Back up saved audio'),
      h('p', { class: 'muted' }, 'Saved audio is kept only in this browser. Download a backup file to keep it safe, ' +
        'or to move it to another browser or computer and import it there.'));
    if (!store || !store.exportSaved) {
      main.append(h('p', { class: 'bad' }, 'The extension is not running on this page. Reload it and try again.'));
      return;
    }

    // Export
    const exportBox = h('div', { class: 'card' });
    main.append(h('h2', null, 'Export'), exportBox);
    const exportStatus = h('span', { class: 'muted' });
    async function drawExport() {
      exportBox.replaceChildren();
      const vods = (await store.list()).sort((a, b) => b.savedAt - a.savedAt);
      if (!vods.length) { exportBox.append(h('p', { class: 'muted' }, 'Nothing saved yet.')); return; }
      const boxes = vods.map((v) => {
        const cb = h('input', { type: 'checkbox', 'data-vod': v.vod });
        // "&vod=<folder>": opened from one VOD's export button: only that one.
        const only = (location.hash.match(/[&?]vod=([^&]+)/) || [])[1];
        cb.checked = !only || decodeURIComponent(only) === v.vod;
        exportBox.append(h('label', { class: 'vod' }, cb, h('span', null,
          h('b', null, v.channel || 'Unknown channel'), ` · streamed ${dayText(v.streamedAt)}`,
          h('small', null, `${v.segments} segments · ${mbText(v.bytes)}`))));
        return cb;
      });
      const button = h('button', {
        onclick: async () => {
          const picked = boxes.filter((b) => b.checked).map((b) => b.getAttribute('data-vod'));
          if (!picked.length) { exportStatus.textContent = 'Pick at least one VOD.'; return; }
          button.disabled = true;
          exportStatus.textContent = 'Preparing the file…';
          try {
            const out = await store.exportSaved(picked);
            const a = h('a', { href: URL.createObjectURL(out.blob), download: `vod-unmuter-backup-${new Date().toISOString().slice(0, 10)}.vodunmuter` });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 60000);
            exportStatus.textContent = `Downloaded: ${out.vods} VOD${out.vods > 1 ? 's' : ''}, ${out.segments} segments, ${mbText(out.bytes)}.`;
          } catch (e) {
            exportStatus.textContent = 'Export failed: ' + ((e && e.message) || e);
          }
          button.disabled = false;
        },
      }, 'Download backup');
      exportBox.append(h('div', { class: 'actions' }, button, exportStatus));
    }

    // Import
    const file = h('input', { type: 'file', accept: '.vodunmuter' });
    const importInfo = h('p', { class: 'muted' }, 'Pick a .vodunmuter file made by Export.');
    const importButton = h('button', { disabled: '' }, 'Import');
    const importStatus = h('span', { class: 'muted' });
    main.append(h('h2', null, 'Import'), h('div', { class: 'card' }, file, importInfo,
      h('p', { class: 'muted' }, 'Segments already saved in this browser are kept as they are. For the ' +
        '"Keep saved audio" setting, imported VODs count as saved today.'),
      h('div', { class: 'actions' }, importButton, importStatus)));
    file.addEventListener('change', async () => {
      importButton.disabled = true;
      importStatus.textContent = '';
      importInfo.className = 'muted';
      const f = file.files && file.files[0];
      if (!f) return;
      try {
        const { head } = await store.readBackupHeader(f);
        const names = [...new Set(head.vods.map((v) => v.channel || 'unknown'))].join(', ');
        importInfo.textContent = `${head.vods.length} VOD${head.vods.length > 1 ? 's' : ''} (${names}), ` +
          `${head.audio.length} segments, ${mbText(f.size)}. Exported ${dayText(head.exported)}.`;
        importButton.disabled = false;
      } catch (e) {
        importInfo.className = 'bad';
        importInfo.textContent = (e && e.message) || String(e);
      }
    });
    importButton.addEventListener('click', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      importButton.disabled = true;
      file.disabled = true;
      try {
        const out = await store.importSaved(f, (done, total) => { importStatus.textContent = `Importing… ${done} / ${total}`; });
        importStatus.className = 'ok';
        importStatus.textContent = `Imported ${out.added} segments (${mbText(out.bytes)}) for ${out.vods} VOD${out.vods === 1 ? '' : 's'}` +
          (out.skipped ? `; ${out.skipped} were already here.` : '.') + ' Open VODs pick it up right away.';
        drawExport();
      } catch (e) {
        importStatus.className = 'bad';
        importStatus.textContent = 'Import failed: ' + ((e && e.message) || e);
      }
      file.disabled = false;
    });

    await drawExport();
  }

  // ------------------------------------------------------------ diagnostics
  // A short text report for bug reports: version, browser, settings, this
  // VOD's result and reasons, self-check, and the last log lines of every
  // part of the extension (page, player). No login token, no history; URLs
  // are already shortened by the logger.
  function browserName() {
    const ua = navigator.userAgent;
    const m = ua.match(/Firefox\/([\d.]+)/) || ua.match(/Edg\/([\d.]+)/) || ua.match(/Chrome\/([\d.]+)/);
    const name = /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : 'Chrome';
    const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'other';
    return `${name} ${m ? m[1].split('.')[0] : '?'} (${os})`;
  }

  function collectReplies(timeoutMs) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const replies = [];
      const listen = (ev) => { if (ev.data && ev.data.type === 'diag-reply' && ev.data.id === id) replies.push(ev.data); };
      const ch = new BroadcastChannel('vod-unmuter');
      ch.addEventListener('message', listen);
      ch.postMessage({ type: 'diag-request', id });
      setTimeout(() => { ch.close(); resolve(replies); }, timeoutMs);
    });
  }

  async function buildDiag() {
    const replies = await collectReplies(700);
    const player = replies.filter((r) => r.where === 'player');
    const all = replies.map((r) => r.info);
    const problems = [];
    const notes = [];
    if (!settings.enabled) problems.push('"Restore muted audio" is turned off');
    if (all.some((i) => i.idb === false)) problems.push('browser storage (IndexedDB) is blocked here, e.g. a private window: nothing can be saved');
    if (all.some((i) => i.storageFull)) problems.push('browser storage for twitch.tv is full: saving stopped');
    if (state && state.type === 'unreachable') problems.push('couldn\'t reach Twitch\'s player on this page');
    if (vodId && !player.length && !(state && state.type === 'restricted')) problems.push('the extension isn\'t running inside Twitch\'s player on this page');
    if (all.some((i) => i.restricted)) notes.push('embedded player or mobile site: Twitch only gives the original sound to www.twitch.tv');
    if (all.some((i) => i.aac === false)) notes.push('this browser can\'t compress saved audio (no AAC encoder): saves stay lossless');
    const st = state || {};
    const reasons = st.reasons ? Object.entries(st.reasons).map(([k, v]) => `${k} ${v}`).join(', ') : '';
    const sv = st.save || {};
    const lines = [
      '### VOD Unmuter diagnostic report',
      `- Version: ${settings.version || '?'} · ${browserName()} · ${new Date().toISOString()}`,
      `- Page: ${location.hostname}${vodId ? ' · VOD ' + vodId : ''}`,
      `- Settings: restore ${settings.enabled ? 'on' : 'off'}, saving ${settings.saveAudio ? 'on' : 'off'} (${settings.saveMode}, ${settings.saveQuality}, limit ${settings.maxStorageMB} MB, keep ${settings.keepDays} days), ` +
        `counter ${settings.badge ? 'on' : 'off'}, green bar ${settings.recolor ? 'on' : 'off'}, debug ${settings.debug ? 'on' : 'off'}, ${(settings.autoChannels || []).length} auto-save channel(s)`,
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
  window.__vodUnmuterDiag = buildDiag;

  async function copyText(text) {
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

  function diagButton() {
    const b = h('button', {
      class: 'vu-link', onclick: async (e) => {
        e.stopPropagation();
        b.textContent = 'Preparing…';
        const { text } = await buildDiag();
        b.textContent = (await copyText(text)) ? 'Copied ✓ paste it in a GitHub issue' : 'Couldn\'t copy (see console)';
        if (b.textContent.startsWith('Couldn')) console.log(text);
      },
    }, 'Copy diagnostic report');
    return b;
  }

  // ------------------------------------------------------------ explanations
  const REPO = 'https://github.com/noahbds/vod-unmuter-extension';
  const WHY_URL = REPO + '#how-long-twitch-keeps-the-original-audio';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const endedAgo = (st) => (st.endedAt ? agoText(Date.now() - st.endedAt) : null);

  // Short label of why a part is still muted (panel list).
  const REASON_SHORT = {
    gone: 'deleted by Twitch', skipped: 'deleted by Twitch', network: 'not checked yet',
    splice: 'sound didn\'t fit', damaged: 'saved copy unusable', checking: 'checking…',
  };
  // Full explanation (seek bar tooltip).
  function reasonText(reason, st) {
    const ago = endedAgo(st);
    switch (reason) {
      case 'gone':
        return `Twitch deleted the original sound here in every quality (checked: ${(st.checkedQualities || []).join(', ') || 'all'}).` +
          (ago ? ` The stream ended ${ago}; Twitch deletes the originals 13 to 32 hours after a stream, and this part wasn't saved before that.` : '');
      case 'skipped':
        return `Not checked one by one: the stream ended ${ago || 'long ago'}, and none of ${st.sampleSize || 24} parts spread over the VOD still had its sound. ` +
          'Twitch deletes the originals 13 to 32 hours after a stream. It is still checked if you play it.';
      case 'network': return 'Twitch\'s video servers didn\'t answer when this part was checked. It is checked again automatically.';
      case 'splice': return 'The original sound was found, but its timing didn\'t match the video, so it is kept muted to avoid a glitch.';
      case 'damaged': return 'Your saved copy of this part couldn\'t be used, so it is kept muted.';
      default: return 'Still being checked.';
    }
  }
  const mainReason = (r) => Object.entries(r.reasons || {}).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || 'gone';

  // One or two lines on why the VOD isn't fully unmuted, most useful first.
  function verdictLines(st) {
    const r = st.reasons || {};
    const lines = [];
    const ago = endedAgo(st);
    const hours = st.endedAt ? (Date.now() - st.endedAt) / 36e5 : null;
    const gone = (r.gone || 0) + (r.skipped || 0);
    if (r.network) lines.push({ tone: 'wait', text: `${plural(r.network, 'part')} couldn't be checked: Twitch's video servers didn't answer. They are checked again automatically.` });
    if (gone) {
      let text;
      if (hours !== null && hours > 32) {
        text = `Twitch deleted the original sound of ${plural(gone, 'part')}: the stream ended ${ago}, and Twitch deletes it 13 to 32 hours after a stream. Only audio saved before then can bring it back.`;
      } else if (hours !== null) {
        text = `Twitch has started deleting this VOD's original sound (the stream ended ${ago}): ${plural(gone, 'part')} are already gone in every quality.` +
          (st.save && st.save.enabled ? ' The rest is being saved on this computer.' : '');
      } else {
        text = `Twitch deleted the original sound of ${plural(gone, 'part')} in every quality.`;
      }
      if (st.save && !st.save.enabled) text += ' Saving is off in the extension menu, so nothing is kept for later.';
      const channelName = st.channel;
      const followed = channelName && (settings.autoChannels || []).includes(channelName);
      if (followed && settings.saveAudio) text += ` Auto-save is on for ${channelName}: its next VODs are saved in time.`;
      const canSuggest = channelName && settings.saveAudio && !followed;
      lines.push({ tone: 'bad', text, why: true, suggest: canSuggest ? channelName : null });
    }
    if (r.splice || r.damaged) lines.push({ tone: 'bad', text: `${plural((r.splice || 0) + (r.damaged || 0), 'part')} had sound that couldn't be used (see the list).` });
    return lines;
  }

  function verdictBox(st) {
    const lines = verdictLines(st);
    if (!lines.length) return null;
    return h('div', { class: 'vu-verdict' }, lines.map((l) => h('div', { class: 'vu-verdict-line vu-' + l.tone },
      l.text,
      l.why ? [' ', h('a', { class: 'vu-link', href: WHY_URL, target: '_blank', rel: 'noopener' }, 'Why?')] : null,
      l.suggest ? h('div', null, h('button', {
        class: 'vu-link', onclick: (e) => {
          e.stopPropagation();
          window.postMessage({ source: 'vod-unmuter-page', type: 'addAutoChannel', login: l.suggest }, location.origin);
          e.target.replaceWith(h('span', { class: 'vu-ok-c' }, `✓ New VODs from ${l.suggest} will be saved in time (auto-save).`));
        },
      }, `Auto-save ${l.suggest}'s next VODs`)) : null)));
  }

  function speakerIcon(on) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'vu-icon');
    const path = (d, extra) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      for (const [k, v] of Object.entries(extra || {})) p.setAttribute(k, v);
      svg.append(p);
    };
    path('M4 9h4l5-4v14l-5-4H4z', { fill: 'currentColor' });
    if (on) {
      path('M16 9a4 4 0 0 1 0 6', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });
      path('M18.5 6.5a7.5 7.5 0 0 1 0 11', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });
    } else {
      path('M16 9l5 6M21 9l-5 6', { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });
    }
    return svg;
  }

  const pad = (n) => String(Math.floor(n)).padStart(2, '0');
  function clock(s) {
    s = Math.max(0, Math.round(s));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
  }
  function span(s) {
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${pad((s % 3600) / 60)}m`;
  }

  const savedDate = () => {
    const t = state && state.save && state.save.savedAt;
    return t ? ' on ' + new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  };
  const QUALITY_LABEL = {
    original: 'Saved in original quality (lossless)',
    high: 'Saved in high quality (96 kbps)',
    small: 'Saved in small size (64 kbps)',
  };
  const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

  // Plain-language description of where a part's sound comes from.
  function explainSource(src) {
    const watching = (state && state.quality) || 'this quality';
    switch (src.kind) {
      case 'original': return {
        color: '#22c55e', name: `Original ${src.quality} file`,
        why: 'The unmuted file for the quality you are watching still exists.' };
      case 'backup': return {
        color: '#22c55e', name: `Twitch's unmuted backup (${src.quality})`,
        why: 'A spare unmuted copy Twitch kept next to the muted file.' };
      case 'saved': return {
        color: '#a970ff', name: 'Saved copy on this computer',
        why: `Saved by the extension${savedDate()} while Twitch still had the original.` };
      case 'other': return {
        color: '#38bdf8',
        name: src.quality === 'audio_only' ? 'Sound from the audio-only version'
          : `Sound from the ${src.quality} version` + (/^(160|360)p/.test(src.quality) ? ' (lower sound quality)' : ''),
        why: `Deleted in ${watching}, still there in other qualities. Only the sound is borrowed; the picture stays ${watching}.` };
      default: return {
        color: '#38bdf8', name: `Sound from the ${src.quality} unmuted backup`,
        why: `Only the sound is borrowed; the picture stays ${watching}.` };
    }
  }

  function findPlayer() {
    const players = document.querySelectorAll('[data-a-target="video-player"]');
    for (const p of players) if (p.querySelector('.seekbar-bar')) return p;
    return players[0] || null;
  }

  // ------------------------------------------------------------------ styles
  const css = `
    html.vu-recolor .seekbar-segment[style*="212, 73, 73"] { opacity: 0 !important; }
    .vu-bars { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
    .vu-bar { position: absolute; top: 0; bottom: 0; min-width: 2px; }
    .vu-bar.vu-ok { background: linear-gradient(90deg, #dcfce7 var(--vu-played, 0%), rgba(34, 197, 94, 0.9) var(--vu-played, 0%)); }
    .vu-bar.vu-no { background: linear-gradient(90deg, #fde2e2 var(--vu-played, 0%), rgba(232, 72, 72, 0.85) var(--vu-played, 0%)); }
    .vu-bar.vu-pending { background: linear-gradient(90deg, #e4e4e7 var(--vu-played, 0%), rgba(161, 161, 170, 0.75) var(--vu-played, 0%)); }
    .vu-bar.vu-wait { background: linear-gradient(90deg, #fef3c7 var(--vu-played, 0%), rgba(250, 204, 21, 0.85) var(--vu-played, 0%)); }
    /* Twitch's position marker stays above the colored parts */
    html.vu-recolor .seekbar-bar > span:not(.seekbar-segment) { z-index: 2; }
    .vu-verdict { margin: 0 0 10px; display: grid; gap: 6px; }
    .vu-verdict-line { font-size: 12px; line-height: 1.45; padding: 6px 8px; border-radius: 6px; background: rgba(255, 255, 255, 0.06); }
    .vu-verdict-line.vu-bad { border-left: 3px solid #e84848; }
    .vu-verdict-line.vu-wait { border-left: 3px solid #facc15; }
    .vu-verdict-line.vu-warn { border-left: 3px solid #facc15; }
    a.vu-link { color: #bf94ff; text-decoration: none; } a.vu-link:hover { text-decoration: underline; }

    /* Button in the player's control bar, next to the settings gear. */
    .vu-ctrl {
      position: relative; display: flex; align-items: center; margin-right: 4px;
      font: 600 13px/1 Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: #efeff1; user-select: none;
    }
    .vu-ctrl.vu-floating { position: absolute; top: 10px; left: 10px; z-index: 2000; }
    .vu-btn {
      all: unset; box-sizing: border-box; cursor: pointer;
      display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px;
      border-radius: 4px; font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .vu-floating .vu-btn { background: rgba(14, 14, 16, 0.82); border-radius: 999px; }
    .vu-btn:hover, .vu-ctrl.vu-open .vu-btn { background: rgba(255, 255, 255, 0.15); }
    .vu-btn:focus-visible { outline: 2px solid #a970ff; outline-offset: 1px; }
    .vu-btn .vu-of { color: #adadb8; font-weight: 500; }
    .vu-icon { width: 20px; height: 20px; flex: none; }
    .vu-ok-c { color: #22c55e; } .vu-part-c { color: #facc15; } .vu-no-c { color: #f87171; }
    .vu-sub { color: #adadb8; font-size: 12px; font-weight: 500; line-height: 1.4; }
    .vu-spin {
      width: 14px; height: 14px; flex: none; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.2); border-top-color: #22c55e;
      animation: vu-spin .8s linear infinite;
    }
    @keyframes vu-spin { to { transform: rotate(360deg); } }

    .vu-panel { display: none; position: absolute; bottom: 100%; right: 0; padding-bottom: 8px; z-index: 2000; }
    .vu-floating .vu-panel { bottom: auto; top: 100%; right: auto; left: 0; padding: 6px 0 0; }
    .vu-ctrl:hover .vu-panel, .vu-ctrl.vu-open .vu-panel { display: block; }
    .vu-panel-inner {
      font-weight: 500; line-height: 1.35; cursor: default;
      width: 310px; max-height: 340px; overflow-y: auto;
      background: rgba(14, 14, 16, 0.94); border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px; padding: 10px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.45);
    }
    .vu-stats { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin-bottom: 8px; }
    .vu-stats span:nth-child(odd) { color: #adadb8; }
    .vu-meter { height: 6px; border-radius: 3px; background: rgba(232,72,72,.85); overflow: hidden; margin: 6px 0 10px; }
    .vu-meter > div { height: 100%; background: #22c55e; }
    .vu-list-title { color: #adadb8; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
    .vu-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-variant-numeric: tabular-nums; }
    .vu-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .vu-row .vu-len { margin-left: auto; color: #adadb8; }
    .vu-note { color: #adadb8; font-size: 12px; line-height: 1.4; margin: 8px 0 2px; }

    .vu-tip {
      position: absolute; z-index: 2001; pointer-events: none;
      transform: translate(-50%, -100%);
      font: 500 12px/1.4 Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: #efeff1; width: max-content; max-width: 320px;
      background: rgba(14, 14, 16, 0.94); border-radius: 8px; padding: 8px 11px;
      box-shadow: 0 4px 16px rgba(0,0,0,.45);
    }
    .vu-tip-head { font-weight: 700; margin-bottom: 2px; }
    .vu-tip-line { color: #adadb8; font-variant-numeric: tabular-nums; }
    .vu-tip-title { color: #adadb8; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; margin: 7px 0 3px; }
    .vu-src { display: grid; grid-template-columns: auto 1fr; gap: 0 7px; margin-top: 4px; }
    .vu-src .vu-dot { margin-top: 5px; }
    .vu-src-name { font-weight: 600; }
    .vu-src-why { color: #adadb8; font-size: 11.5px; }
    .vu-via { color: #adadb8; font-size: 11.5px; }
    .vu-save { margin: 0 0 10px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,.08); border-bottom: 1px solid rgba(255,255,255,.08); }
    .vu-save > div + div { margin-top: 3px; }
    .vu-save-c { color: #bf94ff; font-weight: 700; }
    .vu-meter.vu-meter-save { background: rgba(255,255,255,.12); margin: 4px 0 0; }
    .vu-meter.vu-meter-save > div { background: #a970ff; }
    .vu-link { all: unset; cursor: pointer; color: #bf94ff; font-size: 12px; margin-top: 4px; }
    .vu-link:hover { text-decoration: underline; }
    .vu-link:focus-visible { outline: 2px solid #a970ff; outline-offset: 2px; border-radius: 2px; }
  `;
  const style = h('style', { id: 'vod-unmuter-style' }, css);
  (document.head || document.documentElement).append(style);

  // ---------------------------------------------------------------- elements
  const badge = h('div', { class: 'vu-ctrl' });
  const bars = h('div', { class: 'vu-bars' });
  const tip = h('div', { class: 'vu-tip' });
  let badgeVersion = -1, barsVersion = -1;

  function agoText(ms) {
    const hours = ms / 36e5;
    if (hours < 1) return 'less than an hour ago';
    if (hours < 48) return `${Math.round(hours)} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  // Hover text of the counter while checking: progress, then an early
  // verdict from the spread-out sample and from how old the stream is.
  function checkingText(st, sample) {
    const lines = [`Checking muted segments: ${st.done || 0} of ${st.muted} done` +
      (st.found ? `, ${st.found} can be unmuted so far.` : '.')];
    if (sample) {
      if (!sample.found) {
        lines.push(`None of ${sample.size} segments spread over the whole VOD can be unmuted: ` +
          'the original sound looks deleted in every quality. Checking the rest to be sure…');
      } else {
        lines.push(`Early estimate: about ${Math.round((sample.found / sample.size) * 100)}% can be unmuted ` +
          `(${sample.found} of ${sample.size} segments spread over the VOD).`);
      }
    }
    if (st.endedAt) {
      const since = Date.now() - st.endedAt;
      if (since > (st.allGoneAfterH || 32) * 36e5) {
        lines.push(`The stream ended ${agoText(since)}. Twitch usually deletes the original sound ` +
          '13 to 32 hours after a stream, so only audio saved before then can still be restored.');
      }
    }
    return lines.join('\n\n');
  }

  function renderBadge() {
    if (badgeVersion === version) return;
    badgeVersion = version;
    badge.replaceChildren();

    const toggle = (e) => {
      e.stopPropagation();
      pinned = !pinned;
      badge.classList.toggle('vu-open', pinned);
    };

    if (state.type === 'unreachable') {
      badge.append(h('button', { class: 'vu-btn', 'aria-haspopup': 'true', onclick: toggle,
        'aria-label': 'VOD Unmuter is not active on this player' },
        h('span', { class: 'vu-part-c' }, '⚠'), h('span', null, 'Not active')),
      h('div', { class: 'vu-panel', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'vu-panel-inner' },
          h('div', { class: 'vu-verdict-line vu-warn' },
            'VOD Unmuter couldn\'t reach Twitch\'s player on this page, so muted parts stay muted. ' +
            'Reload the page. If it keeps happening, another extension may be starting the player first: ' +
            'copy the diagnostic report and open an issue on GitHub.'),
          h('div', { style: 'display:flex;gap:14px;margin-top:8px' },
            h('button', { class: 'vu-link', onclick: () => location.reload() }, 'Reload the page'),
            diagButton(),
            h('a', { class: 'vu-link', href: REPO + '/issues', target: '_blank', rel: 'noopener' }, 'Open an issue ↗')))));
      return;
    }

    if (state.type === 'restricted') {
      const open = () => {
        const v = document.querySelector('video');
        const t = v && v.currentTime > 1 ? Math.floor(v.currentTime) : 0;
        const at = t ? `?t=${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s` : '';
        window.open(`https://www.twitch.tv/videos/${vodId}${at}`, '_blank', 'noopener');
      };
      const where = /\/\/m\./.test(state.origin || '') ? 'the mobile site' : 'embedded players';
      badge.append(h('button', { class: 'vu-btn', 'aria-haspopup': 'true', onclick: toggle,
        'aria-label': `${state.muted} muted segments: open on twitch.tv to unmute them` },
        h('span', { class: 'vu-part-c' }, speakerIcon(false)), h('span', null, `${state.muted} muted`)),
      h('div', { class: 'vu-panel', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'vu-panel-inner' },
          h('div', { class: 'vu-note', style: 'margin-top:0' },
            `Twitch only gives the original sound of muted parts to www.twitch.tv, not to ${where}. ` +
            'Open this VOD on twitch.tv (same moment) to hear them.' +
            (where === 'the mobile site' ? ' On a phone, use "Request desktop site".' : '')),
          h('button', { class: 'vu-link', onclick: open }, 'Open on twitch.tv ↗'))));
      return;
    }

    const checking = state.type === 'checking';
    const { restored, muted } = state;
    const cls = restored === muted ? 'vu-ok-c' : restored ? 'vu-part-c' : 'vu-no-c';
    const pct = state.mutedSeconds ? Math.round((state.restoredSeconds / state.mutedSeconds) * 100) : 0;

    let button;
    if (checking) {
      const done = Math.round(((state.done || 0) / state.muted) * 100);
      const sample = state.sample && state.sample.size && state.sample.done >= state.sample.size ? state.sample : null;
      const looksGone = !!sample && !sample.found;
      button = h('button', { class: 'vu-btn' + (looksGone ? ' vu-gone' : ''), title: checkingText(state, sample), 'aria-haspopup': 'true', onclick: toggle },
        looksGone ? h('span', { class: 'vu-no-c' }, speakerIcon(false)) : h('div', { class: 'vu-spin' }),
        `${done}%`);
    } else {
      button = h('button', {
        class: 'vu-btn', 'aria-haspopup': 'true',
        'aria-label': `Unmuted ${restored} of ${muted} muted segments`, onclick: toggle,
      }, h('span', { class: cls }, speakerIcon(restored > 0)),
        h('span', null, restored, h('span', { class: 'vu-of' }, ` / ${muted}`)));
    }
    if (!state.ranges) { badge.append(button); return; }

    const panel = h('div', { class: 'vu-panel', onclick: (e) => e.stopPropagation() },
      h('div', { class: 'vu-panel-inner' },
        checking
          ? h('div', { class: 'vu-verdict' }, h('div', { class: 'vu-verdict-line vu-wait' },
              checkingText(state, state.sample && state.sample.done >= state.sample.size ? state.sample : null).split('\n\n').join(' ')))
          : verdictBox(state),
        h('div', { class: 'vu-stats' },
          state.quality ? [h('span', null, 'Quality'), h('span', null, state.quality)] : null,
          h('span', null, 'Muted segments'), h('span', null, muted),
          h('span', null, 'Unmuted'), h('span', { class: 'vu-ok-c' }, restored),
          state.fromOther ? [h('span', null, '…using other qualities'), h('span', null, state.fromOther)] : null,
          state.fromSaved ? [h('span', null, '…using your saved copy'), h('span', null, state.fromSaved)] : null,
          checking ? [h('span', null, 'Checked so far'), h('span', null, `${state.done || 0} / ${muted}`)] : null,
          h('span', null, checking ? 'Muted so far' : 'Still muted'), h('span', { class: muted - restored ? 'vu-no-c' : '' },
            checking ? (state.done || 0) - restored : muted - restored),
          state.unknown ? [h('span', null, '…not checked yet (network problem, retrying)'), h('span', null, state.unknown)] : null,
          h('span', null, 'Audio restored'), h('span', null, `${span(state.restoredSeconds)} / ${span(state.mutedSeconds)}`)),
        h('div', { class: 'vu-meter', title: `${pct}% of the muted time restored` },
          h('div', { style: `width:${pct}%` })),
        savedSection(),
        h('div', { class: 'vu-list-title' }, 'Muted parts of this VOD'),
        state.ranges.map((r) => h('div', { class: 'vu-row' },
          h('span', { class: 'vu-dot', style: `background:${r.kind === 'pending' ? '#8a8a93' : r.kind === 'wait' ? '#facc15' : !r.restored ? '#e84848' : (r.sources || []).every((x) => x.kind === 'saved') ? '#a970ff' : '#22c55e'}` }),
          h('span', null, `${clock(r.start)} – ${clock(r.end)}`),
          h('span', { class: 'vu-len' }, r.restored ? span(r.end - r.start) : REASON_SHORT[mainReason(r)] || 'still muted',
            viaText(r)))),
        restored < muted
          ? h('div', { class: 'vu-sub', style: 'margin-top:8px' },
              'Hover a red part of the seek bar to see why it is still muted.')
          : null,
        h('div', { style: 'margin-top:8px' }, diagButton())));

    badge.append(button, panel);
  }

  // "Saved on this computer" part of the panel.
  function savedSection() {
    const sv = state.save;
    if (!sv) return null;
    const send = (type) => (e) => {
      e.stopPropagation();
      channel.postMessage({ type, vodKey: state.vodKey });
    };
    const link = (label, type) => h('button', { class: 'vu-link', onclick: send(type) }, label);
    let body;
    if (!sv.enabled) {
      body = [h('div', { class: 'vu-sub' },
        'Saving is off. Turn on "Save audio for later" in the extension menu to keep this VOD unmuted after Twitch deletes the originals (about a day after the stream).')];
      if (sv.saved) body.push(h('div', { class: 'vu-sub' }, `Still saved from before: ${sv.saved} segments · ${mb(sv.bytes)}`));
    } else if (sv.paused && !sv.saved) {
      body = [h('div', { class: 'vu-sub' }, 'Deleted. Nothing is saved for this VOD.'),
        sv.savable ? link('Save it again', 'saveNow') : null];
    } else if (sv.active) {
      const p = sv.savable ? Math.round((sv.saved / sv.savable) * 100) : 0;
      body = [h('div', null, `Saving… ${sv.saved} / ${sv.savable} segments`),
        h('div', { class: 'vu-meter vu-meter-save' }, h('div', { style: `width:${p}%` }))];
    } else if (sv.limitReached && sv.saved < sv.savable) {
      body = [h('div', null, `${sv.saved} / ${sv.savable} segments saved`, sv.bytes ? h('span', { class: 'vu-sub' }, ` · ${mb(sv.bytes)}`) : null),
        h('div', { class: 'vu-no-c', style: 'font-size:12px' }, sv.storageFull
          ? 'Your browser\'s storage for twitch.tv is full (the disk is nearly full, or the browser\'s own limit). Free some disk space or delete saved VODs in the extension menu.'
          : `Storage limit reached (${sv.maxMB >= 1000 ? sv.maxMB / 1000 + ' GB' : sv.maxMB + ' MB'}). Raise it or pick a smaller saved quality in the extension menu.`),
        sv.saved ? link('Delete saved audio for this VOD', 'deleteSaved') : null];
    } else if (!sv.saved && !sv.savable) {
      body = [h('div', { class: 'vu-sub' }, 'Nothing to save: Twitch already deleted the originals.')];
    } else {
      const all = sv.saved >= sv.savable;
      body = [
        h('div', null, h('span', { class: all ? 'vu-save-c' : '' }, `${sv.saved} / ${sv.savable}`),
          ' segments saved', sv.bytes ? h('span', { class: 'vu-sub' }, ` · ${mb(sv.bytes)}`) : null),
        sv.compressing
          ? h('div', { class: 'vu-sub' }, `Compressing… ${sv.compressing.done} / ${sv.compressing.total}`)
          : h('div', { class: 'vu-sub' }, sv.aac === false && sv.quality !== 'original'
            ? 'Saved in original quality (lossless): this browser can\'t compress audio'
            : QUALITY_LABEL[sv.quality] || ''),
        h('div', { class: 'vu-sub' }, all
          ? 'This VOD stays unmuted after Twitch deletes the originals.'
          : sv.mode === 'watched'
            ? 'Only the parts you play are saved (change this in the extension menu).'
            : 'The rest will be saved while you watch.'),
        sv.saved ? h('div', { style: 'display:flex;gap:14px' },
          link('Delete saved audio for this VOD', 'deleteSaved'),
          h('button', { class: 'vu-link', onclick: (e) => {
            e.stopPropagation();
            window.open(`https://www.twitch.tv/robots.txt#vod-unmuter-backup&vod=${encodeURIComponent(state.vodKey)}`, '_blank', 'noopener');
          } }, 'Export to a file')) : null,
      ];
    }
    return h('div', { class: 'vu-save' }, h('div', { class: 'vu-list-title' }, 'Saved on this computer'), body);
  }

  function renderBars() {
    if (barsVersion !== version) {
      barsVersion = version;
      // A part with an invalid position would only make the browser complain
      // ("NaN%"): skip it, and say once in the console what was wrong.
      const valid = (r) => Number.isFinite(r.start) && Number.isFinite(r.end) && state.total > 0;
      const bad = state.ranges.filter((r) => !valid(r));
      if (bad.length && !badRangesLogged) {
        badRangesLogged = true;
        console.warn('[VOD Unmuter] · page: skipped seek bar parts with an invalid position', JSON.stringify({ total: state.total, type: state.type, example: bad[0] }));
      }
      bars.replaceChildren(...state.ranges.filter(valid).map((r) => {
        const el = h('span', {
          class: `vu-bar ${r.restored ? 'vu-ok' : r.kind === 'pending' ? 'vu-pending' : r.kind === 'wait' ? 'vu-wait' : 'vu-no'}`,
          style: `inset-inline-start:${(r.start / state.total) * 100}%;width:${((r.end - r.start) / state.total) * 100}%`,
        });
        el.vuFrom = (r.start / state.total) * 100;
        el.vuTo = (r.end / state.total) * 100;
        return el;
      }));
    }
    paintPlayed();
  }

  // The colored parts cover Twitch's purple "already watched" fill, so the
  // watched part of each one is drawn lighter (almost white) instead.
  function playedPercent() {
    const fill = document.querySelector('.seekbar-bar .seekbar-segment[style*="169, 112, 255"]');
    if (fill) { const w = parseFloat(fill.style.width); if (w >= 0) return w; }
    const v = document.querySelector('video');
    return v && state && state.total ? (v.currentTime / state.total) * 100 : 0;
  }
  function paintPlayed() {
    const p = playedPercent();
    for (const el of bars.children) {
      const f = Math.max(0, Math.min(1, (p - el.vuFrom) / ((el.vuTo - el.vuFrom) || 1))) * 100;
      el.style.setProperty('--vu-played', f.toFixed(2) + '%');
    }
  }

  // "· via 720p60" when part of a range's sound comes from another quality.
  function viaText(r) {
    const others = [...new Set((r.sources || [])
      .filter((s) => s.kind === 'other' || s.kind === 'other-backup').map((s) => s.quality))];
    return others.length ? h('span', { class: 'vu-via' }, ` · via ${others.join(', ')}`) : null;
  }

  // Next to the settings gear in the control bar; floating in the top-left
  // corner if the player has no gear (some embeds).
  function placeBadge(player) {
    const gear = player.querySelector('[data-a-target="player-settings-button"]');
    // The gear is wrapped in several block elements; climb to the wrapper
    // that sits directly in the control bar's row, so we end up beside it.
    const row = gear && gear.closest('.player-controls__right-control-group');
    let slot = gear;
    while (slot && row && slot.parentElement !== row) slot = slot.parentElement;
    if (slot && row) {
      badge.classList.remove('vu-floating');
      if (badge.nextSibling !== slot) slot.parentElement.insertBefore(badge, slot);
    } else {
      badge.classList.add('vu-floating');
      if (badge.parentNode !== player) player.append(badge);
    }
  }

  document.addEventListener('click', (e) => {
    if (pinned && !badge.contains(e.target)) { pinned = false; badge.classList.remove('vu-open'); }
  }, true);

  // ------------------------------------------------------------------ update
  function update() {
    const id = currentVodId();
    if (id !== vodId) { vodId = id; state = null; version++; vodSince = Date.now(); owner = null; }

    const player = findPlayer();
    // Twitch shows muted parts (red marks on its seek bar, or its "audio for
    // portions of this video has been muted" notice) but nothing came
    // from the extension inside the player: it couldn't hook the player.
    // It has to last 8 s: Twitch's notice can show a moment before the
    // extension's first message (e.g. after the mature-content gate).
    const twitchShowsMuted = !state && vodId && player && settings.enabled &&
      (player.querySelector('.seekbar-segment[style*="212, 73, 73"]') ||
       document.querySelector('[data-test-selector^="muted-segments-alert"]'));
    if (!twitchShowsMuted) mutedSeenSince = 0;
    else if (!mutedSeenSince) mutedSeenSince = Date.now();
    else if (Date.now() - mutedSeenSince > 8000 && Date.now() - vodSince > UNREACHABLE_AFTER_MS) {
      state = { type: 'unreachable', vod: null };
      version++;
    }
    const show = !!(state && vodId && player);

    if (show && settings.badge) {
      placeBadge(player);
      renderBadge();
    } else badge.remove();

    const bar = player && player.querySelector('.seekbar-bar');
    const recolor = show && settings.recolor && (state.type === 'result' || state.type === 'checking') && state.ranges && bar && state.total > 0;
    document.documentElement.classList.toggle('vu-recolor', !!recolor);
    if (recolor) {
      if (bars.parentNode !== bar) bar.append(bars);
      renderBars();
    } else bars.remove();

    if (!recolor) tip.remove();
  }

  // ------------------------------------------------------------ hover details
  document.addEventListener('pointermove', (e) => {
    if (!state || state.type !== 'result' || !settings.recolor || !e.target.closest) { tip.remove(); return; }
    const area = e.target.closest('[data-a-target="player-seekbar"]');
    const bar = area && area.querySelector('.seekbar-bar');
    const player = area && area.closest('[data-a-target="video-player"]');
    if (!bar || !player) { tip.remove(); return; }

    const br = bar.getBoundingClientRect();
    let frac = (e.clientX - br.left) / br.width;
    if (getComputedStyle(bar).direction === 'rtl') frac = 1 - frac;
    const t = frac * state.total;
    const tolerance = (4 / br.width) * state.total; // ~4px either side
    let hit = null, best = Infinity;
    for (const r of state.ranges) {
      const d = t < r.start ? r.start - t : t > r.end ? t - r.end : 0;
      if (d <= tolerance && d < best) { best = d; hit = r; }
    }
    if (!hit) { tip.remove(); return; }

    const plural = (n) => `${n} segment${n > 1 ? 's' : ''}`;
    const sources = hit.sources || [];
    // (replaceChildren doesn't unpack nested lists, so flatten them first)
    tip.replaceChildren(...[
      h('div', { class: 'vu-tip-head ' + (hit.restored ? 'vu-ok-c' : hit.kind === 'pending' || hit.kind === 'wait' ? 'vu-part-c' : 'vu-no-c') },
        hit.restored ? '✓ Audio unmuted' : hit.kind === 'pending' ? '… Not checked yet' : hit.kind === 'wait' ? '… Checked again soon' : '✕ Still muted'),
      h('div', { class: 'vu-tip-line' },
        `${clock(hit.start)} – ${clock(hit.end)} · ${span(hit.end - hit.start)} · ${plural(hit.segments)}`),
      hit.restored
        ? [h('div', { class: 'vu-tip-title' }, 'Where the sound comes from'),
           sources.map((src, i) => {
             const d = explainSource(src);
             // Explain each kind once (several qualities share the same reason).
             if (sources.slice(0, i).some((o) => explainSource(o).why === d.why)) d.why = null;
             return h('div', { class: 'vu-src' },
               h('span', { class: 'vu-dot', style: `background:${d.color}` }),
               h('div', null,
                 h('div', { class: 'vu-src-name' },
                   sources.length > 1 ? `${plural(src.segments)}: ${d.name}` : d.name),
                 d.why ? h('div', { class: 'vu-src-why' }, d.why) : null));
           })]
        : Object.entries(hit.reasons || { gone: hit.segments }).sort((a, b) => b[1] - a[1]).map(([reason, n], i, all) =>
            h('div', { class: 'vu-src-why', style: 'margin-top:4px' },
              all.length > 1 ? h('b', null, `${plural(n, 'segment')}: `) : null, reasonText(reason, state))),
    ].flat(Infinity));

    if (tip.parentNode !== player) player.append(tip);
    const clientX = e.clientX;
    const place = () => {
      if (!tip.parentNode) return;
      const pr = player.getBoundingClientRect();
      let top = br.top - 14;
      const preview = player.querySelector('[data-test-selector="vod-seekbar-preview-overlay-preview-image"]');
      const card = preview && (preview.closest('.tw-balloon') || preview.parentElement);
      const cr = card && card.getBoundingClientRect();
      if (cr && cr.height > 0 && cr.bottom <= br.top + 2) top = cr.top - 8;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(clientX - pr.left, half + 6), pr.width - half - 6)}px`;
      tip.style.top = `${Math.max(top - pr.top, tip.offsetHeight + 4)}px`;
    };
    // Twitch draws its preview image a moment later (sometimes after the
    // mouse stopped moving): place the box now, and again once it's there.
    requestAnimationFrame(place);
    clearTimeout(tipTimers[0]); clearTimeout(tipTimers[1]);
    tipTimers = [setTimeout(place, 150), setTimeout(place, 450)];
  }, true);
  let tipTimers = [];

  // --------------------------------------------------------------- messaging
  const channel = new BroadcastChannel('vod-unmuter');
  channel.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'hello' && m.where === 'player') { playerHellos++; return; }
    if (m.instance && ['checking', 'result', 'none'].includes(m.type)) {
      if (m.playing) owner = m.instance;
      else if (owner && m.instance !== owner) return;
    }
    if (m.type === 'settings') {
      settings = Object.assign({}, settings, m.settings);
      version++;
    } else if (m.type === 'checking') {
      if (state && state.type === 'result' && state.key === m.key) return;
      state = m; version++;
    } else if (m.type === 'result') {
      state = m; version++;
    } else if (m.type === 'restricted') {
      if (state && state.type === 'restricted' && state.vod === m.vod) return;
      state = m; version++;
    } else if (m.type === 'none') {
      // The player moved on from that VOD.
      if (!state || state.vod !== m.vod) return;
      state = null; version++;
    } else return;
    update();
  });
  channel.postMessage({ type: 'hello' });

  setInterval(update, 700);
  // Keep the watched part in step with playback (media events don't bubble,
  // but they do pass through the document in the capture phase).
  for (const type of ['timeupdate', 'seeked']) {
    document.addEventListener(type, () => { if (bars.isConnected && state && state.ranges) paintPlayed(); }, true);
  }
})();
