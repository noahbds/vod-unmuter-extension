// Hook module (page and player worker): see src/hook.js. Pure: no state, no browser APIs.

export const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let w = 0;
  for (const b of parts) { out.set(b, w); w += b.length; }
  return out;
};

// AAC frames (ADTS) carried by a segment's audio packets.
export function packetsToAdts(packets) {
  const parts = [];
  let started = false;
  for (let o = 0; o + 188 <= packets.length; o += 188) {
    const afc = (packets[o + 3] >> 4) & 3;
    if (!(afc & 1)) continue;
    let p = o + 4 + ((afc & 2) ? 1 + packets[o + 4] : 0);
    if (p >= o + 188) continue;
    if (packets[o + 1] & 0x40) {
      if (p + 9 > o + 188) continue;
      p += 9 + packets[p + 8];
      started = true;
    } // skip the PES header
    if (started && p < o + 188) parts.push(packets.subarray(p, o + 188));
  }
  return concat(parts);
}
export function splitAdts(es) {
  const frames = [];
  for (let i = 0; i + 7 <= es.length;) {
    if (es[i] !== 0xff || (es[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
    const len = ((es[i + 3] & 3) << 11) | (es[i + 4] << 3) | (es[i + 5] >> 5);
    if (len < 7 || i + len > es.length) break;
    frames.push(es.subarray(i, i + len));
    i += len;
  }
  return frames;
}
export const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
export const adtsInfo = (f) => ({ sampleRate: ADTS_RATES[(f[2] >> 2) & 0xf] || 48000, channels: (((f[2] & 1) << 2) | (f[3] >> 6)) || 2 });

// Wraps a bare AAC frame with a 7-byte ADTS header (objectType 2 = AAC-LC).
export function wrapAdts(raw, sampleRate, channels, objectType = 2) {
  const rate = ADTS_RATES.indexOf(sampleRate);
  if (rate < 0 || objectType < 1 || objectType > 4 || channels < 1 || channels > 7) return null;
  const len = raw.length + 7;
  const f = new Uint8Array(len);
  f.set([0xff, 0xf1, ((objectType - 1) << 6) | (rate << 2) | (channels >> 2),
    ((channels & 3) << 6) | (len >> 11), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
  f.set(raw, 7);
  return f;
}

// AAC frames -> MPEG-TS audio packets (PID 0x100; spliceAudio renumbers it).
export function muxAdts(frames, pts, sampleRate) {
  const PER_PES = 4;
  const ticks = (1024 * 90000) / sampleRate; // 90 kHz clock per AAC frame
  const packets = [];
  let cc = 0;
  for (let i = 0; i < frames.length; i += PER_PES) {
    const payload = concat(frames.slice(i, i + PER_PES));
    const t = Math.round(pts + i * ticks) % 8589934592;
    const hi = Math.floor(t / 1073741824) & 7, lo = t % 1073741824;
    const len = 8 + payload.length;
    const pes = concat([new Uint8Array([0, 0, 1, 0xc0, len > 0xffff ? 0 : len >> 8, len > 0xffff ? 0 : len & 0xff,
      0x80, 0x80, 5, 0x21 | (hi << 1), (lo >> 22) & 0xff, (((lo >> 15) & 0x7f) << 1) | 1, (lo >> 7) & 0xff, ((lo & 0x7f) << 1) | 1]), payload]);
    for (let o = 0; o < pes.length;) {
      const pkt = new Uint8Array(188);
      const left = pes.length - o;
      pkt[0] = 0x47;
      pkt[1] = (o === 0 ? 0x40 : 0) | 0x01;
      pkt[2] = 0x00;
      if (left >= 184) {
        pkt[3] = 0x10 | cc;
        pkt.set(pes.subarray(o, o + 184), 4);
        o += 184;
      } else {
        pkt[3] = 0x30 | cc; // adaptation field = stuffing
        const af = 183 - left;
        pkt[4] = af;
        if (af > 0) { pkt[5] = 0; pkt.fill(0xff, 6, 5 + af); }
        pkt.set(pes.subarray(o), 5 + af);
        o = pes.length;
      }
      cc = (cc + 1) & 0x0f;
      packets.push(pkt);
    }
  }
  return concat(packets);
}
