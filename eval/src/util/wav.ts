/**
 * Minimal WAV (PCM16, mono) read/write — no dependencies. The Realtime API
 * gives us raw PCM16 at 24kHz; we wrap it for ASR and unwrap fixtures on read.
 */

const DEFAULT_RATE = 24000;

/** Wrap raw PCM16 mono bytes in a RIFF/WAVE header. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate = DEFAULT_RATE): Uint8Array {
  const byteRate = sampleRate * 2; // mono, 16-bit
  const blockAlign = 2;
  const dataLen = pcm.length;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  let p = 0;
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) buf[p++] = s.charCodeAt(i);
  };
  writeStr("RIFF");
  dv.setUint32(p, 36 + dataLen, true); p += 4;
  writeStr("WAVE");
  writeStr("fmt ");
  dv.setUint32(p, 16, true); p += 4;             // fmt chunk size
  dv.setUint16(p, 1, true); p += 2;              // PCM
  dv.setUint16(p, 1, true); p += 2;              // mono
  dv.setUint32(p, sampleRate, true); p += 4;
  dv.setUint32(p, byteRate, true); p += 4;
  dv.setUint16(p, blockAlign, true); p += 2;
  dv.setUint16(p, 16, true); p += 2;             // bits per sample
  writeStr("data");
  dv.setUint32(p, dataLen, true); p += 4;
  buf.set(pcm, p);
  return buf;
}

/**
 * Extract raw PCM16 from a WAV file. Tolerates extra chunks (e.g. LIST/INFO)
 * before `data`. Throws if the file isn't PCM16 mono.
 */
export function wavToPcm16(wav: Uint8Array): { pcm: Uint8Array; sampleRate: number } {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (off: number) =>
    String.fromCharCode(wav[off], wav[off + 1], wav[off + 2], wav[off + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let p = 12;
  let sampleRate = DEFAULT_RATE;
  let bitsPerSample = 16;
  let channels = 1;
  let dataOff = -1;
  let dataLen = 0;
  while (p < wav.length - 8) {
    const id = tag(p);
    const size = dv.getUint32(p + 4, true);
    if (id === "fmt ") {
      channels = dv.getUint16(p + 10, true);
      sampleRate = dv.getUint32(p + 12, true);
      bitsPerSample = dv.getUint16(p + 22, true);
    } else if (id === "data") {
      dataOff = p + 8;
      dataLen = size;
      break;
    }
    p += 8 + size + (size & 1); // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error("WAV missing data chunk");
  if (bitsPerSample !== 16 || channels !== 1) {
    throw new Error(`WAV must be PCM16 mono (got ${bitsPerSample}-bit, ${channels}ch)`);
  }
  return { pcm: wav.slice(dataOff, dataOff + dataLen), sampleRate };
}
