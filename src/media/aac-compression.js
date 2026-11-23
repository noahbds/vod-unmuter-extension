// Hook module (page and player worker): see src/hook.js.

import { log } from '../shared/logger.js';
import { concat } from './adts-muxer.js';

export async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
export async function deflate(bytes) {
  try { return { data: await pipeBytes(bytes, new CompressionStream('deflate-raw')), packed: true }; }
  catch (e) { return { data: bytes, packed: false }; }
}
export const inflate = (bytes) => pipeBytes(bytes, new DecompressionStream('deflate-raw'));

// ---- re-encoding (saving step 2, "High" / "Small" quality) --------------
// Uses WebCodecs. Each segment is encoded with the end of the previous
// segment in front of it and then cut exactly at its own start: AAC
// encoders add ~44 ms of silence at the start of every encode, which
// would otherwise leave a gap every 10 seconds.
export const KBPS = { high: 96, small: 64 };
export const delays = new Map(); // "rate|channels|kbps" -> encoder delay in samples, or null
export const codecsAvailable = () => typeof scope.AudioEncoder === 'function' && typeof scope.AudioDecoder === 'function';
// Can this browser make AAC at all? (Firefox can't.) Told to the UI, so it
// doesn't promise compressed saves that won't happen.
export let aacSupported = null;
(async () => {
  try {
    aacSupported = codecsAvailable() && !!(await scope.AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000, aac: { format: 'adts' } })).supported;
  } catch (e) { aacSupported = false; }
})();

export async function decodeFrames(frames, info) {
  const out = Array.from({ length: info.channels }, () => []);
  let failed = null;
  const dec = new scope.AudioDecoder({
    output: (a) => {
      for (let c = 0; c < info.channels; c++) {
        const b = new Float32Array(a.numberOfFrames);
        a.copyTo(b, { planeIndex: c, format: 'f32-planar' });
        out[c].push(b);
      }
      a.close();
    },
    error: (e) => { failed = e; },
  });
  dec.configure({ codec: 'mp4a.40.2', sampleRate: info.sampleRate, numberOfChannels: info.channels });
  frames.forEach((f, i) => dec.decode(new scope.EncodedAudioChunk({
    type: 'key', timestamp: Math.round((i * 1024 * 1e6) / info.sampleRate), data: f,
  })));
  await dec.flush();
  dec.close();
  if (failed) throw failed;
  return out.map((parts) => {
    const ch = new Float32Array(parts.reduce((n, b) => n + b.length, 0));
    let w = 0;
    for (const b of parts) { ch.set(b, w); w += b.length; }
    return ch;
  });
}

export async function encodePcm(chans, info, kbps) {
  const frames = [];
  let failed = null;
  const enc = new scope.AudioEncoder({
    output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); frames.push(b); },
    error: (e) => { failed = e; },
  });
  enc.configure({ codec: 'mp4a.40.2', sampleRate: info.sampleRate, numberOfChannels: info.channels, bitrate: kbps * 1000, aac: { format: 'adts' } });
  const n = chans[0].length;
  const planar = new Float32Array(n * info.channels);
  chans.forEach((c, i) => planar.set(c, i * n));
  enc.encode(new scope.AudioData({ format: 'f32-planar', sampleRate: info.sampleRate, numberOfFrames: n, numberOfChannels: info.channels, timestamp: 0, data: planar }));
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  return frames;
}

// The encoder's start-up delay differs between systems (2112 samples on
// macOS): measure it once by encoding noise and finding where it lands.
export async function encoderDelay(info, kbps) {
  const key = info.sampleRate + '|' + info.channels + '|' + kbps;
  if (delays.has(key)) return delays.get(key);
  let delay = null;
  try {
    const cfg = { codec: 'mp4a.40.2', sampleRate: info.sampleRate, numberOfChannels: info.channels, bitrate: kbps * 1000, aac: { format: 'adts' } };
    const dcfg = { codec: 'mp4a.40.2', sampleRate: info.sampleRate, numberOfChannels: info.channels };
    if (codecsAvailable() && (await scope.AudioEncoder.isConfigSupported(cfg)).supported &&
        (await scope.AudioDecoder.isConfigSupported(dcfg)).supported) {
      let seed = 12345;
      const noise = new Float32Array(info.sampleRate);
      // Low-passed noise: never repeats (no false matches) and AAC encodes
      // it faithfully enough to find the shift reliably.
      let y = 0;
      for (let i = 0; i < noise.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        y = 0.9 * y + 0.2 * (seed / 4294967296 - 0.5);
        noise[i] = y;
      }
      const out = (await decodeFrames(await encodePcm(Array(info.channels).fill(noise), info, kbps), info))[0];
      let best = -1, bestLag = 0;
      const from = 8192, to = Math.min(from + 16384, noise.length - 8192);
      for (let lag = 0; lag < 6144; lag++) { // real encoders: ~1000-2200 samples
        let c = 0, a = 0, b = 0;
        for (let i = from; i < to; i += 2) { const x = noise[i], y = out[i + lag] || 0; c += x * y; a += x * x; b += y * y; }
        const r = c / Math.sqrt(a * b || 1);
        if (r > best) { best = r; bestLag = lag; }
      }
      if (best > 0.8) delay = bestLag;
    }
  } catch (e) { delay = null; }
  delays.set(key, delay);
  if (delay === null) log('info', 'this browser has no AAC encoder: saved audio stays lossless (1.1 to 2.4 MB per muted minute)');
  return delay;
}

// prevTail: the decoded end of the previous segment (or null = silence).
export async function reencode(prevTail, cur, info, kbps, delay, frameCount) {
  const K = Math.ceil(delay / 1024) + 1;
  const lead = 1024 * K - delay; // samples placed before the segment start
  const n = cur[0].length;
  const input = cur.map((ch, c) => {
    const x = new Float32Array(lead + n);
    const prev = prevTail && prevTail[c];
    if (prev && prev.length) x.set(prev.subarray(Math.max(0, prev.length - lead)), lead - Math.min(lead, prev.length));
    x.set(ch, lead);
    return x;
  });
  const frames = await encodePcm(input, info, kbps);
  const keep = frames.slice(K, K + frameCount); // output frame K starts exactly at the segment start
  return keep.length >= frameCount - 2 ? concat(keep) : null;
}
