# Changelog

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
