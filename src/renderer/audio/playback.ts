// Playback — a gapless, scheduled AudioBufferSource queue fed by main's
// AUDIO_CHUNK events, with INSTANT flush on barge-in. (SURFACE_PLAN §5.)
//
// This is the WebAudio replacement for the subprocess speaker. The barge-in
// flush is the SIGKILL analog: `src.stop()` synchronously drops every
// not-yet-played scheduled buffer in-process. There is no OS pipe or hardware
// process buffer here — the scheduled WebAudio buffers ARE the only buffer and
// they live in our own renderer, so the flush is cleaner and lower-variance
// than killing a player process.
//
// Two gates protect against the post-barge-in tail (mirrors main's `bargedIn`):
//   - main's gate drops the OpenAI NETWORK tail before chunks leave main;
//   - this renderer gate (`gated`) ignores any AUDIO_CHUNK still in the IPC
//     pipe after FLUSH_AUDIO. Because AUDIO_CHUNK and FLUSH_AUDIO ride the same
//     `webContents` queue, they stay ordered; `responseStarted()` lifts the
//     gate when a fresh narration response begins.

import { int16ToFloat32, SAMPLE_RATE_HZ } from './pcm.ts'

/** Scheduling lookahead. Start each chunk at least this far in the future so
 *  IPC jitter can't make us schedule into the past (which would drop the
 *  chunk). 20 ms absorbs normal jitter without an audible gap. */
const LOOKAHEAD_S = 0.02

export type Playback = {
  /** The playback AudioContext. Shared so the caller can `resume()` it on the
   *  start gesture (contexts begin `suspended`). */
  readonly context: AudioContext
  /** Enqueue one PCM16 chunk (raw bytes as an ArrayBuffer from main) for
   *  gapless playback. No-op while gated (post-barge-in tail). */
  readonly enqueue: (pcm: ArrayBuffer) => void
  /** Barge-in: stop + clear everything NOW, and gate incoming chunks until the
   *  next `responseStarted()`. The SIGKILL analog. */
  readonly flush: () => void
  /** A fresh narration response began — lift the post-flush gate. */
  readonly responseStarted: () => void
  /** End-of-turn marker. (Playback drains on its own; this is for indicators.) */
  readonly markDone: () => void
  /** True while audio is actively scheduled/playing (`playHead` is ahead of the
   *  clock). Drives the speaking indicator's amplitude gate. */
  readonly isPlaying: () => boolean
  /** Current output level in [0, 1] (RMS of the latest analyser window) — for
   *  the resonator's amplitude reactivity. */
  readonly level: () => number
  /** Tear down: stop sources, close the context. Idempotent. */
  readonly stop: () => Promise<void>
}

export function createPlayback(): Playback {
  // A dedicated 24 kHz context. The Realtime wire rate is 24 kHz; WebAudio
  // upsamples 24 k → device rate inside the graph for free, so we author
  // buffers at 24 kHz and never resample by hand.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE_HZ })

  // Output meter tap for the resonator amplitude.
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.3
  analyser.connect(context.destination)
  const levelBuf = new Float32Array(analyser.fftSize)

  /** Every scheduled source still in flight (so flush can stop them all). */
  const liveSources = new Set<AudioBufferSourceNode>()
  /** The running schedule clock — when the next chunk should start. */
  let playHead = 0
  /** Post-barge-in gate: drop chunks until the next response starts. */
  let gated = false

  function enqueue(pcm: ArrayBuffer): void {
    if (gated) return
    if (pcm.byteLength < 2) return

    // Bytes → Int16 (LE) → Float32. The ArrayBuffer from main is a fresh,
    // exact-length copy (audio-sink.ts slices it), so the Int16 view is safe
    // even on odd offsets — but guard the length to whole samples anyway.
    const sampleCount = pcm.byteLength >> 1
    const int16 = new Int16Array(pcm, 0, sampleCount)
    const float32 = int16ToFloat32(int16)

    const buffer = context.createBuffer(1, float32.length, SAMPLE_RATE_HZ)
    // `getChannelData(0).set(...)` rather than `copyToChannel(float32)` — the
    // latter's signature pins `Float32Array<ArrayBuffer>` (the lib's tightened
    // typed-array generic), while `int16ToFloat32` returns the wider
    // `Float32Array<ArrayBufferLike>`. `.set` accepts an ArrayLike<number> and
    // is exactly as fast.
    buffer.getChannelData(0).set(float32)

    const src = context.createBufferSource()
    src.buffer = buffer
    src.connect(analyser)

    const startAt = Math.max(context.currentTime + LOOKAHEAD_S, playHead)
    src.start(startAt)
    playHead = startAt + buffer.duration

    liveSources.add(src)
    src.onended = (): void => {
      liveSources.delete(src)
    }
  }

  function flush(): void {
    gated = true
    for (const src of liveSources) {
      try {
        src.stop()
        src.disconnect()
      } catch {
        /* already stopped/disconnected */
      }
    }
    liveSources.clear()
    // Reset the schedule clock so the next response starts immediately rather
    // than queuing behind the (now-killed) tail.
    playHead = context.currentTime
  }

  function responseStarted(): void {
    gated = false
  }

  function markDone(): void {
    // Nothing to stop — scheduled buffers drain themselves. The indicator reads
    // `isPlaying()`; this exists for symmetry / future end-of-turn hooks.
  }

  function isPlaying(): boolean {
    return playHead > context.currentTime + 0.001
  }

  function level(): number {
    analyser.getFloatTimeDomainData(levelBuf)
    let sumSq = 0
    for (let i = 0; i < levelBuf.length; i++) {
      const v = levelBuf[i] ?? 0
      sumSq += v * v
    }
    const rms = Math.sqrt(sumSq / levelBuf.length)
    return rms > 1 ? 1 : rms
  }

  let stopped = false
  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    flush()
    try {
      analyser.disconnect()
    } catch {
      /* already gone */
    }
    if (context.state !== 'closed') await context.close()
  }

  return {
    context,
    enqueue,
    flush,
    responseStarted,
    markDone,
    isPlaying,
    level,
    stop,
  }
}
