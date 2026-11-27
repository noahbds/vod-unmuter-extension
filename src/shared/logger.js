// Hook module (page and player worker): see src/hook.js.

import { TAG } from './constants.js';
import { settings, WHERE } from './state.js';

// ---- logging -----------------------------------------------------------
// One logger for everything: levels error / warn / info / debug (debug
// only with the popup's "Debug logging" switch). The last 150 lines are
// kept in memory for the diagnostic report. URLs are shortened to their
// last path parts, without their query (no tokens).
//
// In the console (Chrome and Firefox): a purple "[VOD Unmuter]" badge, then
// where the line comes from (page / player / auto-save), then the text.
// Objects and errors given to log() are also passed to the console as they
// are, so they can be expanded there (an error shows its stack). Filter the
// console with "VOD Unmuter" to see only these lines. Chrome shows debug
// lines only with "Verbose" ticked in the console's levels menu.
const LOG_KEEP = 150;
export const logLines = [];
export const shortUrl = (text) => String(text).replace(/https?:\/\/[^\s"']+/g, (u) => {
  const path = u.split(/[?#]/)[0].split('/').filter(Boolean);
  return path.length > 3 ? '…/' + path.slice(-3).join('/') : path.slice(1).join('/') || u.split('?')[0];
});
export const describeArg = (a) => {
  if (a instanceof Error || (a && a.name && a.message)) return `${a.name}: ${a.message}`;
  if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
  return String(a);
};
const BADGE_CSS = 'color:#fff;background:#9146ff;border-radius:3px;padding:0 4px;font-weight:600';
const WHERE_CSS = 'color:#9146ff;font-weight:600';
// %s, not the text itself, in the format: a "%" in the text stays as it is.
const styled = (where, text, level) => [`%c${TAG}%c %s%c %s`, BADGE_CSS, WHERE_CSS, where, level === 'debug' ? 'color:#888' : '', text];

function rememberLine(where, level, text) {
  logLines.push({ t: Date.now(), where, level, text });
  if (logLines.length > LOG_KEEP) logLines.shift();
}

export function log(level, ...args) {
  const where = typeof args[0] === 'string' && args[0].startsWith('@') ? args.shift().slice(1) : WHERE;
  if (level === 'debug' && !(typeof settings !== 'undefined' && settings.debug)) return;
  const text = shortUrl(args.map(describeArg).join(' '));
  rememberLine(where, level, text);
  const words = shortUrl(args.filter((a) => typeof a !== 'object' || a === null).map(String).join(' '));
  const objects = args.filter((a) => a && typeof a === 'object');
  try { (console[level === 'info' ? 'log' : level] || console.log)(...styled(where, words, level), ...objects); } catch (e) { /* no console */ }
}

// A title line with details under it: in the console, a group that starts
// collapsed (click it to see the lines); in the diagnostic report, the title
// then each line. Without details it is just a line.
export function logGroup(level, title, lines, where = WHERE) {
  const text = shortUrl(title);
  rememberLine(where, level, text);
  for (const l of lines) rememberLine(where, 'debug', '  ' + shortUrl(l));
  try {
    if (!lines.length || typeof console.groupCollapsed !== 'function') {
      (console[level === 'info' ? 'log' : level] || console.log)(...styled(where, text, level));
      return;
    }
    console.groupCollapsed(...styled(where, text, level));
    for (const l of lines) console.log(shortUrl(l));
    console.groupEnd();
  } catch (e) { /* no console */ }
}
