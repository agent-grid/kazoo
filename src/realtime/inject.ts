// Higher-level narration injection — wraps `RealtimeSession.injectNarration`
// with mode-aware policy (flow vs high-level batching, salience filter, etc.).
//
// TODO(narration): this is a placeholder. The real surface depends on the
// narration module's decisions about batching cadence and back-pressure.
// Keep this file as the single seam so swapping policy later doesn't touch
// the session or orchestrator code.

import type { RealtimeSession } from './session.ts'

export type NarrationInjector = {
  /** Speak a phrase in the agent's voice. May queue, drop, or batch
   *  depending on session/turn state. Idempotent on empty strings. */
  speak: (phrase: string) => void
  /** Drop any queued/pending phrases — e.g. on barge-in or task cancel. */
  flush: () => void
}

/** Naive passthrough injector. The narration module will replace this with a
 *  policy-aware version once flow vs high-level modes are wired up. */
export function createPassthroughInjector(session: RealtimeSession): NarrationInjector {
  return {
    speak(phrase: string) {
      if (!phrase) return
      session.injectNarration(phrase)
    },
    flush() {
      // No queue yet — nothing to drop. Real impl will clear pending phrases.
    },
  }
}
