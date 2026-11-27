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
//
// src/hook.js is put together from its modules (src/shared, src/media,
// src/storage, src/recovery, src/player, src/messaging): each
// "// @include <module>" line of src/hook.js is replaced by that file, without
// its `import` lines and `export` keywords. Nothing is minified or renamed.
// Every other file is copied as it is. The build then checks the result (see
// "hook checks" below) and stops if anything is wrong.
//
// This file can also be imported (the unit tests do): it only builds when run.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const FILES = ['src', 'popup', 'icons', 'LICENSE']; // everything the extension needs
const HOOK = 'src/hook.js';
const UI = 'src/ui.js';
// Modules that only the page uses: in src/hook.js they sit outside
// installUnmuteHook, or between the page-only markers (cut out of the copy
// sent to the player worker).
const PAGE_ONLY = ['storage/backup.js', 'recovery/auto-save.js', 'player/worker-injection.js', 'messaging/page-bridge.js'];
// What the page exposes, used by ui.js, bridge.js (through the page) and the tests.
const STORE_API = ['list', 'remove', 'removeMany', 'expire', 'exportSaved', 'importSaved', 'readBackupHeader', 'clearGone', 'compressSaved', 'pin'];
const DEBUG_API = ['jobs', 'renditions', 'scanTs', 'extractAudio', 'spliceAudio', 'listSaved', 'loadRecord', 'recordToAudio', 'muxAdts', 'splitAdts', 'packetsToAdts', 'encoderDelay'];

const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

// The hook's and UI's modules (src/<folder>/<file>.js) are not copied on their
// own: they are assembled into src/hook.js and src/ui.js.
const isUiModule = (rel) => rel.startsWith('src/ui/') && rel.split('/').length > 2;
const isHookModule = (rel) => rel.startsWith('src/') && rel.split('/').length > 2 && !isUiModule(rel);
const isSubModule = (rel) => isHookModule(rel) || isUiModule(rel);

function sourceFiles() {
  const files = [];
  for (const item of FILES) {
    const src = path.join(ROOT, item);
    for (const file of fs.statSync(src).isDirectory() ? listFiles(src) : [src]) {
      files.push(path.relative(ROOT, file).split(path.sep).join('/'));
    }
  }
  return files;
}

function copyInto(target, hookCode, uiCode) {
  const files = [];
  for (const rel of sourceFiles()) {
    if (isSubModule(rel)) continue;
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    if (rel === HOOK) fs.writeFileSync(path.join(target, rel), hookCode);
    else if (rel === UI) fs.writeFileSync(path.join(target, rel), uiCode);
    else fs.copyFileSync(path.join(ROOT, rel), path.join(target, rel));
    files.push(rel);
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

// ---------------------------------------------------------------- JS scanner
// Just enough of a tokenizer to find what a module declares at its top level
// and which names it really uses (not in comments, strings or regexes, not
// `obj.prop` or `{ key: … }`).
const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'await', 'yield']);
function scanJs(code) {
  const toks = [];
  const stack = []; // open braces: 'code' or 'tmpl' (a template's ${)
  const n = code.length;
  let i = 0;
  const depth = () => stack.filter((s) => s === 'code').length;
  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.type === 'id') return KW_BEFORE_REGEX.has(p.value);
    return p.type === 'punc' && p.value !== ')' && p.value !== ']';
  };
  const template = () => { // inside a template literal, up to its end or a ${
    while (i < n) {
      const c = code[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; toks.push({ type: 'str' }); return; }
      if (c === '$' && code[i + 1] === '{') { i += 2; stack.push('tmpl'); toks.push({ type: 'punc', value: '(' }); return; }
      i++;
    }
    throw new Error('unterminated template literal');
  };
  while (i < n) {
    const c = code[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '\'' || c === '"') {
      for (i++; i < n && code[i] !== c; i++) if (code[i] === '\\') i++;
      i++;
      toks.push({ type: 'str' });
      continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (c === '/' && regexAllowed()) {
      let cls = false;
      for (i++; i < n; i++) {
        const d = code[i];
        if (d === '\\') { i++; continue; }
        if (d === '\n') throw new Error('unterminated regex');
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
      }
      for (i++; i < n && /[a-z]/i.test(code[i]); i++);
      toks.push({ type: 'regex' });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(code[j])) j++;
      toks.push({ type: 'id', value: code.slice(i, j), depth: depth() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1]))) {
      for (i++; i < n && /[\w.]/.test(code[i]); i++);
      toks.push({ type: 'num' });
      continue;
    }
    if (c === '{') { stack.push('code'); toks.push({ type: 'punc', value: '{' }); i++; continue; }
    if (c === '}') {
      i++;
      if (stack.pop() === 'tmpl') { toks.push({ type: 'punc', value: ')' }); template(); } else toks.push({ type: 'punc', value: '}' });
      continue;
    }
    if (c === '?' && code[i + 1] === '.' && !/[0-9]/.test(code[i + 2])) { toks.push({ type: 'punc', value: '.' }); i += 2; continue; }
    toks.push({ type: 'punc', value: c });
    i++;
  }
  if (stack.length) throw new Error('unbalanced braces');
  const ids = [];
  toks.forEach((t, k) => {
    if (t.type === 'id') ids.push({ name: t.value, depth: t.depth, prev: toks[k - 1], prev2: toks[k - 2], next: toks[k + 1], next2: toks[k + 2] });
  });
  return ids;
}
const isPunc = (t, ...v) => !!t && t.type === 'punc' && v.includes(t.value);
const isMember = (t) => isPunc(t.prev, '.') && !isPunc(t.prev2, '.');

