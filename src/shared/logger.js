// Hook module (page and player worker): see src/hook.js.

import { TAG } from './constants.js';
import { settings, WHERE } from './state.js';

// ---- logging -----------------------------------------------------------
// One logger for everything: levels error / warn / info / debug (debug
// only with the popup's "Debug logging" switch). The last 150 lines are
// kept in memory for the diagnostic report. URLs are shortened to their
// last path parts, without their query (no tokens).
export const LOG_KEEP = 150;
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
export function log(level, ...args) {
  const where = typeof args[0] === 'string' && args[0].startsWith('@') ? args.shift().slice(1) : WHERE;
  if (level === 'debug' && !(typeof settings !== 'undefined' && settings.debug)) return;
  const text = shortUrl(args.map(describeArg).join(' '));
  logLines.push({ t: Date.now(), where, level, text });
  if (logLines.length > LOG_KEEP) logLines.shift();
  try { (console[level === 'info' ? 'log' : level] || console.log)(`${TAG} · ${where}: ${text}`); } catch (e) { /* no console */ }
}
