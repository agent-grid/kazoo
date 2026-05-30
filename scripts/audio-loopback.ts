// Phase 0 derisk — mic → Realtime → speaker.
//
// This script is THE spine. It deliberately depends only on:
//   - src/config.ts          (env loading)
//   - src/lib/logger.ts      (so output goes to a file, not stdout)
//   - src/audio/*            (mic + speaker)
//   - src/realtime/session.ts (the lifted client)
//
// No executor. No narration. No Ink. No memory. If this round-trip is
// green — you talk, you hear yourself replied to, you can interrupt
// mid-sentence and it shuts up — the rest of the system is glue.
//
// STATUS: skeleton. The audio module is interface-only; we fill both in
// during Phase 0 (the first feature PR after this scaffold lands).
//
// Acceptance checklist (taped to the wall for the Phase 0 PR):
//   [ ] Mic frames stream at 24 kHz mono PCM16, no drops, no underruns.
//   [ ] `input_audio_buffer.append` reaches the server (look for
//       `input_audio_buffer.speech_started` from server-VAD).
//   [ ] `response.output_audio.delta` frames decode + play through speaker.
//   [ ] Talking over the assistant triggers `speech-started` → speaker.flush()
//       and audio cuts off within ~100 ms.
//   [ ] Ctrl-C closes cleanly (no orphan sox/aplay processes).

import { base64ToInt16, createMic, createSpeaker, int16ToBase64 } from '../src/audio/index.ts'
import { loadConfig } from '../src/config.ts'
import { createLogger } from '../src/lib/logger.ts'
import { RealtimeSession } from '../src/realtime/session.ts'

async function main(): Promise<void> {
  const cfg = loadConfig()
  const logger = createLogger({ file: cfg.log.file, level: cfg.log.level }).child({
    mod: 'audio-loopback',
  })
  logger.info('audio-loopback: starting Phase-0 spine')

  // TODO(phase-0): construct mic + speaker via createMic / createSpeaker
  // once those throw stubs land real implementations.
  const speaker = createSpeaker({ logger })
  const mic = createMic({ logger })

  const session = new RealtimeSession({
    apiKey: cfg.openaiApiKey,
    model: cfg.realtime.model,
    voice: cfg.realtime.voice,
    ...(cfg.realtime.speed !== undefined ? { speed: cfg.realtime.speed } : {}),
    instructions:
      'You are a loopback test partner. When the user speaks, briefly echo ' +
      'what they said and ask one short follow-up question. Keep it under ' +
      'two short sentences.',
    logger,
    onEvent(ev) {
      switch (ev.type) {
        case 'audio-chunk':
          speaker.write(base64ToInt16(ev.audio))
          return
        case 'speech-started':
          // Barge-in: kill the in-flight playback immediately.
          void speaker.flush()
          return
        case 'audio-done':
          return
        case 'caption':
          logger.info({ role: ev.role, text: ev.text, final: ev.final }, 'caption')
          return
        case 'state':
          logger.info({ state: ev.state }, 'realtime state')
          return
        case 'error':
          logger.error({ err: ev }, 'realtime error')
          return
        default:
          logger.debug({ ev }, 'realtime event')
      }
    },
  })

  await session.connect()
  logger.info('audio-loopback: realtime connected; streaming mic')

  // Pump mic frames into the session. Each frame is Int16Array PCM16 LE.
  const pump = (async () => {
    for await (const frame of mic.frames) {
      session.sendAudio(int16ToBase64(frame))
    }
  })()

  const shutdown = async (): Promise<void> => {
    logger.info('audio-loopback: shutting down')
    await mic.close()
    await speaker.close()
    session.close()
  }
  process.once('SIGINT', () => {
    void shutdown().then(() => process.exit(0))
  })

  await pump
}

main().catch((err) => {
  process.stderr.write(
    `audio-loopback: fatal — ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})
