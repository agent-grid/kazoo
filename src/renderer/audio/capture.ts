// Mic capture — getUserMedia → 24 kHz AudioContext → AudioWorklet → PCM16
// frames → IPC to main.session.sendAudio. (SURFACE_PLAN §5.)
//
// Pipeline:
//   getUserMedia (mono, AEC/NS/AGC on)
//     → new AudioContext({ sampleRate: 24000 })   [Chromium resamples device,
//                                                    anti-aliased — no manual
//                                                    downsampler anywhere]
//     → MediaStreamAudioSourceNode
//     → AudioWorkletNode('kazoo-mic')   [worklet: Int16 + 480-sample framing]
//        .port.onmessage = (ArrayBuffer) → window.kazoo.sendMicFrame(frame)
//     → (tap) AnalyserNode               [for the StatusBar mic meter]
//
// The worklet output is the 20 ms PCM16 frame as a transferable ArrayBuffer.
// We forward it straight to the preload bridge, which `postMessage`s it into
// main; main base64-encodes once (where `Buffer` exists) and calls
// `realtime.sendAudio`. The renderer never base64s and never sees a `Buffer`.
//
// The worklet module is loaded from a `self`-origin URL so it fetches under
// the production CSP (`worker-src 'self'`). `new URL('./mic-worklet.js',
// import.meta.url)` resolves to the separately-built worklet asset.

import { SAMPLE_RATE_HZ } from './pcm.ts'

/** The worklet module URL — resolved per build mode, both same-origin so the
 *  fetch passes the production CSP (`worker-src 'self'`).
 *
 *  The two modes need DIFFERENT specifiers (a Vite worklet trap):
 *   - DEV: Vite's dev server serves the transpiled module at the `.ts` path;
 *     a `.js` path there falls through to the SPA HTML fallback (HTTP 200 but
 *     NOT the worklet), which would make `addModule` load markup and fail.
 *   - BUILD: `mic-worklet.ts` is a dedicated rollup input emitted as a
 *     transpiled `mic-worklet.js` sibling. We point straight at it; the static
 *     `new URL('./mic-worklet.js', import.meta.url)` below resolves as a
 *     sibling at runtime.
 *
 *  In dev we assemble the `.ts` specifier WITHOUT a static string literal so
 *  Vite's build-time asset scanner doesn't also emit the raw `.ts` source as a
 *  stray (unreferenced, un-transpiled) asset. `import.meta.env.DEV` is
 *  statically replaced, so the production bundle keeps only the `.js` branch. */
function resolveWorkletUrl(): URL {
  if (import.meta.env.DEV) {
    // Resolve `mic-worklet.ts` (the dev server serves it transpiled) WITHOUT a
    // `new URL(literal, import.meta.url)` — that literal is what Vite's
    // build-time asset scanner would pick up and emit a stray raw-`.ts` copy
    // for. We instead derive the sibling path from this module's own URL at
    // runtime, which the scanner can't see. `capture.ts` and `mic-worklet.ts`
    // are siblings, so swapping the last path segment is exact.
    const here = new URL(import.meta.url)
    here.pathname = here.pathname.replace(/[^/]+$/, 'mic-worklet.ts')
    return here
  }
  // BUILD: `mic-worklet.ts` is a dedicated rollup input emitted as a transpiled
  // `mic-worklet.js` sibling; this static reference resolves to it at runtime.
  return new URL('./mic-worklet.js', import.meta.url)
}

const WORKLET_URL = resolveWorkletUrl()

/** The processor name registered inside the worklet. */
const PROCESSOR_NAME = 'kazoo-mic'

export type MicCapture = {
  /** The capture AudioContext (24 kHz). Shared so the caller can resume it on
   *  the start gesture. */
  readonly context: AudioContext
  /** Read the current input level in [0, 1] (RMS of the latest analyser
   *  window). Cheap; safe to poll from rAF. */
  readonly level: () => number
  /** Tear down: disconnect nodes, stop tracks, close the context. Idempotent. */
  readonly stop: () => Promise<void>
}

export type StartCaptureOptions = {
  /** Called with each 480-sample PCM16 frame (transferable ArrayBuffer). In the
   *  app this is `window.kazoo.sendMicFrame`. Injectable for tests. */
  onFrame: (frame: ArrayBuffer) => void
  /** Optional: surface a fatal capture error (permission denied, no device). */
  onError?: (err: unknown) => void
}

/** Begin mic capture. Resolves once the graph is live and frames are flowing.
 *  Throws if `getUserMedia` is denied or no device exists — the caller should
 *  surface that to the user (the Start button). */
export async function startCapture(opts: StartCaptureOptions): Promise<MicCapture> {
  // 1. Mic stream. Mono + the three browser DSP knobs: echo cancellation is
  //    load-bearing here — mic and speaker share one renderer with no physical
  //    device isolation, so without AEC the speaker leaks into the mic and
  //    trips server-VAD into a false barge-in. (SURFACE_PLAN §5, Risk #3.)
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  })

  // 2. Force the context to the wire rate. Chromium honors the requested rate
  //    and resamples the device with a proper anti-aliasing filter, so the
  //    worklet receives 24 kHz audio and never resamples.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE_HZ })

  try {
    // 3. Load the worklet module from its self-origin asset URL.
    await context.audioWorklet.addModule(WORKLET_URL)

    // 4. Build the graph: source → worklet (→ frames out) and source →
    //    analyser (→ level). The worklet is a sink for our purposes; we do NOT
    //    connect it to `destination` (that would echo the mic to the speaker).
    const source = context.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    })

    worklet.port.onmessage = (event: MessageEvent): void => {
      const frame = event.data
      if (frame instanceof ArrayBuffer && frame.byteLength > 0) {
        opts.onFrame(frame)
      }
    }
    worklet.onprocessorerror = (): void => {
      opts.onError?.(new Error('kazoo-mic worklet processor crashed'))
    }

    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.3
    const levelBuf = new Float32Array(analyser.fftSize)

    source.connect(worklet)
    source.connect(analyser)

    const level = (): number => {
      analyser.getFloatTimeDomainData(levelBuf)
      let sumSq = 0
      for (let i = 0; i < levelBuf.length; i++) {
        const v = levelBuf[i] ?? 0
        sumSq += v * v
      }
      // RMS, then clamp to [0, 1] for the meter.
      const rms = Math.sqrt(sumSq / levelBuf.length)
      return rms > 1 ? 1 : rms
    }

    let stopped = false
    const stop = async (): Promise<void> => {
      if (stopped) return
      stopped = true
      worklet.port.onmessage = null
      try {
        source.disconnect()
      } catch {
        /* already gone */
      }
      try {
        worklet.disconnect()
      } catch {
        /* already gone */
      }
      for (const track of stream.getTracks()) track.stop()
      if (context.state !== 'closed') await context.close()
    }

    return { context, level, stop }
  } catch (err) {
    // Capture graph failed to build — release the stream + context so we don't
    // leak a live mic indicator, then rethrow for the caller.
    for (const track of stream.getTracks()) track.stop()
    if (context.state !== 'closed') await context.close()
    throw err
  }
}
