# Twitch VOD Unmuter — v1.6.0 Plan (Audited & Upgraded)

**Target release:** `1.6.0`  
**Current baseline audited:** `main` (`e6934c8`, [manifest.json](manifest.json) `1.5.0`)  
**Non-negotiables:**
- **Zero dependencies & readable build:** `node build.mjs` uses Node stdlib only; `dist/*/src/hook.js` and `dist/*/src/ui.js` stay unminified with module banners for Mozilla AMO review ([STORE_LISTING.md](STORE_LISTING.md)).
- **100% local & zero server:** No third-party servers, no crowd-sourced audio hosting, no viewer-clip stitching, no telemetry ([PRIVACY.md](PRIVACY.md)).
- **`build.mjs` static-scanner invariants:** Single-line `import { … } from '…';` only, inline `export function/const/let` only, no duplicate top-level identifiers across assembled modules, no cross-module variable reassignment (`assignedNames`), and strict isolation between worker modules and `PAGE_ONLY` modules (`storage/backup.js`, `recovery/auto-save.js`, `player/worker-injection.js`, `messaging/page-bridge.js`).

---

## 0. What the Second-Pass Codebase Audit Upgraded in This Plan

Auditing every module in `src/`, `popup/`, `build.mjs`, and `test/` exposed **six subtle traps** that would have caused performance regressions, build failures, or UX glitches if implemented naively:

1. **Zero-overhead container detection for `.mp4` ↔ `.ts` donors:**  
   Probing *both* `<dir>/<n>.mp4` and `<dir>/<n>.ts` per segment would **double HTTP probes** (e.g. `12,000` requests instead of `6,000` on a 1,000-segment deleted VOD). Instead, each rendition directory on Twitch is uniformly `.mp4` or `.ts` for the whole VOD, and an `.mp4` rendition always keeps its unmuted `init-0.mp4` header for the full 60-day life of the VOD. Calling a cached `renditionKind(job, dir)` that probes `<vodBase><dir>/<initName>` **once per `(vodBase, dir)`** both identifies `.mp4` (`200`) vs `.ts` (`403`/`404`) *and* caches the `init-0.mp4` bytes already needed by `readMp4Init()`—adding at most ~5 requests per VOD (`0%` per-segment overhead).
2. **Hidden `.mp4`/`.ts` assumption in `leadInFrames()` (`save-compress-jobs.js:214`):**  
   Seamless AAC re-encoding fetches segment `num - 1` using `job.mp4 ? '.mp4' : '.ts'` across all `saveDirs(job)`. On mixed-container VODs (e.g. watching `.mp4` `chunked` while `audio_only` is `.ts`), `leadInFrames()` would `404` on `audio_only/<num-1>.mp4` and fall back to a `10 MB` video segment or silence unless it also uses `renditionKind(job, dir)`.
3. **Contiguous-stretch race when unlocking `skipMuted` during live checking:**  
   Unlocking `maybeSkipMuted()` while `state.type === 'checking'` lets the player skip confirmed-deleted (`kind === 'no'`) parts without waiting 60+ s for the whole VOD scan. However, if range `R` is `'no'` and immediately adjacent range `R_next` (`R_next.start === R.end`) is still `'pending'`, jumping immediately to `R.end` would cause a **double jump + double toast** 200 ms later when `R_next` also resolves to `'no'`. Holding the skip briefly while an adjacent `R_next` at `hit.end` is `'pending'` (which playhead-priority scanning resolves next) merges the jump cleanly.
4. **Tooltip false `"Saved copy: none"` on unchecked grey segments:**  
   Unlocking seek-bar hover tooltips during `'checking'` exposes a latent branch in `savedCopyText()` ([src/ui/explanations.js](src/ui/explanations.js)): unchecked segments (`r.kind === 'pending'`, `r.restored === false`) fall through to `'none'`. Guarding `if (r.kind === 'pending') return null;` suppresses the misleading line until the part is checked.
