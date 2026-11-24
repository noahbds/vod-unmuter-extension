// Hook module (page and player worker): see src/hook.js. Pure: no state, no browser APIs.

import { adtsInfo, concat } from './adts-muxer.js';

// ------------------------------------------------------------ fragmented MP4
// VODs streamed in HEVC/AV1 come as fragmented MP4: one "init-0.mp4" per
// quality (the track list: which track is the sound, its timescale and AAC
// settings), then numbered files made of moof (sample table) + mdat (sample
// bytes) pairs. To give a muted file the sound of another quality, its
// audio samples are swapped for that quality's ones and its moof/mdat pairs
// are written again (sizes and offsets change; video bytes stay the same).

// The boxes in buf[start, end): { type, start, end, body } (body: where the
// contents start, after the size/type header).
export function mp4Boxes(buf, start = 0, end = buf.length) {
  const out = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    let body = o + 8;
    if (size === 1) {
      if (o + 16 > end) return null;
      size = dv.getUint32(o + 8) * 2 ** 32 + dv.getUint32(o + 12);
      body = o + 16;
    } else if (size === 0) size = end - o;
    if (size < body - o || o + size > end) return null; // damaged or cut
    out.push({ type, start: o, end: o + size, body });
    o += size;
  }
  return o === end ? out : null;
}

const childOf = (buf, box, type) => (mp4Boxes(buf, box.body, box.end) || []).find((b) => b.type === type);
const childrenOf = (buf, box, type) => (mp4Boxes(buf, box.body, box.end) || []).filter((b) => b.type === type);
const view = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const u64 = (dv, o) => dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4);
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// AudioSpecificConfig in an esds box: ES_Descriptor (3) > DecoderConfig (4)
// > DecoderSpecificInfo (5). Two qualities' sound can be swapped only if
// these bytes match (same AAC profile, sample rate and channels).
export function esdsConfig(buf, esds) {
  let o = esds.body + 4; // version + flags
  const desc = () => {
    const tag = buf[o++];
    let len = 0;
    for (let i = 0; i < 4; i++) { const b = buf[o++]; len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
    return { tag, len, at: o };
  };
  let d = desc();
  if (d.tag !== 3) return null;
  const flags = buf[o + 2];
  o += 3;
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + buf[o];
  if (flags & 0x20) o += 2;
  d = desc();
  if (d.tag !== 4) return null;
  o += 13;
  d = desc();
  if (d.tag !== 5 || d.at + d.len > esds.end) return null;
  return buf.subarray(d.at, d.at + d.len);
}

// init-0.mp4: its tracks (id -> { handler, timescale, defaults }) and
// which one is the sound.
export function readMp4Init(buf) {
  const top = mp4Boxes(buf);
  const moov = top && top.find((b) => b.type === 'moov');
  if (!moov) return null;
  const dv = view(buf);
  const tracks = new Map();
  for (const trak of childrenOf(buf, moov, 'trak')) {
    const tkhd = childOf(buf, trak, 'tkhd');
    const mdia = childOf(buf, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const id = dv.getUint32(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12));
    const mdhd = childOf(buf, mdia, 'mdhd');
    const hdlr = childOf(buf, mdia, 'hdlr');
    if (!mdhd || !hdlr) continue;
    const timescale = dv.getUint32(mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12));
    const handler = String.fromCharCode(...buf.subarray(hdlr.body + 8, hdlr.body + 12));
    const track = { id, handler, timescale, defaults: { duration: 0, size: 0, flags: 0 }, codec: null, config: null };
    const minf = childOf(buf, mdia, 'minf');
    const stbl = minf && childOf(buf, minf, 'stbl');
    const stsd = stbl && childOf(buf, stbl, 'stsd');
    const entry = stsd && (mp4Boxes(buf, stsd.body + 8, stsd.end) || [])[0];
    if (entry) {
      track.codec = entry.type;
      if (handler === 'soun' && entry.type === 'mp4a') {
        // Audio sample entry: 28 bytes before its child boxes.
        const esds = (mp4Boxes(buf, entry.body + 28, entry.end) || []).find((b) => b.type === 'esds');
        const cfg = esds && esdsConfig(buf, esds);
        if (cfg) track.config = hex(cfg);
      }
    }
    tracks.set(id, track);
  }
  const mvex = childOf(buf, moov, 'mvex');
  for (const trex of mvex ? childrenOf(buf, mvex, 'trex') : []) {
    const t = tracks.get(dv.getUint32(trex.body + 4));
    if (t) t.defaults = { duration: dv.getUint32(trex.body + 12), size: dv.getUint32(trex.body + 16), flags: dv.getUint32(trex.body + 20) };
  }
  const audio = [...tracks.values()].find((t) => t.handler === 'soun');
  return audio ? { tracks, audioId: audio.id, audio } : null;
}

