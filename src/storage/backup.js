// Hook module, page only (cut out of the player worker's copy): see src/hook.js.

import { IS_PAGE, post } from '../shared/state.js';
import { log } from '../shared/logger.js';
import { audioRange, idb, recBytes, vodInfo } from './idb.js';
import { clearGone } from './gone-cache.js';
import { deleteSavedVod, expireSaved, listSaved, noteStorageFull, updateVodInfo } from './saved-audio.js';

// ---- backup files ------------------------------------------------------
// One file holds any number of saved VODs:
//   "VODUNMUTER-BACKUP\n"  then a 4-byte little-endian header length,
//   the header (JSON), then the raw audio bytes the header points to.
// Binary fields of a record are written as { $bin: [offset, length] }.
export const BACKUP_MAGIC = 'VODUNMUTER-BACKUP\n';
export const BACKUP_FORMAT = 1;
export const AUDIO_KEY_RE = /^([A-Za-z0-9_-]+)\|(\d+)$/;

export async function exportSaved(vodKeys) {
  const vods = (await listSaved()).filter((v) => !vodKeys || vodKeys.includes(v.vod));
  const header = { format: BACKUP_FORMAT, app: 'Twitch VOD Unmuter', exported: Date.now(), vods, audio: [] };
  const blobs = [];
  let offset = 0;
  for (const v of vods) {
    const { keys, values } = (await idb('audio', 'readonly', (audio, out) => {
      const k = audio.getAllKeys(audioRange(v.vod));
      const r = audio.getAll(audioRange(v.vod));
      r.onsuccess = () => { out.value = { keys: k.result, values: r.result }; };
    })) || { keys: [], values: [] };
    const parts = [];
    keys.forEach((key, i) => {
      const rec = {};
      for (const [name, value] of Object.entries(values[i] || {})) {
        if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          rec[name] = { $bin: [offset, bytes.byteLength] };
          parts.push(bytes);
          offset += bytes.byteLength;
        } else rec[name] = value;
      }
      header.audio.push({ key, rec });
    });
    blobs.push(new Blob(parts)); // one VOD at a time, so the browser can keep it on disk
  }
  const head = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.byteLength, true);
  const blob = new Blob([BACKUP_MAGIC, len, head].concat(blobs), { type: 'application/octet-stream' });
  log('info', `backup file made: ${vods.length} VOD(s), ${header.audio.length} parts, ${(offset / 1e6).toFixed(1)} MB of sound` + (vodKeys ? ` (chosen: ${vodKeys.length})` : ' (everything saved)'));
  return { blob, vods: vods.length, segments: header.audio.length, bytes: offset };
}

export async function readBackupHeader(file) {
  const magicLen = BACKUP_MAGIC.length;
  const start = new Uint8Array(await file.slice(0, magicLen + 4).arrayBuffer());
  if (new TextDecoder().decode(start.subarray(0, magicLen)) !== BACKUP_MAGIC) throw new Error('This is not a VOD Unmuter backup file.');
  const headLen = new DataView(start.buffer).getUint32(magicLen, true);
  const head = JSON.parse(new TextDecoder().decode(await file.slice(magicLen + 4, magicLen + 4 + headLen).arrayBuffer()));
  if (!head || head.format !== BACKUP_FORMAT || !Array.isArray(head.vods) || !Array.isArray(head.audio)) {
    throw new Error('This backup was made by a newer version of the extension, or is damaged.');
  }
  return { head, dataStart: magicLen + 4 + headLen };
}

