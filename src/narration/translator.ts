// Executor events → spoken-style phrases.
//
// Design principle (plan §04 — "Harvest preambles"): the executor already
// states intent in plain language before each tool call. That assistant
// text IS the narration. We don't build a command→English translator;
// we harvest preambles and add light glue for tool semantics.
//
// STATUS: scaffold only — the real translator + salience filter come with
// the Phase-2 integration.

import type { ExecutorEvent } from '../executor/events.ts'

export type NarrationPhrase = {
  text: string
  /** Source so the salience filter can decide whether to speak this one. */
  source: 'preamble' | 'tool-summary' | 'progress' | 'error'
  /** Estimated importance, 0..1. The injector batches/drops low-salience
   *  phrases in `high-level` mode. */
  salience: number
}

export type Translator = {
  ingest: (ev: ExecutorEvent) => NarrationPhrase[]
}

/** Construct a translator. */
export function createTranslator(): Translator {
  return {
    ingest(_ev: ExecutorEvent): NarrationPhrase[] {
      // TODO(narration): real implementation.
      //
      // Sketch:
      //   - assistant-text → one preamble phrase, salience 0.9 (highest).
      //   - tool-use → "I'm reading auth.ts" style summary. Salience is
      //     tool-dependent: Edit/Write = 0.8, Read/Grep = 0.3.
      //   - tool-result → only narrated if isError or surprising; otherwise
      //     swallowed (the preamble already covered intent).
      //   - turn-done(finalForTask) → "done" milestone, salience 1.0.
      return []
    },
  }
}
