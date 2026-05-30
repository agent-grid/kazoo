// App — the renderer root. The single reducer over `window.kazoo.onBus` plus
// the headless audio engine (`useAudioIO`), composed into the four-region
// terminal UI: Header · WorkStage (the hero) · ConversationStrip · StatusBar.
// (SURFACE_PLAN §6.)
//
// Binding model: main forwards every internal `BusEvent` verbatim over CH.BUS;
// this component reduces them into a single UI store (`store/reducer.ts`) and
// re-renders. The audio-derived signals (mic level, playback amplitude,
// isSpeaking) come from `useAudioIO` — sampled per animation frame — so 24 kHz
// audio never churns the store. SESSION_INFO (cwd/model) arrives once, on the
// ready handshake.

import { useEffect, useReducer, useState } from 'react'
import type { NarrationMode } from '../core/narration/modes.ts'
import type { SessionInfo } from '../shared/ipc-types.ts'
import { useAudioIO } from './audio/useAudioIO.ts'
import { ConversationStrip } from './components/ConversationStrip.tsx'
import { Header } from './components/Header.tsx'
import { StatusBar } from './components/StatusBar.tsx'
import { WorkStage } from './components/WorkStage.tsx'
import { INITIAL_STATE, reduce, type UiState } from './store/reducer.ts'

export function App(): React.JSX.Element {
  const audio = useAudioIO()
  const [ui, dispatch] = useReducer(busReducer, INITIAL_STATE)
  const [session, setSession] = useState<SessionInfo | null>(null)

  // ── The single bus subscription. Every `BusEvent` from main lands here and
  // is reduced into the store. The receipt timestamp is stamped on dispatch
  // (the bus union has no timestamps — SURFACE_PLAN §6).
  useEffect(() => {
    const off = window.kazoo.onBus((ev) => {
      dispatch({ ev, at: Date.now() })
    })
    return off
  }, [])

  // ── One-shot session metadata (cwd/model) for the StatusBar.
  useEffect(() => {
    const off = window.kazoo.onSessionInfo((info) => {
      setSession(info)
    })
    return off
  }, [])

  // ── Announce readiness so main flushes SESSION_INFO. Fire once.
  useEffect(() => {
    window.kazoo.ready()
  }, [])

  const live = audio.status === 'live'

  const onToggleCall = (): void => {
    if (live) void audio.stop()
    else void audio.start()
  }

  const onSetMode = (mode: NarrationMode): void => {
    // Optimism is unnecessary: main echoes the change back as a `narration-mode`
    // bus event, which the reducer applies. Just send.
    window.kazoo.setMode(mode)
  }

  return (
    <div className="app">
      <Header
        fsm={ui.fsm}
        connection={ui.connection}
        isSpeaking={audio.isSpeaking}
        outputLevel={audio.outputLevel}
        live={live}
        onToggleCall={onToggleCall}
      />
      <WorkStage
        currentAction={ui.currentAction}
        fsm={ui.fsm}
        workFeed={ui.workFeed}
        changedFiles={ui.changedFiles}
      />
      <ConversationStrip turns={ui.turns} />
      <StatusBar
        fsm={ui.fsm}
        connection={ui.connection}
        mode={ui.mode}
        micLevel={audio.micLevel}
        isSpeaking={audio.isSpeaking}
        cwd={session?.cwd ?? null}
        live={live}
        onSetMode={onSetMode}
      />
      {audio.error !== null && (
        <div style={{ position: 'fixed', bottom: 36, right: 12 }} className="call-error">
          audio error: {audio.error}
        </div>
      )}
    </div>
  )
}

// useReducer adapter — the store reducer takes (state, ev, at); wrap the event +
// receipt time into a single action so React's reducer signature is satisfied.
type BusAction = { ev: Parameters<typeof reduce>[1]; at: number }

function busReducer(state: UiState, action: BusAction): UiState {
  return reduce(state, action.ev, action.at)
}
