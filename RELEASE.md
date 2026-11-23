# Release checklist

Do these in order for every version.

## When work on a version starts

- [ ] Bump `"version"` in `manifest.json` and the zip names in `README.md`.
- [ ] Add a `## x.y.z (in progress: not released yet)` section to
      `CHANGELOG.md`.

## Before releasing

1. **Twitch still works as expected** (20 s):

   ```bash
   cd test && npm install && node twitch-check.cjs
   ```

   If a check fails, Twitch changed something the extension relies on: fix
   that first.

2. **All browser tests pass** (≈ 15 min, Chromium and Firefox):

   ```bash
   cd test && node run.cjs
   ```

   Needs Chrome for Testing (`npx playwright install chromium`) and Firefox.
   Tests use live Twitch VODs found at run time. A test is skipped (not
   failed) when no suitable VOD exists, e.g. no recent VOD with muted parts.
   Every test also fails on any warning or error the extension writes to the
   console.

3. **Build and lint:**

   ```bash
   node build.mjs
   npx web-ext lint --source-dir dist/firefox
   ```

   0 errors and 0 warnings expected.

4. **By hand, in both browsers** (5 min), with the zips from `dist/`:
   - [ ] a recent VOD: counter, green seek bar, hover a part, panel;
   - [ ] an old VOD: verdict "Twitch deleted the original sound…";
   - [ ] the menu: status OK, saved list, Back up… page;
   - [ ] the console (F12) shows no `[VOD Unmuter]` warnings.

5. **Texts:**
   - [ ] `CHANGELOG.md`: remove "in progress", add the date.
   - [ ] `STORE_LISTING.md`: description, release notes, and a justification
         for any new permission.
   - [ ] `PRIVACY.md`: anything new stored or sent? Update the date.

6. **Publish:**
   - [ ] Commit, tag `vx.y.z`, push (the privacy policy URL must work).
   - [ ] Chrome Web Store: upload `dist/twitch-vod-unmuter-chrome-x.y.z.zip`.
   - [ ] addons.mozilla.org: upload `dist/twitch-vod-unmuter-firefox-x.y.z.zip`
         with the release notes.
