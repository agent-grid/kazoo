// Speaker playback — terminal-native, PCM16 @ 24 kHz mono.
//
// CRITICAL CONSTRAINT (orchestrator requirement): `flush()` MUST drop any
// queued audio synchronously. Barge-in is "user starts talking → speaker
// shuts up immediately". Any implementation that can't promise this is
// unacceptable for Kazoo regardless of latency/quality wins.
//
// Strategy: subprocess wrapper around `sox -t raw … -d` (macOS+Linux) or
// `aplay -f S16_LE -r 24000` (Linux). Both accept raw PCM16 on stdin and
// play through the default device. For instant flush we kill+respawn the
// subprocess — the few ms restart cost is paid only on interrupts.
//
// STATUS: interface only. Phase 0 fills this in.

import type { Logger } from '../lib/logger.ts'

export type SpeakerConfig = {
  sampleRate?: number // default 24000
  channels?: number // default 1
  logger: Logger
}

export type Speaker = {
  /** Enqueue a PCM16 frame for playback. Non-blocking. */
  write: (samples: Int16Array) => void
  /** Drop everything currently queued AND interrupt the in-flight playback.
   *  Returns once the device is silent. Used on barge-in. */
  flush: () => Promise<void>
  /** Wait for all queued audio to finish playing naturally. */
  drain: () => Promise<void>
  /** Tear down the subprocess. */
  close: () => Promise<void>
}

/** Open the system speaker.
 *
 *  TODO(phase-0): implement via `child_process.spawn` of sox/aplay.
 *  - `write` pipes Int16Array bytes to stdin.
 *  - `flush` kills the child (SIGKILL) and respawns it on next write.
 *  - `drain` awaits stdin drain + a short tail latency.
 *  - `close` ends stdin and awaits exit.
 *
 *  When swapping to a native binding later, keep the flush semantics:
 *  `node-speaker` doesn't expose a hard flush, so we'd need to wrap it
 *  in our own queue and respawn the underlying stream. */
export function createSpeaker(_cfg: SpeakerConfig): Speaker {
  throw new Error('audio/speaker: not implemented (Phase 0)')
}
