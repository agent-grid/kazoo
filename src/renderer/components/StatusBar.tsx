// StatusBar — bottom chrome. (SURFACE_PLAN §6.)
//
//   <MicMeter>      live input level (renderer WebAudio analyser — NOT a bus
//                   event; dims while narration plays to signal echo-management)
//   <ModeToggle>    flow ⇄ high-level; mirrors the `narration-mode` bus event
//                   and calls window.kazoo.setMode on click
//   session-state   orchestrator FSM word + connection
//   <WorkspaceDir>  the executor cwd from SESSION_INFO
//   <Clock>         call duration

import { useEffect, useRef, useState } from 'react'
import type { NarrationMode } from '../../core/narration/modes.ts'
import type { OrchestratorState } from '../../core/orchestrator/state.ts'
import type { RealtimeSessionState } from '../../core/realtime/events.ts'

export type StatusBarProps = {
  fsm: OrchestratorState
  connection: RealtimeSessionState
  mode: NarrationMode
  micLevel: number
  /** Mic is being echo-managed while narration plays — dim the meter. */
  isSpeaking: boolean
  /** Workspace dir from SESSION_INFO; null until the handshake completes. */
  cwd: string | null
  /** Whether the call is live, to drive the clock. */
  live: boolean
  onSetMode: (mode: NarrationMode) => void
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  return (
    <footer className="status-bar">
      <MicMeter level={props.micLevel} dimmed={props.isSpeaking} />
      <ModeToggle mode={props.mode} onSetMode={props.onSetMode} />
      <span className="status-seg">
        <span className="status-fsm">{fsmWord(props.fsm)}</span>
        <span>·</span>
        <span>{connectionWord(props.connection)}</span>
      </span>
      <span className="status-seg spacer status-dir">{props.cwd ?? '~'}</span>
      <Clock live={props.live} fsm={props.fsm} />
    </footer>
  )
}

/** WebAudio RMS bars. Eight cells; lit count scales with the level. Dims to the
 *  rest color while narration is playing (echo-managed). */
// Fixed-length meter cells. A stable key per cell (no array-index-as-key) —
// the set never reorders, only its `lit` class toggles.
const METER_CELLS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] as const

function MicMeter(props: { level: number; dimmed: boolean }): React.JSX.Element {
  const lit = Math.round(clamp01(props.level) * METER_CELLS.length)
  return (
    <span className={`mic-meter${props.dimmed ? ' muted' : ''}`}>
      <span>mic</span>
      <span className="bars">
        {METER_CELLS.map((cell, i) => (
          <span
            key={cell}
            className={`bar${i < lit ? ' lit' : ''}`}
            style={{ height: `${4 + i}px` }}
          />
        ))}
      </span>
    </span>
  )
}

/** flow ⇄ high-level. Display mirrors the store (which mirrors the
 *  `narration-mode` bus event, so a voice toggle stays truthful); the click
 *  sends the OTHER mode to main. */
function ModeToggle(props: {
  mode: NarrationMode
  onSetMode: (m: NarrationMode) => void
}): React.JSX.Element {
  const other: NarrationMode = props.mode === 'flow' ? 'high-level' : 'flow'
  return (
    <button type="button" className="mode-toggle" onClick={() => props.onSetMode(other)}>
      mode: <span className="on">{props.mode}</span> ⇄
    </button>
  )
}

/** Call duration. Starts ticking when the call goes live; resets to 0 when it
 *  ends/idles. Local timer — no bus event carries duration. */
function Clock(props: { live: boolean; fsm: OrchestratorState }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  const startedRef = useRef<number | null>(null)

  useEffect(() => {
    const running = props.live && props.fsm !== 'idle' && props.fsm !== 'ended'
    if (!running) {
      startedRef.current = null
      setElapsed(0)
      return
    }
    if (startedRef.current === null) startedRef.current = Date.now()
    const id = setInterval(() => {
      if (startedRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startedRef.current) / 1000))
      }
    }, 1000)
    return () => {
      clearInterval(id)
    }
  }, [props.live, props.fsm])

  return <span className="status-clock">⏱ {fmt(elapsed)}</span>
}

function fmt(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fsmWord(fsm: OrchestratorState): string {
  switch (fsm) {
    case 'wrapping-up':
      return 'wrapping up'
    case 'ended':
      return 'call ended'
    case 'user-speaking':
      return 'listening'
    default:
      return fsm
  }
}

function connectionWord(state: RealtimeSessionState): string {
  switch (state) {
    case 'active':
      return 'connected'
    case 'connecting':
      return 'connecting'
    case 'error':
      return 'connection error'
    case 'ended':
      return 'disconnected'
    case 'closing':
      return 'closing'
    default:
      return 'offline'
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}
