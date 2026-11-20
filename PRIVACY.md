# Privacy policy: Twitch VOD Unmuter

*Last updated: November 20, 2026*

Twitch VOD Unmuter is a browser extension that restores the sound in muted
parts of Twitch VODs. This policy explains what data it handles. In short:
**everything stays in your browser. The extension has no server, sends
nothing to its developer or to anyone other than Twitch, and contains no
analytics, ads or tracking.**

## What the extension handles, and why

| Data | Why | Where it goes |
|---|---|---|
| **Twitch video files** of the VODs you open (playlists and 10-second video segments) | To find and play the original, unmuted audio | Downloaded from Twitch's servers, like the Twitch player does |
| **Saved audio** of muted parts | So a VOD stays unmuted after Twitch deletes the originals (about a day after the stream) | Stored only in your browser, in twitch.tv's local storage (IndexedDB). Never uploaded |
| **List of deleted Twitch files** (VOD folder name and the numbers of segments Twitch no longer has) | So opening the same VOD again doesn't re-check files that can't come back | Stored only in your browser, in twitch.tv's local storage (IndexedDB). Never uploaded. Removed after 90 days |
| **Backup files** of saved audio | Only when you click *Download backup*, to keep a copy or move it to another browser | Saved by your browser to your downloads folder. The extension never uploads them; importing reads the file you pick, locally |
| **Your Twitch login token** (the `auth-token` cookie Twitch sets when you log in) | Only for auto-save of subscriber-only VODs: to ask Twitch for access to a VOD, exactly as the Twitch player does | Read inside the twitch.tv page and sent only to Twitch (`gql.twitch.tv`). Never stored or sent anywhere else |
| **Your settings** and **auto-save channel list** | To remember your choices | Your browser's extension storage. If you use your browser's sync feature, your browser syncs them to your own account |
| **Auto-save status** (which recent VODs were checked and how much was saved) | To show the status in the extension's menu | Your browser's extension storage, on this device only |

## What the extension does not do

- It does not collect, sell, share or transfer any data to the developer or
  to third parties.
- It does not track your browsing. It only runs on twitch.tv.
- It does not use cookies of its own, analytics, advertising or fingerprinting.
- It does not use data for any purpose other than restoring and saving VOD
  audio.

## Network requests

The extension only contacts Twitch:

- `www.twitch.tv`, `m.twitch.tv`, `player.twitch.tv`: the Twitch pages it runs
  on.
- `usher.ttvnw.net` and Twitch's video servers (CloudFront): VOD playlists and
  video segments.
- `gql.twitch.tv`: Twitch's API, to list recent VODs of the channels you add
  to auto-save, and to get access to a VOD.

## Deleting your data

- **Saved audio:** use *Delete* or *Delete all* in the extension's menu, or
  clear twitch.tv's site data in your browser. Saved audio is also deleted
  automatically after the period you choose (60 days by default) and when the
  storage limit is reached.
- **List of deleted Twitch files:** removed automatically after 90 days, or
  by clearing twitch.tv's site data.
- **Backup files:** they are ordinary files in your downloads; delete them
  like any other file.
- **Everything:** uninstall the extension and clear twitch.tv's site data.

## Contact

Questions or concerns: open an issue at
<https://github.com/noahbds/vod-unmuter-extension/issues>.

## Changes

If this policy changes, the new version will be published at this address
with a new date.
