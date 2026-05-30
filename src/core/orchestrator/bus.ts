// Tiny typed event bus. The TUI subscribes to it for display; the orchestrator
// publishes everything that crosses module boundaries.
//
// Deliberately not Node's EventEmitter — that's stringly-typed and we'd lose
// the discriminated-union ergonomics on every listener.

import type { ExecutorEvent } from '../executor/events.ts'
import type { NarrationMode } from '../narration/modes.ts'
import type { RealtimeEvent } from '../realtime/events.ts'
import type { OrchestratorState } from './state.ts'

export type BusEvent =
  | { type: 'realtime'; event: RealtimeEvent }
  | { type: 'executor'; event: ExecutorEvent }
  | { type: 'state'; state: OrchestratorState }
  | { type: 'narration-spoken'; text: string }
  | { type: 'narration-mode'; mode: NarrationMode }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type BusListener = (ev: BusEvent) => void

/** Called when a listener throws. Bus emits MUST never crash the publisher,
 *  but errors shouldn't be invisible either — wire this to the logger. */
export type ListenerErrorHandler = (err: unknown, ev: BusEvent) => void

export type Bus = {
  emit: (ev: BusEvent) => void
  subscribe: (fn: BusListener) => () => void
}

export type BusOptions = {
  /** Default: no-op (errors silently swallowed). Production callers should
   *  pass a logger-backed handler so misbehaving listeners surface. */
  onListenerError?: ListenerErrorHandler
}

export function createBus(opts: BusOptions = {}): Bus {
  const listeners = new Set<BusListener>()
  const onListenerError = opts.onListenerError ?? noopErrorHandler
  return {
    emit(ev) {
      for (const fn of listeners) {
        try {
          fn(ev)
        } catch (err) {
          // Listeners must not crash the bus. Surface via the handler so the
          // failure is at least visible in the log.
          try {
            onListenerError(err, ev)
          } catch {
            // The error handler itself failed. Nothing useful left to do —
            // swallow rather than recurse.
          }
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

function noopErrorHandler(): void {
  /* default — opts in to silence */
}
