# Chrome Web Store listing: texts to paste

Each section matches a field of the developer dashboard.

---

## Fiche produit (Store listing)

**Catégorie:** Outils (or Divertissement)
**Langue:** anglais

### Description

```
Twitch VOD Unmuter brings back the sound in the muted parts of Twitch VODs.

When Twitch mutes part of a VOD (usually because of music), it keeps the original audio on its servers for a while: until about a day after the stream ends. Twitch VOD Unmuter finds that audio and plays it right in the normal Twitch player. It can also save it on your computer, so the VOD stays unmuted after Twitch deletes the originals.

FEATURES

• Automatic: open a VOD and the muted parts play with sound. Nothing to click.
• Every quality as a backup: Twitch keeps a separate copy per quality and deletes them separately. If the quality you watch lost a part, the sound is taken from another quality, and the picture stays in yours.
• Counter in the player, next to the settings button: how many muted parts were unmuted. Hover it for details and the list of every muted part.
• Green seek bar: unmuted parts in green, still-muted parts in red. Hover one to see its time, where its sound comes from, whether it's saved, and why it's still muted if it is.
• Clear explanations: the counter's panel says why a VOD isn't fully unmuted (e.g. "Twitch deleted the original sound: the stream ended 3 days ago") and offers to auto-save that channel's next VODs.
• Fast: an estimate within seconds, then every muted part is checked. VODs whose sound Twitch deleted long ago are recognized in seconds, and opening a VOD again is almost instant.
• Save audio for later: keeps the sound of muted parts on your computer, compressed in Chrome, Edge and Brave (about 0.75 MB per muted minute; Firefox keeps it lossless, 1.1 to 2.4 MB), with a storage limit and automatic deletion after the delay you choose. Save the whole VOD, or only the parts ahead of where you are (handy when you resume a stream you watched live).
• Saved audio in the menu: grouped by channel, pin the VODs to keep forever, export one VOD to a file.
• Auto-save channels: add your favorite channels, and their new VODs (and live streams) are saved without you opening them. Optional notifications when it's done.
• Backups: export your saved audio to a file and import it again, in the same browser or another one.

GOOD TO KNOW

• Restoring only works while Twitch still has the original audio (roughly 13 to 32 hours after a stream ends), or if the extension saved it before. That's what auto-save is for.
• Works on VODs of streams that are still live.
• Subscriber-only VODs work when you're logged in to Twitch with a subscribed account.
• Twitch VOD Unmuter is not affiliated with or endorsed by Twitch.

FAQ

Why is this older VOD still muted?
Twitch deletes the original sound of muted parts 13 to 32 hours after a stream ends. After that, only audio the extension saved before can restore it. Add the channels you watch to auto-save so their next VODs are saved in time. Hover a red part of the seek bar to see why it is still muted.

Does it work with subscriber-only VODs?
Yes, when you're logged in to Twitch with a subscribed account.

Why does saving use more space in Firefox?
Firefox can't compress audio to AAC, so saves stay lossless there (about 1.1 to 2.4 MB per muted minute instead of 0.75).

Why doesn't it work on embedded players or the mobile site?
Twitch only gives the original sound to www.twitch.tv. The counter offers to open the VOD there.

Something is wrong?
The extension's menu shows a status line and has a "Copy diagnostic report" button to paste in a GitHub issue.

PRIVACY

Everything stays in your browser. No account, no server, no analytics, no tracking. The extension only talks to Twitch. Privacy policy: https://github.com/noahbds/vod-unmuter-extension/blob/main/PRIVACY.md
```

### Images

| Field | File |
|---|---|
| Icône du magasin (128×128) | `icons/icon-128.png` |
| Captures d'écran (1280×800, up to 5, in this order) | `art/store-1280x800.png`, `art/screenshot-1-seekbar.png`, `art/screenshot-2-tooltip.png`, `art/screenshot-3-saved.png`, `art/screenshot-4-settings.png` (or `art/screenshot-5-autosave.png`) |
| Petite image promotionnelle (440×280) | `art/store-440x280.png` |
| Bannière extra large (1400×560, optional) | `art/store-1400x560.png` |

### URLs

- **URL de la page d'accueil:** `https://github.com/noahbds/vod-unmuter-extension`
- **URL de l'assistance:** `https://github.com/noahbds/vod-unmuter-extension/issues`

**Contenu réservé aux adultes:** leave unchecked.

---

## Confidentialité (Privacy practices)

### Description de l'objectif unique

