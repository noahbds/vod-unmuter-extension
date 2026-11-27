# Changelog

## 1.6.0

In the player:
- **Mixed MP4 ↔ MPEG-TS recovery on Enhanced Broadcasting VODs.** High qualities
  streamed as fragmented MP4 (`1440p60` / `chunked` HEVC/AV1) can now borrow
  sound from `.ts` qualities (`audio_only`, `720p60`, `480p30`) and save directly
  from `audio_only/*.ts` (~40× smaller downloads than full `.mp4` video
  segments), and `.ts` qualities can borrow sound from `.mp4` qualities. Each
  donor quality's container is detected with at most one cached `init-0.mp4`
  check per VOD (`0` extra requests on pure `.ts` VODs).
- **Playhead-priority checking on long VODs.** After the initial 24-segment
  spread sample, segments at and ahead of your current playback position are
  checked first (wrapping around to `0:00` afterward), so seeking deep into a
  long VOD resolves the seek bar around you right away.
- **Live seek-bar hover details & smart auto-skip while checking.** Hovering
  green, red or grey parts of the seek bar now shows details while the VOD is
  still being checked, and *Skip parts that stay muted* skips confirmed deleted
  stretches without waiting for the whole VOD check to finish (holding briefly
  if an adjacent part is still pending so contiguous stretches skip in one jump).
- **Skip-muted notification with *Undo*.** When *Skip parts that stay muted*
  jumps forward, a brief pill (`Skipped 40:20 – 42:10 (still muted) · Undo`)
  explains why playback jumped and lets you jump back in one click.
- **Pin, *Save this VOD*, active-part highlight and `‹ Prev` / `Next ›` in the
  panel.** Pin a VOD (`📌`), trigger a one-off full save even when global saving
  is off or set to *"Parts ahead of me"*, see the currently playing muted range
  highlighted in the list, and step between muted stretches. Panel height adapts
  to short split-screen players, and Theatre / Fullscreen control rebuilds
  re-mount the counter and seek bar immediately via `MutationObserver`.

Saved audio, backups and auto-save:
- **Backups keep `📌` pins and can include settings & auto-save channels.**
  Importing a `.vodunmuter` file now preserves pinned VODs so automatic cleanup
  never removes them, and backups can optionally export and restore your
  settings and auto-save channel list.
- **Clean up VODs Twitch already deleted.** The *Saved* tab checks saved VOD IDs
  in batches, marks VODs that no longer exist on Twitch (`deleted on Twitch`),
  and offers a one-click **Clean up** button for unpinned deleted VODs.
- **Storage bar breakdown, search filter & offline compression.** The storage
  bar distinguishes pinned vs. evictable space and warns when the browser's
  origin quota is lower than your limit; a live filter appears when 6+ VODs are
  saved; and **Compress lossless saves** on the backup page (or lowering *Saved
  quality* in the menu) re-encodes older lossless saves offline with zero
  network requests. WebCodecs AAC compression also falls back to raw
  `mp4a.40.2` output wrapped in ADTS headers when native ADTS output isn't
  supported.
- **Faster, more resilient auto-save.** Channel checks are batched into
  15-channel GraphQL queries instead of one request per channel, you can paste
  multiple channel names or links at once, auto-save checks `/vod/v2/` with
  HEVC/AV1 codecs enabled, and *Check now* pings open Twitch tabs to clear stale
  locks if an earlier tab closed or hung.

Behind the scenes:
- **Bounded memory, SPA VOD-switch fixes & hot-path optimizations.** Idle VOD
  maps (`playlists`, `known`, `mp4Inits`, `renditions`, `segments`) are evicted
  on SPA navigation and after auto-save runs; instant `0.0 s` cached checks on
  SPA VOD switches are no longer cleared by the next UI tick (fixing false
  `"Not active"` / `"unreachable"` warnings); master-playlist qualities are
  shared across multiple player workers; cancelled pre-roll ad playlists
  (`AbortError`) no longer log playlist errors; segment lookups use `O(1)`
  `job.byNum`; watched-part deletions batch into a single IndexedDB transaction;
  MP4 `moof` fragments write in one pass; MPEG-TS header parsing enforces strict
  188-byte packet bounds; and worker injection decodes binary `Uint8Array`
  `Blob`s without sync XHR and supports `{ type: 'module' }` workers.
