// UI module (page MAIN world): see src/ui.js.
// Seek bar recoloring, watched fill, hover details, and auto-skipping still-muted stretches.

import { cleanVodTitle, clock, currentVodId, h, span, UI_CSS } from './dom.js';
import { applyUiSettings, settings, ui, UNREACHABLE_AFTER_MS } from './state.js';
import { explainSource, reasonText, savedCopyLine } from './explanations.js';
import { placeBadge, renderBadge, setPanelPinned } from './panel.js';

export function findPlayer() {
  const players = document.querySelectorAll('[data-a-target="video-player"]');
  for (const p of players) if (p.querySelector('.seekbar-bar')) return p;
  return players[0] || null;
}

// Pure helper: finds a confirmed still-muted range ('no', not 'pending' or 'wait')
// covering `currentTime` that hasn't just been auto-skipped.
export function findMutedRangeToSkip(ranges, currentTime, lastSkippedStart) {
  if (!Array.isArray(ranges) || !Number.isFinite(currentTime)) return null;
  for (const r of ranges) {
    if (r.restored || r.kind !== 'no') continue;
    if (currentTime >= r.start && currentTime < r.end - 0.5 && r.start !== lastSkippedStart) return r;
  }
  return null;
}

export function maybeSkipMuted(video) {
  if (!settings.skipMuted || !video || video.paused) return false;
  if (!ui.state || ui.state.type !== 'result' || !Array.isArray(ui.state.ranges)) return false;
  if (Date.now() < ui.manualSeekUntil) return false;
  const t = video.currentTime;
  if (ui.lastSkippedStart >= 0) {
    const prev = ui.state.ranges.find((r) => r.start === ui.lastSkippedStart);
    if (!prev || t < prev.start - 2 || t > prev.end + 2) ui.lastSkippedStart = -1;
  }
  const hit = findMutedRangeToSkip(ui.state.ranges, t, ui.lastSkippedStart);
  if (!hit) return false;
  ui.lastSkippedStart = hit.start;
  video.currentTime = hit.end;
  return true;
}

