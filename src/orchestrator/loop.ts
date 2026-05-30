// The orchestration loop — the single seam where Realtime, the executor,
// narration, audio, and memory meet.
//
// Wiring (plan §03):
//   mic.frames                          → realtime.sendAudio(base64)
//   realtime.on('audio-chunk')          → speaker.write(decoded)
//   realtime.on('speech-started')       → speaker.flush + injector.flush  (barge-in)
//   realtime.on('caption' user final)   → executor.submit(text)
//   executor.on(event)                  → translator.ingest → injector.speak
//   realtime.on('response-done')        → injector.onResponseDone()
//   stop()                              → realtime.requestWrapUp + distiller.appendFromWrapUp + close
//
// Concurrency contract: narration MUST flow while the executor is working.
// Every event in this file is non-blocking — we never `await` a long-running
// thing inside an event handler. The injector queues; the speaker queues;
// the mic pump runs in its own task.
//
// Wiring API: the orchestrator EXPOSES its two event-receiver methods
// (`onRealtimeEvent`, `onExecutorEvent`) so cli.tsx can pass them as the
// `onEvent` callback when constructing the Realtime session and executor
// runner. (Those objects need their handlers set at construction time and
// the orchestrator depends on them, so we'd have a circular dep otherwise.)

import { base64ToInt16, int16ToBase64, type MicStream, type Speaker } from '../audio/index.ts'
import type { ExecutorEvent, ExecutorRunner } from '../executor/runner.ts'
import type { Logger } from '../lib/logger.ts'
import type { Distiller } from '../memory/distill.ts'
import { createTranslator, type Translator } from '../narration/translator.ts'
import type { RealtimeEvent } from '../realtime/events.ts'
import type { NarrationInjector } from '../realtime/inject.ts'
import type { RealtimeSession } from '../realtime/session.ts'
import type { Bus } from './bus.ts'
import { canTransition, type OrchestratorState } from './state.ts'

export type OrchestratorDeps = {
  realtime: RealtimeSession
  executor: ExecutorRunner
  injector: NarrationInjector
  mic: MicStream
  speaker: Speaker
  distiller: Distiller
  bus: Bus
  logger: Logger
  /** Prompt the Realtime turn uses on hangup to produce the wrap-up text. */
  wrapUpPrompt?: string
}

export type Orchestrator = {
  /** Current high-level state — for the TUI's status bar. */
  readonly state: OrchestratorState
  /** Wire as `onEvent` when constructing the RealtimeSession. */
  onRealtimeEvent: (ev: RealtimeEvent) => void
  /** Wire as `onEvent` when constructing the executor runner. */
  onExecutorEvent: (ev: ExecutorEvent) => void
  /** Begin the call. Connects Realtime, starts the mic pump. Resolves
   *  once Realtime is connected; the loop runs in the background. */
  start: () => Promise<void>
  /** Graceful hangup. Triggers wrap-up + memory append, then closes
   *  Realtime, mic, speaker. */
  stop: () => Promise<void>
}