function topLevelDecls(ids) {
  return ids.filter((t) => t.depth === 0 && t.prev && t.prev.type === 'id' &&
    ['function', 'class', 'const', 'let', 'var'].includes(t.prev.value)).map((t) => t.name);
}

function usedNames(ids) {
  return new Set(ids.filter((t) => !isMember(t) && !(isPunc(t.next, ':') && isPunc(t.prev, '{', ','))).map((t) => t.name));
}

// `name = …`, `name += …`, `name++`, `++name` (not `==`, `=>`, `obj.name = …`).
function assignedNames(ids) {
  return new Set(ids.filter((t) => !isPunc(t.prev, '.') && (
    (isPunc(t.next, '=') && !isPunc(t.next2, '=', '>')) ||
    (isPunc(t.next, '+', '-', '*', '/', '%', '&', '|', '^') && isPunc(t.next2, '=')) ||
    (isPunc(t.next, '+') && isPunc(t.next2, '+')) || (isPunc(t.next, '-') && isPunc(t.next2, '-')) ||
    (isPunc(t.prev, '+') && isPunc(t.prev2, '+')) || (isPunc(t.prev, '-') && isPunc(t.prev2, '-'))
  )).map((t) => t.name));
}

// ---------------------------------------------------------------- assembly
const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';[ \t]*\n/gm;
const EXPORT_DECL_RE = /^export (?:async function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

function readModule(rel) {
  const file = 'src/' + rel;
  if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`missing module ${file}`);
  const text = readText(file);
  const imports = [...text.matchAll(IMPORT_RE)].map((m) => ({
    names: m[1].split(',').map((s) => s.trim()).filter(Boolean),
    from: path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2])),
  }));
  const exported = [...text.matchAll(EXPORT_DECL_RE)].map((m) => m[1]);
  const stripped = text.replace(IMPORT_RE, '');
  const body = stripped.replace(/^export (?=(async function|function|const|let|class) )/gm, '');
  if (/^\s*(import|export)\b/m.test(body)) throw new Error(`${file}: unsupported import/export syntax`);
  const ids = scanJs(stripped);
  return { rel, file, raw: text, body: body.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, ''), imports, exported, ids, decls: topLevelDecls(ids) };
}

function verifyModuleGraph(entryFile, allMods, sharedMods, problems, allowImportMod) {
  const owner = new Map();
  for (const m of sharedMods) {
    for (const d of m.decls) {
      if (owner.has(d)) problems.push(`"${d}" is declared in both ${owner.get(d).file} and ${m.file}`);
      else owner.set(d, m);
    }
  }
  for (const m of allMods.values()) {
    if (m.inside === false && m.imports.length) problems.push(`${m.file}: runs outside installUnmuteHook, so it can't import from the hook's modules`);
    const imported = new Set();
    const used = usedNames(m.ids);
    for (const imp of m.imports) {
      const from = allMods.get(imp.from);
      if (!from || (allowImportMod && !allowImportMod(from))) { problems.push(`${m.file}: imports from ${imp.from}, which isn't a shared module of ${entryFile}`); continue; }
      if (from.pageOnly && !m.pageOnly) problems.push(`${m.file}: runs in the player worker too, but imports from the page-only ${from.file}`);
      for (const name of imp.names) {
        imported.add(name);
        if (!from.decls.includes(name)) problems.push(`${m.file}: imports "${name}", which ${from.file} doesn't declare`);
        else if (!used.has(name)) problems.push(`${m.file}: imports "${name}" without using it`);
      }
    }
    if (m.inside === false) continue;
    for (const name of used) {
      const o = owner.get(name);
      if (o && o !== m && !imported.has(name)) problems.push(`${m.file}: uses "${name}" from ${o.file} without importing it`);
    }
    for (const name of assignedNames(m.ids)) {
      if (imported.has(name)) problems.push(`${m.file}: assigns "${name}", which belongs to ${owner.get(name).file} (change it there)`);
    }
  }
}

