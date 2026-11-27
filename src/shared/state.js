// Hook module (page and player worker): see src/hook.js.

import { CHANNEL } from './constants.js';

// State shared by every part of the hook, one copy per hook instance (the
// page, and each player worker). `scope` is installUnmuteHook's argument:
// `self` in the player worker, `window` in the page (see src/hook.js).

export const IS_PAGE = typeof scope.document !== 'undefined'; // vs. the player worker
export const WHERE = IS_PAGE ? 'page' : 'player';
// Each copy of the hook has an id: another extension can start a second
// player worker, and the UI must follow the copy that really plays.
export const INSTANCE = Math.random().toString(36).slice(2, 10);

// Twitch's video servers refuse the original files of muted parts (403)
// to requests from the embedded player and the mobile site, while serving
// them to www.twitch.tv (measured: same file, only the Origin differs).
// Pages can't change their Origin, so there the extension doesn't check
// anything (it would wrongly find everything "deleted"); it tells the user
// to open the VOD on www.twitch.tv instead.
export let ORIGIN = '';
try { ORIGIN = scope.location.origin; } catch (e) { /* ignore */ }
export const RESTRICTED = /^https:\/\/(player|m)\.twitch\.tv$/.test(ORIGIN);

export const realFetch = scope.fetch;
export let settings = { enabled: true, saveAudio: true, saveMode: 'whole', keepDays: 60, saveQuality: 'high', maxStorageMB: 1000, debug: false, skipMuted: false };
// "whole": save every muted part. "unplayed": save the parts not watched
// yet, and drop a part's saved copy once it has been watched through.
// (Older versions had "watched"; it now means "unplayed".)
export const saveMode = () => (settings.saveMode === 'whole' ? 'whole' : 'unplayed');
// New settings from the extension (via the channel). Returns the previous ones.
// Saving is on for this job: not switched off, and not deleted from the
// menu this session.
export const savingOn = (job) => !!(job.forceSave || (settings.saveAudio && !job.noSave));
export function updateSettings(patch) {
  const before = settings;
  settings = Object.assign({}, settings, patch);
  return before;
}

export let channel = null;
try { channel = new BroadcastChannel(CHANNEL); } catch (e) { /* unsupported */ }
// The channel is shared by every twitch.tv tab: each message says which
// tab it comes from, so a tab's counter only shows its own VOD.
export const TAB = scope.__vodUnmuterTab || '';
export const post = (msg) => { try { channel && channel.postMessage(Object.assign({ tab: TAB }, msg)); } catch (e) { /* ignore */ } };

export const known = new Map();       // file URL -> true (exists) / false (gone)
export const pending = new Map();     // file URL -> Promise<boolean>
export const segments = new Map();    // rewritten segment URL -> muted segment record
export const playlists = new Map();   // playlist URL -> { text, job }
export const renditions = new Map();  // VOD folder URL -> quality dirs, best first
export const vodIdsByBase = new Map(); // VOD folder URL -> Twitch VOD id
export const mp4Inits = new Map();     // init-0.mp4 URL -> Promise<bytes or null>
export const mp4Dirs = new Map();      // VOD folder URL -> Set of quality dirs known to use .mp4
export const dirExts = new Map();      // "<vodBase><dir>" -> Promise<'.mp4' | '.ts'>