- **Zero-dead-code build gate & new unit tests.** `node build.mjs` now fails on
  unused imports, unreferenced top-level declarations, or unneeded module
  exports across `src/` and `popup/`, alongside new unit tests covering mixed
  `.mp4`↔`.ts` recovery, batched GQL auto-save, stale-lock recovery, playhead
  scan priority, memory eviction, and backup/compression upgrades.

## 1.5.0
### 1.5.0 adds clickable muted segments, automatic skipping of unrecoverable muted audio, improved UI and accessibility, fixes VOD detection, and restores original audio in fragmented MP4 streams (HEVC/AV1), with enhanced diagnostics.
In the player:
- **Click any muted part in the panel to jump to it.** Each line under *Muted
  parts of this VOD* (`40:20 – 40:30`) now seeks the video to that moment
  (also works with the keyboard: `Tab`, then `Enter` or `Space`).
- **Fix: the checking spinner (`⟳ 29%`) reset every 250 ms.** Each progress
  update rebuilt the counter button and restarted the 800 ms spin animation at
  the top (~112° per tick), so it twitched on the right side instead of
  spinning. The button and its spinner now stay mounted in the DOM while the
  percentage and panel update in place.
- **Fix: panel and counter alignment.** The open panel no longer overlaps the
  seek bar above the control row; values in the top stats table (*Source*,
  *279*, *0*, *46m 41s / 46m 41s*) align flush right with the muted parts list
  below; the speaker icon is vertically centered with the counter digits;
  *Delete saved audio* and *Export to a file* align to the left and right
  edges; and reopening an already-saved VOD shows its saved size (`· XX MB`).
- **Skip parts that stay muted** (off by default, under *In the player* in the
  menu). When a VOD has muted stretches whose sound Twitch already deleted,
  the player jumps straight past them (`r.start` → `r.end`). Parts still being
  checked or waiting for a network retry are not skipped, and clicking a muted
  part in the panel lets you watch it without being jumped away.
- **Keyboard and screen-reader access:** the counter button sets
  `aria-expanded`, pressing `Escape` closes the open panel and returns focus
  to the button, and the panel's list is reachable with `Tab`.
- **Fix: VOD id not read from Twitch's new playlist address.** Twitch's
  player now asks for `usher.ttvnw.net/vod/v2/<id>.m3u8`; the id is read from
  both forms again, so saves get their title and link without waiting for
  the page.
- **MP4 VODs (HEVC/AV1) are unmuted when the original is still there.**
  Twitch now serves some VODs as fragmented MP4 (`init-0.mp4`, `123.mp4`,
  `123-muted.mp4`) instead of MPEG-TS; the extension ignored them, and the
  panel said it couldn't reach the player. Their muted parts now play the
  original (`123.mp4`, then `123-unmuted.mp4`) of the quality being watched,
  else the sound of another quality spliced into the muted file
  (`src/media/fragmented-mp4.js`: the AAC samples are swapped and the
  moof/mdat pairs rewritten; the AAC settings must match and the sound must
  start and end within 0.1 s). Their sound is saved too (while watching and
  by auto-save), in the same format as MPEG-TS VODs: the AAC frames get an
  ADTS header and a 90 kHz start time, so compression, backups and the
  storage limit work unchanged; when played, a saved copy is turned back
  into MP4 samples on the watched quality's clock and spliced in.
- **Diagnostics:** the report now says when a VOD's playlist had no muted
  parts in it (with two example file names), and with debug logging on, when
  a playlist request was refused (e.g. `403` for a sub-only VOD) and which
  qualities the master playlist listed.

Saved audio, backups and auto-save:
- **VOD title and direct link in the saved list.** Saved VODs now remember
  their Twitch VOD id and stream title (both when watched and when
  auto-saved), so the *Saved* tab shows the stream title and a `↗` link to
  open the VOD on Twitch (even when two streams happened on the same day).
- **Smaller lossless saves (especially in Firefox).** Lossless saves (`fmt:
  'adts'`) now strip the 188-byte MPEG-TS packet headers, PES headers and
  `0xff` adaptation-field stuffing before compressing with deflate, then put
  the MPEG-TS packets back when played. The AAC frames are bit-for-bit
  identical, and lossless saves (Firefox, or *Original* quality) are about
  10–15% smaller. Older lossless saves are upgraded automatically when the VOD
  is opened.
