// The mic AudioWorkletProcessor. Runs on the dedicated audio render thread, in
// its own AudioWorkletGlobalScope (see ../worklet.d.ts for the ambient types).
//
// RESPONSIBILITY — deliberately minimal (SURFACE_PLAN §5):
//   - Float32 [-1, 1]  →  PCM16 LE (Int16)
//   - accumulate into fixed 480-sample (20 ms @ 24 kHz) frames
//   - postMessage each full frame's ArrayBuffer to the main thread (zero-copy)
//
// NO resampling lives here. The capture AudioContext is created with
// `{ sampleRate: 24000 }`, so Chromium resamples the mic device through a
// proper anti-aliasing filter BEFORE samples reach this worklet — eliminating
// the old hand-rolled 48k→24k decimator, its carried filter state, and the
// boundary-click / aliasing risk class entirely. We therefore see audio that
// is already 24 kHz mono; we only quantize + frame it.
//
// This file is built as a SEPARATE asset (not inlined) so the renderer can
// `audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url))` and
// fetch it from `self` origin under the production CSP (`worker-src 'self'`).
// Because it is loaded by URL — not imported into the renderer bundle — it
// must be self-contained: NO imports. The two PCM constants below are
// duplicated from `pcm.ts` (kept trivially in sync) rather than imported.

/** Frame size: 480 samples = 20 ms @ 24 kHz. Matches the Realtime
 *  `input_audio_buffer.append` cadence the subprocess path used. */
const FRAME_SAMPLES = 480

/** Quantize one Float32 sample [-1, 1] to PCM16. Asymmetric scale so the full
 *  Int16 range is used without clipping at +1.0. Mirrors `float32ToInt16` in
 *  pcm.ts — kept in sync by hand (the worklet can't import). */
function sampleToInt16(x: number): number {
  const s = x < -1 ? -1 : x > 1 ? 1 : x
  return s < 0 ? s * 0x8000 : s * 0x7fff
}

class KazooMicProcessor extends AudioWorkletProcessor {
  /** Rolling accumulator of quantized samples awaiting a full 480-frame. */
  private readonly frame = new Int16Array(FRAME_SAMPLES)
  /** Write cursor into `frame`. */
  private filled = 0

  override process(inputs: Float32Array[][]): boolean {
    // inputs[0] = first input; [0][0] = its first (mono) channel. A
    // disconnected input yields an empty array — emit silence-free (skip).
    const channel = inputs[0]?.[0]
    if (channel === undefined) {
      // Keep the processor alive even with no input this quantum (e.g. the
      // graph is still connecting); returning false would tear it down.
      return true
    }

    for (let i = 0; i < channel.length; i++) {
      this.frame[this.filled] = sampleToInt16(channel[i] ?? 0)
      this.filled++

      if (this.filled === FRAME_SAMPLES) {
        // Ship a COPY's backing buffer and transfer it (zero-copy hand-off),
        // then keep our own `frame` for the next fill. A fresh copy each frame
        // avoids the main thread reading a buffer we're about to overwrite.
        const out = this.frame.slice() // Int16Array copy (own ArrayBuffer)
        this.port.postMessage(out.buffer, [out.buffer])
        this.filled = 0
      }
    }

    // Returning true keeps the node processing for the life of the graph.
    return true
  }
}

registerProcessor('kazoo-mic', KazooMicProcessor)
