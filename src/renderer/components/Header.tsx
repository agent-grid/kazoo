// Header — the brand + the live-state organ. (SURFACE_PLAN §6 "Component tree".)
//
//   <Wordmark>        static pixel KAZOO
//   <KazooResonator>  the ··· that ANIMATES while speaking, idle otherwise
//   <ConnectionPip>   WS health (distinct from the orchestrator FSM)
//
// The call control (Start/Hang up) lives here too so it's always reachable.

import type { OrchestratorState } from '../../core/orchestrator/state.ts'
import type { RealtimeSessionState } from '../../core/realtime/events.ts'

export type HeaderProps = {
  fsm: OrchestratorState
  connection: RealtimeSessionState
  /** True while narration audio is actively playing (from useAudioIO). */
  isSpeaking: boolean
  /** Playback RMS [0, 1] — the ONLY raw-audio signal the UI reads, used for
   *  the speaking-pulse amplitude. */
  outputLevel: number
  /** Call lifecycle, for the Start/Hang up button. */
  live: boolean
  onToggleCall: () => void
}

export function Header(props: HeaderProps): React.JSX.Element {
  const { fsm, connection, isSpeaking, outputLevel, live, onToggleCall } = props
  return (
    <header className="header">
      <Wordmark />
      <KazooResonator fsm={fsm} isSpeaking={isSpeaking} amplitude={outputLevel} />
      <ConnectionPip connection={connection} />
      <span className="header-spacer" />
      <span className={`speaking-label${isSpeaking ? ' is-speaking' : ''}`}>
        {isSpeaking ? '◜ SPEAKING ◞' : 'idle'}
      </span>
      <button
        type="button"
        className={`call-btn ${live ? 'hangup' : 'start'}`}
        onClick={onToggleCall}
      >
        {live ? 'Hang up' : 'Start call'}
      </button>
    </header>
  )
}

/** Static pixel wordmark. Rendered as styled glyphs (not the PNG) so it stays
 *  crisp at any scale and ships no raster asset into the bundle. */
const WORDMARK_LETTERS = [
  { key: 'k', ch: 'K' },
  { key: 'a', ch: 'A' },
  { key: 'z', ch: 'Z' },
  { key: 'o1', ch: 'O' },
  { key: 'o2', ch: 'O' },
] as const

function Wordmark(): React.JSX.Element {
  return (
    <span className="wordmark" role="img" aria-label="KAZOO">
      {WORDMARK_LETTERS.map((l) => (
        <span key={l.key}>{l.ch}</span>
      ))}
    </span>
  )
}

/** The resonator: three dots whose animation is driven by the orchestrator FSM,
 *  with the speaking-pulse amplitude driven by raw playback RMS. (SURFACE_PLAN
 *  §6 resonator table.) */
function KazooResonator(props: {
  fsm: OrchestratorState
  isSpeaking: boolean
  amplitude: number
}): React.JSX.Element {
  const mode = resonatorMode(props.fsm, props.isSpeaking)
  // Amplitude only matters in the speaking mode; pass it as a CSS var the
  // stylesheet multiplies into scale + glow.
  const ampStyle =
    mode === 'speaking'
      ? ({ '--amp': clamp01(props.amplitude).toFixed(3) } as React.CSSProperties)
      : undefined
  return (
    <span
      className={`resonator ${mode}`}
      style={ampStyle}
      role="img"
      aria-label={`resonator ${mode}`}
    >
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </span>
  )
}

type ResonatorMode = 'idle' | 'listening' | 'user-speaking' | 'working' | 'speaking'

/** Map the merged FSM + playback signal to a visual mode. `narrating` only
 *  reads as "speaking" while audio is actually playing — otherwise it's the
 *  brief gap between phrases, which should read as working/idle, not a frozen
 *  glow. (SURFACE_PLAN §6.) */
function resonatorMode(fsm: OrchestratorState, isSpeaking: boolean): ResonatorMode {
  if (fsm === 'narrating') return isSpeaking ? 'speaking' : 'working'
  switch (fsm) {
    case 'listening':
      return 'listening'
    case 'user-speaking':
      return 'user-speaking'
    case 'working':
    case 'wrapping-up':
      return 'working'
    default:
      return 'idle'
  }
}

/** Realtime WS health dot. */
function ConnectionPip(props: { connection: RealtimeSessionState }): React.JSX.Element {
  return (
    <span
      className={`pip ${pipClass(props.connection)}`}
      title={`connection: ${props.connection}`}
      role="img"
      aria-label={`connection ${props.connection}`}
    />
  )
}

function pipClass(state: RealtimeSessionState): string {
  switch (state) {
    case 'connecting':
      return 'connecting'
    case 'active':
      return 'active'
    case 'error':
      return 'error'
    case 'ended':
      return 'ended'
    default:
      return 'idle'
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}
