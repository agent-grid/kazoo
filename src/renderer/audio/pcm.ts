// Browser-safe PCM16 conversions for the renderer's WebAudio layer.
//
// Relocated from the deleted `src/audio/format.ts`. The sandboxed renderer
// has NO `Buffer` (nodeIntegration:false), so these are pure typed-array
// conversions only. Base64 ↔ bytes happens in MAIN (where `Buffer` exists),
// at the Realtime WS boundary — see SURFACE_PLAN.md §5. The wire format is
// PCM16 LE, mono, 24 kHz in both directions (OpenAI Realtime's native rate),
// so nothing on this path resamples.

/** OpenAI Realtime wire sample rate. Capture + playback both run here. */
export const SAMPLE_RATE_HZ = 24000
export const BYTES_PER_SAMPLE = 2
export const CHANNELS = 1

/** Float32 [-1, 1] (WebAudio) → PCM16 LE samples. Asymmetric scale so the
 *  full Int16 range is used without clipping at +1.0. */
export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** PCM16 LE samples → Float32 [-1, 1] for an AudioBuffer. */
export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    out[i] = (input[i] ?? 0) / 0x8000
  }
  return out
}

/** Duration in ms of a PCM16 mono buffer at the wire rate. */
export function durationMs(samples: Int16Array, sampleRate = SAMPLE_RATE_HZ): number {
  return (samples.length / sampleRate) * 1000
}
