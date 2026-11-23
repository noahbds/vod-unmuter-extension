# Changelog

## 1.3.0 (in progress)

Phase 1, bug fixes:

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
