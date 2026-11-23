# Plan for 1.3

Goal: fewer surprises. Most complaints about an unmuter come from one
question: *"why is this still muted?"* When the extension says clearly what
happened and why, there's nothing to complain about. So 1.3 is mostly about
reliability and explanations, then a few features.

Four phases, in this order:

1. [Bug fixes](#phase-1-bug-fixes)
2. [Reliability and explanations](#phase-2-reliability-and-explanations)
3. [Features](#phase-3-features)
4. [Testing and release](#phase-4-testing-and-release)

Effort: S = a day or less, M = a few days, L = a week or more.

---

## Phase 1: bug fixes

**Status: done** (see CHANGELOG.md, 1.3.0). Results:
- **B1, B2, B3, B7:** fixed and tested.
- **B4:** not caused by this extension. Without TwitchNoSub, Twitch gives the
  same error for a subscriber-only VOD with or without the extension
  (`vod_manifest_restricted`). The 404 most likely comes from TwitchNoSub
  replacing the master playlist.
- **B5:** the extension now runs in a temporary Firefox profile (Selenium +
  geckodriver), with console capture. Moving every test there is phase 4.
- **B6:**
  - two tabs on the same VOD: OK;
  - storage full: fixed;
  - embedded player and mobile site: Twitch refuses the originals there, so
    the extension now says so instead of reporting everything deleted;
  - very long VODs: OK (1,026 muted segments);
  - not tested yet: private windows, extension update with Twitch tabs open.

Found in a real Firefox console log (Squeezie VOD 2937494566, with TwitchNoSub
installed) and in parts of the code that were never tested outside Chromium.

| # | Problem | What we know | Fix | Effort |
|---|---|---|---|---|
| B1 | **Every quality gets a full check.** The log shows the same "416/420" line five times (Source, 720p60, 480p30, 360p30, 160p30) | Each media playlist the player (or another extension) loads starts its own full check: up to 5× the requests and 5× the log lines | Fully check only the quality being played. Other qualities wait, and reuse the shared "found / deleted" answers when played | M |
| B2 | **Firefox can't re-encode to AAC, and nobody is told.** Log: `this browser cannot re-encode AAC: saved audio stays lossless` | Firefox has no AAC encoder. *High* and *Small* quality silently keep lossless audio there: 1.1 to 2.4 MB per muted minute instead of about 0.75, so the storage limit fills 2–3× faster. The popup, README and store text all promise 0.75 MB | Popup: mark High/Small as "not available in Firefox: saved lossless". Use a per-browser size in the storage estimates. Correct the README and store text | S |
| B3 | **Synchronous request warning.** Log: `L'utilisation d'XMLHttpRequest de façon synchrone…` | `src/hook.js:1630` reads Twitch's worker code synchronously every time a player starts, even when the Blob hook already added ours | Remember the Blob URLs we already hooked and skip the read for them. The sync read then only happens in the rare fallback case | S |
| B4 | **"Player stopping playback - error MasterPlaylist:11 (code 404)", twice** | Comes from Twitch's player before any extension message; it then played fine. Unknown whether TwitchNoSub, Twitch or this extension causes it | Reproduce with: no extensions / only this one / only TwitchNoSub / both. Fix only if it's ours | S |
| B5 | **Never tested in Firefox itself** | Every automated test so far ran in Chromium. B2 is a Firefox-only bug that the tests could not have found | Run the whole test set in Firefox too (see phase 4) | M |
| B6 | **Untested situations** | m.twitch.tv; player.twitch.tv embeds on other sites; the same VOD open in two tabs (two saves at once); storage full (quota error); private windows (no IndexedDB); extension updated while Twitch tabs are open; very long VODs (2,000+ muted segments); slow or unstable connections | Test each one, fix what breaks, and document what can't work (e.g. private windows) | M |
| B7 | **Network errors may count as "deleted"** | A probe retries 3 times, then reports "not found" for any failure. A timeout or 5xx is not a deletion, but it ends up looking like one | Only 403/404/410 mean "deleted". Timeouts and 5xx stay "unknown": retried later and never remembered as deleted | S |

---

## Phase 2: reliability and explanations

**Status: done** (see CHANGELOG.md, 1.3.0). Changes from the plan:
- The debug log prefixes each line with the channel and quality instead of
  grouping with `console.groupCollapsed`: checks run in parallel, so groups
  would interleave.
- A damaged saved copy is reported ("saved copy unusable") and kept muted,
  not deleted and saved again.
- Subscriber-only VODs: Twitch's player already shows its own message, so the
  extension adds none.

### 2.1 Why *this part* is still muted

Today a muted part only says "still muted". Each muted segment will carry a
**reason**, shown in the seek bar tooltip and the panel list:

| Reason | Text for the user |
|---|---|
| Deleted everywhere | "Twitch deleted the original sound in every quality (checked: Source, 720p60, 480p, audio only…)" |
| Not checked (old VOD) | "Not checked one by one: the stream ended 3 days ago and Twitch deletes the originals 13–32 h after a stream" |
| Network problem | "Couldn't reach Twitch's video servers. Will retry" |
| Couldn't splice | "Found the sound but couldn't fit it in (timing didn't match). Kept muted to avoid a glitch" |
| Saved copy unreadable | "Your saved copy of this part is damaged. Deleted, will be saved again if possible" |
| Not saved in time | "Wasn't saved before Twitch deleted it (VOD opened N hours after the stream)" |

Effort: M.

### 2.2 Why *the whole VOD* isn't unmuted

A one-line verdict at the top of the panel, picked from what is known:

- "Twitch deleted the original sound: this stream ended 3 days ago, and Twitch
  deletes it 13 to 32 hours after a stream. Only audio saved earlier can help.
  **Add squeezie to auto-save** so the next VOD is saved in time."
- "Saving was off when you watched this VOD."
- "Storage limit reached: 120 of 420 parts saved. Raise the limit or delete
  old saves."
- "Subscriber-only VOD: log in with a subscribed account."
- **"VOD Unmuter couldn't reach Twitch's player."** The page shows muted parts
  (Twitch's red seek bar marks) but the extension never heard from the player
  within ~10 s. Usually another extension started the player first. Shows
  "reload the page; if it keeps happening, report it with the diagnostic
  report". This is exactly the TwitchNoSub case from before: users saw
  *nothing at all* and had no clue why.

Effort: M.

### 2.3 Console logging

| Now | 1.3 |
|---|---|
| 9 `console` calls, plain text, some errors swallowed silently (`catch (e) {}`) | One logger with levels (error / warn / info / debug). Every caught error goes through it with context (VOD, segment, quality, URL without tokens) |
| One summary line per quality (5 identical lines on one VOD) | One summary per VOD: quality watched, restored / muted, and a breakdown of reasons (e.g. `416 restored · 4 deleted everywhere · 0 errors`) |
| Worker and page messages look the same | Prefixed `[VOD Unmuter · player]` / `[VOD Unmuter · page]` / `[VOD Unmuter · auto-save]` |
| Nothing for debugging without code changes | **Debug logging** switch in the popup (off by default): every probe, splice and save, grouped per VOD with `console.groupCollapsed` |

Effort: M.

### 2.4 Diagnostic report

A **Copy diagnostic report** button in the panel and the popup. It copies a
short text for a GitHub issue:
- extension version, browser and version;
- settings;
- VOD id and quality;
- counts per reason;
- the last 50 log lines (from an in-memory ring buffer);
- self-check results (2.5).

No login token and no browsing history. URLs are shortened to the VOD
folder. Effort: S.

### 2.5 Self-check

Run once per page load, shown in the popup as **Status: OK** or a list of
problems, and included in the diagnostic report:
- browser storage (IndexedDB) available? It isn't in private windows.
- AAC re-encoding available? (B2)
- the hook reached Twitch's player? (2.2)
- auto-save: last run, last error, Twitch tab available?

Effort: S.

### 2.6 Set expectations before people are disappointed

- **First-run page** after install: what the extension can do, the 13–32 hour
  window, why auto-save matters, one button to add channels. Effort: S.
- Panel and popup texts link to the matching README section ("Why?").
  Effort: S.
- A short FAQ added to the store descriptions: "Why is this old VOD still
  muted?", "Does it work with subscriber-only VODs?", "Why does saving use
  more space in Firefox?". Effort: S.

---

## Phase 3: features

**Status: done**, except *auto-save your follows*: Twitch's API refuses to
list follows without its own signed requests, even logged in. Suggestions
from saved VODs replace it. See CHANGELOG.md.

### Save more VODs in time

| Feature | What it does | Effort |
|---|---|---|
| **Auto-save your follows** | One button in the popup adds every channel you follow on Twitch to auto-save. Optionally keeps the list in sync | S |
| **Suggest auto-save** | When a VOD's originals are already gone, the panel offers to add that channel to auto-save (see 2.2) | S |
| **Auto-save notifications** | Optional browser notification when auto-save finishes ("Saved 182 muted segments from wankil's VOD") or fails (storage limit, subscriber-only, no Twitch tab) | S |
| **Badge on the toolbar icon** | Shows when auto-save is running or needs attention | S |

### Clearer while checking

| Feature | What it does | Effort |
|---|---|---|
| **Live seek bar** | Fills while checking: grey = not checked yet, green = restored, red = gone | S |
| **Panel while checking** | Clicking the counter during a check opens the panel with what's known so far | S |
| **"Partly saved" in the list** | The popup's saved list shows how much of each VOD is saved (e.g. 182 / 204) and why the rest isn't | S |

### Saved audio

| Feature | What it does | Effort |
|---|---|---|
| **Per-VOD export** | An export button on each saved VOD, in the popup and in the player's panel | S |
| **Pin a VOD** | Pinned VODs are never deleted by *Delete saved audio after* or by the storage limit | S |
| **Storage use per channel** | Saved VODs grouped by channel, with a total for each and "delete this channel" | S |
| **Saved list without a Twitch tab** | The popup can list saved VODs with no Twitch tab open (deleting and exporting still need one) | M |

---

## Phase 4: testing and release

**Do the tests read the console?** Until now, only partly. Some test scripts
printed the extension's own messages from the player, but none collected
*every* console message or failed on warnings and errors. And since they all
ran in Chromium, Firefox-only messages like B2 were never seen. From 1.3:

| Item | What it does | Effort |
|---|---|---|
| **Tests in the repository** | The browser tests from development (competing extension, timing, saving and compression, backup, growing playlist, VOD switching, old-VOD shortcut) move into `test/`, run with one command | M |
| **Console check in every test** | Collect every console message from the page and the player worker. A test fails on any `[VOD Unmuter]` error or warning, and on uncaught exceptions from our scripts. Twitch's own noise (ads CORS, CSS, GraphQL) is ignored by a filter | S |
| **Firefox runs** | The same tests in Firefox (Playwright's Firefox or `web-ext run`) | M |
| **With other extensions** | Run with TwitchNoSub-like and ad-blocker-like Worker wrappers installed, in both load orders | S |
| **Twitch change detector** | Before each release, a quick check that Twitch's player, playlists and video servers still behave as expected | S |
| **Release checklist** | Version bump, changelog, store texts, `web-ext lint`, Chrome and Firefox zips, both browsers tested by hand on one VOD | S |
