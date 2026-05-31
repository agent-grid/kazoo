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

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
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

  // ── Workspace picker. Main owns the native dialog + safety validation +
  // executor swap; the renderer just drives it and surfaces the outcome.
  // The notice is a short transient string (cleared on success or after a
  // few seconds for non-fatal results).
  const [picking, setPicking] = useState(false)
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null)
  // Cancel the auto-clear timer if a new pick lands first (prevents the old
  // timer from clearing the new notice).
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flashNotice = useCallback((text: string | null, ms: number): void => {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = null
    }
    setWorkspaceNotice(text)
    if (text !== null && ms > 0) {
      noticeTimerRef.current = setTimeout(() => {
        setWorkspaceNotice(null)
        noticeTimerRef.current = null
      }, ms)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current)
    }
  }, [])

  const onPickWorkspace = useCallback((): void => {
    if (picking) return
    setPicking(true)
    flashNotice(null, 0)
    void window.kazoo
      .pickWorkspace()
      .then((result) => {
        if (result.ok) {
          // SESSION_INFO is broadcast by main on success; the existing
          // onSessionInfo listener updates the displayed cwd. A short ack
          // confirms the swap actually happened.
          flashNotice('workspace updated', 2500)
          return
        }
        switch (result.reason) {
          case 'cancelled':
            // User backed out of the dialog. No notice — silent is fine.
            return
          case 'busy':
          case 'unsafe':
          case 'invalid':
          case 'error':
            flashNotice(result.message, 6000)
            return
          default: {
            // Exhaustiveness — a new reason variant must be handled.
            const _never: never = result
            void _never
            return
          }
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        flashNotice(`picker error: ${message}`, 6000)
      })
      .finally(() => {
        setPicking(false)
      })
  }, [picking, flashNotice])

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
        workspaceNotice={workspaceNotice}
        onSetMode={onSetMode}
        onPickWorkspace={onPickWorkspace}
        picking={picking}
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
