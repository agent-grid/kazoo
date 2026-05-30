// Wrap-up → memory append. On hangup the orchestrator asks the Realtime
// session for a text-only summary via `requestWrapUp` (already implemented
// in src/realtime/session.ts), then this module distills it into two
// shards and appends them to the right markdown files.
//
// STATUS: stub. The distillation prompt + append logic land alongside the
// orchestrator integration.

import type { Logger } from '../lib/logger.ts'
import type { MemoryPaths } from './store.ts'

export type WrapUpInput = {
  /** Text returned by `realtime.requestWrapUp(...)`. */
  wrapUpText: string
  /** Optional: the full user-turn transcript for context. */
  transcript?: string
}

export type Distiller = {
  /** Parse `wrapUpText` into voice-pref deltas + project-fact deltas, and
   *  append each to the correct file. No-op on empty input.
   *
   *  TODO: implement. Sketch:
   *    - ask the Realtime turn to format wrap-up as two sections:
   *        ## voice-prefs
   *        - ...
   *        ## project-facts
   *        - ...
   *    - parse those sections, append-with-timestamp to the right file.
   *    - dedupe against existing content (cheap substring check).
   */
  appendFromWrapUp: (input: WrapUpInput) => Promise<void>
}

export function createDistiller(_paths: MemoryPaths, _logger: Logger): Distiller {
  return {
    async appendFromWrapUp(_input) {
      throw new Error('memory/distill: not implemented')
    },
  }
}