- **No duplicate downloads in *"Parts ahead of me"* mode.** When the player
  downloads a muted part ahead of your position before the background saver
  gets to it, that download is now saved directly instead of being fetched a
  second time.
- **Backup page:** **Select all** and **Select none** buttons when exporting
  several VODs, stream titles in the list, automatic refresh of the menu's
  offline saved-VOD cache after importing, and a clear message (keeping what
  already fit) if browser storage fills up during an import.
- **Auto-save:** adding a channel or clicking *Check now* while an auto-save
  run is already going now queues a follow-up check right after it finishes,
  reusing the background tab instead of waiting for the next 20-minute timer.

Behind the scenes:
- **`src/ui.js` (958 lines) is split into 7 modules** under `src/ui/`
  (`dom.js`, `state.js`, `backup-page.js`, `diagnostics.js`,
  `explanations.js`, `panel.js`, `seekbar.js`), put together and checked by
  `node build.mjs` (imports, duplicate declarations, cross-module assignments,
  and a fake-page sandbox check) the same way `src/hook.js` is.
- **Shared channel input helper** (`popup/channel-form.js`) used by both the
  menu and the first-run welcome page.
- **Unit tests in CI:** GitHub Actions (`.github/workflows/build.yml`) now
  runs the offline unit test suite on every push and pull request, alongside
  new unit tests covering `src/ui/*`, `fmt: 'adts'` lossless saves,
  ahead-mode opportunistic saving, backup quota handling, and VOD metadata.

## 1.4.0

### Clearer logs, two fixes, and the code reorganized underneath (nothing else
changes in what the extension does).

**Clearer logs** (console, F12). Every line has a purple `[VOD Unmuter]`
badge, says where it comes from (`page`, `player`, `auto-save`, `bridge`,
`background`), names the VOD by channel, stream day and quality ("squeezie
2026-11-22 · Source"), and a muted part by its place in the video ("part 242
(40:20–40:30)"). Type `VOD Unmuter` in the console's filter box to see only
these lines.
- **The end of a check** is one line: how many muted parts can be unmuted and
  from where, the muted time, the stretches that stay muted ("53:04–54:25 (8
  parts), …") and how long it took. With *Debug logging*, click it to open
  every part, in VOD order. Neighbours with the same result share a line, and
  each file asked shows Twitch's answer (`200` found, `403`/`404` deleted,
  `503` or "network error": asked again later, "remembered": no request
  needed). It also says when the time went to waiting for a free request slot
  rather than to Twitch.
- **New lines:** when checking starts. Each muted part the player plays, and
  how (*Debug logging*). What was saved, from which quality, how many MB, and
  why any part wasn't. What compression freed. Retries and their result.
  Settings changes, deletions, and backup files made and read.
- **Auto-save** logs each run in the background's own console (Chrome:
  `chrome://extensions`, "service worker"; Firefox: `about:debugging`,
  Inspect). It shows each channel's recent VODs and why each one is or isn't
  saved now ("tried 0.2 h ago, again after 15 min"), which tab is used, and
  the result per VOD.
- **Warnings** say which VOD and part they are about, and errors can be
  expanded to see where they happened.

Fix: **the menu's saved list said "258 parts" instead of "258 / 1174
parts"** (and didn't say why the rest wasn't saved) when nothing had been
saved yet by the time the VOD's check ended, e.g. a VOD whose first muted part
is far from where you start watching. The totals are now added as soon as the
first part is saved.

