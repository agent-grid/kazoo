// Tiny typed event bus. The TUI subscribes to it for display; the orchestrator
// publishes everything that crosses module boundaries.
//
// Deliberately not Node's EventEmitter — that's stringly-typed and we'd lose
// the discriminated-union ergonomics on every listener.

import type { ExecutorEvent } from '../executor/events.ts'
import type { RealtimeEvent } from '../realtime/events.ts'
import type { OrchestratorState } from './state.ts'

export type BusEvent =
  | { type: 'realtime'; event: RealtimeEvent }
  | { type: 'executor'; event: ExecutorEvent }
  | { type: 'state'; state: OrchestratorState }
  | { type: 'narration-spoken'; text: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type BusListener = (ev: BusEvent) => void

export type Bus = {
  emit: (ev: BusEvent) => void
  subscribe: (fn: BusListener) => () => void
}

export function createBus(): Bus {
  const listeners = new Set<BusListener>()
  return {
    emit(ev) {
      for (const fn of listeners) {
        try {
          fn(ev)
        } catch {
          // listeners must not crash the bus
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
