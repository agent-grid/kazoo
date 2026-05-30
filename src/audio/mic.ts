// Mic capture — terminal-native, PCM16 @ 24 kHz mono.
//
// Strategy (per scaffold decision): subprocess wrapper around `sox` / `rec`
// on macOS+Linux, `arecord` on Linux as fallback. Zero native dependency at
// install time. The interface below is the contract a future native binding
// (naudiodon / `mic`+`speaker`) must satisfy so we can swap implementations
// without touching callers.
//
// STATUS: interface only. Phase 0 will fill this in — see
// `scripts/audio-loopback.ts` for the integration target.

import type { Logger } from '../lib/logger.ts'

export type MicConfig = {
  sampleRate?: number // default 24000
  channels?: number // default 1
  /** Capture chunk size in samples. Smaller = lower latency, more overhead.
   *  20 ms @ 24 kHz = 480 samples is a reasonable starting point. */
  frameSamples?: number
  logger: Logger
}

/** A live mic stream. `frames` yields Int16Array chunks; calling `close()`
 *  drains the subprocess and ends iteration cleanly. */
export type MicStream = {
  frames: AsyncIterable<Int16Array>
  close: () => Promise<void>
}

/** Open the system mic and stream PCM16 LE frames.
 *
 *  TODO(phase-0): implement via `child_process.spawn` of sox/arecord.
 *  Capture stdout as raw bytes, slice into `frameSamples`-sized Int16Array
 *  chunks, push to an AsyncQueue. On `close()`, send SIGTERM and await exit.
 *
 *  Acceptance for the swap-to-native path: same signature, same back-pressure
 *  behavior (push frames only when downstream is ready). */
export function createMic(_cfg: MicConfig): MicStream {
  throw new Error('audio/mic: not implemented (Phase 0)')
}
