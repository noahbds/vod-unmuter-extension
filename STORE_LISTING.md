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

### Description

Same text as the Chrome Web Store description above.

### Categories

Photos, Music & Videos (or Social & Communication)

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
