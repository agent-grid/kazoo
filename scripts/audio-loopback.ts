// Phase 0 derisk — mic → Realtime → speaker.
//
// This script is THE spine. It deliberately depends only on:
//   - src/config.ts            (env loading)
//   - src/lib/logger.ts        (so detailed logs go to a file, not stdout)
//   - src/audio/*              (mic + speaker — subprocess via sox or alsa)
//   - src/realtime/session.ts  (the lifted client)
//
// No executor. No narration. No Ink. No memory. If this round-trip is
// green — you talk, you hear yourself replied to, you can interrupt
// mid-sentence and it shuts up — the rest of the system is glue.
//
// Acceptance checklist (taped to the wall for this PR):
//   [x] Mic frames stream at 24 kHz mono PCM16, no drops, no underruns.
//   [x] `input_audio_buffer.append` reaches the server (look for
//       `input_audio_buffer.speech_started` from server-VAD).
//   [x] `response.output_audio.delta` frames decode + play through speaker.
//   [x] Talking over the assistant triggers `speech-started` → speaker.flush()
//       and audio cuts off ~immediately.
//   [x] Ctrl-C closes cleanly (no orphan sox/aplay processes).
//
// Operator script: launch it, hear the agent introduce itself, ask for
// "say hello to me three times slowly", and talk over it while it's
// counting. It should stop instantly. If it doesn't, the speaker flush
// path is broken.

import {
  base64ToInt16,
  createMic,
  createSpeaker,
  detectBackend,
  int16ToBase64,
} from '../src/audio/index.ts'
import { loadConfig } from '../src/config.ts'
import { isKazooError } from '../src/lib/errors.ts'
import { createLogger } from '../src/lib/logger.ts'
import { RealtimeSession } from '../src/realtime/session.ts'

function tty(line: string): void {
  process.stdout.write(`${line}\n`)
}

async function main(): Promise<void> {
  // Fail-fast on config BEFORE we touch audio devices or the network.
  const cfg = loadConfig()

  // Then check audio backend BEFORE we open the WS — no point burning a
  // realtime connection if the speaker won't work.
  const backend = detectBackend()

  const logger = createLogger({ file: cfg.log.file, level: cfg.log.level }).child({
    mod: 'audio-loopback',
  })
  logger.info({ backend: backend.kind }, 'audio-loopback: starting Phase-0 spine')
  tty(`kazoo audio-loopback · backend=${backend.kind} · log=${cfg.log.file}`)
  tty('connecting to OpenAI Realtime…')

  const speaker = createSpeaker({ logger, backend })
  const mic = createMic({ logger, backend })

  const session = new RealtimeSession({
    apiKey: cfg.openaiApiKey,
    model: cfg.realtime.model,
    voice: cfg.realtime.voice,
    ...(cfg.realtime.speed !== undefined ? { speed: cfg.realtime.speed } : {}),
    instructions:
      'You are a loopback test partner. Greet the user briefly when the ' +
      'session opens, then respond to whatever they say with one or two ' +
      'short sentences. If they ask you to count or say something multiple ' +
      'times, do it slowly so they have a chance to interrupt you.',
    logger,
    onEvent(ev) {
      switch (ev.type) {
        case 'audio-chunk':
          speaker.write(base64ToInt16(ev.audio))
          return
        case 'audio-done':
          logger.debug('realtime: audio-done')
          return
        case 'speech-started':
          // Barge-in: drop everything the speaker has queued or is playing.
          // The server is auto-cancelling the in-flight response in parallel.
          logger.info('realtime: speech-started → flushing speaker')
          void speaker.flush()
          return
        case 'speech-stopped':
          logger.debug('realtime: speech-stopped')
          return
        case 'caption':
          if (ev.final) {
            tty(`  ${ev.role === 'user' ? 'you' : 'kazoo'}: ${ev.text}`)
            logger.info({ role: ev.role, text: ev.text }, 'caption (final)')
          }
          return
        case 'state':
          logger.info({ state: ev.state }, 'realtime state')
          if (ev.state === 'active') tty('connected. talk whenever — Ctrl-C to quit.')
          if (ev.state === 'ended') tty(`realtime ended (${ev.reason})`)
          return
        case 'response-done':
          logger.debug({ status: ev.status }, 'realtime: response-done')
          return
        case 'error':
          logger.error({ err: ev }, 'realtime error')
          tty(`realtime error: ${ev.message}`)
          return
        default:
          logger.debug({ ev }, 'realtime event')
      }
    },
  })

  try {
    await session.connect()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    tty(`failed to connect to Realtime: ${msg}`)
    logger.error({ err: msg }, 'audio-loopback: connect failed')
    await mic.close()
    await speaker.close()
    process.exit(1)
  }
  logger.info('audio-loopback: realtime connected; streaming mic')

  // Pump mic frames into the session. Each frame is Int16Array PCM16 LE @
  // 24 kHz. base64 encode and append to the input audio buffer; server-VAD
  // handles turn detection.
  const pump = (async () => {
    for await (const frame of mic.frames) {
      session.sendAudio(int16ToBase64(frame))
    }
  })()

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    tty(`\nshutting down (${signal})…`)
    logger.info({ signal }, 'audio-loopback: shutting down')
    // Order matters: close the session FIRST so we stop receiving
    // `audio-chunk` events. Otherwise an in-flight chunk arrives after the
    // speaker is torn down and writes to a destroyed subprocess.
    session.close()
    // Mic next — stops feeding the (now-closed) session.
    await mic.close()
    // Speaker last — drains anything already in its queue, then tears down.
    await speaker.close()
  }
  process.once('SIGINT', () => {
    void shutdown('SIGINT').then(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => process.exit(0))
  })

  await pump
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  // KazooError messages are already operator-readable; for everything else
  // print the raw and let the file log have the stack.
  if (isKazooError(err)) {
    process.stderr.write(`audio-loopback: ${msg}\n`)
  } else {
    process.stderr.write(`audio-loopback: fatal — ${msg}\n`)
  }
  process.exit(1)
})