5. **Origin-isolated IndexedDB for offline re-compression:**  
   `popup.html` runs on the extension origin and cannot open `https://www.twitch.tv`'s IndexedDB directly. On-demand *"Compress lossless saves"* must execute in the `www.twitch.tv` `MAIN` world (via `window.__vodUnmuterStore.compressSaved()` on the backup page or through `bridge.js` → `page-bridge.js`), using adjacent saved segments (`vod|<num-1>`) for seamless AAC lead-in with **zero network requests**.
6. **Memory eviction safety in SPA tabs (`build.mjs` scope + active background jobs):**  
   Evicting old VOD state on SPA navigation (`switchVod`) must **never** evict a job with `job.saving || job.compressing || !job.finished` (e.g. user navigates to VOD B while VOD A finishes compressing in the background), and the eviction helper must live in `recovery/recovery-state.js` (not `PAGE_ONLY` `auto-save.js`) so both worker SPA navigation and page auto-save share it cleanly.

---

## 1. Track 1 — Mixed-Container (`.mp4` ↔ `.ts`) & `/vod/v2/` Recovery

### 1.1 Cross-container donor borrowing & saving
* **Problem:** On Twitch Enhanced Broadcasting (`/vod/v2/`) streams, high qualities (`chunked` / `1440p60` HEVC/AV1) are fragmented MP4 while `audio_only` and H.264 renditions are often `.ts`. Today [src/recovery/probe-resolver.js](src/recovery/probe-resolver.js) (`urlFor`) forces `seg.job.mp4 ? '.mp4' : '.ts'` for every donor directory, causing false misses on `.ts` donors and forcing MP4 VOD saves to download `10+ MB` `.mp4` video segments instead of `0.27 MB` `audio_only/<n>.ts`.
* **Exact changes:**
  - [src/shared/state.js](src/shared/state.js): add `export const dirExts = new Map(); // "<vodBase><dir>" -> Promise<'.mp4' | '.ts'>`.
  - [src/recovery/probe-resolver.js](src/recovery/probe-resolver.js):
    - Update `loadInit(job, dir)` to default `initName` to `job.initName || 'init-0.mp4'` (so a watched `.ts` quality can still load a donor `.mp4` quality's `init-0.mp4`).
    - Add `renditionExt(job, dir)`: returns `job.mp4 ? '.mp4' : '.ts'` immediately when `dir === job.dir`, otherwise checks/caches `loadInit(job, dir)` (`bytes ? '.mp4' : '.ts'`).
    - Resolve donor URLs per directory extension (`<vodBase><dir>/<num><ext><query>`), keeping [src/storage/gone-cache.js](src/storage/gone-cache.js) compatible without schema changes (`GONE_RE` already keys by actual `.ts`/`.mp4` suffix).
  - [src/player/segment-handler.js](src/player/segment-handler.js) & [src/recovery/save-compress-jobs.js](src/recovery/save-compress-jobs.js):
    - Extract a shared helper `extractDonorAudio(job, bytes, dir)` that reads `.mp4` (via `loadInit` + `extractMp4Audio`) or `.ts` (via `extractAudio`) based on the donor directory's container, and converts across containers when needed:
      - **`.ts` donor → `.mp4` target:** `extractAudio` → `packetsToAdts` → `splitAdts` → `adtsToMp4Audio(frames, pts, ownInit)` → `spliceMp4Audio`.
      - **`.mp4` donor → `.ts` target:** `extractMp4Audio` → `mp4AudioToAdts` → `muxAdts(frames, pts, rate)` → `spliceAudio`.
    - Update `saveFromBytes(seg, bytes, dir)` and `leadInFrames(job, num, cache)` to branch on the **donor directory's** container rather than `job.mp4`.
  - [src/player/playlist-handler.js](src/player/playlist-handler.js): remove stale comment at lines 79–81 claiming MP4 VODs don't use other qualities or saving.

### 1.2 Align `auto-save.js` and `twitch-check` with `/vod/v2/` & metadata
* [src/recovery/auto-save.js](src/recovery/auto-save.js):
  - Request `https://usher.ttvnw.net/vod/v2/${vodId}.m3u8?...&supported_codecs=av1,h265,h264` first, falling back to `/vod/${vodId}.m3u8` on non-`200`/non-`403` responses so HEVC/AV1-only renditions are visible to auto-save.
  - Accept `{ title, channel, streamedAt }` from [src/background.js](src/background.js) → [src/bridge.js](src/bridge.js) so VODs with non-standard CDN folder names never show `Unknown channel` or `?` dates.
* [test/lib/twitch.cjs](test/lib/twitch.cjs) & [test/twitch-check.cjs](test/twitch-check.cjs):
  - Match `-muted\.(ts|mp4)` instead of hardcoding `-muted\.ts`, and probe `<n>.ts` or `<n>.mp4` according to the playlist's container so `twitch-check.cjs` passes regardless of whether the live recent VOD is H.264 `.ts` or HEVC/fMP4.

---

## 2. Track 2 — Playhead-Priority Checking & In-Player UX

### 2.1 Playhead-priority scan order (`scan-scheduler.js`)
* **Problem:** Opening or seeking to `8:30:00` of a 10-hour VOD checks segments linearly from `0:00`, leaving the viewer's playhead grey/unchecked for 60+ seconds.
* **Exact changes** ([src/recovery/scan-scheduler.js](src/recovery/scan-scheduler.js)):
  - Keep phase 1 (the 24-segment spread sample) first so the early verdict and 36-hour `skipRest` optimization remain unchanged.
  - Replace the static linear index cursor for phase 2 with a small `nextSegment(job, remaining)` picker: whenever `job.position` is known, take the first unchecked segment with `s.start + s.duration >= job.position`, wrapping around to the earliest unchecked segment once everything ahead of `job.position` is done. Seeking mid-scan automatically shifts priority to the new playhead in `< 250 ms`.

### 2.2 Live seek-bar hover tooltips & smart `skipMuted` during `'checking'`
* [src/ui/seekbar.js](src/ui/seekbar.js):
  - Allow seek-bar tooltips when `state.type === 'result' || state.type === 'checking'`.
  - Allow `maybeSkipMuted(video)` during `'checking'` for ranges already confirmed `r.kind === 'no'`, **unless** an immediately contiguous range at `r.end` (`Math.abs(next.start - r.end) < 0.5`) has `next.kind === 'pending'` (waiting briefly so contiguous deleted stretches skip in one jump).
* [src/ui/explanations.js](src/ui/explanations.js):
  - Return `null` from `savedCopyText(r, st)` when `r.kind === 'pending'`.

### 2.3 Skip-muted toast with one-click *Undo*
* [src/ui/seekbar.js](src/ui/seekbar.js) & [src/ui/dom.js](src/ui/dom.js):
  - When `maybeSkipMuted()` jumps from `hit.start` to `hit.end`, mount a small pill inside `player` (`Skipped 40:20–42:10 (still muted) · Undo`, `aria-live="polite"`, auto-dismissed after `5 s` or on manual seek).
  - Clicking **Undo** calls `seekToTime(fromTime)` (which sets `ui.manualSeekUntil` so the viewer stays in that range without being re-skipped) and dismisses the pill.

### 2.4 In-player *Pin*, *Save whole VOD*, active-range highlight & responsive panel
* **Panel controls** ([src/ui/panel.js](src/ui/panel.js), [src/recovery/recovery-state.js](src/recovery/recovery-state.js), [src/player/channel-handler.js](src/player/channel-handler.js)):
  - Include `pinned: !!job.pinned` in `sendResult()`'s `save` payload (loaded alongside `savedBytes`/`savedAt` in `checkAll()`).
  - Add **Pin (`📌 Keep forever` / `Pinned ✓`)** in `savedSection()` when segments are saved, relaying `{ type: 'pinSaved', vodKey, pinned }` over `BroadcastChannel` so `IS_PAGE` updates IndexedDB + `savedCache` and all jobs update `job.pinned`.
  - Add **Save this VOD** in `savedSection()` when global saving is off (`!sv.enabled && sv.savable`) or **Save whole VOD** when `sv.mode === 'unplayed' && sv.saved < sv.savable`: sets `job.forceSave = true` on `{ type: 'saveNow', vodKey, forceWhole: true }` so `savingOn(job)` and `maybeSaveAll(job)` save every restorable part of *this* VOD without changing global settings.
* **Active muted-range highlight & prev/next jump:**
  - Mark the `.vu-row` whose `[r.start, r.end]` contains `ui.currentTime` (or the next upcoming range) with `.vu-row-current`, and add compact `‹ Prev` / `Next ›` buttons on the *Muted parts of this VOD* header when `ranges.length > 1`.
* **Viewport clamping & instant Theatre/Fullscreen remount:**
  - Clamp `.vu-panel-inner` `max-height` dynamically to `Math.max(160, player.clientHeight - 76)px` so narrow split-screen players never clip the top of the panel.
  - Attach a `MutationObserver` (coalesced with `requestAnimationFrame`) on the player container alongside a slower `2000 ms` fallback interval so badge and seek-bar overlays re-attach immediately when Twitch rebuilds controls on Theatre/Fullscreen toggles.

---

## 3. Track 3 — Storage Hygiene, Backups & Compression

### 3.1 Fix `pinned` preservation & optional settings/channels in `.vodunmuter` backups
* [src/storage/backup.js](src/storage/backup.js):
  - **Bug fix:** Copy `if (meta.pinned) info.pinned = true;` in `importSaved()` so pinned VODs stay protected after importing into another browser.
  - **Settings & auto-save channels in backups (format `1` compatible):** Allow `exportSaved(vodKeys, extraSettings)` to include an optional `settings` + `autoChannels` object in the JSON header (ignored gracefully by older versions; offered as an *"Also import settings & auto-save channels"* checkbox on [src/ui/backup-page.js](src/ui/backup-page.js) when present, including backups of settings/channels even when 0 VODs are saved).

### 3.2 Detect & clean up saves for VODs Twitch already deleted
* [popup/popup.js](popup/popup.js):
  - When rendering the *Saved* tab (online, when saved VODs have `vodId`s), batch-query `gql.twitch.tv` (`videos(ids: [...]) { id }`) once per popup open (cached 15 min in `storage.session`).
  - Mark any saved VOD whose `vodId` no longer exists on Twitch with `Deleted on Twitch`, and if any unpinned deleted VODs exist, show a one-click **Clean up N deleted VODs (XX MB)** banner action above the list.

### 3.3 Storage bar breakdown, search filter & no-tab manager shortcut
* [popup/popup.js](popup/popup.js) & [popup/popup.css](popup/popup.css):
  - Split the storage meter fill into **pinned** (solid) vs **evictable** (lighter) segments and show `· XX MB pinned` when `pinnedBytes > 0`.
  - Read `reply.quota` (already returned by [src/messaging/page-bridge.js](src/messaging/page-bridge.js) via `navigator.storage.estimate()`) and warn when the browser's available origin quota is smaller than `maxStorageMB`.
  - Show a compact filter input (`Filter by channel or title…`) when `vods.length >= 6`.
  - When `reply.noTab` is true (read-only cached view), add an **Open manager on Twitch ↗** button next to the cached timestamp to open `BACKUP_URL` in one click.

### 3.4 Offline re-compression of lossless saves & raw-AAC WebCodecs fallback
* **Raw AAC WebCodecs fallback** ([src/media/aac-compression.js](src/media/aac-compression.js), [popup/popup.js](popup/popup.js), [popup/welcome.js](popup/welcome.js)):
  - Probe `aac: { format: 'adts' }` first; if unsupported, probe default `mp4a.40.2` (`aac: { format: 'aac' }`). When using raw `'aac'` mode, wrap each `EncodedAudioChunk` with the 7-byte ADTS header (shared helper with `mp4AudioToAdts`), unlocking 96/64 kbps compression on browsers whose `AudioEncoder` only emits raw AAC frames.
* **Compress existing lossless saves** ([src/storage/saved-audio.js](src/storage/saved-audio.js), [src/recovery/save-compress-jobs.js](src/recovery/save-compress-jobs.js), [src/ui/backup-page.js](src/ui/backup-page.js)):
  - Expose `compressSavedVod(vodKey, kbps, onProgress)` in `window.__vodUnmuterStore` that re-encodes `fmt: 'adts'` / `'deflate'` records in IndexedDB using adjacent saved segments (`vod|<num-1>`) for seamless lead-in (0 network requests), surfaced on the backup/manage page and when lowering *Saved quality* in the popup.

---

## 4. Track 4 — Auto-Save Speed, Memory Bounds & Hardening

### 4.1 Batched GraphQL checks, multi-channel paste & stale-busy recovery
* [src/background.js](src/background.js):
  - Batch `findWork()` in chunks of 15 channels using GraphQL field aliases (`c0: user(login: "...") { ... }`), cutting 15–30 sequential HTTP round trips down to 1–2 requests.
  - Pass `{ titles, channels, streamedAt }` in `{ vu: 'autosave' }` so `auto-save.js` never relies solely on CDN folder-name heuristics.
  - Before skipping a manual `check(true)` (*Check now*) due to `autoBusyUntil > Date.now()`, verify that `autoTab` (or an active `bridge.js` tab) still exists and answers `{ vu: 'autoPing' }` with `{ busy: true }`; otherwise clear the stale lock and run immediately.
* [popup/channel-form.js](popup/channel-form.js):
  - Split pasted input on commas, whitespace, or newlines (`parseChannelLogins(raw)`), validate all logins in one aliased GQL query, and add all valid channels at once.

### 4.2 Bounded memory in long-lived Twitch SPA & auto-save tabs
* [src/recovery/recovery-state.js](src/recovery/recovery-state.js) & [src/recovery/auto-save.js](src/recovery/auto-save.js):
  - Add `evictVodState(vodBase)` that removes matching entries from `playlists`, `segments`, `known`, `renditions`, `vodIdsByBase`, `mp4Inits`, and `dirExts`.
  - Call `evictVodState(job.vodBase)` in `autoSave()`'s `finally` block (fixing `known` / `mp4Inits` / `renditions` retention across repeated background runs).
  - In `switchVod()`, prune finished, idle (`!j.saving && !j.compressing`) jobs older than the 3 most recent distinct `vodBase`s in that tab.

### 4.3 Unified `vodInfo`, strict TS bounds & worker-injection hardening
* **Single `vodInfo` source of truth:** Deduplicate the 3 `vodKey.split('_')` implementations ([src/storage/idb.js](src/storage/idb.js), [src/shared/constants.js](src/shared/constants.js), [src/recovery/recovery-state.js](src/recovery/recovery-state.js)) and prefer `job.channel` / `job.streamedAt` when known (fixing Highlights and non-standard VOD keys).
* **MPEG-TS packet bounds** ([src/media/transport-stream.js](src/media/transport-stream.js), [src/media/adts-muxer.js](src/media/adts-muxer.js)): Guard adaptation-field and PES header offsets (`p < o + 188`, `p + 14 <= o + 188`, `p + 3 + secLen <= o + 188`) against malformed packets reading across 188-byte boundaries.
* **Worker injection** ([src/player/worker-injection.js](src/player/worker-injection.js)): Decode `ArrayBuffer` / `ArrayBufferView` `Blob` parts via `TextDecoder` so `urlText` never falls back to deprecated synchronous XHR on binary `Blob`s, and wrap `{ type: 'module' }` workers with `import ${JSON.stringify(href)};` instead of `importScripts()`.
* **Release-gate script** ([package.json](package.json)): Extend `npm run check-version` to verify that `manifest.json`, `package.json`, `README.md` zip filenames, and the top heading of `CHANGELOG.md` agree.

---

## 5. Track 5 — Final Codebase Cleanup, Optimization & Condensation

Run as the dedicated **final phase** once Tracks 1–4 are complete and covered by tests, so both existing technical debt and any scaffolding left over from 1.6 feature work are cleaned up in one pass—while keeping the code plain, readable, and AMO-compliant (never obfuscated or golfed).

### 5.1 Remove dead code, unused exports & enforce automatically in `build.mjs`
* **Delete already-identified dead declarations:**
  - `TWITCH_TABS` (`popup/popup.js:4`, never referenced) and `day` (`popup/popup.js:121`, superseded by `shortDay`).
  - Unused `force` parameter on `maybeSaveAll(job, force)` (`src/recovery/save-compress-jobs.js:127`).
  - Legacy `watched` migration branches condensed to a single normalization helper.
* **Prune ~47 unneeded `export` modifiers** on module-private helpers/state across `src/` that are never imported by any other module or unit test (e.g. `pipeBytes`, `delays`, `codecsAvailable`, `encodePcm`, `ADTS_RATES`, `esdsConfig`, `restrictedNoted`, `unmutedNoted`, `segmentResponse`, `findDonor`, `describeTime`, `noneCurrent`, `makeCurrent`, `saveQueue`, `serially`, `storageFullFor`, `packAdts`, `mp4Frames`, `leadInFrames`, `runCompress`, `checkSegments`, `LOG_KEEP`, `BADGE_CSS`, `WHERE_CSS`, `goneQueue`, `goneTimer`, `dbPromise`, `goneDbPromise`, `openGoneDb`, `collectReplies`, `copyText`, `pad`, `WHY_URL`, `endedAgo`, `savedDate`, `savedSection`, `findPlayer`, `renderBars`, `playedPercent`, `paintPlayed`, `updateUi`), leaving each module's `export` list as its true cross-module + unit-test API.
* **Enforce zero dead code in `build.mjs`:**
  - Extend `scanJs` checks in [build.mjs](build.mjs) to fail the build on **unused imports**, **unreferenced top-level declarations** in `src/hook.js` / `src/ui.js` / `popup/*.js` / `src/background.js` / `src/bridge.js`, and **unused internal `export`s** (unless imported by another module or `test/unit/*.test.mjs`).

### 5.2 Deduplicate & condense repeated code across modules
* **Unify `assembleHook()` and `assembleUi()` in [build.mjs](build.mjs):** Both functions duplicate ~75 lines of `@include` scanning, duplicate-declaration checks, missing-import checks, `assignedNames` checks, and banner assembly; extract one shared `assembleBundle()` (~65 lines saved).
* **Deduplicate repeated constants & helpers:**
  - Share `TWITCH_CLIENT_ID` + WebCodecs `checkAacSupport()` across `popup/popup.js` and `popup/welcome.js` via `popup/channel-form.js` (or `popup/shared.js`), eliminating 4 duplicate `AudioEncoder.isConfigSupported(...)` blocks across popup + `aac-compression.js`.
  - Reuse `mb()` from `src/ui/dom.js` inside `src/ui/backup-page.js` instead of redeclaring `mbText`, and reuse `BACKUP_URL` consistently in `popup/popup.js` (`line 257` currently re-hardcodes the URL literal).
  - Unify the 3 `vodKey.split('_')` channel/timestamp parsers (`idb.js`, `constants.js`, `recovery-state.js`) into one helper.
* **Condense verbose DOM/message boilerplate:** Tighten repetitive attribute/listener wiring in `popup/popup.js`, `src/ui/panel.js`, and `src/ui/backup-page.js` without sacrificing clarity.

### 5.3 Hot-path & memory optimizations
* **`O(1)` segment lookup (`job.byNum`):** Keep the `Map(num -> seg)` already built transiently in `rewritePlaylist()` on `job.byNum`, replacing `O(N)` `job.segs.find(...)` scans inside `partOf()`, `leadInFrames()`, and `dropBehind()` (`O(N²)` across 1,000-segment compression runs).
* **Batched IndexedDB deletes & cached storage total:**
  - Replace the per-segment IndexedDB transaction loop in `dropBehind()` (`save-compress-jobs.js:21`) with a single `deleteSavedSegments(vodKey, nums)` transaction (~50× fewer IDB transactions when skipping ahead on a long VOD), and batch multi-VOD deletes in `expireSaved()` / `deleteChannel` / `deleteAll`.
  - Cache total saved bytes in memory inside `makeRoom()` (invalidated on `deleteSaved`/`savedChanged`/eviction) instead of running `vods.getAll()` on every single saved segment.
* **Single-pass MP4 `moof` writing:** In `writePair()` ([src/media/fragmented-mp4.js](src/media/fragmented-mp4.js)), build `moof` once and patch each `trun`'s `data_offset` in place via `DataView.setUint32` instead of building and discarding a full dummy `moof` buffer first.
* **Drop redundant `.raw` playlist copies on finished VODs:** Once `#EXT-X-ENDLIST` is seen (`!job.live`), stop retaining the duplicate multi-hundred-KB `entry.raw` playlist string alongside `entry.text` in `playlists`.

---

## 6. Phased Implementation Order & Test Gates

| Phase | Scope | New / Updated Verification |
|---|---|---|
| **Phase 1: Media & Mixed-Container Core** | Track 1.1–1.2, Track 4.3 (TS bounds, `vodInfo`, worker injection) | Unit tests in `fragmented-mp4.test.mjs`, `transport-stream.test.mjs`, and mixed `.mp4`↔`.ts` donor playback + `audio_only/*.ts` saving in `worker-sandbox.test.mjs`; live `node test/twitch-check.cjs` |
| **Phase 2: Scan Priority, Memory Bounds & Player UX** | Track 2.1–2.4, Track 4.2 | Unit tests in `recovery-state.test.mjs` & `ui.test.mjs` (playhead-priority ordering, `'checking'` tooltips & contiguous `skipMuted` hold, skip toast + Undo, panel Pin/Save, `evictVodState`) |
| **Phase 3: Backups, Storage Hygiene & Compression** | Track 3.1–3.4 | Unit tests in `backup-format.test.mjs` (`pinned` round-trip, settings/channels header, raw-AAC ADTS framing, offline `compressSavedVod`) |
| **Phase 4: Auto-Save Batching & Popup Polish** | Track 4.1, popup filter/meter/deleted-VOD cleanup, `check-version` | New `test/unit/background-popup.test.mjs` (batched GQL aliasing, multi-channel paste, stale `autoBusyUntil` ping recovery) |
| **Phase 5: Codebase Cleanup, Optimization & Condensation (Final)** | Track 5.1–5.3 + docs & release gate | `build.mjs` dead-code/unused-import/unused-export checks active (0 warnings), line & bundle-size audit, `npm run check-version`, `npm run lint`, `npm run test:unit`, `node test/twitch-check.cjs`, and full `node test/run.cjs` |

---

## 7. Acceptance Criteria for v1.6.0

- [ ] An fMP4 VOD (`chunked`/`1440p60` HEVC/AV1) borrows and saves audio from `.ts` renditions (`audio_only/*.ts`, `480p30/*.ts`) and a `.ts` rendition borrows from `.mp4` renditions, with at most 1 init probe per donor quality.
- [ ] Seeking into a long VOD during `'checking'` prioritizes segments at/ahead of the playhead, shows live seek-bar tooltips (without false `Saved copy: none`), and skips confirmed still-muted stretches cleanly with an **Undo** toast.
- [ ] Viewers can **Pin** and **Save whole VOD** directly from the player's panel, and `.vu-panel-inner` never clips on short split-screen players.
- [ ] `.vodunmuter` backups preserve `pinned` status and optionally export/import settings + `autoChannels`; *Saved* tab flags & cleans up VODs deleted on Twitch and shows pinned vs. evictable storage usage.
- [ ] `background.js` checks auto-save channels in batched GQL queries, recovers immediately from stale `autoBusyUntil` locks on *Check now*, and long-lived Twitch tabs evict old idle VOD maps cleanly.
- [ ] **Final cleanup gate:** Zero unused imports, dead declarations, or unneeded internal exports across `src/`, `popup/`, and `build.mjs` (enforced automatically by `node build.mjs`); hot-path IDB/MP4/lookup operations optimized; code condensed without minification or loss of readability.
- [ ] `npm run check-version`, `npm run lint` (0 errors, 0 warnings), `npm run test:unit`, `node test/twitch-check.cjs`, and `node test/run.cjs` all pass.
