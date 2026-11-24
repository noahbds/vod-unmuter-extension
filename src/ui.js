// Runs in the page's MAIN world. Adds the unmute counter next to the player's
// settings button, recolors the seek bar (green = audio restored, red = still
// muted), shows details when hovering a part of the seek bar, lets you click a
// part in the panel to jump to it, and can skip parts that stay muted.
//
// The code is split into modules under src/ui/: `node build.mjs` replaces each
// "// @include" line with that module (without its import/export keywords), so
// the extension loads ONE plain script, dist/*/src/ui.js.
(() => {
  'use strict';
  if (window.__vodUnmuterUI) return;
  window.__vodUnmuterUI = true;

  // @include ui/dom.js
  // @include ui/state.js
  // @include ui/backup-page.js
  // @include ui/diagnostics.js
  // @include ui/explanations.js
  // @include ui/panel.js
  // @include ui/seekbar.js

  if (isBackupPage()) {
    const start = () => renderBackupPage().catch((e) => { document.body.textContent = String(e); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    return;
  }

  window.__vodUnmuterDiag = buildDiag;
  startUiLoop();
})();
