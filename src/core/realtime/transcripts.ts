// Transcript-stream helpers. Folds the streaming `caption` event flow into
// turn-level final transcripts that the orchestrator can route to the executor.
//
// TODO: real implementation. For Phase 0 (audio loopback) this isn't needed —
// the lifted client already emits `caption` events with `final: true` for
// completed user turns. This module exists so the orchestrator has a clear
// import target once we start aggregating partials into turn objects.

import type { CaptionEvent } from './events.ts'

export type UserTurn = {
  text: string
  /** Wall-clock ms at the moment the final caption arrived. */
  at: number
}

export type TranscriptListener = (turn: UserTurn) => void

/** Emits one `UserTurn` per final user caption. Drops partials. */
export function onFinalUserTurn(listener: TranscriptListener) {
  return (ev: CaptionEvent): void => {
    if (ev.role !== 'user' || !ev.final) return
    const text = ev.text.trim()
    if (!text) return
    listener({ text, at: Date.now() })
  }
}
