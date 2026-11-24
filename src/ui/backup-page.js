// UI module (page MAIN world): see src/ui.js.
// Full-page backup & restore UI at https://www.twitch.tv/robots.txt#vod-unmuter-backup.

import { h } from './dom.js';

export function isBackupPage(loc) {
  const l = loc || (typeof location !== 'undefined' ? location : null);
  return !!(l && l.hostname === 'www.twitch.tv' && l.pathname === '/robots.txt' &&
    String(l.hash || '').startsWith('#vod-unmuter-backup') && typeof window !== 'undefined' && window === window.top);
}

export async function renderBackupPage() {
  const store = window.__vodUnmuterStore;
  document.title = 'Back up saved audio · Twitch VOD Unmuter';
  const css = h('style', null, `
    html, body { margin: 0; background: #0e0e10; color: #efeff1; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
    h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 8px; }
    p { margin: 6px 0; } .muted { color: #adadb8; } .bad { color: #f87171; } .ok { color: #22c55e; }
    .card { background: #18181b; border: 1px solid #2f2f35; border-radius: 8px; padding: 16px; }
    label.vod { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid #26262c; }
    label.vod:last-of-type { border-bottom: 0; } label.vod small { display: block; color: #adadb8; }
    button { background: #9146ff; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; } button.quiet { background: #2f2f35; padding: 5px 10px; font-size: 13px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center; }
    .pick-bar { display: flex; gap: 6px; margin-bottom: 8px; }
    input[type=file] { color: #adadb8; max-width: 100%; }
  `);
  const mbText = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
  const dayText = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '?');
  const main = h('main');
  document.documentElement.replaceChildren(h('head', null, h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }), css), h('body', null, main));
  document.title = 'Back up saved audio · Twitch VOD Unmuter';

  main.append(h('h1', null, 'Back up saved audio'),
    h('p', { class: 'muted' }, 'Saved audio is kept only in this browser. Download a backup file to keep it safe, ' +
      'or to move it to another browser or computer and import it there.'));
  if (!store || !store.exportSaved) {
    main.append(h('p', { class: 'bad' }, 'The extension is not running on this page. Reload it and try again.'));
    return;
  }

  // Export
  const exportBox = h('div', { class: 'card' });
  main.append(h('h2', null, 'Export'), exportBox);
  const exportStatus = h('span', { class: 'muted' });
  async function drawExport() {
    exportBox.replaceChildren();
    const vods = (await store.list()).sort((a, b) => b.savedAt - a.savedAt);
    if (!vods.length) { exportBox.append(h('p', { class: 'muted' }, 'Nothing saved yet.')); return; }
    const boxes = [];
    if (vods.length > 1) {
      const setAll = (checked) => () => { for (const b of boxes) b.checked = checked; };
      exportBox.append(h('div', { class: 'pick-bar' },
        h('button', { type: 'button', class: 'quiet', onclick: setAll(true) }, 'Select all'),
        h('button', { type: 'button', class: 'quiet', onclick: setAll(false) }, 'Select none')));
    }
    const only = (location.hash.match(/[&?]vod=([^&]+)/) || [])[1];
    for (const v of vods) {
      const cb = h('input', { type: 'checkbox', 'data-vod': v.vod });
      // "&vod=<folder>": opened from one VOD's export button: only that one.
      cb.checked = !only || decodeURIComponent(only) === v.vod;
      boxes.push(cb);
      exportBox.append(h('label', { class: 'vod' }, cb, h('span', null,
        h('b', null, v.channel || 'Unknown channel'), ` · streamed ${dayText(v.streamedAt)}`,
        v.title ? ` · ${v.title}` : '',
        h('small', null, `${v.segments} segments · ${mbText(v.bytes)}`))));
    }
    const button = h('button', {
      onclick: async () => {
        const picked = boxes.filter((b) => b.checked).map((b) => b.getAttribute('data-vod'));
        if (!picked.length) { exportStatus.textContent = 'Pick at least one VOD.'; return; }
        button.disabled = true;
        exportStatus.textContent = 'Preparing the file…';
        try {
          const out = await store.exportSaved(picked);
          const a = h('a', { href: URL.createObjectURL(out.blob), download: `vod-unmuter-backup-${new Date().toISOString().slice(0, 10)}.vodunmuter` });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 60000);
          exportStatus.textContent = `Downloaded: ${out.vods} VOD${out.vods > 1 ? 's' : ''}, ${out.segments} segments, ${mbText(out.bytes)}.`;
        } catch (e) {
          exportStatus.textContent = 'Export failed: ' + ((e && e.message) || e);
        }
        button.disabled = false;
      },
    }, 'Download backup');
    exportBox.append(h('div', { class: 'actions' }, button, exportStatus));
  }

  // Import
  const file = h('input', { type: 'file', accept: '.vodunmuter' });
  const importInfo = h('p', { class: 'muted' }, 'Pick a .vodunmuter file made by Export.');
  const importButton = h('button', { disabled: '' }, 'Import');
  const importStatus = h('span', { class: 'muted' });
  main.append(h('h2', null, 'Import'), h('div', { class: 'card' }, file, importInfo,
    h('p', { class: 'muted' }, 'Segments already saved in this browser are kept as they are. For the ' +
      '"Keep saved audio" setting, imported VODs count as saved today.'),
    h('div', { class: 'actions' }, importButton, importStatus)));
  file.addEventListener('change', async () => {
    importButton.disabled = true;
    importStatus.textContent = '';
    importInfo.className = 'muted';
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const { head } = await store.readBackupHeader(f);
      const names = [...new Set(head.vods.map((v) => v.channel || 'unknown'))].join(', ');
      importInfo.textContent = `${head.vods.length} VOD${head.vods.length > 1 ? 's' : ''} (${names}), ` +
        `${head.audio.length} segments, ${mbText(f.size)}. Exported ${dayText(head.exported)}.`;
      importButton.disabled = false;
    } catch (e) {
      importInfo.className = 'bad';
      importInfo.textContent = (e && e.message) || String(e);
    }
  });
  importButton.addEventListener('click', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    importButton.disabled = true;
    file.disabled = true;
    try {
      const out = await store.importSaved(f, (done, total) => { importStatus.textContent = `Importing… ${done} / ${total}`; });
      importStatus.className = out.storageFull ? 'bad' : 'ok';
      importStatus.textContent = `Imported ${out.added} segments (${mbText(out.bytes)}) for ${out.vods} VOD${out.vods === 1 ? '' : 's'}` +
        (out.skipped ? `; ${out.skipped} were already here.` : '.') +
        (out.storageFull ? ' Stopped early: browser storage for twitch.tv is full.' : ' Open VODs pick it up right away.');
      window.postMessage({ source: 'vod-unmuter-page', type: 'refreshSavedCache' }, location.origin);
      drawExport();
    } catch (e) {
      importStatus.className = 'bad';
      importStatus.textContent = 'Import failed: ' + ((e && e.message) || e);
    }
    file.disabled = false;
  });

  await drawExport();
}
