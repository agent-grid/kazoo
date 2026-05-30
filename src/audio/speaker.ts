// Speaker playback — terminal-native, PCM16 @ 24 kHz mono.
//
// CRITICAL CONSTRAINT: `flush()` MUST drop any queued audio synchronously.
// Barge-in is "user starts talking → speaker shuts up immediately". The
// orchestrator depends on it.
//
// Implementation strategy:
//   - One long-lived child process for normal playback. Bytes piped to
//     stdin go straight to the audio device with minimal OS buffering.
//   - On `flush()` we SIGKILL the child. That instantly drops everything —
//     in-flight stdin bytes, OS pipe buffer, and the device's small
//     hardware buffer all die with the process. We then spawn a fresh
//     child lazily on the next `write()`. The ~10-30 ms restart cost is
//     only paid on interrupts, where it doesn't matter.
//   - `drain()` is the polite cousin: end stdin, wait for the child to
//     finish playing buffered audio, then exit naturally.
//
// Stdin errors (EPIPE on a freshly-killed child) are expected during the
// flush race window and swallowed.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { KazooError } from '../lib/errors.ts'
import type { Logger } from '../lib/logger.ts'
import { type AudioBackend, detectBackend } from './backend.ts'
import { SAMPLE_RATE_HZ } from './format.ts'

export type SpeakerConfig = {
  sampleRate?: number // default 24000
  channels?: number // default 1
  /** Backend to use. Defaults to `detectBackend()`. Mostly for tests. */
  backend?: AudioBackend
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

export function createSpeaker(cfg: SpeakerConfig): Speaker {
  if (cfg.sampleRate !== undefined && cfg.sampleRate !== SAMPLE_RATE_HZ) {
    throw new KazooError(
      'audio/format',
      `speaker: sampleRate must be ${SAMPLE_RATE_HZ}; got ${cfg.sampleRate}`,
    )
  }
  if (cfg.channels !== undefined && cfg.channels !== 1) {
    throw new KazooError('audio/format', `speaker: channels must be 1; got ${cfg.channels}`)
  }

  const backend = cfg.backend ?? detectBackend()
  const logger = cfg.logger.child({ mod: 'audio.speaker', backend: backend.kind })

  let child: ChildProcessWithoutNullStreams | null = null
  let closed = false

  function spawnChild(): ChildProcessWithoutNullStreams {
    logger.debug(
      { command: backend.speaker.command, args: backend.speaker.args },
      'speaker: spawning player',
    )
    let proc: ChildProcessWithoutNullStreams
    try {
      // All three piped for the strongly-typed `WithoutNullStreams` variant.
      // We don't read stdout — the player writes audio bytes to the device
      // directly — so we drain it to avoid back-pressure on the pipe.
      proc = spawn(backend.speaker.command, [...backend.speaker.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      proc.stdout.resume() // drain unused stdout
    } catch (err) {
      throw new KazooError(
        'audio/device',
        `speaker: failed to spawn ${backend.speaker.command}`,
        err,
      )
    }

    // EPIPE on a killed child is expected during the flush race window.
    // Anything else is worth logging.
    proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return
      logger.warn({ err: err.message, code: err.code }, 'speaker: stdin error')
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim()
      if (text) logger.warn({ stderr: text }, 'speaker: player stderr')
    })

    proc.on('error', (err) => {
      logger.error({ err: err.message }, 'speaker: player process error')
    })

    proc.on('exit', (code, signal) => {
      logger.debug({ code, signal }, 'speaker: player exited')
      if (child === proc) child = null
    })

    return proc
  }

  function ensureChild(): ChildProcessWithoutNullStreams | null {
    if (closed) return null
    if (child && !child.killed && child.exitCode === null) return child
    child = spawnChild()
    return child
  }

  function killChild(): Promise<void> {
    const proc = child
    if (!proc) return Promise.resolve()
    // Detach it BEFORE killing so a racing `write` immediately respawns
    // instead of writing to the doomed process.
    child = null
    if (proc.exitCode !== null) return Promise.resolve()
    return new Promise<void>((resolve) => {
      proc.once('exit', () => resolve())
      try {
        proc.kill('SIGKILL')
      } catch {
        resolve()
      }
    })
  }

  return {
    write(samples: Int16Array): void {
      if (closed) return
      const proc = ensureChild()
      if (!proc) return
      const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
      // Best-effort: if the pipe is already broken (mid-flush race) the
      // stdin 'error' listener swallows EPIPE. We don't want to throw here.
      try {
        proc.stdin.write(bytes)
      } catch (err) {
        logger.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'speaker: write threw (likely race with flush)',
        )
      }
    },

    async flush(): Promise<void> {
      if (closed) return
      logger.debug('speaker: flush — killing player')
      await killChild()
    },

    async drain(): Promise<void> {
      const proc = child
      if (!proc) return
      // End stdin so the player drains its buffer, then wait for exit.
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
      try {
        proc.stdin.end()
      } catch {
        /* */
      }
      await exited
      if (child === proc) child = null
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      logger.debug('speaker: closing')
      const proc = child
      if (!proc) return
      // Try to drain politely; fall back to kill after a short grace period.
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
      try {
        proc.stdin.end()
      } catch {
        /* */
      }
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* */
        }
      }, 500)
      killTimer.unref?.()
      await exited
      clearTimeout(killTimer)
      if (child === proc) child = null
    },
  }
}