function renderTemplate(template, mods) {
  return template.split('\n').map((line) => {
    const m = line.match(/^(\s*)\/\/ @include (\S+)$/);
    if (!m) return line;
    const mod = mods.get(m[2]);
    return [`${m[1]}// ---- src/${mod.rel} ----`].concat(mod.body.split('\n').map((l) => (l ? m[1] + l : l))).join('\n');
  }).join('\n');
}

// Builds dist's src/hook.js from the template and its modules, after checking
// that the modules fit together.
export function assembleHook() {
  const template = readText(HOOK);
  const problems = [];
  const includes = [];
  let inHook = false, pageOnly = false;
  for (const line of template.split('\n')) {
    if (/^\s*function installUnmuteHook\(scope\) \{$/.test(line)) inHook = true;
    else if (inHook && /^ {2}\}$/.test(line)) inHook = false;
    if (line.includes('/* vu:page-only:start */')) pageOnly = true;
    if (line.includes('/* vu:page-only:end */')) pageOnly = false;
    const m = line.match(/^\s*\/\/ @include (\S+)$/);
    if (m) includes.push({ rel: m[1], inside: inHook, pageOnly: pageOnly || !inHook });
  }
  if ((template.match(/\/\* vu:page-only:start \*\//g) || []).length !== 1 || (template.match(/\/\* vu:page-only:end \*\//g) || []).length !== 1) {
    problems.push(`${HOOK}: needs exactly one /* vu:page-only:start */ … /* vu:page-only:end */ region`);
  }
  const mods = new Map();
  for (const inc of includes) {
    if (mods.has(inc.rel)) { problems.push(`${HOOK}: ${inc.rel} is included twice`); continue; }
    mods.set(inc.rel, Object.assign(readModule(inc.rel), inc));
  }
  for (const rel of sourceFiles().filter(isHookModule).map((f) => f.slice(4))) {
    if (rel.endsWith('.js') && !mods.has(rel)) problems.push(`src/${rel} is not included by ${HOOK}`);
  }
  for (const m of mods.values()) {
    if (PAGE_ONLY.includes(m.rel) !== m.pageOnly) {
      problems.push(`${m.file}: ${PAGE_ONLY.includes(m.rel) ? 'page-only module outside the page-only parts' : 'included in a page-only part but not listed in PAGE_ONLY'} of ${HOOK}`);
    }
  }
  verifyModuleGraph(HOOK, mods, [...mods.values()].filter((m) => m.inside), problems, (from) => from.inside);
  if (problems.length) throw new Error(problems.join('\n'));
  return { code: renderTemplate(template, mods), modules: [...mods.values()] };
}

// Builds dist's src/ui.js from the template and its src/ui/*.js modules.
export function assembleUi() {
  const template = readText(UI);
  const problems = [];
  const mods = new Map();
  for (const line of template.split('\n')) {
    const m = line.match(/^\s*\/\/ @include (\S+)$/);
    if (!m) continue;
    if (mods.has(m[1])) problems.push(`${UI}: ${m[1]} is included twice`);
    else mods.set(m[1], readModule(m[1]));
  }
  for (const rel of sourceFiles().filter(isUiModule).map((f) => f.slice(4))) {
    if (rel.endsWith('.js') && !mods.has(rel)) problems.push(`src/${rel} is not included by ${UI}`);
  }
  verifyModuleGraph(UI, mods, [...mods.values()], problems);
  if (problems.length) throw new Error(problems.join('\n'));
  return { code: renderTemplate(template, mods), modules: [...mods.values()] };
}

// Fails the build if any top-level symbol is never referenced, or if any
// module exports a symbol that no other module, entry template, or test uses.
function checkNoDeadCode(hookCode, hookModules, uiCode, uiModules) {
  const problems = [];
  const countRefs = (ids) => {
    const counts = new Map();
    for (const t of ids) {
      if (isMember(t) || (isPunc(t.next, ':') && isPunc(t.prev, '{', ','))) continue;
      counts.set(t.name, (counts.get(t.name) || 0) + 1);
    }
    return counts;
  };
  for (const [bundleCode, mods] of [[hookCode, hookModules], [uiCode, uiModules]]) {
    const counts = countRefs(scanJs(bundleCode));
    for (const m of mods) {
      for (const d of m.decls) {
        if ((counts.get(d) || 0) <= 1) problems.push(`${m.file}: "${d}" is declared at top level and never used`);
      }
    }
  }
  for (const rel of ['src/background.js', 'src/bridge.js', 'popup/popup.js', 'popup/welcome.js', 'popup/channel-form.js']) {
    const ids = scanJs(readText(rel));
    const counts = countRefs(ids);
    for (const d of topLevelDecls(ids)) {
      if ((counts.get(d) || 0) <= 1) problems.push(`${rel}: "${d}" is declared at top level and never used`);
    }
  }
  const testDir = path.join(ROOT, 'test', 'unit');
  const testText = fs.existsSync(testDir)
    ? listFiles(testDir).filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    : '';
  const allModules = hookModules.concat(uiModules);
  const templatesText = readText(HOOK) + '\n' + readText(UI) + '\n' + testText;
  for (const m of allModules) {
    const others = allModules.filter((o) => o !== m).map((o) => o.raw).join('\n') + '\n' + templatesText;
    for (const exp of m.exported) {
      if (!new RegExp(`\\b${exp}\\b`).test(others)) problems.push(`${m.file}: exports "${exp}", which nothing outside ${m.file} uses`);
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

// ---------------------------------------------------------------- sandbox
// Runs the built hook in fake page and player-worker globals that have only
// standard JavaScript plus the web APIs listed here: if the worker's copy used
// anything from outside installUnmuteHook, it would fail here.
export function makeSandbox(kind, opts = {}) {
  const rec = { console: [], posted: [], channels: [], workers: [], windowMessages: [], blobs: new Map() };
  let blobId = 0;
  class SandboxURL extends URL {
    static createObjectURL(obj) { const u = `blob:https://www.twitch.tv/${++blobId}`; rec.blobs.set(u, obj); return u; }
    static revokeObjectURL(u) { rec.blobs.delete(u); }
  }
  class FakeChannel {
    constructor(name) { this.name = name; this.listeners = []; rec.channels.push(this); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    postMessage(data) { rec.posted.push(structuredClone(data)); }
    close() {}
  }
  const say = (level) => (...args) => rec.console.push({ level, text: args.map(String).join(' ') });
  const g = {
    console: { log: say('log'), info: say('info'), debug: say('debug'), warn: say('warn'), error: say('error') },
    setTimeout: opts.timers ? setTimeout : () => 0, clearTimeout: opts.timers ? clearTimeout : () => {},
    URL: SandboxURL, Blob, Response, Request, Headers, AbortController, TextEncoder, TextDecoder,
    CompressionStream, DecompressionStream, structuredClone, queueMicrotask,
    BroadcastChannel: FakeChannel,
    fetch: opts.fetch || (async () => new Response('', { status: 404 })),
    indexedDB: opts.indexedDB, IDBKeyRange: opts.IDBKeyRange,
  };
  if (kind === 'page') {
    Object.assign(g, {
      document: { cookie: '' },
      location: { origin: 'https://www.twitch.tv', href: 'https://www.twitch.tv/videos/1' },
      navigator: {},
      Worker: class { constructor(url, options) { this.url = String(url); this.options = options; rec.workers.push(this); } },
      XMLHttpRequest: class { open() { throw new Error('sync XHR in the sandbox'); } },
      addEventListener() {},
      postMessage(data) { rec.windowMessages.push(data); },
    });
  }
  const ctx = vm.createContext(g);
  const global = vm.runInContext('globalThis', ctx);
  global[kind === 'page' ? 'window' : 'self'] = global;
  return { ctx, global, rec, run: (code, filename) => vm.runInContext(code, ctx, { filename }) };
}

// Boots the built hook as Twitch would: in the page, then in a player worker
// made from a Blob. Throws if anything is off.
export async function sandboxCheck(code, opts = {}) {
  const fail = (msg) => { throw new Error('sandbox: ' + msg); };
  const page = makeSandbox('page', opts);
  page.run(code, 'dist/src/hook.js');
  const w = page.global;
  if (!w.__vodUnmuterLoaded || !w.__vodUnmuterHooked) fail('the page was not hooked');
  if (!/^[a-z0-9]{1,8}$/.test(w.__vodUnmuterTab)) fail('no tab id');
  if (!w.__vodUnmuterStore || STORE_API.some((k) => typeof w.__vodUnmuterStore[k] !== 'function')) fail(`__vodUnmuterStore must have ${STORE_API.join(', ')}`);
  if (!w.__vodUnmuterAuto || typeof w.__vodUnmuterAuto.save !== 'function') fail('no __vodUnmuterAuto.save');
  if (!w.__vodUnmuterDebug || DEBUG_API.some((k) => !(k in w.__vodUnmuterDebug))) fail(`__vodUnmuterDebug must have ${DEBUG_API.join(', ')}`);

  // a. Twitch makes its player worker from a Blob of its code.
  const playerCode = '/* amazon-ivs-wasmworker */ void 0;\n';
  const blob = page.run(`new Blob([${JSON.stringify(playerCode)}])`);
  const workerCode = await blob.text();
  if (!workerCode.startsWith(`self.__vodUnmuterTab = ${JSON.stringify(w.__vodUnmuterTab)};\n(function installUnmuteHook(scope)`)) fail('the player\'s Blob was not given the hook');
  if (!workerCode.endsWith(')(self);\n' + playerCode)) fail('the player\'s own code must follow the hook');
  if (workerCode.includes('vu:page-only')) fail('the page-only part was not cut out of the worker\'s copy');
  // b. A Worker made from a URL gets the hook too; one already hooked is left alone.
  page.run('new Worker("https://www.twitch.tv/player-worker.js")');
  const wrapped = await page.rec.blobs.get(page.rec.workers[0].url).text();
  if (!wrapped.endsWith('importScripts("https://www.twitch.tv/player-worker.js");')) fail('a Worker from a URL was not wrapped');
  const hookedUrl = page.run('URL.createObjectURL')(blob);
  page.run(`new Worker(${JSON.stringify(hookedUrl)})`);
  if (page.rec.workers[1].url !== hookedUrl) fail('an already hooked worker was hooked twice');

  // The page-only modules must not reach the worker.
  const pageOnlyNames = new Set(assembleHookPageOnlyNames(code));
  const leaked = [...usedNames(scanJs(workerCode))].filter((n) => pageOnlyNames.has(n));
  if (leaked.length) fail(`the player worker's copy uses page-only code: ${leaked.join(', ')}`);

  const worker = makeSandbox('worker', opts);
  const ownFetch = worker.global.fetch;
  worker.run(workerCode, 'player-worker.js');
  const s = worker.global;
  if (!s.__vodUnmuterHooked || s.__vodUnmuterTab !== w.__vodUnmuterTab) fail('the player worker was not hooked');
  if (s.fetch === ownFetch || typeof s.fetch !== 'function') fail('the worker\'s fetch was not hooked');
  if (s.__vodUnmuterStore || s.__vodUnmuterAuto) fail('the worker must not expose the page\'s store');
  if (!s.__vodUnmuterDebug || DEBUG_API.some((k) => !(k in s.__vodUnmuterDebug))) fail('no __vodUnmuterDebug in the worker');
  if (!worker.rec.posted.some((m) => m.type === 'hello' && m.where === 'player' && m.tab === w.__vodUnmuterTab)) fail('the worker did not say hello on the channel');

  await new Promise((r) => setImmediate(r));
  const problems = [...page.rec.console, ...worker.rec.console].filter((l) => /^(warn|error)$/.test(l.level));
  if (problems.length) fail('console: ' + problems.map((l) => l.text).join(' | '));
  return { page, worker, workerCode };
}

// Names declared by the page-only modules, read back from the built file's banners.
function assembleHookPageOnlyNames(code) {
  const names = [];
  const parts = code.split(/^\s*\/\/ ---- src\/(\S+) ----$/m);
  for (let k = 1; k < parts.length; k += 2) {
    if (!PAGE_ONLY.includes(parts[k])) continue;
    names.push(...topLevelDecls(scanJs(parts[k + 1].split(/^\s*\/\* vu:page-only:end \*\/$/m)[0])));
  }
  return names;
}

// ---------------------------------------------------------------- checks
function checkSources() {
  const base = JSON.parse(readText('manifest.json'));
  if (base.description.length > 132) { // Chrome Web Store limit
    throw new Error(`manifest.json: description is ${base.description.length} characters; the Chrome Web Store allows 132.`);
  }
  // Chrome refuses to load the extension if a script isn't strict UTF-8, which
  // includes Unicode "non-characters" such as U+FFFF (Firefox accepts them).
  // Write them as escapes ('￿') in the source instead.
  for (const rel of sourceFiles()) {
    if (!/\.(js|html|css|json)$/.test(rel)) continue;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(ROOT, rel)));
    const bad = [...text].findIndex((ch) => {
      const c = ch.codePointAt(0);
      return (c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe;
    });
    if (bad >= 0) throw new Error(`${rel}: contains a Unicode non-character (Chrome won't load it). Use an escape like '\\uffff' instead.`);
  }
  return base;
}

// Boots the built src/ui.js in a minimal fake page context.
export async function uiSandboxCheck(uiCode) {
  const fail = (msg) => { throw new Error('ui sandbox: ' + msg); };
  const page = makeSandbox('page');
  class FakeNode {
    constructor(tag) { this.tagName = String(tag || '').toUpperCase(); this.children = []; this.style = { setProperty() {} }; this.attrs = {}; this.classList = { toggle() {}, add() {}, remove() {} }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener() {}
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() {}
    contains() { return false; }
  }
  Object.assign(page.global, {
    Node: FakeNode,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ direction: 'ltr' }),
    location: { origin: 'https://www.twitch.tv', hostname: 'www.twitch.tv', pathname: '/videos/1', search: '', hash: '', href: 'https://www.twitch.tv/videos/1' },
    navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0' },
    document: {
      cookie: '', title: 'Stream - Twitch', readyState: 'complete',
      head: new FakeNode('head'), body: new FakeNode('body'), documentElement: new FakeNode('html'),
      createElement: (t) => new FakeNode(t),
      createElementNS: (_, t) => new FakeNode(t),
      createTextNode: (t) => new FakeNode('#text:' + t),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
  });
  page.run(uiCode, 'dist/src/ui.js');
  if (!page.global.__vodUnmuterUI) fail('__vodUnmuterUI was not set');
  if (typeof page.global.__vodUnmuterDiag !== 'function') fail('__vodUnmuterDiag was not exposed');
  if (!page.rec.posted.some((m) => m.type === 'hello')) fail('ui.js did not say hello on the channel');
  const problems = page.rec.console.filter((l) => /^(warn|error)$/.test(l.level));
  if (problems.length) fail('console: ' + problems.map((l) => l.text).join(' | '));
  return page;
}

// Every script the extension loads must at least parse.
function checkSyntax(files, hookCode, uiCode) {
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const code = rel === HOOK ? hookCode : rel === UI ? uiCode : readText(rel);
    try { new vm.Script(code, { filename: rel }); } catch (e) { throw new Error(`${rel}: ${e.message}`); }
  }
}

// ---------------------------------------------------------------- build
async function main() {
  const base = checkSources();
  const { code: hookCode, modules: hookModules } = assembleHook();
  const { code: uiCode, modules: uiModules } = assembleUi();
  checkNoDeadCode(hookCode, hookModules, uiCode, uiModules);
  checkSyntax(sourceFiles().filter((f) => !isSubModule(f)), hookCode, uiCode);
  await sandboxCheck(hookCode);
  await uiSandboxCheck(uiCode);
  console.log(`hook     ${HOOK} from ${hookModules.length} modules: checked (imports, page-only parts, page + worker sandbox)`);
  console.log(`ui       ${UI} from ${uiModules.length} modules: checked (imports, page sandbox)`);

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
  fs.rmSync(DIST, { recursive: true, force: true });
  for (const [browser, makeManifest] of Object.entries(manifests)) {
    const dir = path.join(DIST, browser);
    const files = copyInto(dir, hookCode, uiCode);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest(), null, 2) + '\n');
    files.push('manifest.json');
    const zipName = `twitch-vod-unmuter-${browser}-${base.version}.zip`;
    zip(dir, files, path.join(DIST, zipName));
    const kb = (fs.statSync(path.join(DIST, zipName)).size / 1024).toFixed(0);
    console.log(`${browser.padEnd(8)} dist/${browser}/  +  dist/${zipName} (${files.length} files, ${kb} KB)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
