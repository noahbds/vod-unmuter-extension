# Twitch VOD Unmuter

A browser extension for Chrome and Firefox that brings back the sound in the
muted parts of Twitch VODs, and can save that sound so a VOD stays unmuted
after Twitch deletes it.

- 🔊 **Unmutes VODs** using the original audio Twitch still stores
- 🎚️ **Uses every quality as a backup**: if the quality you watch lost a part,
  the sound is borrowed from another quality
- 💾 **Saves the sound for later**, because Twitch deletes the originals about
  a day after the stream
- 🟢 **Green seek bar** and a **counter next to the ⚙️ button**, with details
  on where each part's sound comes from

---

## Contents

- [Install](#install)
- [Using it](#using-it)
- [Settings](#settings)
- [Saved audio](#saved-audio)
- [How it works](#how-it-works)
- [How long Twitch keeps the original audio](#how-long-twitch-keeps-the-original-audio)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Project files](#project-files)

---

## Install

### Chrome, Edge, Brave, Opera

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one with `manifest.json`).

After you change or update the files, click the reload ↻ icon on the
extension, then reload your Twitch tabs.

### Firefox (128 or newer)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder.

Firefox removes temporary add-ons when it restarts. To keep it installed,
sign it through [addons.mozilla.org](https://addons.mozilla.org/developers/)
as an *unlisted* add-on (free, private, nothing is published), or use Firefox
Developer Edition / Nightly with `xpinstall.signatures.required` set to
`false` in `about:config`.

> **Turn off the old Tampermonkey script** (`twitch-vod-unmuter.user.js`) if
> you installed it, or both will try to unmute at the same time.

---

## Using it

Open any VOD. Nothing else to do: muted parts play with sound whenever it can
still be found.

**Counter** (in the player's control bar, left of ⚙️):

| You see | Meaning |
|---|---|
| ⟳ `34%` | Checking the muted parts (the video already plays meanwhile) |
| 🔊 `182 / 182` (green) | Every muted part is unmuted |
| 🔊 `150 / 182` (yellow) | Some parts can't be unmuted any more |
| 🔇 `0 / 182` (red) | Twitch deleted the sound of every muted part |

Hover the counter (or click it to keep it open) for:
- the quality you're watching and how many parts were unmuted,
- how many used another quality or your saved copy,
- the **saved on this computer** status, with a button to delete it,
- the list of every muted part of the VOD.

**Seek bar:** Twitch's red marks are replaced by **green** (sound restored) and
**red** (still muted). Hover one to see its time, its length and **where its
sound comes from**:

| Source | Meaning |
|---|---|
| 🟢 Original *Source* file | Twitch still has the unmuted file for the quality you watch |
| 🟢 Twitch's unmuted backup | A spare unmuted copy Twitch kept next to the muted file |
| 🔵 Sound from the *720p60* version | Deleted in your quality, still in another one. Only the sound is borrowed; the picture stays in your quality |
| 🟣 Saved copy on this computer | Saved by the extension earlier, while Twitch still had it |

---

## Settings

Click the extension's icon in the toolbar.

| Setting | Default | What it does |
|---|---|---|
| **Restore muted audio** | On | The main switch. Takes effect when the VOD is reloaded |
| **Counter in the player** | On | The counter next to ⚙️ |
| **Green seek bar** | On | Recolors muted parts and shows details on hover |
| **Save audio for later** | On | Keeps the sound of muted parts on this computer (see below) |
| **What to save** | Whole VOD | *Whole VOD*: every part that can still be unmuted, in the background. *Parts I play*: only what you watch (less download, but unwatched parts are lost when Twitch deletes them) |
| **Delete saved audio after** | 60 days | 7 days, 30 days, 60 days, 6 months or never. Twitch keeps VODs at most 60 days |

---

## Saved audio

Twitch deletes the original audio of muted parts **about a day after the
stream ends** (see [the measurements](#how-long-twitch-keeps-the-original-audio)).
After that, the only way to hear those parts is a copy saved before.

**What gets saved:** only the sound of the muted parts, never the video. That's
about **1.6 MB per minute of muted audio**: a VOD with 30 muted minutes takes
about 50 MB. In *Whole VOD* mode, the extension downloads the smallest quality
that still has each original, so saving is quick. A 43-minute test took 10
seconds and about 80 MB of download.

**When it's saved:** whenever you open a VOD while Twitch still has the
originals, usually within about a day of the stream. The extension can't save
a VOD you never opened in time.

**Where it's saved:** in your browser's storage for `twitch.tv` (IndexedDB),
on this computer only.

- Clearing your browser data / cookies for twitch.tv **also deletes saved
  audio**.
- Private / incognito windows don't keep it.
- It's separate per site: `www.twitch.tv` and `m.twitch.tv` each have their
  own.

**Managing it:**
- In the **player**: hover the counter → *Saved on this computer* → *Delete
  saved audio for this VOD*. *Save it again* undoes that during the session.
- In the **popup**: the list of saved VODs (channel, stream date, size), with
  ✕ to delete one and **Delete all**. The popup needs an open Twitch tab,
  because the audio lives in twitch.tv's storage.
- Saves older than your **Delete saved audio after** setting are removed
  automatically.

---

## How it works

Twitch serves each VOD as a list of 10-second video files (an HLS playlist).
When it mutes a part, it replaces those files with copies whose audio is
silence (`123-muted.ts` instead of `123.ts`). For a while the originals stay on
Twitch's servers, and Twitch keeps **one copy per quality**, deleting them
separately.

1. **Playlist:** the extension renames every muted file back to its original
   name, so the video starts with no delay.
2. **Each muted segment**, when the player asks for it, comes from the first
   of these that works:
   1. the original file in your quality (`123.ts`, then Twitch's backup
      `123-unmuted.ts`),
   2. the sound saved on this computer,
   3. the original file in **another quality**. Its sound is spliced into the
      muted video of your quality (same timestamps, picture unchanged),
   4. the muted file, so playback never breaks.
3. **In the background**, it checks every muted part to fill the counter and
   seek bar, and (if enabled) saves the sound.

It only reports on the quality you're actually watching, since each quality
can have a different amount left.

Technical notes:
- Twitch's player downloads video inside a Web Worker. The extension runs its
  hook inside that worker by wrapping `Worker` before the page loads.
- File checks use `GET` requests cancelled right after the headers, because
  `HEAD` requests fail at random on Twitch's CDN.
- The audio splice works on the MPEG-TS packets directly (PAT/PMT, audio PID,
  continuity counters). It checks that the audio starts at the same time
  (±0.1 s) before using it. Output was verified with ffmpeg: the video stream
  is identical to Twitch's and the audio decodes with no errors.

---

## How long Twitch keeps the original audio

Twitch doesn't document it. We measured 81 VODs from 15 channels in November
2026:

| Time since the stream **ended** | VODs | Original audio found |
|---|---|---|
| 2–13 hours | 10 | Every VOD: usually 70–100% of the muted parts (lowest 20%) |
| 32–85 hours | 8 | None |
| 4–60 days | 63 | None |

So the originals disappear somewhere between **13 and 32 hours after the
stream ends**, probably on a 24-hour timer. Lower qualities (160p, 360p) lose
theirs first. VODs are muted while the stream is still live, so a long stream
already has muted parts before it ends.

**In practice:** open a VOD within about a day of the stream and leave *Save
audio for later* on.

---

## Privacy

- Everything happens in your browser. The extension doesn't send data
  anywhere, has no analytics and no server.
- Its only network requests go to Twitch: the same servers the player already
  uses for the VOD's video files.
- Saved audio stays on your computer, in twitch.tv's browser storage.
- Settings are stored with your browser's extension storage (synced if you use
  browser sync).

Use it for your own viewing. The muted audio is usually copyrighted music.

---

## Troubleshooting

**Nothing is unmuted / the counter shows 0**
The VOD is probably more than a day old, and Twitch deleted the originals in
every quality. Only a copy saved earlier can help then.

**No counter next to ⚙️**
- Check that *Counter in the player* is on in the popup.
- The VOD has no muted parts: the counter only appears when there are some.
- Reload the extension (↻ in `chrome://extensions`) and then the Twitch tab.

**The popup says "Open any Twitch page"**
Saved audio lives in twitch.tv's storage, so the popup needs a Twitch tab to
read it.

**Saved audio disappeared**
It's deleted along with twitch.tv's site data (clearing cookies / browsing
data, some privacy extensions or cleaners), and after the *Delete saved audio
after* delay.

**Something looks broken after a Twitch update**
Open the console (F12) and look for messages starting with `[VOD Unmuter]`. If
the player stops loading, turn off *Restore muted audio* and reload.

---

## Project files

```
manifest.json          Extension manifest (Manifest V3, Chrome + Firefox)
src/hook.js            Runs in the page and in the player's worker: playlists,
                       segments, audio splicing, saving (IndexedDB)
src/ui.js              Counter, panel, seek bar colors, hover details
src/bridge.js          Passes settings and popup requests to the page
popup/                 Settings and saved-audio manager
icons/                 Extension icons
twitch-vod-unmuter.user.js
                       The original Tampermonkey script (basic unmuting only)
```
