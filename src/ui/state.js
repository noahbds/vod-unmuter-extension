// UI module (page MAIN world): see src/ui.js. Shared UI state and settings.

export let settings = { enabled: true, badge: true, recolor: true, saveAudio: true, saveMode: 'whole', keepDays: 60, saveQuality: 'high', maxStorageMB: 1000, skipMuted: false };
export const UNREACHABLE_AFTER_MS = 12000;

export const ui = {
  state: null,             // latest 'checking' or 'result' message for this VOD
  version: 0,              // bumped whenever state changes
  vodId: null,
  pinned: false,           // panel kept open by a click
  vodSince: Date.now(),    // when this VOD page was opened
  playerHellos: 0,         // hook instances inside Twitch's player that said hello
  mutedSeenSince: 0,       // since when Twitch shows muted parts without word from the player
  owner: null,             // the hook copy that really plays this VOD
  badRangesLogged: false,
  badge: null,
  bars: null,
  tip: null,
  channel: null,
  badgeVersion: -1,
  barsVersion: -1,
  lastSkippedStart: -1,    // start time of the last auto-skipped still-muted range
  manualSeekUntil: 0,      // brief cooldown after clicking a range row so auto-skip doesn't jump away
};

export function applyUiSettings(patch) {
  settings = Object.assign({}, settings, patch);
  ui.version++;
}
