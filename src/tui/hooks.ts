// React hooks that subscribe Ink components to the orchestrator's bus.
// Kept tiny — components stay declarative; all state mutation happens here.

import { useEffect, useState } from 'react'
import type { Bus, BusEvent } from '../orchestrator/bus.ts'
import type { OrchestratorState } from '../orchestrator/state.ts'

export type Turn = {
  role: 'user' | 'assistant'
  text: string
  /** Wall-clock ms — used for transcript ordering. */
  at: number
}

/** Latest transcript turns (user + spoken assistant), append-only. */
export function useTranscript(bus: Bus): Turn[] {
  const [turns, setTurns] = useState<Turn[]>([])
  useEffect(() => {
    return bus.subscribe((ev: BusEvent) => {
      if (ev.type !== 'realtime') return
      const re = ev.event
      if (re.type !== 'caption' || !re.final) return
      setTurns((prev) => [...prev, { role: re.role, text: re.text, at: Date.now() }])
    })
  }, [bus])
  return turns
}

/** Tail of recent bus events for the live event log pane. Capped. */
export function useEventLog(bus: Bus, capacity = 200): BusEvent[] {
  const [events, setEvents] = useState<BusEvent[]>([])
  useEffect(() => {
    return bus.subscribe((ev) => {
      setEvents((prev) => {
        const next = prev.length >= capacity ? prev.slice(prev.length - capacity + 1) : prev.slice()
        next.push(ev)
        return next
      })
    })
  }, [bus, capacity])
  return events
}

/** Current orchestrator state (drives the status bar). */
export function useOrchestratorState(
  bus: Bus,
  initial: OrchestratorState = 'idle',
): OrchestratorState {
  const [state, setState] = useState<OrchestratorState>(initial)
  useEffect(() => {
    return bus.subscribe((ev) => {
      if (ev.type === 'state') setState(ev.state)
    })
  }, [bus])
  return state
}
