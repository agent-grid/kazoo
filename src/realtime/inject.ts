// Higher-level narration injection — wraps `RealtimeSession.injectNarration`
// with a FIFO queue so phrases that arrive while Realtime is already speaking
// aren't dropped on the floor.
//
// Why a queue:
//   `RealtimeSession.injectNarration()` no-ops when `responseActive` is true
//   (we can't have two responses in flight at once). The executor emits
//   events in bursts; without a queue we'd lose every phrase that arrived
//   mid-narration. So we hold phrases here and feed them one at a time,
//   advancing on each `response-done` event the orchestrator hands us.
//
// Barge-in:
//   `flush()` drops the entire queue. The orchestrator calls it on
//   `speech-started`; the realtime server-VAD has already cancelled the
//   in-flight response.

import type { Logger } from '../lib/logger.ts'
import type { RealtimeSession } from './session.ts'

export type NarrationInjector = {
  /** Speak a phrase in the agent's voice. May queue if Realtime is busy. */
  speak: (phrase: string) => void
  /** Drop any queued/pending phrases — e.g. on barge-in or task cancel. */
  flush: () => void
  /** Called by the orchestrator on each realtime `response-done` event.
   *  Advances the queue. */
  onResponseDone: () => void
}

export function createQueuedInjector(session: RealtimeSession, logger: Logger): NarrationInjector {
  const queue: string[] = []
  // True between the moment we call session.injectNarration() and the
  // matching `response-done` event. We can't start a new injection while
  // it's true — the server rejects overlapping responses.
  let injecting = false

  function tryNext(): void {
    if (injecting) return
    if (queue.length === 0) return
    if (session.state !== 'active') return
    const phrase = queue.shift()
    if (phrase === undefined) return
    injecting = true
    logger.debug({ phrase: phrase.slice(0, 120), queued: queue.length }, 'injector: speak')
    session.injectNarration(phrase)
  }

  return {
    speak(phrase: string): void {
      const text = phrase.trim()
      if (!text) return
      queue.push(text)
      tryNext()
    },
    flush(): void {
      if (queue.length > 0) {
        logger.debug({ dropped: queue.length }, 'injector: flushed queue')
        queue.length = 0
      }
      // Realtime auto-cancelled the in-flight response on speech_started,
      // so the response-done won't necessarily fire for it. Reset our flag
      // optimistically; if a late done event lands, tryNext() is a no-op
      // for an empty queue.
      injecting = false
    },
    onResponseDone(): void {
      injecting = false
      tryNext()
    },
  }
}

/** Naive passthrough injector — kept for tests / non-queueing callers. */
export function createPassthroughInjector(session: RealtimeSession): NarrationInjector {
  return {
    speak(phrase: string) {
      if (!phrase) return
      session.injectNarration(phrase)
    },
    flush() {
      /* no queue */
    },
    onResponseDone() {
      /* no queue */
    },
  }
}