// One traf: its track, start time (tfdt) and samples, each with where its
// bytes are in buf. `base`: where the data of a traf without an explicit
// base starts (the moof, or the end of the previous traf's data).
function readTraf(buf, traf, moof, init, fallbackBase) {
  const dv = view(buf);
  const kids = mp4Boxes(buf, traf.body, traf.end) || [];
  const tfhd = kids.find((b) => b.type === 'tfhd');
  if (!tfhd) return null;
  const tf = dv.getUint32(tfhd.body) & 0xffffff;
  let o = tfhd.body + 4;
  const trackId = dv.getUint32(o); o += 4;
  const track = init.tracks.get(trackId);
  const d = Object.assign({}, track ? track.defaults : { duration: 0, size: 0, flags: 0 });
  let base = (tf & 0x20000) ? moof.start : fallbackBase;
  let sdi = null;
  if (tf & 0x1) { base = u64(dv, o); o += 8; }
  if (tf & 0x2) { sdi = dv.getUint32(o); o += 4; }
  if (tf & 0x8) { d.duration = dv.getUint32(o); o += 4; }
  if (tf & 0x10) { d.size = dv.getUint32(o); o += 4; }
  if (tf & 0x20) { d.flags = dv.getUint32(o); o += 4; }
  const tfdt = kids.find((b) => b.type === 'tfdt');
  const time = tfdt ? (buf[tfdt.body] === 1 ? u64(dv, tfdt.body + 4) : dv.getUint32(tfdt.body + 4)) : 0;
  const samples = [];
  let next = base; // where the next trun's data starts without a data offset
  for (const trun of kids.filter((b) => b.type === 'trun')) {
    const version = buf[trun.body];
    const rf = dv.getUint32(trun.body) & 0xffffff;
    let p = trun.body + 4;
    const count = dv.getUint32(p); p += 4;
    let at = next;
    if (rf & 0x1) { at = base + dv.getInt32(p); p += 4; }
    let firstFlags = null;
    if (rf & 0x4) { firstFlags = dv.getUint32(p); p += 4; }
    for (let i = 0; i < count; i++) {
      const s = { duration: d.duration, size: d.size, flags: i === 0 && firstFlags !== null ? firstFlags : d.flags, cto: 0, offset: at };
      if (rf & 0x100) { s.duration = dv.getUint32(p); p += 4; }
      if (rf & 0x200) { s.size = dv.getUint32(p); p += 4; }
      if (rf & 0x400) { s.flags = dv.getUint32(p); p += 4; }
      if (rf & 0x800) { s.cto = version ? dv.getInt32(p) : dv.getUint32(p); p += 4; }
      if (p > trun.end) return null;
      at += s.size;
      samples.push(s);
    }
    next = at;
  }
  if (samples.some((s) => s.offset < 0 || s.offset + s.size > buf.length)) return null;
  // Boxes that point at byte positions (encryption info) can't be moved.
  if (kids.some((b) => b.type === 'saio' || b.type === 'senc')) return null;
  const others = kids.filter((b) => !['tfhd', 'tfdt', 'trun'].includes(b.type)).map((b) => buf.subarray(b.start, b.end));
  return { trackId, sdi, time, samples, others, end: next };
}

// A media file: its top-level boxes, and each moof with its trafs.
export function readMp4Fragment(buf, init) {
  const top = mp4Boxes(buf);
  if (!top || !init) return null;
  const pairs = [];
  for (let i = 0; i < top.length; i++) {
    if (top[i].type !== 'moof') continue;
    const moof = top[i];
    const mdat = top[i + 1] && top[i + 1].type === 'mdat' ? top[i + 1] : null;
    if (!mdat) return null;
    const kids = mp4Boxes(buf, moof.body, moof.end);
    if (!kids) return null;
    const trafs = [];
    let base = moof.start;
    for (const k of kids.filter((b) => b.type === 'traf')) {
      const t = readTraf(buf, k, moof, init, base);
      if (!t) return null;
      trafs.push(t);
      base = t.end;
    }
    pairs.push({ index: i, moof, mdat, trafs, others: kids.filter((b) => b.type !== 'traf').map((b) => buf.subarray(b.start, b.end)) });
  }
  return pairs.length ? { top, pairs } : null;
}