// Adds what is in the file. Segments already saved here are kept as they are.
export async function importSaved(file, onProgress) {
  const { head, dataStart } = await readBackupHeader(file);
  const vodMeta = new Map(head.vods.filter((v) => v && typeof v.vod === 'string').map((v) => [v.vod, v]));
  const result = { vods: new Set(), added: 0, skipped: 0, bytes: 0 };
  let hitQuota = false;
  const BATCH = 40;
  for (let i = 0; i < head.audio.length; i += BATCH) {
    // Read the bytes first: an IndexedDB transaction can't wait for file reads.
    const batch = [];
    let batchBad = 0;
    for (const entry of head.audio.slice(i, i + BATCH)) {
      const m = entry && typeof entry.key === 'string' && entry.key.match(AUDIO_KEY_RE);
      if (!m || !entry.rec || typeof entry.rec !== 'object') { batchBad++; continue; }
      const rec = {};
      for (const [name, value] of Object.entries(entry.rec)) {
        if (value && Array.isArray(value.$bin)) {
          const [off, len] = value.$bin;
          rec[name] = new Uint8Array(await file.slice(dataStart + off, dataStart + off + len).arrayBuffer());
          if (rec[name].byteLength !== len) throw new Error('The backup file is incomplete.');
        } else rec[name] = value;
      }
      if (!(rec.data instanceof Uint8Array || rec.packets instanceof Uint8Array)) { batchBad++; continue; }
      batch.push({ key: entry.key, vod: m[1], rec });
    }
    let batchAdded = 0, batchSkipped = batchBad, batchBytes = 0;
    const batchVods = new Set();
    try {
      await idb(['audio', 'vods'], 'readwrite', (audio, vods) => {
        const totals = new Map(); // vod -> { segments, bytes } added in this batch
        let pendingChecks = batch.length;
        const finish = () => {
          for (const [vod, add] of totals) {
            const r = vods.get(vod);
            r.onsuccess = () => {
              const meta = vodMeta.get(vod) || {};
              const info = r.result || Object.assign(vodInfo(vod), {
                channel: meta.channel || vodInfo(vod).channel, streamedAt: meta.streamedAt || vodInfo(vod).streamedAt,
                vod, savedAt: Date.now(), segments: 0, bytes: 0, // "saved" = imported now, so it isn't expired at once
              });
              if (meta.vodId && !info.vodId) info.vodId = meta.vodId;
              if (meta.title && !info.title) info.title = meta.title;
              if (meta.muted && !info.muted) { info.muted = meta.muted; info.restorable = meta.restorable || 0; }
              info.segments += add.segments;
              info.bytes += add.bytes;
              vods.put(info);
            };
          }
        };
        if (!pendingChecks) return;
        for (const item of batch) {
          const k = audio.getKey(item.key);
          k.onsuccess = () => {
            if (k.result === undefined) {
              audio.put(item.rec, item.key);
              if (!totals.has(item.vod)) totals.set(item.vod, { segments: 0, bytes: 0 });
              const t = totals.get(item.vod);
              t.segments++;
              t.bytes += recBytes(item.rec);
              batchAdded++;
              batchBytes += recBytes(item.rec);
            } else batchSkipped++;
            batchVods.add(item.vod);
            if (--pendingChecks === 0) finish();
          };
        }
      });
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        noteStorageFull(e);
        hitQuota = true;
        break;
      }
      throw e;
    }
    result.added += batchAdded;
    result.skipped += batchSkipped;
    result.bytes += batchBytes;
    for (const v of batchVods) result.vods.add(v);
    if (onProgress) onProgress(Math.min(i + BATCH, head.audio.length), head.audio.length);
  }
  for (const vod of result.vods) post({ type: 'savedChanged', vodKey: vod });
  log('info', `backup file read${Number.isFinite(head.exported) ? ` (made ${new Date(head.exported).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''}: ${result.added} part(s) added, ` +
    `${(result.bytes / 1e6).toFixed(1)} MB, ${result.vods.size} VOD(s) · ${result.skipped} skipped (already saved here, or damaged entries)` +
    (hitQuota ? ' · stopped: browser storage is full' : ''));
  const out = { vods: result.vods.size, added: result.added, skipped: result.skipped, bytes: result.bytes };
  if (hitQuota) out.storageFull = true;
  return out;
}

// Only the page instance manages the database for the popup / UI.
if (IS_PAGE) {
  scope.__vodUnmuterStore = {
    list: listSaved, remove: deleteSavedVod, expire: expireSaved,
    exportSaved, importSaved, readBackupHeader, clearGone,
    pin: (vod, pinned) => updateVodInfo(vod, { pinned: !!pinned }),
  };
}