Fix: **with the browser's storage full, the console got a warning every
second** while watching (the extension couldn't save how far you got).
"Storage is full" is now said once, as for saving.

**Firefox 140 or newer** is now needed (Firefox for Android: 142), up from
128: the add-on's "collects no data" declaration, which addons.mozilla.org
asks for, only exists from those versions. Firefox 128 ESR is no longer
supported by Mozilla.

Behind the scenes:
- **`src/hook.js` (2,100 lines) is split into 20 modules** by what they do:
  `shared` (constants, state, logging), `media` (MPEG-TS, ADTS,
  compression), `storage` (IndexedDB, deleted-files cache, backups),
  `recovery` (checking, what the UI is told, saving, auto-save), `player`
  (playlists, segments, messages, getting into the player's worker),
  `messaging` (the page's side of `bridge.js`). `node build.mjs` still needs
  no dependencies. It puts them back into one plain `src/hook.js` (nothing
  minified or renamed, a banner before each module) and checks the result:
  every module imports what it uses, nothing is declared twice, nothing a
  module imports is changed elsewhere, the player's copy uses no page-only
  code, and the built file runs in a fake page and a fake player worker that
  have nothing else in them.
- **Less code in Twitch's player:** its copy of the hook leaves out what only
  the page uses (backup files, auto-save): 84 KB instead of 91 KB.
- **Unit tests** (`cd test && npm run test:unit`: 60 tests, no browser, under
  a second, Node 22+). They cover MPEG-TS parsing and splicing (33-bit
  timestamps, PID and continuity-counter renumbering, timing checks), ADTS ↔
  TS round trips, saved audio totals, backup files (export, import, damaged
  files), storage full, which qualities are tried in which order, the seek
  bar's ranges, the log lines, and the built hook in the fake page and worker
  (playlist rewriting, the original file, another quality's sound spliced
  in). A test also checks that the five places with default settings agree.
- `README.md`: the new layout, reading the console, unit tests.
  `STORE_LISTING.md`: the reviewer notes explain the build.
  `RELEASE.md`: unit tests are a release step.
- **Repo setup:** a root `package.json` with npm scripts (`build`, `lint`,
  `start:firefox`, `start:chrome`, the tests) using Mozilla's `web-ext`, a
  GitHub Actions check that builds and lints every push and pull request,
  `.editorconfig`, `.nvmrc`, LF line endings, and a wider `.gitignore`.

## 1.3.0

**"Parts ahead of me"** replaces "Parts I play" in *What to save*. Only the
muted parts ahead of where you are are kept: once you've played 20 s at a
position, the saved copies of every part before it (watched or skipped, e.g.
when you jump to where you stopped yesterday) are removed, and a part you
watch through is removed too. The furthest position is remembered per VOD.
Parts behind the player's position are never downloaded in the first place:
saving waits for the position (up to 15 s), then goes forward from it, nearest
first, and rewinding saves the parts that are ahead again. Tested: opening a
VOD 60 s before its last muted stretch saved only the 4 parts ahead (of 108). "Watched" follows the video's real
position (not what the player buffers ahead, not ads). Tested: 48 s watched
inside a muted stretch → 4 copies removed (94 → 90). A setting of "Parts I
play" switches to it. Hovering a part of the seek bar now also says whether
it has a **saved copy** ("yes", "14 of 18 segments, 4 removed after you
watched them", "none", …).

Fix: **auto-save errors stayed after removing the channel** (e.g. "1 problem:
subscriber-only" forever). Removing a channel now forgets its VODs and
errors. A subscriber-only VOD without a subscription is no longer a
"problem" (red status, "!" on the icon): it's a note, and the channel's line
says "needs a subscription to save". It's retried every 3 hours instead of
every 15 minutes.

Redesigned menu: four tabs instead of one long page.
- **Settings:** the player, then saving.
- **Auto-save:** channels and options.
- **Saved:** a storage bar, then one collapsible group per channel, one line
  per VOD.
- **Help:** status, diagnostic report, debug logging, links.

Texts are shorter (details on hover), the header has a status dot (green or
red), and dropdowns no longer stretch the labels into several lines. The
menu remembers the last tab.

Phase 4, tests (for development, not in the extension):

- `test/run.cjs` runs the real extension on live Twitch VODs (found at run
  time) in Chrome for Testing and Firefox. There are 16 Chromium tests,
  covering every fix and feature of 1.3 (two tabs, another extension, a second
  player, growing playlists, network errors, old VODs, embedded player,
  storage full, backup, menu, auto-save, "Not active", live checking,
  first-run page), plus a Firefox test. Every test also fails on any
  extension warning or error in the console. All 17 pass.
- `test/twitch-check.cjs`: a 20-second check that Twitch still works the way
  the extension relies on (token, playlists, file naming, which sites get the
  originals, "deleted" answers, muted ranges).
- `RELEASE.md`: release checklist.

Phase 3, features:

- **Live checking.** The seek bar fills in while VOD parts are checked (grey =
  not checked yet), and the counter opens its panel during the check, with
  what is known so far.
- **Saved audio list, in the menu:**
  - grouped by channel, with a total and **Delete channel**;
  - each VOD says how much is saved and why the rest isn't, e.g.
    "94 / 108 parts saved · 14 deleted by Twitch before saving";
  - **📌 Pin** a VOD so neither "Delete saved audio after" nor the storage
    limit ever removes it;
  - **⤓ Export** one VOD (also from the player's panel: "Export to a file");
  - the list shows even with no Twitch tab open (read-only, with its date).
- **Auto-save:**
  - suggests channels whose VODs you saved ("+ zackrawrr");
  - optional **Notifications** when it saves a VOD or can't;
  - the toolbar icon shows "…" while it runs and "!" when something needs
    attention.
- **Firefox:** the saved quality switches to Original by itself. High and
  Small can't be made there (no AAC encoder), so they're disabled in the menu.
- Not done: **auto-save your follows**. Twitch refuses to list follows to
  extensions, even logged in ("service error" without its internal signed
  requests), and reading them from the page would break with every redesign.
  The suggestions above are the substitute.

Fix: **counter showing another tab's VOD** (e.g. 416/420 then 496/496 after
changing a setting). The extension's parts talk over a channel that every
twitch.tv tab shares, so a tab could show the result of a VOD open in another
tab, and every setting change made all tabs answer at once. Every message now
says which tab it comes from, and the counter only listens to its own tab.
Tested with two tabs on different VODs: the previous build showed the other
tab's 0 / 205 instead of 94 / 108; the fixed one never does.

Also more robust:
- If another extension starts a second player worker in the same tab, the
  counter follows the copy that really downloads the video.
- If Twitch changes which parts of a VOD are muted while you watch, parts it
  no longer mutes leave the count (tested: 30 parts unmuted, 94 / 108 →
  64 / 78).
- Seek bar parts with an invalid position are skipped instead of producing
  "NaN%" warnings, and the cause is logged once.

Phase 2, explanations and reliability:

- **Why each part is still muted.** Hover a red part of the seek bar:
  - "deleted in every quality (checked: Source, 720p60…)";
  - "not checked one by one (old VOD)";
  - "network problem, checked again automatically" (shown in yellow);
  - "sound found but its timing didn't match";
  - "saved copy unusable".

  The panel's list shows a short version for each part.
- **Why the whole VOD isn't unmuted.** The panel starts with a verdict, e.g.
  "Twitch deleted the original sound of 205 parts: the stream ended 12 days
  ago, and Twitch deletes it 13 to 32 hours after a stream". It comes with a
  **Why?** link and an **Auto-save <channel>'s next VODs** button.
- **"Not active" warning.** When Twitch shows muted parts but the extension
  never heard from the player (usually another extension started it first),
  the counter says **⚠ Not active**. Its panel has a reload button, a
  diagnostic report button and a link to open an issue. It waits 8 s to avoid
  false alarms (tested on 3 VODs, including a late mature-content gate).
- **Diagnostic report.** **Copy diagnostic report** in the panel and the menu
  copies a text for a GitHub issue:
  - version, browser, settings;
  - the VOD's result with reasons;
  - each part of the extension's state;
  - self-check;
  - the last log lines.

  No tokens, URLs shortened.
- **Status in the menu.** "Status: OK" or the list of problems:
  - restoring turned off;
  - storage blocked or full;
  - player not reached;
  - auto-save errors.
- **Console.** One logger with levels, lines prefixed
  `[VOD Unmuter] · player:` / `· page:` / `· auto-save:`, and errors that
  used to be silent are now logged. A **Debug logging** switch in the menu
  shows every check, splice and save.
- **First-run page** after installing. It explains the 13–32 hour limit, lets
  you add auto-save channels, and covers what doesn't work (embedded players,
  mobile site) and the Firefox storage note.
- **Seek bar:** inside green (and red) parts, the part you've already watched
  is drawn light, almost white, so you can see where you are. Twitch's
  position marker stays on top.

Phase 1, bug fixes:

- **Counter flickering to another result when changing a setting** (e.g.
  416/420 then 496/496). When another extension (such as TwitchNoSub) fetches
  a VOD's playlist from the page, the extension's page copy checked that VOD a
  second time and answered too. Only the copy that really plays the VOD
  reports now, and the page copy no longer checks twice.

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