// The sound of a media file: its samples (decode time, duration, flags,
// bytes), in the track's timescale.
export function extractMp4Audio(buf, initBytes) {
  const init = initBytes && readMp4Init(initBytes);
  const frag = init && readMp4Fragment(buf, init);
  if (!frag) return null;
  const samples = [];
  for (const pair of frag.pairs) {
    for (const t of pair.trafs) {
      if (t.trackId !== init.audioId) continue;
      let time = t.time;
      for (const s of t.samples) {
        samples.push({ time, duration: s.duration, flags: s.flags, cto: s.cto, bytes: buf.subarray(s.offset, s.offset + s.size) });
        time += s.duration;
      }
    }
  }
  if (!samples.length) return null;
  return { timescale: init.audio.timescale, config: init.audio.config, start: samples[0].time, samples };
}

// ---- writing boxes
const u32 = (n) => { const b = new Uint8Array(4); view(b).setUint32(0, n >>> 0); return b; };
const u64b = (n) => concat([u32(Math.floor(n / 2 ** 32)), u32(n % 2 ** 32)]);
function mp4Box(type, parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  view(out).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}
const fullBox = (type, version, flags, parts) => mp4Box(type, [u32((version << 24) | flags), ...parts]);

// A traf with every sample written out (duration, size, flags, and the
// composition offset if any): no dependence on defaults or base offsets.
function writeTraf(t, dataOffset) {
  const hasCto = t.samples.some((s) => s.cto);
  const signed = t.samples.some((s) => s.cto < 0); // version 1: signed offsets
  const tfhd = fullBox('tfhd', 0, 0x20000 | (t.sdi !== null ? 0x2 : 0), [u32(t.trackId), ...(t.sdi !== null ? [u32(t.sdi)] : [])]);
  const tfdt = fullBox('tfdt', 1, 0, [u64b(t.time)]);
  const per = [];
  for (const s of t.samples) {
    per.push(u32(s.duration), u32(s.bytes.length), u32(s.flags));
    if (hasCto) { const b = new Uint8Array(4); if (signed) view(b).setInt32(0, s.cto); else view(b).setUint32(0, s.cto); per.push(b); }
  }
  const trun = fullBox('trun', signed ? 1 : 0, 0x1 | 0x100 | 0x200 | 0x400 | (hasCto ? 0x800 : 0), [u32(t.samples.length), u32(dataOffset), ...per]);
  return mp4Box('traf', [tfhd, tfdt, trun, ...t.others]);
}

// moof + mdat for these trafs. The moof's size doesn't depend on the data
// offsets, so it is written once to measure it, then for real.
function writePair(others, trafs) {
  const build = (offsets) => mp4Box('moof', [...others, ...trafs.map((t, i) => writeTraf(t, offsets[i]))]);
  const moofSize = build(trafs.map(() => 0)).length;
  const offsets = [];
  let at = moofSize + 8;
  for (const t of trafs) { offsets.push(at); at += t.samples.reduce((n, s) => n + s.bytes.length, 0); }
  const data = trafs.flatMap((t) => t.samples.map((s) => s.bytes));
  return concat([build(offsets), mp4Box('mdat', data)]);
}

