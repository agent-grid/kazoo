// The orchestration loop — the single seam where Realtime, the executor,
// narration, audio, and memory meet.
//
// Wiring (plan §03 + Electron SURFACE_PLAN §5):
//   mic frames (renderer → IPC)         → realtime.sendAudio(base64)   [wired in main, outside the loop]
//   realtime.on('audio-chunk')          → audioSink.play(base64)
//   realtime.on('speech-started')       → audioSink.flush + injector.flush  (barge-in)
//   realtime.on('response-created')     → audioSink.responseStarted()  (lift renderer tail-gate)
//   realtime.on('audio-done')           → audioSink.done()
//   realtime.on('caption' user final)   → reflexive stop-keyword backstop only
//                                          (the model decides delegate/answer/stop)
//   realtime.on('tool-call' delegate)   → executor.submit (read-only wrapped on
//                                          'unknown_fact') + sendToolResult
//   realtime.on('tool-call' stop)       → executor.cancelTurn({dropQueue}) + sendToolResult
//   executor.on(event)                  → translator.ingest → injector.speak   (mouth)
//                                       → awareness.ingest → injectAwareness    (memory)
//   realtime.on('response-done')        → injector.onResponseDone()
//   stop()                              → realtime.requestWrapUp + distiller.appendFromWrapUp + close
//
// Concurrency contract: narration MUST flow while the executor is working.
// Every event in this file is non-blocking — we never `await` a long-running
// thing inside an event handler. The injector queues; the AudioSink queues.
//
// Audio seam: the orchestrator is surface-agnostic — it never imports Electron
// or any subprocess. Outbound audio goes through the injected `AudioSink`
// (implemented in main via `webContents.send`); inbound mic frames arrive
// over IPC in main and are pushed to `realtime.sendAudio` there, so the loop
// has no mic dependency at all.
//
// Wiring API: the orchestrator EXPOSES its two event-receiver methods
// (`onRealtimeEvent`, `onExecutorEvent`) so the composition root (main) can
// pass them as the `onEvent` callback when constructing the Realtime session
// and executor runner. (Those objects need their handlers set at construction
// time and the orchestrator depends on them, so we'd have a circular dep
// otherwise.)

import type { ExecutorEvent, ExecutorRunner } from '../executor/runner.ts'
import type { Logger } from '../lib/logger.ts'
import type { Distiller } from '../memory/distill.ts'
import { createTranslator, type Translator } from '../narration/translator.ts'
import type { RealtimeEvent } from '../realtime/events.ts'
import type { NarrationInjector } from '../realtime/inject.ts'
import type { RealtimeSession } from '../realtime/session.ts'
import { type AwarenessLog, createAwarenessLog } from './awareness.ts'
import type { Bus } from './bus.ts'
import { canTransition, type OrchestratorState } from './state.ts'

// Reflexive stop backstop (SUPERVISOR_SPEC §3a). A small allowlist that, on a
// FINAL user caption, calls `executor.cancelTurn()` directly — bypassing the
// model. This is a RELIABILITY backstop, not a latency win: both this and the
// `stop_executor` tool fire off the same final caption, so neither is faster.
// It fires even if the model fails to pick the tool. A needless halt is cheap
// and recoverable; a missed stop is expensive — so the one place a keyword
// classifier earns its keep.
const STOP_KEYWORDS = /\b(stop|cancel|halt|abort)\b/i

/** Wrap an `unknown_fact` delegation so the worker answers READ-ONLY and
 *  mutates nothing (SUPERVISOR_SPEC §3b). `EXECUTOR_SAFETY_RULES` tells the
 *  executor to "do work / continue working" and has no answer-only mode, so a
 *  delegated *question* could otherwise provoke an edit. This wrapper rides on
 *  top of those rules and adds the missing "don't mutate while answering"
 *  constraint without any runner change. `new_task` delegations submit
 *  UNWRAPPED (edits allowed). */
function wrapReadOnly(task: string): string {
  return (
    'READ-ONLY QUESTION. Do not edit, create, or delete any file, and do not ' +
    'run commands that change state. Investigate using read-only inspection ' +
    `only, then answer in one or two sentences: ${task}`
  )
}

/** The one audio abstraction the orchestrator depends on. Keeps the loop
 *  surface-free: the Electron impl (`src/main/audio-sink.ts`) decodes the
 *  base64 to bytes and ships an ArrayBuffer to the renderer over IPC; a test
 *  impl can be a plain spy. All payloads are base64 PCM16 LE 24 kHz mono —
 *  forwarded verbatim from the Realtime `audio-chunk` event. */
