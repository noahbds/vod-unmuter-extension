// Hook module (page and player worker): see src/hook.js. Pure: no state, no browser APIs.

// ------------------------------------------------------------ MPEG-TS
// Finds the audio stream of a .ts segment and the timestamp it starts at.
export function scanTs(buf) {
  const PKT = 188;
  if (buf.length < PKT || buf[0] !== 0x47) return null;
  let pmtPid = -1, audioPid = -1, audioType = -1, pts = -1;
  for (let o = 0; o + PKT <= buf.length && pts < 0; o += PKT) {
    if (buf[o] !== 0x47) return null;
    if (!(buf[o + 1] & 0x40)) continue; // only packets that start a unit
    const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
    const afc = (buf[o + 3] >> 4) & 3;
    if (!(afc & 1)) continue;
    let p = o + 4 + ((afc & 2) ? 1 + buf[o + 4] : 0);
    if (pid === 0 && pmtPid < 0) {
      p += 1 + buf[p];
      const secLen = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
      for (let q = p + 8; q < p + 3 + secLen - 4; q += 4) {
        if (((buf[q] << 8) | buf[q + 1]) !== 0) { pmtPid = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3]; break; }
      }
    } else if (pid === pmtPid && audioPid < 0) {
      p += 1 + buf[p];
      const secLen = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
      const infoLen = ((buf[p + 10] & 0x0f) << 8) | buf[p + 11];
      for (let q = p + 12 + infoLen; q < p + 3 + secLen - 4;) {
        const type = buf[q];
        const esLen = ((buf[q + 3] & 0x0f) << 8) | buf[q + 4];
        if (type === 0x0f || type === 0x11) { audioPid = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2]; audioType = type; break; }
        q += 5 + esLen;
      }
    } else if (pid === audioPid && buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1 && (buf[p + 7] & 0x80)) {
      pts = ((buf[p + 9] >> 1) & 7) * 1073741824 +
        ((buf[p + 10] << 22) | ((buf[p + 11] >> 1) << 15) | (buf[p + 12] << 7) | (buf[p + 13] >> 1));
    }
  }
  return audioPid >= 0 ? { audioPid, audioType, pts, pmtPid } : null;
}

// The audio packets of a segment: what gets saved, and what gets spliced.
export function extractAudio(buf) {
  const PKT = 188;
  const info = scanTs(buf);
  if (!info) return null;
  const offsets = [];
  for (let o = 0; o + PKT <= buf.length; o += PKT) {
    if ((((buf[o + 1] & 0x1f) << 8) | buf[o + 2]) === info.audioPid) offsets.push(o);
  }
  if (!offsets.length) return null;
  const packets = new Uint8Array(offsets.length * PKT);
  offsets.forEach((o, i) => packets.set(buf.subarray(o, o + PKT), i * PKT));
  return { type: info.audioType, pts: info.pts, packets };
}

// Keeps every packet of `target` (video, metadata) but replaces its audio
// with `audio` (from extractAudio): the same segment from another quality,
// or a saved copy.
export function spliceAudio(target, audio) {
  const PKT = 188;
  const t = scanTs(target);
  if (!t || !audio || t.audioType !== audio.type) return null;
  // Same segment? Audio must start at the same time (within 0.1 s).
  if (t.pts >= 0 && audio.pts >= 0 && Math.abs(t.pts - audio.pts) > 9000) return null;
  const src = audio.packets;
  const count = Math.floor(src.length / PKT);
  if (!count) return null;

  const keep = [];
  let firstCC = -1;
  let start = 0; // audio may only come after the stream table (PAT/PMT)
  for (let o = 0; o + PKT <= target.length; o += PKT) {
    const pid = ((target[o + 1] & 0x1f) << 8) | target[o + 2];
    if (pid === t.audioPid) {
      if (firstCC < 0) firstCC = target[o + 3] & 0x0f;
    } else {
      keep.push(o);
      if (pid === t.pmtPid && !start) start = keep.length;
    }
  }
  const ccShift = firstCC < 0 ? 0 : (firstCC - (src[3] & 0x0f) + 16) % 16;

  const out = new Uint8Array((keep.length + count) * PKT);
  let w = 0, a = 0;
  const putAudio = () => {
    out.set(src.subarray(a * PKT, a * PKT + PKT), w);
    a++;
    out[w + 1] = (out[w + 1] & 0xe0) | (t.audioPid >> 8);
    out[w + 2] = t.audioPid & 0xff;
    out[w + 3] = (out[w + 3] & 0xf0) | (((out[w + 3] & 0x0f) + ccShift) % 16);
    w += PKT;
  };
  // Spread the audio evenly between the target's other packets, starting
  // right after the stream table so players know it's audio.
  const span = Math.max(1, keep.length - start);
  for (let i = 0; i < keep.length; i++) {
    while (i >= start && a < count && a / count <= (i - start) / span) putAudio();
    out.set(target.subarray(keep[i], keep[i] + PKT), w);
    w += PKT;
  }
  while (a < count) putAudio();
  return out;
}
