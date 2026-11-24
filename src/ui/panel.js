// UI module (page MAIN world): see src/ui.js.
// Control-bar counter button, dropdown panel, click-to-seek and keyboard access.

import { clock, h, mb, span, speakerIcon } from './dom.js';
import { ui } from './state.js';
import { diagButton } from './diagnostics.js';
import { checkingText, mainReason, QUALITY_LABEL, REASON_SHORT, REPO, verdictBox, viaText } from './explanations.js';

export function seekToTime(sec) {
  const v = typeof document !== 'undefined' && document.querySelector('video');
  if (!v) return;
  ui.manualSeekUntil = Date.now() + 3000;
  v.currentTime = Math.max(0, sec);
}

export function setPanelPinned(open, returnFocus) {
  ui.pinned = !!open;
  if (!ui.badge) return;
  ui.badge.classList.toggle('vu-open', ui.pinned);
  const btn = ui.badge.querySelector('.vu-btn');
  if (btn) {
    btn.setAttribute('aria-expanded', String(ui.pinned));
    if (!ui.pinned && returnFocus) btn.focus();
  }
}

export function renderBadge() {
  if (ui.badgeVersion === ui.version || !ui.badge) return;
  ui.badgeVersion = ui.version;
  ui.badge.replaceChildren();
  const state = ui.state;

  const toggle = (e) => {
    e.stopPropagation();
    setPanelPinned(!ui.pinned, false);
  };

  if (state.type === 'unreachable') {
    ui.badge.append(h('button', { class: 'vu-btn', 'aria-haspopup': 'true', 'aria-expanded': String(ui.pinned), onclick: toggle,
      'aria-label': 'VOD Unmuter is not active on this player' },
      h('span', { class: 'vu-part-c' }, '⚠'), h('span', null, 'Not active')),
    h('div', { class: 'vu-panel', role: 'region', 'aria-label': 'VOD Unmuter details', onclick: (e) => e.stopPropagation() },
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
      window.open(`https://www.twitch.tv/videos/${ui.vodId}${at}`, '_blank', 'noopener');
    };
    const where = /\/\/m\./.test(state.origin || '') ? 'the mobile site' : 'embedded players';
    ui.badge.append(h('button', { class: 'vu-btn', 'aria-haspopup': 'true', 'aria-expanded': String(ui.pinned), onclick: toggle,
      'aria-label': `${state.muted} muted segments: open on twitch.tv to unmute them` },
      h('span', { class: 'vu-part-c' }, speakerIcon(false)), h('span', null, `${state.muted} muted`)),
    h('div', { class: 'vu-panel', role: 'region', 'aria-label': 'VOD Unmuter details', onclick: (e) => e.stopPropagation() },
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
    button = h('button', { class: 'vu-btn' + (looksGone ? ' vu-gone' : ''), title: checkingText(state, sample), 'aria-haspopup': 'true', 'aria-expanded': String(ui.pinned), onclick: toggle },
      looksGone ? h('span', { class: 'vu-no-c' }, speakerIcon(false)) : h('div', { class: 'vu-spin' }),
      `${done}%`);
  } else {
    button = h('button', {
      class: 'vu-btn', 'aria-haspopup': 'true', 'aria-expanded': String(ui.pinned),
      'aria-label': `Unmuted ${restored} of ${muted} muted segments`, onclick: toggle,
    }, h('span', { class: cls }, speakerIcon(restored > 0)),
      h('span', null, restored, h('span', { class: 'vu-of' }, ` / ${muted}`)));
  }
  if (!state.ranges) { ui.badge.append(button); return; }

  const panel = h('div', { class: 'vu-panel', role: 'region', 'aria-label': 'VOD Unmuter details', onclick: (e) => e.stopPropagation() },
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
      state.ranges.map((r) => {
        const label = r.restored ? span(r.end - r.start) : REASON_SHORT[mainReason(r)] || 'still muted';
        return h('div', {
          class: 'vu-row', role: 'button', tabindex: '0',
          title: `Jump to ${clock(r.start)}`,
          'aria-label': `Jump to ${clock(r.start)} – ${clock(r.end)}, ${r.restored ? 'unmuted, ' + label : label}`,
          onclick: () => seekToTime(r.start),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seekToTime(r.start); } },
        },
          h('span', { class: 'vu-dot', style: `background:${r.kind === 'pending' ? '#8a8a93' : r.kind === 'wait' ? '#facc15' : !r.restored ? '#e84848' : (r.sources || []).every((x) => x.kind === 'saved') ? '#a970ff' : '#22c55e'}` }),
          h('span', null, `${clock(r.start)} – ${clock(r.end)}`),
          h('span', { class: 'vu-len' }, label, viaText(r)));
      }),
      restored < muted
        ? h('div', { class: 'vu-sub', style: 'margin-top:8px' },
            'Hover a red part of the seek bar to see why it is still muted.')
        : null,
      h('div', { style: 'margin-top:8px' }, diagButton())));

  ui.badge.append(button, panel);
}

// "Saved on this computer" part of the panel.
export function savedSection() {
  const state = ui.state;
  const sv = state && state.save;
  if (!sv) return null;
  const send = (type) => (e) => {
    e.stopPropagation();
    if (ui.channel) ui.channel.postMessage({ type, vodKey: state.vodKey });
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
        : sv.mode !== 'whole'
          ? 'Only parts ahead of where you are are kept (after 20 s of playback there). Rewinding to an earlier part plays muted once Twitch deletes the original.'
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

// Next to the settings gear in the control bar; floating in the top-left
// corner if the player has no gear (some embeds).
export function placeBadge(player) {
  const gear = player.querySelector('[data-a-target="player-settings-button"]');
  const row = gear && gear.closest('.player-controls__right-control-group');
  let slot = gear;
  while (slot && row && slot.parentElement !== row) slot = slot.parentElement;
  if (slot && row) {
    ui.badge.classList.remove('vu-floating');
    if (ui.badge.nextSibling !== slot) slot.parentElement.insertBefore(ui.badge, slot);
  } else {
    ui.badge.classList.add('vu-floating');
    if (ui.badge.parentNode !== player) player.append(ui.badge);
  }
}
