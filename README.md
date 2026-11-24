# Twitch VOD Unmuter

A browser extension for Chrome and Firefox that brings back the sound in the
muted parts of Twitch VODs, and can save that sound so a VOD stays unmuted
after Twitch deletes it.

- 🔊 **Unmutes VODs** using the original audio Twitch still stores
- 🎚️ **Uses every quality as a backup**: if the quality you watch lost a part,
  the sound is borrowed from another quality
- 💾 **Saves the sound for later**, because Twitch deletes the originals about
  a day after the stream, compressed (up to −70%) with a storage limit you set
- 📺 **Auto-saves channels you choose**, even VODs you haven't opened, and
  live streams as they're muted
- 🟢 **Green seek bar** and a **counter next to the ⚙️ button**, with details
  on where each part's sound comes from

---

## Contents

- [Install](#install)
- [Using it](#using-it)
- [Settings](#settings)
- [Saved audio](#saved-audio)
- [Auto-save channels](#auto-save-channels)
- [How it works](#how-it-works)
- [How long Twitch keeps the original audio](#how-long-twitch-keeps-the-original-audio)
- [Other ways to get the audio back](#other-ways-to-get-the-audio-back)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Project files](#project-files)

---

## Install

First build it (needs [Node.js](https://nodejs.org) 18 or newer, nothing else):

```bash
node build.mjs
```

This creates, in `dist/`:

| File | Use |
|---|---|
| `dist/chrome/` | Chrome, Edge, Brave, Opera: *Load unpacked* |
| `dist/firefox/` | Firefox: *Load Temporary Add-on* |
| `twitch-vod-unmuter-chrome-1.5.0.zip` | Upload to the Chrome Web Store |
| `twitch-vod-unmuter-firefox-1.5.0.zip` | Upload to addons.mozilla.org (signing) |

The two builds differ only in `manifest.json` (Chrome runs the background
script as a service worker, Firefox as a background page).

### Chrome, Edge, Brave, Opera

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/chrome` folder.

After you change the files, run `node build.mjs` again, click the reload ↻
icon on the extension, then reload your Twitch tabs.

### Firefox (140 or newer)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `dist/firefox/manifest.json`.

Firefox removes temporary add-ons when it restarts. To keep it installed,
sign it through [addons.mozilla.org](https://addons.mozilla.org/developers/)
as an *unlisted* add-on (free, private, nothing is published), or use Firefox
Developer Edition / Nightly with `xpinstall.signatures.required` set to
`false` in `about:config`.

### Developing

`npm install` (once) gets Mozilla's [web-ext](https://github.com/mozilla/web-ext)
tool, then:

```bash
npm run start:firefox   # build, then open Firefox with the extension loaded
npm run start:chrome    # same in Chrome
npm run lint            # build, then Mozilla's add-on linter on dist/firefox
```

The browser reloads the extension whenever `dist/` changes: after editing
`src/`, run `npm run build`. Settings for web-ext are in `web-ext-config.mjs`.
GitHub Actions builds and lints every push and pull request
(`.github/workflows/build.yml`) and keeps the zips as a download.

---

## Using it

Open any VOD. Nothing else to do: muted parts play with sound whenever it can
still be found.

**Counter** (in the player's control bar, left of ⚙️):

| You see | Meaning |
|---|---|
| ⟳ `34%` | Checking the muted parts (the video already plays meanwhile) |
| 🔇 `34%` (red) | Still checking, but a sample spread over the whole VOD found nothing: the sound looks deleted in every quality |
| 🔊 `182 / 182` (green) | Every muted part is unmuted |
| 🔊 `150 / 182` (yellow) | Some parts can't be unmuted any more |
| 🔇 `0 / 182` (red) | Twitch deleted the sound of every muted part |

While checking, hovering the counter shows the progress, an **early
estimate** (from 24 segments spread over the VOD, ready in a few seconds) and,
for streams that ended more than 32 hours ago, a reminder that Twitch has
usually deleted the originals by then.

Opening a VOD again is much faster: files Twitch already deleted are
remembered and not checked again (a VOD with 1,026 muted segments, all
deleted: 85 s the first time, 2 s the next).

For a stream that ended **more than 36 hours ago**, if none of those 24
segments has its sound left, the rest isn't checked one by one: none of the 71
VODs we measured that old had any original left. It takes a few seconds
instead of a minute or more (205 muted segments: 24.5 s → 7.9 s), and the
panel says so. Any part you play is still checked at that moment.

Hover the counter (or click it to keep it open) for:
- a **verdict** when something is still muted, e.g. "Twitch deleted the
  original sound of 205 parts: the stream ended 12 days ago…", with a
  **Why?** link and a button to auto-save that channel's next VODs;
- the quality you're watching and how many parts were unmuted,
- how many used another quality or your saved copy,
- the **saved on this computer** status, with a button to delete it,
- the list of every muted part of the VOD (click any part to jump the player
  to it; press `Escape` to close the panel).

**Seek bar:** Twitch's red marks are replaced by **green** (sound restored),
**red** (still muted) and **yellow** (not checked yet: network problem,
retried automatically). The part you've already watched is drawn lighter.
Hovering a red part tells **why** it's still muted. Hover one to see its time, its length and **where its
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
| **Skip parts that stay muted** | Off | Automatically jumps the player past muted parts whose sound Twitch already deleted |
| **Save audio for later** | On | Keeps the sound of muted parts on this computer (see below) |
| **What to save** | Whole VOD | *Whole VOD*: every part that can still be unmuted, in the background. *Parts ahead of me*: only parts ahead of where you are. Nothing behind the player's position is downloaded (saving starts from it, nearest first). Once you've played 20 s at a position, saved copies of every part before it (watched or skipped) are removed; your furthest position is remembered per VOD |
| **Saved quality** | High | *Original*: lossless. *High*: 96 kbps. *Small*: 64 kbps. See [compression](#compression) |
| **Storage limit** | 1 GB | 250 MB to 5 GB, or no limit. When full, the oldest saved VODs are deleted first |
| **Delete saved audio after** | 60 days | 7 days, 30 days, 60 days, 6 months or never. Twitch keeps VODs at most 60 days |
| **Auto-save channels** | none | Channels whose new VODs are saved without playing them. See [below](#auto-save-channels) |
| **Open a Twitch tab if needed** | On | Lets auto-save open a small background Twitch tab when none is open |

---

## Saved audio

Twitch deletes the original audio of muted parts **about a day after the
stream ends** (see [the measurements](#how-long-twitch-keeps-the-original-audio)).
After that, the only way to hear those parts is a copy saved before.

**What gets saved:** only the sound of the muted parts, never the video. For
each muted part, the extension downloads the smallest file that still has the
original with full-quality sound:

| Twitch quality | File size (10 s) | Its sound |
|---|---|---|
| audio_only | 0.27 MB | Full quality: identical to Source |
| 480p / 720p / Source | 1.8 / 4.3 / 10.5 MB | Full quality: identical to Source |
| 360p | 0.9 MB | Much lower (≈ 67 kbps) |
| 160p | 0.4 MB | Much lower (≈ 50 kbps) |

So it tries audio_only first, then 480p, 720p, Source, and 360p/160p only as
a last resort. Measured: 40 muted segments saved in 2 seconds for 10.8 MB of
download. The same order is used when borrowing sound during playback, and
the tooltip says when sound comes from 360p/160p.

### Compression

Saving happens in two steps, so it never slows down what you're watching:

1. **While saving:** the original sound is stored losslessly compressed
   (deflate, about −13% to −20%).
2. **In the background, a few seconds later:** with *High* or *Small* quality,
   it's re-encoded to a lower bitrate with the browser's own AAC encoder
   (WebCodecs).

| Saved quality | Size per muted minute | Notes |
|---|---|---|
| Original | 1.1–2.4 MB | Lossless. Streams use 160 to 320 kbps audio, so size varies |
| **High** (default) | **≈ 0.75 MB** | 96 kbps. Measured: a 323 kbps stream went from 10.4 MB to 3.0 MB (−71%) |
| Small | ≈ 0.5 MB | 64 kbps |

Re-encoding is seamless: AAC encoders add about 44 ms of silence at the start
of every encode, which would leave a gap every 10 seconds. The extension
encodes each segment with the end of the previous one in front of it and cuts
exactly at the segment's start. The encoder's delay is measured on your machine
the first time. Tested result: the restored sound is in sync to the sample,
with no dip at the joins.

**Firefox can't encode AAC**, so there saved audio always stays in lossless
*Original* quality (1.1–2.4 MB per muted minute, 2–3× more than *High*): plan
a bigger storage limit. The popup and the counter's panel say so. Older uncompressed saves are compressed the next
time you open that VOD.

### Storage limit

Set in the popup (default 1 GB). When a new save doesn't fit, the **oldest
saved VODs are deleted first**. If the VOD you're watching doesn't fit on its
own, saving stops and the counter's panel says so. Compression frees space, so
saving resumes by itself when it can.

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
- In the **popup**, *Saved* tab: saved VODs grouped by channel (with a total and **Delete
  channel**). Each one says how much is saved and why the rest isn't (e.g.
  "94 / 108 parts saved · 14 deleted by Twitch before saving"), with buttons
  to **📌 pin** it (never deleted automatically), **⤓ export** it, or **✕**
  delete it. **Delete all** and **Back up…** are at the top. With no Twitch
  tab open, the list still shows (read-only). The popup needs an open Twitch tab,
  because the audio lives in twitch.tv's storage.
- Saves older than your **Delete saved audio after** setting are removed
  automatically.

### Backup and moving to another browser

Saved audio exists only in this browser, and it's the only copy left once
Twitch deletes the originals. **Back up…** in the popup opens a page on
twitch.tv where you can:

- **Export:** pick VODs and download them as one `.vodunmuter` file (same size
  as in storage, e.g. 31 MB for 253 segments).
- **Import:** load a `.vodunmuter` file, in this browser or another one
  (Chrome ↔ Firefox works). Segments already saved are kept as they are.
  Imported VODs count as saved on the import day for *Delete saved audio
  after*. VODs open in other tabs use the imported sound right away.

The page is `https://www.twitch.tv/robots.txt#vod-unmuter-backup`: it has to be
on twitch.tv because that's where the audio is stored.

---

## Auto-save channels

Add channels in the popup (name, `@name` or a twitch.tv link). Every 20
minutes the extension looks for VODs from those channels that are **live or
ended less than 36 hours ago**, and saves their muted parts without you
playing them. Live streams are included because Twitch mutes them while
they're still live; they're re-checked until they end.

- **Where it runs:** in an open Twitch tab, because saved audio lives in
  twitch.tv's storage and subscriber-only VODs need your Twitch login. If no
  Twitch tab is open, it opens `twitch.tv/robots.txt` (a tiny text page) in the
  background and closes it when done. Turn off *Open a Twitch tab if needed*
  to only use tabs you already have open.
- **Subscriber-only VODs:** saved if you're logged in to Twitch in this
  browser with a subscribed account, the same way the player gets access.
- **Suggestions:** channels whose VODs you saved but don't auto-save show as
  "+ channel" buttons. The counter's panel also offers to auto-save a channel
  when its VOD's originals are already gone.
- **Notifications** (off by default): one when auto-save saves a VOD, or
  can't (error, storage limit).
- **Toolbar icon:** shows "…" while auto-save runs, "!" when something needs
  attention (details in the menu).
- **Status:** the popup shows each channel's latest VOD, for example
  *Latest VOD: 181/181 saved (1 already deleted by Twitch) · 5 min ago*, and
  **Check now** runs a check immediately.
- **Limits:** the browser has to be running. A computer that's off or asleep
  for the whole day after a stream misses it. It always uses the *Whole VOD*
  mode, and follows your saved quality and storage limit.

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
4. **Auto-save** (`src/background.js`): a timer asks a Twitch tab to do steps
   2–3 for recent VODs of the chosen channels, without playing them.

It only reports on the quality you're actually watching, since each quality
can have a different amount left.

Technical notes:
- Twitch's player downloads video inside a Web Worker. The extension runs its
  hook inside that worker by wrapping `Worker` before the page loads.
- File checks use `GET` requests cancelled right after the headers, because
  `HEAD` requests fail at random on Twitch's CDN.
- Every muted segment is checked individually. Twitch deletes originals in a
  scattered way, with holes inside kept stretches and survivors inside deleted
  ones, so guessing from a few segments was measurably wrong (up to 17% of
  recoverable segments missed on one VOD). 24 segments spread over the VOD
  are checked first, only to show an early estimate; the rest follow in
  playback order, 48 requests at a time. Saving downloads 8 files at a time
  (253 segments saved in about 32 s instead of 76 s with 3).
- Files Twitch answered "not found" for are remembered per VOD (a separate
  `vod-unmuter-gone` database, segment numbers only, kept 90 days): a deleted
  original never comes back, so they're never checked twice.
- The audio splice works on the MPEG-TS packets directly (PAT/PMT, audio PID,
  continuity counters, timestamps). Audio is placed after the stream table so
  players recognize it from the first packet. It checks that the audio starts
  at the same time (±0.1 s) before using it. Output was verified with ffmpeg:
  the video stream is identical to Twitch's and the audio decodes with no
  errors.
- Re-encoded saves are stored as plain AAC frames and turned back into MPEG-TS
  packets (with the original timestamps) only when played.

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
stream ends**. It isn't one sudden deletion: blocks disappear one after
another over those hours, and lower qualities (160p, 360p) lose theirs first.
One VOD went from fully restorable to 181/182 within a few hours, and another
was down to 25 of 204 segments ten hours after the stream. VODs are muted while the stream is still live, so a long stream
already has muted parts before it ends.

**In practice:** open a VOD within about a day of the stream and leave *Save
audio for later* on.

---

## Other ways to get the audio back

We searched for other ways to recover audio after Twitch deletes the
originals (November 2026). In short: **there are none on Twitch's side.**

- **Every known tool uses the same files.** TwitchDownloader, twitch-dlp,
  VodRecovery and TwitchRecover all unmute by fetching the original `.ts`
  files instead of the `-muted` ones, or the `index-dvr.m3u8` playlist, which
  lists the same originals. twitch-dlp can also take the sound from another
  quality, like this extension. All of them stop working once Twitch deletes
  the files ([TwitchDownloader #1309](https://github.com/lay295/TwitchDownloader/issues/1309),
  [#210](https://github.com/lay295/TwitchDownloader/issues/210),
  [twitch-dlp](https://github.com/DmitryScaletta/twitch-dlp)).
- **The muted file has nothing left.** Its sound is replaced by digital silence
  (measured at −91 dB), not lowered.
- **If the streamer uses OBS's "Twitch VOD Track"**, music was never in the
  VOD in the first place, so even the originals are silent for it
  ([guide](https://github.com/Hyphen-ated/no-music-in-vods-tutorial)).
- **Outside Twitch:** clips made during the stream are separate files and may
  keep the sound for the moment they cover. Streamers' own YouTube uploads
  usually cut or replace the same music.

So saving the sound in time, which this extension does, is the only reliable
way. Others have built the same idea: a TwitchDownloader fork adds "saved clean
audio" playback ([pull request](https://github.com/pnsbadr/TwitchDownloader/pull/9)),
and another browser extension saves recovered parts as files
([Twitch-VOD-Unmute](https://github.com/Pouare514/Twitch-VOD-Unmute)).

---

## Privacy

- Everything happens in your browser. The extension doesn't send data
  anywhere, has no analytics and no server.
- Its only network requests go to Twitch: the same servers the player already
  uses for the VOD's video files, and Twitch's API to list a channel's VODs.
- For subscriber-only VODs, auto-save asks Twitch for access with your
  existing Twitch login, exactly as the player does. The login is read in the
  Twitch page and only ever sent to Twitch.
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

**"Storage limit reached" in the counter's panel**
The VOD doesn't fit in your limit. Raise *Storage limit*, choose a smaller
*Saved quality*, or delete older saves in the popup.

**Auto-save shows "subscriber-only"**
The VOD needs a subscription. Log in to Twitch in this browser with a
subscribed account.

**Auto-save says "Waiting for a Twitch tab to be open"**
*Open a Twitch tab if needed* is off and no Twitch tab is open. Open one, or
turn that setting on.

**Saved audio disappeared**
It's deleted along with twitch.tv's site data (clearing cookies / browsing
data, some privacy extensions or cleaners), and after the *Delete saved audio
after* delay. Use **Back up…** in the popup to keep a copy in a file.

**Checking takes a long time**
The first visit checks every muted segment in every quality: about a minute
for 1,000 muted segments. Hover the counter: after a few seconds it already
gives an estimate. The next visit to the same VOD is nearly instant.

**On an embedded player or m.twitch.tv the counter says "N muted"**
Twitch's video servers only give the original sound of muted parts to
www.twitch.tv: from `player.twitch.tv` (VODs embedded in other websites) and
`m.twitch.tv` they refuse it. Click the counter, then **Open on twitch.tv**.
On a phone, use "Request desktop site". Saved audio is also kept per site, so
it's only available on www.twitch.tv.

**The counter says "⚠ Not active"**
Twitch shows muted parts, but the extension couldn't get into Twitch's player.
Reload the page. If it keeps happening, another extension is probably starting
the player first: click **Copy diagnostic report** and open an issue.

**Reporting a problem**
The extension's menu shows a **Status** line (self-check) and has **Copy
diagnostic report**. It copies the version, browser, settings, this VOD's
result with reasons, and the last log lines (no tokens) to paste into a
GitHub issue. **Debug logging** in the menu logs every check, splice and
save to the console (F12).

**Something looks broken after a Twitch update**
Open the console (F12) and look for messages starting with `[VOD Unmuter]`. If
the player stops loading, turn off *Restore muted audio* and reload.

**Reading the console**
Type `VOD Unmuter` in the console's filter box to see only the extension's
lines. Each says where it comes from: `page`, `player` (Twitch's video player
worker), `auto-save` or `bridge`. It also names the VOD ("squeezie 2026-11-22
· Source") and, for a muted part, its place in the video ("part 242
(40:20–40:30)"). The summary of a check is a collapsed group: with *Debug
logging* on, click it to see every part, with each file asked and Twitch's
answer (`404`, `403`: deleted; `503` or "network error": not sure, asked again
later). In Chrome, debug lines need **Verbose** ticked in the console's levels
menu. The text after each line (for example `64ca7465-…:147:71`) is the
browser's link to the code that wrote it. In the player it's a random name,
because Twitch makes its worker from a Blob. The auto-save timer logs in its
own console: Chrome: `chrome://extensions`, then *service worker* under the
extension. Firefox: `about:debugging`, *This Firefox*, then *Inspect*.

---

## Testing

Unit tests (no browser, no network, under a second; Node 22 or later) cover
the code that needs no Twitch: MPEG-TS and ADTS parsing and splicing, saved
audio accounting, backup files, what the UI is told, and the built
`src/hook.js` run in a fake page and player worker:

```bash
cd test && npm run test:unit
```

The browser tests run the real extension on live Twitch VODs (found at run
time, since VODs age), in Chrome for Testing and Firefox.

```bash
cd test
npm install
npx playwright install chromium   # once
node twitch-check.cjs             # does Twitch still work as expected? (20 s)
node run.cjs --quick              # main tests (≈ 4 min)
node run.cjs                      # everything, Chromium + Firefox (≈ 15 min)
node run.cjs two-tabs backup      # only some tests
```

Every test also fails if the extension writes a warning or an error to the
console (page or player) that the test doesn't expect. See
[RELEASE.md](RELEASE.md) for the release checklist.

---

## Project files

```
CHANGELOG.md           What changed in each version
RELEASE.md             Release checklist
test/                  Browser tests (run.cjs), Twitch change detector
                       (twitch-check.cjs), unit tests (unit/), test fixtures
build.mjs              Builds dist/ for Chrome and Firefox (folders + zips):
                       puts src/hook.js together from its modules, checks it
manifest.json          Extension manifest (Manifest V3, Chrome + Firefox)
package.json           npm scripts (build, lint, start:*, tests) and web-ext
web-ext-config.mjs     web-ext settings (lint, run)
.github/workflows/     CI: build and lint on every push and pull request
src/hook.js            Runs in the page and in the player's worker. A template:
                       the build replaces its "// @include" lines with:
  shared/              constants, shared state, logging
  media/               MPEG-TS (find, extract, splice audio), ADTS <-> TS,
                       compression (deflate, AAC re-encoding with WebCodecs)
  storage/             IndexedDB: saved audio, deleted-files cache, backups
  recovery/            checking muted parts, what the UI is told, saving,
                       auto-save
  player/              playlist and segment requests, channel messages,
                       getting the hook into the player's worker
  messaging/           the page's side of bridge.js
src/ui.js              Counter, panel, seek bar colors, hover details, backup
                       page. A template put together from:
  ui/                  dom, state, backup-page, diagnostics, explanations,
                       panel, seekbar
src/bridge.js          Passes settings, popup and auto-save requests to the page
src/background.js      Auto-save timer: finds recent VODs, picks a Twitch tab
popup/                 Settings, saved-audio manager, first-run page, shared
                       channel input helper (channel-form.js)
icons/                 Extension icons (16, 32, 48, 128 px)
art/                   Logo sources (SVG), 512 px logo, store images (1280x800,
                       440x280); original-*: alternative logo without Twitch's shape
```
