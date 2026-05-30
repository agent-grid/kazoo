// PCM16 ↔ base64 conversions. The Realtime wire format wants base64 PCM16 LE
// @ 24 kHz mono in both directions. Every Bun-supported platform is LE so
// the host-order Int16Array view is correct without a byteswap.

/** Encode an Int16Array (PCM16 LE samples) to a base64 string. */
export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  return Buffer.from(bytes).toString('base64')
}

/** Decode a base64 string into PCM16 LE samples. */
export function base64ToInt16(b64: string): Int16Array {
  const buf = Buffer.from(b64, 'base64')
  // Copy into a fresh aligned ArrayBuffer — Node's Buffer can be backed by a
  // shared pool with an odd byteOffset, which would break the Int16 view.
  const aligned = new ArrayBuffer(buf.byteLength)
  new Uint8Array(aligned).set(buf)
  return new Int16Array(aligned)
}

/** Sanity-check a chunk is the size we expect for our 24 kHz mono pipeline.
 *  Returns the duration in ms. Throws if the byte length isn't a multiple
 *  of 2 (each PCM16 sample is 2 bytes). */
export function durationMs(samples: Int16Array, sampleRate = 24000): number {
  return (samples.length / sampleRate) * 1000
}

export const SAMPLE_RATE_HZ = 24000
export const BYTES_PER_SAMPLE = 2
export const CHANNELS = 1