export type AudioSink = {
  /** Queue a base64 PCM16 chunk for playback. */
  play: (b64Pcm16: string) => void
  /** Barge-in: stop + clear all queued/playing audio immediately. */
  flush: () => void
  /** A fresh narration response began — lift the renderer's post-flush gate. */
  responseStarted: () => void
  /** End of the current audio turn — stop the speaking indicator. */
  done: () => void
}

export type OrchestratorDeps = {
  realtime: RealtimeSession
  executor: ExecutorRunner
  injector: NarrationInjector
  audioSink: AudioSink
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
  /** Begin the call. Connects Realtime. Resolves once Realtime is
   *  connected; the loop runs in the background. Mic capture is driven by
   *  the renderer and bridged in main, so there is no mic pump here. */
  start: () => Promise<void>
  /** Graceful hangup. Triggers wrap-up + memory append, then closes
   *  Realtime. The renderer tears down its own AudioContext/MediaStream. */
  stop: () => Promise<void>
}

const DEFAULT_WRAP_UP_PROMPT =
  'The call is ending. Produce a short wrap-up: one or two sentences ' +
  "summarizing what we did, then a 'voice-prefs' line and a 'project-facts' " +
  'line capturing anything worth remembering for next time. Plain text only.'

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { realtime, executor, injector, audioSink, distiller, bus, logger } = deps
  const log = logger.child({ mod: 'orchestrator' })
  const translator: Translator = createTranslator()
  // Second consumer off the executor stream (SUPERVISOR_SPEC §4): a structured,
  // timestamped, bounded `[WORK-LOG]` injected SILENTLY so the voice can answer
  // "what did I change / what am I doing / is it done" from context instead of
  // fabricating or needlessly delegating.
  const awareness: AwarenessLog = createAwarenessLog()

  let state: OrchestratorState = 'idle'
  let lastWrapUpText: string | null = null
  let wrapUpResolver: (() => void) | null = null
  let stopped = false
  // Post-barge-in audio gate (B2). Set true on `speech-started`; cleared
  // on the next `response-created`. While true we discard incoming
  // `audio-chunk` events — they're tail bytes from the response the
  // server-VAD just cancelled, and forwarding them to the sink would play
  // the leftover audio. The user already barged in; they shouldn't hear
  // what they interrupted. (The renderer keeps a second mini-gate against
  // the IPC tail — see SURFACE_PLAN §5.)
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

  // Re-inject the current `[WORK-LOG]` SILENTLY so the voice can answer from it
  // (SUPERVISOR_SPEC §4b). One living item updated as milestones happen; never
  // voiced (injectAwareness sends no response.create).
  function injectWorkLog(): void {
    const text = awareness.render()
    if (!text) return
    realtime.injectAwareness(text)
  }

  // Route a supervisor tool call (SUPERVISOR_SPEC §3). The model has already
  // decided; the orchestrator just forwards mechanically and lets the model
  // voice its own ack via `sendToolResult`.
  function handleToolCall(ev: Extract<RealtimeEvent, { type: 'tool-call' }>): void {
    if (ev.name === 'delegate_to_executor') {
      const args = ev.args as { task?: string; reason?: 'new_task' | 'unknown_fact' }
      const task = (args.task ?? '').trim()
      if (!task) {
        log.warn({ callId: ev.callId }, 'orch: delegate_to_executor with empty task — ignoring')
        realtime.sendToolResult(ev.callId, { status: 'error', message: 'empty task' })
        return
      }
      // §3b: `unknown_fact` is a READ-ONLY fact-find (never edits on a
      // question); `new_task` submits unwrapped (edits allowed). This is the
      // hinge that makes "understand the project" a read-only delegate-then-
      // narrate flow, not a fabrication.
      const readOnly = args.reason === 'unknown_fact'
      const submitted = readOnly ? wrapReadOnly(task) : task
      log.info(
        { reason: args.reason, readOnly, task: task.slice(0, 160) },
        'orch: delegating to executor',
      )
      // submit() QUEUES behind any in-flight turn (never preempts) — a mid-work
      // delegation is additive work, not a correction (§3). The voice covers
      // the latency by narrating "right after this".
      executor.submit(submitted)
      setState('working', 'delegate_to_executor')
      // Fire-and-forget: return the function output now and let the model voice
      // its own brief ack. Never wait on the executor.
      realtime.sendToolResult(ev.callId, { status: 'accepted', read_only: readOnly })
      return
    }

    // stop_executor (§3a). The sole tool path to cancelTurn. Idempotent with
    // the reflexive keyword backstop — whichever lands first wins.
    const args = ev.args as { drop_queue?: boolean }
    const dropQueue = args.drop_queue === true
    log.info({ dropQueue }, 'orch: stop_executor — cancelling executor turn')
    executor.cancelTurn({ dropQueue })
    realtime.sendToolResult(ev.callId, { status: 'stopped', dropped_queue: dropQueue })
  }

  function onRealtimeEvent(ev: RealtimeEvent): void {
    bus.emit({ type: 'realtime', event: ev })

    switch (ev.type) {
      case 'audio-chunk':
        // Drop stale tail bytes that arrive between barge-in and the
        // server starting our next response.
        if (bargedIn) return
        audioSink.play(ev.audio)
        return
      case 'audio-done':
        audioSink.done()
        return
      case 'speech-started':
        // Barge-in. Drop everything we were about to say.
        bargedIn = true
        audioSink.flush()
        injector.flush()
        setState('user-speaking', 'realtime speech-started')
        return
      case 'response-created':
        // A fresh response started; the audio bytes that follow belong to
        // it, not to the cancelled one. Lift the post-barge-in gate (and
        // the renderer's mirror gate).
        bargedIn = false
        audioSink.responseStarted()
        // Narrating: visual hint that the speaker is about to be busy with
        // a fresh narration response. (B3 — `narrating` was previously
        // declared but never reached.)
        if (state === 'working' || state === 'listening') {
          setState('narrating', 'realtime response-created')
        }
        return
      case 'speech-stopped':
        // Server-VAD says the user is done. Realtime is now configured with
        // `create_response: true` (supervisor mode), so it generates exactly
        // one response per user turn — an answer from context, or a tool call
        // (delegate/stop) which we route in `handleToolCall`. No
        // orchestrator-side submit happens here.
        return
      case 'caption':
        // SUPERVISOR_SPEC §1/§3: a user turn no longer unconditionally submits
        // to the executor. The model decides answer-vs-delegate-vs-stop and
        // emits a `tool-call` when it wants the hands to act; routing happens
        // there, not here. The old blanket `executor.submit(text)` + hardcoded
        // "On it — taking a look." ack are gone — the model now voices its own
        // ack via `sendToolResult`.
        if (ev.role === 'user' && ev.final) {
          const text = ev.text.trim()
          // Reflexive stop backstop (§3a). Fires `cancelTurn` directly on a
          // stop keyword even if the model never picks `stop_executor`. The
          // tool path is idempotent with this — whichever lands first wins,
          // the second is a safe no-op.
          if (text && STOP_KEYWORDS.test(text)) {
            log.info({ text }, 'orch: reflexive stop keyword — cancelling executor turn')
            executor.cancelTurn()
          }
        }
        return
      case 'tool-call':
        handleToolCall(ev)
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

    // TWO independent consumers off this one raw stream (SUPERVISOR_SPEC §4a):
    //
    // (1) NARRATION — semantic, lossy, for the mouth. Pass the FULL phrase
    //     (with source + salience) to the injector; its scheduler uses both
    //     for coalescing and pacing. Raw .text would discard the signal it
    //     needs. The `narration-spoken` bus event is emitted by the injector's
    //     `onSpoken` callback AFTER a phrase actually speaks — emitting here
    //     would lie about coalesced/dropped phrases.
    const phrases = translator.ingest(ev)
    for (const phrase of phrases) {
      injector.speak(phrase)
    }

    // (2) AWARENESS — structured, for the model's memory. Reads the raw tool
    //     inputs directly (NOT the lossy translator), records file-level facts
    //     + completion + errors, and silently re-injects the bounded,
    //     timestamped `[WORK-LOG]` so the voice answers from context (§4b).
    if (awareness.ingest(ev)) {
      injectWorkLog()
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

    // Mic capture is owned by the renderer (getUserMedia → AudioWorklet);
    // frames arrive over IPC in main and are pushed to `realtime.sendAudio`
    // there. There is no mic pump in the loop.

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

    // Stop receiving audio-chunk. The renderer tears down its own
    // AudioContext/MediaStream on a stop/window-close IPC, so there is no
    // mic/speaker to close here.
    realtime.close()

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
