// Salience filter — batches/drops low-importance phrases so the voice
// doesn't drown the user in Read/Grep narration.
//
// STATUS: stub. The threshold model lands with the narration module's real
// implementation.

import type { NarrationPhrase } from './translator.ts'

export type SalienceMode = 'flow' | 'high-level'

export type SalienceFilter = {
  /** Returns the phrases that should be spoken, given current mode. May
   *  drop, batch, or rewrite. */
  filter: (phrases: NarrationPhrase[]) => NarrationPhrase[]
  setMode: (mode: SalienceMode) => void
}

export function createSalienceFilter(initialMode: SalienceMode = 'flow'): SalienceFilter {
  let mode: SalienceMode = initialMode
  return {
    setMode(next) {
      mode = next
    },
    filter(phrases) {
      // TODO(narration): real policy. Flow speaks ~everything ≥ 0.4;
      // high-level speaks only ≥ 0.7 and batches consecutive low-salience
      // phrases into one summary at end-of-turn.
      const threshold = mode === 'flow' ? 0.4 : 0.7
      return phrases.filter((p) => p.salience >= threshold)
    },
  }
}