```
Restore the audio of muted segments in Twitch VODs. The extension plays Twitch's original, unmuted audio in the Twitch player while it still exists, and keeps a local copy of it so the VOD stays unmuted after Twitch deletes the originals. All its features (unmute counter, seek bar colors, saving, auto-save of chosen channels, backup and restore of saved audio) serve this single purpose.
```

### Justification de l'autorisation storage

```
Stores the user's settings (on/off switches, saved audio quality, storage limit, how long saved audio is kept), the list of channels the user added to auto-save, and the auto-save status shown in the extension's menu. Nothing is sent anywhere.
```

### Justification de l'autorisation notifications

```
Optional, off by default: when the user turns on "Notifications" in the extension's menu, it shows a notification when auto-save has saved the muted parts of a VOD from a channel the user chose, or could not save them (storage limit, subscriber-only VOD). Nothing else is ever notified.
```

### Justification de l'autorisation alarms

```
Runs the auto-save check every 20 minutes, only when the user has added channels to auto-save. Twitch deletes the original audio of muted VOD parts about a day after a stream, so the extension must check periodically for new VODs of those channels and save their audio in time, even when the user doesn't open them.
```

### Justification de l'autorisation d'accès à l'hôte

```
www.twitch.tv, m.twitch.tv and player.twitch.tv: the content scripts run on Twitch's VOD player to replace muted video segments with the original audio, to show the unmute counter and seek bar colors, and to store saved audio in twitch.tv's local browser storage (and export or import it on a twitch.tv page, since that's where it is stored). gql.twitch.tv: the background script asks Twitch's API for the recent VODs of the channels the user added to auto-save. The extension runs on no other website and contacts no server other than Twitch.
```

### Consommation des données (what to tick)

| Category | Tick? | Why |
|---|---|---|
| Informations permettant d'identifier personnellement l'utilisateur | No | |
| Information sur la santé | No | |
| Informations financières et de paiement | No | |
| **Informations d'authentification** | **Yes** | Auto-save reads the Twitch login token in the twitch.tv page to get access to subscriber-only VODs. It's sent only to Twitch, never stored or shared |
| Communications personnelles | No | |
| Localisation | No | |
| Historique Web | No | |
| Activité de l'utilisateur | No | |
| **Contenu du site Web** | **Yes** | The audio of Twitch VODs is saved locally in the browser |

Tick all three certifications ("Je ne vends ni ne transfère…", "Je n'utilise ni ne transfère…" ×2): they're all true.

### Règles de confidentialité (privacy policy URL)

```
https://github.com/noahbds/vod-unmuter-extension/blob/main/PRIVACY.md
```

This only works once `PRIVACY.md` is pushed to GitHub and the repository is public.

---

# Firefox Add-ons (addons.mozilla.org)

### Summary (250 characters max)

```
Restores the sound in muted parts of Twitch VODs, using Twitch's original audio while it still exists. Saves it on your computer so VODs stay unmuted after Twitch deletes the originals, and can auto-save your favorite channels.
```

### Description (Markdown, 250 first characters matter most)

```
**Brings back the sound in the muted parts of Twitch VODs.** Twitch keeps the original audio for about a day after a stream: VOD Unmuter plays it right in the normal Twitch player, and can save it so the VOD stays unmuted after Twitch deletes it.

**How it works**

* **Automatic:** open a VOD and the muted parts play with sound. Nothing to click.
* **Every quality as a backup:** Twitch keeps a separate copy per quality and deletes them separately. If yours lost a part, the sound comes from another quality; the picture stays in yours.
* **Counter in the player**, next to the settings button: how many muted parts were unmuted, with details and the list of every muted part.
* **Green seek bar:** unmuted parts in green, still-muted ones in red. Hover a part to see where its sound comes from, whether it's saved, and why it's still muted if it is.
* **Clear explanations:** the panel says why a VOD isn't fully unmuted (e.g. "the stream ended 3 days ago, Twitch deletes the sound 13 to 32 hours after a stream").

**Keep the sound for later**

* **Save audio:** the whole VOD, or only the parts ahead of where you are (handy to resume a stream you watched live). Storage limit and automatic cleanup. In Firefox, saved audio stays lossless (1.1 to 2.4 MB per muted minute).
* **Auto-save channels:** new VODs of the channels you choose are saved in the background, even if you don't open them. Optional notifications.
* **Saved audio list:** grouped by channel, pin the VODs to keep, export to a file and import it in another browser.

**Good to know**

* Restoring only works while Twitch still has the original audio (13 to 32 hours after a stream), or if it was saved before. That's what auto-save is for.
* Subscriber-only VODs work when you're logged in with a subscribed account.
* Embedded players and the mobile site can't be unmuted: Twitch only gives the original sound to www.twitch.tv.
* Not affiliated with or endorsed by Twitch.

**Privacy:** everything stays in your browser. No account, no server, no analytics, no tracking. The extension only talks to Twitch.
```

