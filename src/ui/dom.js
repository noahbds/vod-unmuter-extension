// UI module (page MAIN world): see src/ui.js. Pure formatting and DOM helpers.

export function currentVodId(loc) {
  const l = loc || (typeof location !== 'undefined' ? location : null);
  if (!l) return null;
  const m = String(l.pathname || '').match(/\/videos?\/(\d+)/);
  if (m) return m[1];
  const v = new URLSearchParams(l.search || '').get('video');
  return v ? v.replace(/^v/, '') : null;
}

// Cleans document.title on a Twitch VOD page ("Stream Title - channel - Twitch"
// or "channel - Stream Title - Twitch") for the saved-audio list.
export function cleanVodTitle(rawTitle) {
  const t = String(rawTitle || '').replace(/\s*-\s*Twitch\s*$/i, '').trim();
  return t && t.toLowerCase() !== 'twitch' ? t : '';
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
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

export function speakerIcon(on) {
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

export const pad = (n) => String(Math.floor(n)).padStart(2, '0');
export function clock(s) {
  s = Math.max(0, Math.round(s));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
export function span(s) {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad((s % 3600) / 60)}m`;
}
export const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function agoText(ms) {
  const hours = ms / 36e5;
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export const UI_CSS = `
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
    position: relative; display: inline-flex; align-items: center; height: 30px; margin-right: 4px;
    font: 600 13px/1 Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #efeff1; user-select: none; vertical-align: middle;
  }
  .vu-ctrl.vu-floating { position: absolute; top: 10px; left: 10px; z-index: 2000; }
  .vu-btn {
    all: unset; box-sizing: border-box; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 8px;
    border-radius: 4px; font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1;
  }
  .vu-btn > span { display: inline-flex; align-items: center; }
  .vu-floating .vu-btn { background: rgba(14, 14, 16, 0.82); border-radius: 999px; }
  .vu-btn:hover, .vu-ctrl.vu-open .vu-btn { background: rgba(255, 255, 255, 0.15); }
  .vu-btn:focus-visible { outline: 2px solid #a970ff; outline-offset: 1px; }
  .vu-btn .vu-of { color: #adadb8; font-weight: 500; margin-left: 3px; }
  .vu-icon { width: 20px; height: 20px; flex: none; display: block; }
  .vu-ok-c { color: #22c55e; } .vu-part-c { color: #facc15; } .vu-no-c { color: #f87171; }
  .vu-sub { color: #adadb8; font-size: 12px; font-weight: 500; line-height: 1.4; }
  .vu-spin {
    width: 14px; height: 14px; flex: none; display: block; border-radius: 50%;
    box-sizing: border-box; will-change: transform;
    border: 2px solid rgba(255,255,255,.2); border-top-color: #22c55e;
    animation: vu-spin .8s linear infinite;
  }
  @keyframes vu-spin { to { transform: rotate(360deg); } }

  /* 24px bottom padding keeps the card above the seek bar while preserving the hover bridge. */
  .vu-panel { display: none; position: absolute; bottom: 100%; right: 0; padding-bottom: 24px; z-index: 2000; }
  .vu-floating .vu-panel { bottom: auto; top: 100%; right: auto; left: 0; padding: 6px 0 0; }
  .vu-ctrl:hover .vu-panel, .vu-ctrl.vu-open .vu-panel { display: block; }
  .vu-panel-inner {
    box-sizing: border-box; font-weight: 500; line-height: 1.4; cursor: default;
    width: 320px; max-height: 340px; overflow-y: auto;
    background: rgba(14, 14, 16, 0.96); border: 1px solid rgba(255,255,255,.1);
    border-radius: 10px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.5);
  }
  .vu-stats { display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; margin-bottom: 8px; align-items: baseline; }
  .vu-stats span:nth-child(odd) { color: #adadb8; }
  .vu-stats span:nth-child(even) { text-align: right; font-variant-numeric: tabular-nums; justify-self: end; }
  .vu-meter { height: 6px; border-radius: 3px; background: rgba(232,72,72,.85); overflow: hidden; margin: 8px 0 10px; }
  .vu-meter > div { height: 100%; background: #22c55e; }
  .vu-list-title { color: #adadb8; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 5px; }
  .vu-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; margin: 0 -6px; border-radius: 5px; font-variant-numeric: tabular-nums; }
  .vu-row[role="button"] { cursor: pointer; }
  .vu-row[role="button"]:hover { background: rgba(255, 255, 255, 0.08); }
  .vu-row[role="button"]:focus-visible { outline: 2px solid #a970ff; outline-offset: 1px; background: rgba(255, 255, 255, 0.08); }
  .vu-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .vu-row .vu-len { margin-left: auto; color: #adadb8; text-align: right; }
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
  .vu-saved-line { margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.12); }
  .vu-tip-title { color: #adadb8; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; margin: 7px 0 3px; }
  .vu-src { display: grid; grid-template-columns: auto 1fr; gap: 0 7px; margin-top: 4px; }
  .vu-src .vu-dot { margin-top: 5px; }
  .vu-src-name { font-weight: 600; }
  .vu-src-why { color: #adadb8; font-size: 11.5px; }
  .vu-via { color: #adadb8; font-size: 11.5px; }
  .vu-save { margin: 0 0 10px; padding: 10px 0; border-top: 1px solid rgba(255,255,255,.08); border-bottom: 1px solid rgba(255,255,255,.08); }
  .vu-save > div + div { margin-top: 4px; }
  .vu-save-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 6px !important; }
  .vu-save-actions .vu-link { margin-top: 0; }
  .vu-save-c { color: #bf94ff; font-weight: 700; }
  .vu-meter.vu-meter-save { background: rgba(255,255,255,.12); margin: 4px 0 0; }
  .vu-meter.vu-meter-save > div { background: #a970ff; }
  .vu-link { all: unset; cursor: pointer; color: #bf94ff; font-size: 12px; margin-top: 4px; display: inline-block; }
  .vu-link:hover { text-decoration: underline; }
  .vu-link:focus-visible { outline: 2px solid #a970ff; outline-offset: 2px; border-radius: 2px; }
`;
