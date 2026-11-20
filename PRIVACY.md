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
- **Everything:** uninstall the extension and clear twitch.tv's site data.

## Contact

Questions or concerns: open an issue at
<https://github.com/noahbds/vod-unmuter-extension/issues>.

## Changes

If this policy changes, the new version will be published at this address
with a new date.