const DEFAULT_WRAP_UP_PROMPT =
  'The call is ending. Produce a short wrap-up: one or two sentences ' +
  "summarizing what we did, then a 'voice-prefs' line and a 'project-facts' " +
  'line capturing anything worth remembering for next time. Plain text only.'

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { realtime, executor, injector, mic, speaker, distiller, bus, logger } = deps
  const log = logger.child({ mod: 'orchestrator' })
  const translator: Translator = createTranslator()

  let state: OrchestratorState = 'idle'
  let lastWrapUpText: string | null = null
  let wrapUpResolver: (() => void) | null = null
  let micPump: Promise<void> | null = null
  let stopped = false
  // Post-barge-in audio gate (B2). Set true on `speech-started`; cleared
  // on the next `response-created`. While true we discard incoming
  // `audio-chunk` events — they're tail bytes from the response the
  // server-VAD just cancelled, and writing them respawns the speaker
  // subprocess and plays the leftover audio. The user already barged in;
  // they shouldn't hear what they interrupted.
  let bargedIn = false

  function setState(next: OrchestratorState, reason: string): void {
    if (state === next) return
    if (!canTransition(state, next)) {
      // Don't crash on an out-of-order transition — just log and let the
      // state machine track the latest fact. The formal diagram is a tiny
      // model; real event ordering rarely lines up cleanly.
      log.debug({ from: state, to: next, reason }, 'orch: tolerating invalid transition')
    }
    state = next
    bus.emit({ type: 'state', state: next })
    log.debug({ state: next, reason }, 'orch: state')
    // Heartbeat gate: only fire "still working" lines while we're actually
    // mid-task. Anything else (listening / barge-in / ended) silences it.
    injector.setWorking(next === 'working')
  }

  function onRealtimeEvent(ev: RealtimeEvent): void {
    bus.emit({ type: 'realtime', event: ev })

    switch (ev.type) {
      case 'audio-chunk':
        // Drop stale tail bytes that arrive between barge-in and the
        // server starting our next response.
        if (bargedIn) return
        speaker.write(base64ToInt16(ev.audio))
        return
      case 'audio-done':
        return
      case 'speech-started':
        // Barge-in. Drop everything we were about to say.
        bargedIn = true
        void speaker.flush().catch((err: unknown) => {
          log.warn({ err: String(err) }, 'orch: speaker.flush threw')
        })
        injector.flush()
        setState('user-speaking', 'realtime speech-started')
        return
      case 'response-created':
        // A fresh response started; the audio bytes that follow belong to
        // it, not to the cancelled one. Lift the post-barge-in gate.
        bargedIn = false
        // Narrating: visual hint that the speaker is about to be busy with
        // a fresh narration response. (B3 — `narrating` was previously
        // declared but never reached.)
        if (state === 'working' || state === 'listening') {
          setState('narrating', 'realtime response-created')
        }
        return
      case 'speech-stopped':
        // Server-VAD says the user is done. Realtime is configured with
        // `create_response: false` in narrator-only mode, so it will NOT
        // auto-generate a response — we wait for the final caption and
        // forward to the executor. The only voice output is whatever we
        // explicitly inject via `injector.speak(...)`.
        return
      case 'caption':
        if (ev.role === 'user' && ev.final) {
          const text = ev.text.trim()
          if (text) {
            executor.submit(text)
            // Instant ack — without this the user hears total silence
            // between speaking and the first executor narration phrase,
            // which can be many seconds for any real task. The ack is the
            // ONLY non-executor speech in the loop (besides the opening
            // greeting); everything else originates from the executor.
            //
            // High salience so the scheduler delivers it promptly and
            // doesn't coalesce it with anything.
            injector.speak({
              text: 'On it — taking a look.',
              source: 'progress',
              salience: 1.0,
            })
            setState('working', 'user turn submitted to executor')
          }
        }
        return
      case 'response-done':
        injector.onResponseDone()
        // We finished voicing a narration phrase; if we're not actively
        // being interrupted and the executor is still chewing, fall back
        // to 'working' until the next phrase or turn-done.
        if (state === 'narrating') {
          setState('working', 'realtime response-done')
        }
        return
      case 'state':
        if (ev.state === 'active') {
          setState('listening', 'realtime active')
        } else if (ev.state === 'ended') {
          setState('ended', `realtime ended (${ev.reason})`)
        }
        return
      case 'wrap-up-text':
        lastWrapUpText = ev.text
        wrapUpResolver?.()
        wrapUpResolver = null
        return
      case 'error':
        log.error({ err: ev.message, code: ev.code }, 'orch: realtime error')
        return
    }
  }

  function onExecutorEvent(ev: ExecutorEvent): void {
    bus.emit({ type: 'executor', event: ev })

    // Pass the FULL phrase (with source + salience) to the injector — its
    // scheduler uses both for coalescing and pacing. Raw .text would
    // discard the signal it needs.
    //
    // The `narration-spoken` bus event is emitted by the injector's
    // `onSpoken` callback (cli.tsx) AFTER a phrase actually speaks —
    // emitting here would lie about coalesced/dropped phrases.
    const phrases = translator.ingest(ev)
    for (const phrase of phrases) {
      injector.speak(phrase)
    }

    if (ev.type === 'turn-done' && ev.finalForTask) {
      // Don't downgrade an in-flight 'user-speaking' (barge-in) to listening.
      if (state === 'working' || state === 'narrating') {
        setState('listening', 'executor turn done')
      }
    }
  }

  async function start(): Promise<void> {
    log.info('orch: starting')

    // Connect Realtime. Events start flowing the moment the WS handshake
    // completes — `realtime` was constructed with `onRealtimeEvent` as
    // its onEvent, so the call wiring is already live.
    await realtime.connect()

    // Pump mic frames into Realtime. Runs in background; ends when
    // `mic.close()` is called by stop().
    micPump = (async () => {
      try {
        for await (const frame of mic.frames) {
          realtime.sendAudio(int16ToBase64(frame))
        }
      } catch (err) {
        log.error({ err: String(err) }, 'orch: mic pump errored')
      } finally {
        log.debug('orch: mic pump ended')
      }
    })()

    setState('listening', 'orch start complete')
  }

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    setState('wrapping-up', 'orch stop called')
    log.info('orch: stopping')

    // Wrap-up turn — event-driven, time-boxed. Resolves the instant the
    // `wrap-up-text` event lands (via wrapUpResolver wired in the realtime
    // handler), or after an 8-second timeout if the server never replies.
    // Skip cleanly if Realtime is already dead.
    if (realtime.state === 'active') {
      const wrapUpPrompt = deps.wrapUpPrompt ?? DEFAULT_WRAP_UP_PROMPT
      const waitForWrapUp = new Promise<void>((resolve) => {
        wrapUpResolver = resolve
      })
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, 8000)
        timeoutHandle.unref?.()
      })
      realtime.requestWrapUp(wrapUpPrompt)
      await Promise.race([waitForWrapUp, timeout])
      wrapUpResolver = null
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }

    // Append to memory (best-effort — distiller is a stub today; it throws,
    // we swallow. The seam is in place for when distill lands real bodies.)
    if (lastWrapUpText) {
      try {
        await distiller.appendFromWrapUp({ wrapUpText: lastWrapUpText })
      } catch (err) {
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'orch: distiller append failed (likely stub)',
        )
      }
    }

    // Tear-down order matches scripts/audio-loopback.ts: realtime first
    // (stop receiving audio-chunk), then mic (ends the pump), then speaker.
    realtime.close()
    await mic.close()
    await speaker.close()
    if (micPump) await micPump

    // Stop the heartbeat timer + clear any unspoken phrases.
    injector.close()

    setState('ended', 'orch stopped')
  }

  return {
    get state(): OrchestratorState {
      return state
    },
    onRealtimeEvent,
    onExecutorEvent,
    start,
    stop,
  }
}
