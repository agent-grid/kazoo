// The orchestration loop — the single seam where Realtime, the executor,
// narration, audio, and memory meet.
//
// Wiring (plan §03):
//   realtime.on('caption', final-user)  → executor.submit(text)
//   executor.on(event)                  → narration.ingest → injector.speak
//   realtime.on('speech-started')       → speaker.flush + injector.flush  (barge-in)
//   realtime.on('audio-chunk')          → speaker.write
//   process.on('SIGINT')                → realtime.requestWrapUp + memory.appendFromWrapUp + close
//
// STATUS: skeleton + wiring contract. Real implementation lands once the
// audio + executor modules are alive.

import type { Speaker } from '../audio/index.ts'
import type { ExecutorRunner } from '../executor/runner.ts'
import type { Logger } from '../lib/logger.ts'
import type { Distiller } from '../memory/distill.ts'
import type { NarrationInjector } from '../realtime/inject.ts'
import type { RealtimeSession } from '../realtime/session.ts'
import type { Bus } from './bus.ts'
import type { OrchestratorState } from './state.ts'

export type OrchestratorDeps = {
  realtime: RealtimeSession
  executor: ExecutorRunner
  injector: NarrationInjector
  speaker: Speaker
  distiller: Distiller
  bus: Bus
  logger: Logger
}

export type Orchestrator = {
  state: OrchestratorState
  /** Begin the call. Connects Realtime, opens executor, wires events. */
  start: () => Promise<void>
  /** Graceful hangup. Triggers wrap-up + memory append. */
  stop: () => Promise<void>
}

export function createOrchestrator(_deps: OrchestratorDeps): Orchestrator {
  // TODO(integration): real implementation. The contract above is the
  // checklist; each line is a `realtime.<event>` listener or a downstream
  // `executor.<event>` listener.
  throw new Error('orchestrator/loop: not implemented (next PR)')
}
