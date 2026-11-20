// Builds the extension for Chrome and Firefox. No dependencies: needs Node 18+.
//
//   node build.mjs
//
// Output (in dist/):
//   chrome/                                    unpacked, for "Load unpacked"
//   firefox/                                   unpacked, for about:debugging
//   twitch-vod-unmuter-chrome-<version>.zip    for the Chrome Web Store
//   twitch-vod-unmuter-firefox-<version>.zip   for addons.mozilla.org (signing)
//
// The two builds differ only in manifest.json: Chrome runs the background
// script as a service worker, Firefox as background scripts, and only Firefox
// gets its add-on settings (id, minimum version).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const FILES = ['src', 'popup', 'icons', 'LICENSE']; // everything the extension needs
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const manifests = {
  chrome() {
    const m = structuredClone(base);
    m.background = { service_worker: base.background.service_worker };
    delete m.browser_specific_settings;
    return m;
  },
  firefox() {
    const m = structuredClone(base);
    m.background = { scripts: base.background.scripts };
    return m;
  },
};

// ---------------------------------------------------------------- files
function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .DS_Store and friends
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function copyInto(target) {
  const files = [];
  for (const item of FILES) {
    const src = path.join(ROOT, item);
    for (const file of fs.statSync(src).isDirectory() ? listFiles(src) : [src]) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
      fs.copyFileSync(file, path.join(target, rel));
      files.push(rel);
    }
  }
  return files;
}

// ---------------------------------------------------------------- zip
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(dir, names, outFile) {
  const parts = [];
  const central = [];
  let offset = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed date: reproducible zips
  for (const name of names.sort()) {
    const data = fs.readFileSync(path.join(dir, name));
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outFile, Buffer.concat([...parts, centralBuf, end]));
}

// ---------------------------------------------------------------- checks
if (base.description.length > 132) { // Chrome Web Store limit
  console.error(`manifest.json: description is ${base.description.length} characters; the Chrome Web Store allows 132.`);
  process.exit(1);
}

// Chrome refuses to load the extension if a script isn't strict UTF-8, which
// includes Unicode "non-characters" such as U+FFFF (Firefox accepts them).
// Write them as escapes ('￿') in the source instead.
for (const item of FILES) {
  const src = path.join(ROOT, item);
  for (const file of fs.statSync(src).isDirectory() ? listFiles(src) : [src]) {
    if (!/\.(js|html|css|json)$/.test(file)) continue;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    const bad = [...text].findIndex((ch) => {
      const c = ch.codePointAt(0);
      return (c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe;
    });
    if (bad >= 0) {
      console.error(`${path.relative(ROOT, file)}: contains a Unicode non-character (Chrome won't load it). Use an escape like '\\uffff' instead.`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------- build
fs.rmSync(DIST, { recursive: true, force: true });
for (const [browser, makeManifest] of Object.entries(manifests)) {
  const dir = path.join(DIST, browser);
  const files = copyInto(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest(), null, 2) + '\n');
  files.push('manifest.json');
  const zipName = `twitch-vod-unmuter-${browser}-${base.version}.zip`;
  zip(dir, files, path.join(DIST, zipName));
  const kb = (fs.statSync(path.join(DIST, zipName)).size / 1024).toFixed(0);
  console.log(`${browser.padEnd(8)} dist/${browser}/  +  dist/${zipName} (${files.length} files, ${kb} KB)`);
}