export function renderBars() {
  const state = ui.state;
  if (ui.barsVersion !== ui.version) {
    ui.barsVersion = ui.version;
    // A part with an invalid position would only make the browser complain
    // ("NaN%"): skip it, and say once in the console what was wrong.
    const valid = (r) => Number.isFinite(r.start) && Number.isFinite(r.end) && state.total > 0;
    const bad = state.ranges.filter((r) => !valid(r));
    if (bad.length && !ui.badRangesLogged) {
      ui.badRangesLogged = true;
      console.warn('[VOD Unmuter] · page: skipped seek bar parts with an invalid position', JSON.stringify({ total: state.total, type: state.type, example: bad[0] }));
    }
    ui.bars.replaceChildren(...state.ranges.filter(valid).map((r) => {
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
export function playedPercent() {
  const fill = document.querySelector('.seekbar-bar .seekbar-segment[style*="169, 112, 255"]');
  if (fill) { const w = parseFloat(fill.style.width); if (w >= 0) return w; }
  const v = document.querySelector('video');
  return v && ui.state && ui.state.total ? (v.currentTime / ui.state.total) * 100 : 0;
}

export function paintPlayed() {
  if (!ui.bars) return;
  const p = playedPercent();
  for (const el of ui.bars.children) {
    const f = Math.max(0, Math.min(1, (p - el.vuFrom) / ((el.vuTo - el.vuFrom) || 1))) * 100;
    el.style.setProperty('--vu-played', f.toFixed(2) + '%');
  }
}

export function updateUi() {
  const id = currentVodId();
  if (id !== ui.vodId) {
    ui.vodId = id; ui.state = null; ui.version++; ui.vodSince = Date.now();
    ui.owner = null; ui.lastSkippedStart = -1;
  }

  const player = findPlayer();
  const twitchShowsMuted = !ui.state && ui.vodId && player && settings.enabled &&
    (player.querySelector('.seekbar-segment[style*="212, 73, 73"]') ||
     document.querySelector('[data-test-selector^="muted-segments-alert"]'));
  if (!twitchShowsMuted) ui.mutedSeenSince = 0;
  else if (!ui.mutedSeenSince) ui.mutedSeenSince = Date.now();
  else if (Date.now() - ui.mutedSeenSince > 8000 && Date.now() - ui.vodSince > UNREACHABLE_AFTER_MS) {
    ui.state = { type: 'unreachable', vod: null };
    ui.version++;
  }
  const show = !!(ui.state && ui.vodId && player);

  if (show && settings.badge) {
    placeBadge(player);
    renderBadge();
  } else if (ui.badge) ui.badge.remove();

  const bar = player && player.querySelector('.seekbar-bar');
  const recolor = show && settings.recolor && (ui.state.type === 'result' || ui.state.type === 'checking') && ui.state.ranges && bar && ui.state.total > 0;
  document.documentElement.classList.toggle('vu-recolor', !!recolor);
  if (recolor) {
    if (ui.bars.parentNode !== bar) bar.append(ui.bars);
    renderBars();
  } else if (ui.bars) ui.bars.remove();

  if (!recolor && ui.tip) ui.tip.remove();
}

export function startUiLoop() {
  ui.vodId = currentVodId();
  const style = h('style', { id: 'vod-unmuter-style' }, UI_CSS);
  (document.head || document.documentElement).append(style);
  ui.badge = h('div', { class: 'vu-ctrl' });
  ui.bars = h('div', { class: 'vu-bars' });
  ui.tip = h('div', { class: 'vu-tip' });

  document.addEventListener('click', (e) => {
    if (ui.pinned && !ui.badge.contains(e.target)) setPanelPinned(false, false);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.pinned) {
      e.stopPropagation();
      setPanelPinned(false, true);
    }
  }, true);

  // Hover details on the seek bar.
  let tipTimers = [];
  document.addEventListener('pointermove', (e) => {
    const state = ui.state;
    if (!state || state.type !== 'result' || !settings.recolor || !e.target.closest) { ui.tip.remove(); return; }
    const area = e.target.closest('[data-a-target="player-seekbar"]');
    const bar = area && area.querySelector('.seekbar-bar');
    const player = area && area.closest('[data-a-target="video-player"]');
    if (!bar || !player) { ui.tip.remove(); return; }

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
    if (!hit) { ui.tip.remove(); return; }

    const segsText = (n) => `${n} segment${n > 1 ? 's' : ''}`;
    const sources = hit.sources || [];
    ui.tip.replaceChildren(...[
      h('div', { class: 'vu-tip-head ' + (hit.restored ? 'vu-ok-c' : hit.kind === 'pending' || hit.kind === 'wait' ? 'vu-part-c' : 'vu-no-c') },
        hit.restored ? '✓ Audio unmuted' : hit.kind === 'pending' ? '… Not checked yet' : hit.kind === 'wait' ? '… Checked again soon' : '✕ Still muted'),
      h('div', { class: 'vu-tip-line' },
        `${clock(hit.start)} – ${clock(hit.end)} · ${span(hit.end - hit.start)} · ${segsText(hit.segments)}`),
      hit.restored
        ? [h('div', { class: 'vu-tip-title' }, 'Where the sound comes from'),
           sources.map((src, i) => {
             const d = explainSource(src, state);
             if (sources.slice(0, i).some((o) => explainSource(o, state).why === d.why)) d.why = null;
             return h('div', { class: 'vu-src' },
               h('span', { class: 'vu-dot', style: `background:${d.color}` }),
               h('div', null,
                 h('div', { class: 'vu-src-name' },
                   sources.length > 1 ? `${segsText(src.segments)}: ${d.name}` : d.name),
                 d.why ? h('div', { class: 'vu-src-why' }, d.why) : null));
           })]
        : Object.entries(hit.reasons || { gone: hit.segments }).sort((a, b) => b[1] - a[1]).map(([reason, n], i, all) =>
            h('div', { class: 'vu-src-why', style: 'margin-top:4px' },
              all.length > 1 ? h('b', null, `${segsText(n)}: `) : null, reasonText(reason, state))),
      savedCopyLine(hit, state),
    ].flat(Infinity));

    if (ui.tip.parentNode !== player) player.append(ui.tip);
    const clientX = e.clientX;
    const place = () => {
      if (!ui.tip.parentNode) return;
      const pr = player.getBoundingClientRect();
      let top = br.top - 14;
      const preview = player.querySelector('[data-test-selector="vod-seekbar-preview-overlay-preview-image"]');
      const card = preview && (preview.closest('.tw-balloon') || preview.parentElement);
      const cr = card && card.getBoundingClientRect();
      if (cr && cr.height > 0 && cr.bottom <= br.top + 2) top = cr.top - 8;
      const half = ui.tip.offsetWidth / 2;
      ui.tip.style.left = `${Math.min(Math.max(clientX - pr.left, half + 6), pr.width - half - 6)}px`;
      ui.tip.style.top = `${Math.max(top - pr.top, ui.tip.offsetHeight + 4)}px`;
    };
    requestAnimationFrame(place);
    clearTimeout(tipTimers[0]); clearTimeout(tipTimers[1]);
    tipTimers = [setTimeout(place, 150), setTimeout(place, 450)];
  }, true);

  // Messaging with hook instances in this tab.
  const channel = new BroadcastChannel('vod-unmuter');
  ui.channel = channel;
  channel.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.tab && window.__vodUnmuterTab && m.tab !== window.__vodUnmuterTab) return;
    if (m.type === 'hello' && m.where === 'player') { ui.playerHellos++; return; }
    if (m.instance && ['checking', 'result', 'none'].includes(m.type)) {
      if (m.playing) ui.owner = m.instance;
      else if (ui.owner && m.instance !== ui.owner) return;
    }
    if (m.type === 'settings') {
      applyUiSettings(m.settings);
    } else if (m.type === 'checking') {
      if (ui.state && ui.state.type === 'result' && ui.state.key === m.key) return;
      ui.state = m; ui.version++;
    } else if (m.type === 'result') {
      ui.state = m; ui.version++;
    } else if (m.type === 'restricted') {
      if (ui.state && ui.state.type === 'restricted' && ui.state.vod === m.vod) return;
      ui.state = m; ui.version++;
    } else if (m.type === 'none') {
      if (!ui.state || ui.state.vod !== m.vod) return;
      ui.state = null; ui.version++;
    } else return;
    updateUi();
  });
  channel.postMessage({ type: 'hello' });

  setInterval(updateUi, 700);

  let lastWatched = null;
  setInterval(() => {
    const v = document.querySelector('video');
    const isVod = v && ui.state && ui.state.total && Number.isFinite(v.duration) && Math.abs(v.duration - ui.state.total) < 120;
    if (v && ui.vodId && isVod) {
      channel.postMessage({
        type: 'position', tab: window.__vodUnmuterTab, t: v.currentTime,
        vodId: ui.vodId, title: cleanVodTitle(document.title),
      });
    }
    if (!v || v.paused || !ui.vodId || !isVod) { lastWatched = null; return; }
    maybeSkipMuted(v);
    const t = v.currentTime;
    if (lastWatched !== null && t > lastWatched && t - lastWatched <= 5) {
      channel.postMessage({ type: 'played', tab: window.__vodUnmuterTab, from: lastWatched, to: t });
    }
    lastWatched = t;
  }, 1000);

  for (const type of ['timeupdate', 'seeked']) {
    document.addEventListener(type, (e) => {
      if (ui.bars && ui.bars.isConnected && ui.state && ui.state.ranges) paintPlayed();
      if (type === 'timeupdate' && e.target && e.target.tagName === 'VIDEO') maybeSkipMuted(e.target);
    }, true);
  }
}