// Keeps everything of `target` (video, metadata) but replaces its sound
// with `audio` (from extractMp4Audio): the same file from another quality.
// Returns null if they don't fit together.
export function spliceMp4Audio(target, targetInitBytes, audio) {
  const init = targetInitBytes && readMp4Init(targetInitBytes);
  if (!init || !audio || !audio.samples.length) return null;
  // Same AAC settings and clock, or the player would choke on it.
  if (!init.audio.config || init.audio.config !== audio.config || init.audio.timescale !== audio.timescale) return null;
  const frag = readMp4Fragment(target, init);
  if (!frag) return null;
  const audioTrafs = frag.pairs.flatMap((p) => p.trafs.filter((t) => t.trackId === init.audioId));
  if (!audioTrafs.length) return null;
  const ts = audio.timescale;
  // Same part of the VOD? Sound must start at the same time (within 0.1 s)
  // and last as long (within 0.1 s).
  const start = audioTrafs[0].time;
  const last = audioTrafs[audioTrafs.length - 1];
  const end = last.time + last.samples.reduce((n, s) => n + s.duration, 0);
  const aLast = audio.samples[audio.samples.length - 1];
  const aEnd = aLast.time + aLast.duration;
  if (Math.abs(start - audio.start) > 0.1 * ts || Math.abs((end - start) - (aEnd - audio.start)) > 0.1 * ts) return null;
  // Donor times on the target's clock.
  const shift = start - audio.start;
  // (A saved copy has no sample flags: the target's defaults are used.)
  const donor = audio.samples.map((s) => Object.assign({}, s, { time: s.time + shift, flags: s.flags == null ? init.audio.defaults.flags : s.flags }));

  const out = [];
  let prev = 0;
  let k = 0; // next donor sample
  let audioIndex = 0;
  for (const pair of frag.pairs) {
    out.push(...frag.top.slice(prev, pair.index).filter((b) => b.type !== 'sidx').map((b) => target.subarray(b.start, b.end)));
    prev = pair.index + 2;
    const trafs = pair.trafs.map((t) => {
      if (t.trackId !== init.audioId) {
        return Object.assign({}, t, { samples: t.samples.map((s) => Object.assign({}, s, { bytes: target.subarray(s.offset, s.offset + s.size) })) });
      }
      // This traf gets the donor samples up to where the next audio traf starts.
      audioIndex++;
      const until = audioIndex < audioTrafs.length ? audioTrafs[audioIndex].time : Infinity;
      const mine = [];
      while (k < donor.length && (donor[k].time < until)) mine.push(donor[k++]);
      return Object.assign({}, t, { time: mine.length ? mine[0].time : t.time, samples: mine });
    });
    out.push(writePair(pair.others, trafs));
  }
  // What comes after the last mdat. A sidx (byte sizes of the file) would be
  // wrong now: it is left out, HLS players don't need it.
  out.push(...frag.top.slice(prev).filter((b) => b.type !== 'sidx').map((b) => target.subarray(b.start, b.end)));
  return concat(out);
}

// ---- saved copies
// Saved sound is kept as ADTS AAC frames (the same format as for MPEG-TS
// VODs, so compression, backups and storage don't change), with its start
// time on a 90 kHz clock. MP4 stores the AAC settings once (in the init
// file) and the frames bare: these convert between the two. Only plain
// AAC settings (2 bytes, e.g. "1190") fit in an ADTS header.
export function mp4AudioToAdts(audio) {
  if (!audio || !audio.config || audio.config.length !== 4) return null;
  const asc = parseInt(audio.config, 16);
  const objectType = asc >> 11, rate = (asc >> 7) & 0xf, channels = (asc >> 3) & 0xf;
  if (objectType < 1 || objectType > 4 || rate > 12 || channels > 7) return null;
  return audio.samples.map((s) => {
    const len = s.bytes.length + 7;
    const f = new Uint8Array(len);
    f.set([0xff, 0xf1, ((objectType - 1) << 6) | (rate << 2) | (channels >> 2),
      ((channels & 3) << 6) | (len >> 11), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
    f.set(s.bytes, 7);
    return f;
  });
}

// The AAC settings of an ADTS frame, written like an MP4 init file's ("1190").
export function adtsConfig(frame) {
  const objectType = (frame[2] >> 6) + 1, rate = (frame[2] >> 2) & 0xf, channels = ((frame[2] & 1) << 2) | (frame[3] >> 6);
  return ((objectType << 11) | (rate << 7) | (channels << 3)).toString(16).padStart(4, '0');
}

// Saved ADTS frames -> what spliceMp4Audio takes, on the clock of the
// quality being watched (from its init file). null if the AAC settings
// differ.
export function adtsToMp4Audio(frames, pts90k, initBytes) {
  const init = initBytes && readMp4Init(initBytes);
  if (!init || !frames || !frames.length || adtsConfig(frames[0]) !== init.audio.config) return null;
  const ts = init.audio.timescale;
  const per = (1024 * ts) / adtsInfo(frames[0]).sampleRate; // one AAC frame on that clock
  const start = Math.round((pts90k * ts) / 90000);
  const samples = frames.map((f, i) => {
    const head = (f[1] & 1) ? 7 : 9; // 9 with a CRC
    return { time: start + Math.round(i * per), duration: Math.round((i + 1) * per) - Math.round(i * per), flags: null, cto: 0, bytes: f.subarray(head) };
  });
  return { timescale: ts, config: init.audio.config, start, samples };
}
