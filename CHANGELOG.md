# Changelog

## 1.3.0 (in progress: not released yet)

Phase 2, explanations and reliability:

- **Why each part is still muted.** Hover a red part of the seek bar:
  - "deleted in every quality (checked: Source, 720p60…)";
  - "not checked one by one (old VOD)";
  - "network problem, checked again automatically" (shown in yellow);
  - "sound found but its timing didn't match";
  - "saved copy unusable".

  The panel's list shows a short version for each part.
- **Why the whole VOD isn't unmuted.** The panel starts with a verdict, e.g.
  "Twitch deleted the original sound of 205 parts: the stream ended 12 days
  ago, and Twitch deletes it 13 to 32 hours after a stream". It comes with a
  **Why?** link and an **Auto-save <channel>'s next VODs** button.
- **"Not active" warning.** When Twitch shows muted parts but the extension
  never heard from the player (usually another extension started it first),
  the counter says **⚠ Not active**. Its panel has a reload button, a
  diagnostic report button and a link to open an issue. It waits 8 s to avoid
  false alarms (tested on 3 VODs, including a late mature-content gate).
- **Diagnostic report.** **Copy diagnostic report** in the panel and the menu
  copies a text for a GitHub issue:
  - version, browser, settings;
  - the VOD's result with reasons;
  - each part of the extension's state;
  - self-check;
  - the last log lines.

  No tokens, URLs shortened.
- **Status in the menu.** "Status: OK" or the list of problems:
  - restoring turned off;
  - storage blocked or full;
  - player not reached;
  - auto-save errors.
- **Console.** One logger with levels, lines prefixed
  `[VOD Unmuter] · player:` / `· page:` / `· auto-save:`, and errors that
  used to be silent are now logged. A **Debug logging** switch in the menu
  shows every check, splice and save.
- **First-run page** after installing. It explains the 13–32 hour limit, lets
  you add auto-save channels, and covers what doesn't work (embedded players,
  mobile site) and the Firefox storage note.
- **Seek bar:** inside green (and red) parts, the part you've already watched
  is drawn light, almost white, so you can see where you are. Twitch's
  position marker stays on top.

Phase 1, bug fixes:

- **Counter flickering to another result when changing a setting** (e.g.
  416/420 then 496/496). When another extension (such as TwitchNoSub) fetches
  a VOD's playlist from the page, the extension's page copy checked that VOD a
  second time and answered too. Only the copy that really plays the VOD
  reports now, and the page copy no longer checks twice.

- **Network errors no longer count as "deleted".** A timeout or server error
  used to make a part look deleted for good, and a part *played* during an
  outage stayed muted for the whole session. Now only "not found" answers
  mean deleted. Others are shown as "not checked yet (network problem,
  retrying)" and checked again after 30 s, 2 min and 5 min. Tested with
  Twitch's servers failing for 15 s: back to 94 / 108, the same as without
  errors.
- **Only the quality being played is checked.** The player loads several
  qualities when it adapts, and each one used to get its own full check (up
  to 5× the requests, and the counter jumped back when the quality changed).
  Other qualities now wait, and resume if the player switches to them.
- **Embedded player and mobile site.** Twitch's video servers refuse the
  original files of muted parts to `player.twitch.tv` and `m.twitch.tv`
  (same file: 200 from www.twitch.tv, 403 from those). The extension used to
  report every part as deleted there, and remember it. Now it shows "N muted"
  with an explanation and an **Open on twitch.tv** button (same moment).
- **Firefox can't compress saved audio.** It has no AAC encoder, so *High*
  and *Small* silently stayed lossless (2–3× bigger). The popup and the
  counter's panel now say so.
- **Browser storage full.** Saving now stops once with a clear message in the
  panel, instead of failing on every segment.
- **No more synchronous request when the player starts** (Firefox showed a
  warning for it). It's still used as a fallback when another extension
  creates the player.
- Console: one summary per VOD, with how many parts are deleted, not checked
  (old VOD) or not checked yet (network problem).

## 1.2.0

Faster:

- **Old VODs are checked in seconds.** When a stream ended more than 36 hours
  ago and none of the 24 sample segments still has its sound, the rest isn't
  checked one by one (none of the 71 VODs we measured that old had any
  original left). 205 muted segments: 24.5 s → 7.9 s. The counter's panel
  says why, and any part you play is still checked.
- **Checking is faster:** 48 requests at a time instead of 24 (270 muted
  segments: 14 s → 10 s).
- **Saving is more than twice as fast:** 8 downloads at a time instead of 3
  (253 segments: 76 s → 32 s). This matters because Twitch deletes the
  originals within a day.

Bug fixes:

- **Wrong counter after changing VOD.** Twitch changes pages without
  reloading. Going from a VOD with muted parts to one without kept showing the
  previous VOD's counter and progress. It now disappears.
- **VODs still recording stopped growing.** While the stream was live, the
  extension kept serving the first copy of the VOD's playlist, so the player
  never saw newer parts and new muted parts were never unmuted or saved. The
  playlist is now refreshed, and new muted parts are checked and saved.
- **Missing files of a live VOD were remembered for good.** The newest files
  of a stream can take a moment to appear in every quality, so "not found"
  is only remembered once the VOD has ended.
- **Auto-save gave up too early on VODs with nothing muted.** It now keeps
  checking them for 12 hours after the stream, in case Twitch mutes parts
  later.

## 1.1.0

- **Faster on long VODs.** Checking runs 24 requests at a time instead of 12
  and goes in playback order. On a VOD with 1,026 muted segments, all
  deleted: 144 s → about 70–85 s.
- **Progress that moves.** The counter's percentage now counts each segment,
  instead of staying at 0% until whole stretches were done.
- **Early verdict.** 24 segments spread over the VOD are checked first. After
  a few seconds the counter turns red (🔇) if none of them can be unmuted, and
  its hover text gives an estimate. It also says when the stream ended more
  than 32 hours ago.
- **Deleted files are remembered.** Opening a VOD again skips files Twitch
  already deleted: 85 s → 2 s on the same VOD.
- **Back up saved audio.** *Back up…* in the popup exports saved VODs to a
  `.vodunmuter` file and imports them again, in the same or another browser.
- Fix: the extension now gets into Twitch's player even when another extension
  (e.g. one that also wraps the player) starts it first.

## 1.0.0

First release.