### Other fields

| Field | Answer |
|---|---|
| Ce module est expérimental ? | No |
| Nécessite un paiement… ? | No |
| Catégories (up to 3) | **Photos, musique et vidéos** · **Jeux et divertissements** |
| E-mail d'assistance | Optional: leave empty, or an address you want to make public |
| Site d'assistance | `https://github.com/noahbds/vod-unmuter-extension/issues` |
| Licence | **Licence MIT** (same as the `LICENSE` file) |
| Ce module a une politique de confidentialité ? | Yes: paste the content of `PRIVACY.md` |

### Notes aux testeurs (reviewer notes)

```
Nothing is minified, transpiled or renamed, and there is no third-party code or bundler. build.mjs (plain Node, no dependencies) copies popup/, icons/, LICENSE and src/*.js into dist/firefox and writes the Firefox manifest (background "scripts" instead of a service worker, plus browser_specific_settings). The one assembled file is src/hook.js: its source is split into readable modules (src/shared, src/media, src/storage, src/recovery, src/player, src/messaging), and build.mjs puts each module in place of its "// @include" line in the src/hook.js template, removing only the "import" lines and "export" keywords. Each module starts with a "// ---- src/<module> ----" banner, so the uploaded hook.js reads as the source files in order. To rebuild: node build.mjs (Node 18+), which gives the same files. Source repository: https://github.com/noahbds/vod-unmuter-extension

How to test (no Twitch account needed):
1. Open a Twitch VOD that ended less than ~10 hours ago and has muted parts (red marks on the seek bar). Muted parts play with sound; a counter "restored / muted" appears next to the player's settings button.
2. Open an older VOD (several days): the counter shows 0 / N and its panel explains that Twitch already deleted the original audio.
3. Extension menu: settings, auto-save channels, saved audio, Help (status, diagnostic report).

Why some code looks unusual:
- src/hook.js runs in the page (content script, world MAIN) and must also run inside Twitch's video player, which is a Web Worker created from a Blob. It wraps window.Worker and window.Blob to prepend its own code (the same file, minus the part between /* vu:page-only:start */ and /* vu:page-only:end */, which only the page uses) to the player worker. Nothing else is changed in Twitch's code.
- It fetches Twitch's own files (playlists and 10-second video segments from Twitch's CDN) to find the original, unmuted audio, and splices that audio into the muted segments (MPEG-TS packets, in JavaScript).
- gql.twitch.tv is called with Twitch's public web client id (the one twitch.tv itself uses) to list recent VODs of the channels the user adds to auto-save. For subscriber-only VODs, the user's Twitch "auth-token" cookie is read in the twitch.tv page and sent only to gql.twitch.tv to get a playback token, exactly like Twitch's player.
- Auto-save may open https://www.twitch.tv/robots.txt in a background tab (and close it) when no Twitch tab is open, because saved audio lives in twitch.tv's IndexedDB.
- No remote code, no eval, no analytics. Data stays in the browser (see the privacy policy).
```

### Release notes for version 1.3.0

```
Explanations:
• Hover a muted part of the seek bar to see why it's still muted (deleted by Twitch, network problem, …) and whether it's saved.
• The counter's panel says why a VOD isn't fully unmuted, with a button to auto-save that channel's next VODs.
• "Not active" warning when another extension keeps VOD Unmuter out of Twitch's player.
• The menu shows a status, and "Copy report" makes a diagnostic report for bug reports (no personal data).

New:
• Redesigned menu with tabs: Settings, Auto-save, Saved, Help.
• "Parts ahead of me": save only the muted parts ahead of where you are; parts behind are never downloaded, and their copies are removed.
• Saved audio grouped by channel; pin a VOD to keep it forever; export one VOD; list visible without a Twitch tab.
• Auto-save: suggestions, optional notifications, status on the toolbar icon.
• Live checking: the seek bar fills in while the VOD is checked.
• A first-run page explaining what the extension can and can't do.

Fixes:
• The counter could show another tab's VOD, or jump between two results.
• Network errors no longer make parts look deleted; they're retried.
• Embedded players and the mobile site now say why they can't be unmuted (Twitch only gives the original sound to www.twitch.tv).
• Firefox: saved quality is Original (Firefox can't compress audio), said clearly.
• Storage full, VODs still recording, removed auto-save channels: handled properly.
```

### Privacy policy

Paste the content of `PRIVACY.md`, or link to it.
