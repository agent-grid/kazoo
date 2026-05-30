// Mic capture — terminal-native, PCM16 @ 24 kHz mono.
//
// Implementation: spawn the configured backend's recorder binary (`rec` or
// `arecord`), accumulate its stdout into fixed-size frames, push frames
// into an AsyncQueue. Callers iterate with `for await (const f of mic.frames)`.
//
// Back-pressure: stdout pauses naturally if the queue's consumer isn't
// reading — Node's pipe handling buffers a small amount and then pauses
// the source. We don't add a manual pause/resume yet; if Phase 1 wants
// stricter back-pressure we'll wire it through AsyncQueue.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { AsyncQueue } from '../lib/async.ts'
import { KazooError } from '../lib/errors.ts'
import type { Logger } from '../lib/logger.ts'
import { type AudioBackend, detectBackend } from './backend.ts'
import { BYTES_PER_SAMPLE, SAMPLE_RATE_HZ } from './format.ts'

export type MicConfig = {
  sampleRate?: number // default 24000
  channels?: number // default 1
  /** Capture chunk size in samples. Smaller = lower latency, more overhead.
   *  20 ms @ 24 kHz = 480 samples is a reasonable starting point. */
  frameSamples?: number
  /** Backend to use. Defaults to `detectBackend()`. Mostly for tests. */
  backend?: AudioBackend
  logger: Logger
}

export type MicStream = {
  frames: AsyncIterable<Int16Array>
  close: () => Promise<void>
}

/** Open the system mic and stream PCM16 LE frames. */
export function createMic(cfg: MicConfig): MicStream {
  if (cfg.sampleRate !== undefined && cfg.sampleRate !== SAMPLE_RATE_HZ) {
    throw new KazooError(
      'audio/format',
      `mic: sampleRate must be ${SAMPLE_RATE_HZ}; got ${cfg.sampleRate}`,
    )
  }
  if (cfg.channels !== undefined && cfg.channels !== 1) {
    throw new KazooError('audio/format', `mic: channels must be 1; got ${cfg.channels}`)
  }

  const backend = cfg.backend ?? detectBackend()
  const frameSamples = cfg.frameSamples ?? 480 // 20 ms @ 24 kHz
  const frameBytes = frameSamples * BYTES_PER_SAMPLE
  const logger = cfg.logger.child({ mod: 'audio.mic', backend: backend.kind })

  const queue = new AsyncQueue<Int16Array>()
  // Typed as the broad Buffer (ArrayBufferLike-backed) because Node's
  // `data` event hands us that variant and Buffer.concat preserves it.
  let leftover: Buffer = Buffer.alloc(0)
  let closed = false

  logger.debug(
    { command: backend.mic.command, args: backend.mic.args, frameSamples },
    'mic: spawning recorder',
  )
  let child: ChildProcessWithoutNullStreams
  try {
    // All three piped so we get the strongly-typed `WithoutNullStreams`
    // variant. We don't write to stdin; it stays open and idle.
    child = spawn(backend.mic.command, [...backend.mic.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    throw new KazooError('audio/device', `mic: failed to spawn ${backend.mic.command}`, err)
  }

  child.stdout.on('data', (chunk: Buffer) => {
    if (closed) return
    // Concat once; slice into Int16-aligned frames. Each frame is copied
    // into a fresh ArrayBuffer (Buffer.subarray shares memory with the
    // pool, and an unaligned byteOffset breaks Int16Array views).
    leftover = leftover.length === 0 ? chunk : Buffer.concat([leftover, chunk])
    while (leftover.length >= frameBytes) {
      const slice = leftover.subarray(0, frameBytes)
      const ab = new ArrayBuffer(frameBytes)
      new Uint8Array(ab).set(slice)
      queue.push(new Int16Array(ab))
      leftover = leftover.subarray(frameBytes)
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    // sox `-q` and arecord `-q` suppress the chatty progress lines, but real
    // device errors still come through here. Log at warn.
    const text = chunk.toString('utf-8').trim()
    if (text) logger.warn({ stderr: text }, 'mic: recorder stderr')
  })

  child.on('error', (err) => {
    logger.error({ err: err.message }, 'mic: recorder process error')
    queue.close()
  })

  child.on('exit', (code, signal) => {
    if (!closed) {
      logger.warn({ code, signal }, 'mic: recorder exited unexpectedly')
    } else {
      logger.debug({ code, signal }, 'mic: recorder exited')
    }
    queue.close()
  })

  return {
    frames: queue,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      logger.debug('mic: closing')
      // SIGTERM is enough for recorders — they don't have buffered output
      // we'd lose; the kernel pipe flush handles the last few samples.
      // Fall back to SIGKILL if the process ignores SIGTERM.
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      try {
        child.kill('SIGTERM')
      } catch {
        /* already dead */
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* */
        }
      }, 500)
      killTimer.unref?.()
      await exited
      clearTimeout(killTimer)
      queue.close()
    },
  }
}
