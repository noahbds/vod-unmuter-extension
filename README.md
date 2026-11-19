# Twitch VOD Unmuter

Restores the audio in muted parts of Twitch VODs when Twitch still has the
original files.

- **Instant start:** muted segments are swapped for the originals as the video
  plays. If an original is gone, the muted file plays instead, so playback
  never breaks.
- **Other qualities as backup:** Twitch keeps a copy of the VOD per quality
  and deletes their originals separately. When the quality you watch lost a
  segment's original, the audio is taken from another quality that still has
  it and spliced into your video, so the picture quality never changes.
- **Counter in the control bar** (next to the settings gear): how many muted
  segments were unmuted. Hover or click it to see the stats and every muted
  part of the VOD.
- **Green seek bar:** unmuted parts are green and parts that are still muted
  are red. Hover one to see its time range, length and where the audio came
  from.
- **Popup settings:** turn restoring, the counter or the seek bar colors on or
  off.

## Install in Chrome (or Edge, Brave, Opera)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing
   `manifest.json`).

## Install in Firefox (128 or newer)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder.

A temporary add-on is removed when Firefox restarts. To keep it, sign it
through addons.mozilla.org as an unlisted add-on, or use Firefox Developer
Edition or Nightly with `xpinstall.signatures.required` set to `false`.

## Limits

- Only works when Twitch still stores the original audio in at least one
  quality. Twitch deletes originals over time.
- A Twitch player update could break it. Messages starting with
  `[VOD Unmuter]` appear in the browser console (F12).
