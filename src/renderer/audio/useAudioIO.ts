// useAudioIO — the headless audio hook. Owns the renderer's entire WebAudio
// life: mic capture, scheduled playback, the barge-in flush gate, and the live
// level meters. It renders nothing; it exposes state for the UI
// (`<MicMeter>`, `<KazooResonator>` amplitude) and a `start`/`stop` the call
// UX drives. (SURFACE_PLAN §5, §6.)
//
// Why a hook and not a component: audio is a side-effecting device, not view.
// Keeping it headless lets the UI tree stay pure and lets the audio graph
// outlive re-renders (the contexts/nodes live in refs, not state).
//
// The barge-in path is entirely IPC-driven and never touches React render:
//   main FLUSH_AUDIO  → playback.flush()        (synchronous, in audio thread)
//   main AUDIO_CHUNK  → playback.enqueue(bytes)  (off the React bus)
// React only sees coarse booleans (`isPlaying`) sampled on an animation frame,
// so 24 kHz audio never churns the component tree.

import { useCallback, useEffect, useRef, useState } from 'react'
import { type MicCapture, startCapture } from './capture.ts'
import { createPlayback, type Playback } from './playback.ts'

export type AudioIOStatus = 'idle' | 'starting' | 'live' | 'error'

export type UseAudioIO = {
  /** Lifecycle status for the call UX (Start button, error banner). */
  readonly status: AudioIOStatus
  /** Last fatal error message, if `status === 'error'`. */
  readonly error: string | null
  /** Mic input level [0, 1] — drives `<MicMeter>`. Sampled per animation frame. */
  readonly micLevel: number
  /** Playback output level [0, 1] — drives the resonator amplitude. */
  readonly outputLevel: number
  /** True while narration audio is actively playing. */
  readonly isSpeaking: boolean
  /** Begin capture + playback. MUST be called from a user gesture (the Start
   *  button) so the AudioContexts can `resume()` off `suspended`, and so the
   *  mic permission prompt is gesture-initiated. Also fires `window.kazoo
   *  .start()` to begin the call in main. Idempotent while live/starting. */
  readonly start: () => Promise<void>
  /** Tear down audio and hang up the call. Idempotent. */
  readonly stop: () => Promise<void>
}

export function useAudioIO(): UseAudioIO {
  const [status, setStatus] = useState<AudioIOStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [micLevel, setMicLevel] = useState(0)
  const [outputLevel, setOutputLevel] = useState(0)
  const [isSpeaking, setIsSpeaking] = useState(false)

  // Device handles live in refs — they must survive re-renders and not be
  // recreated by state churn.
  const captureRef = useRef<MicCapture | null>(null)
  const playbackRef = useRef<Playback | null>(null)
  const rafRef = useRef<number | null>(null)
  // Unsubscribe functions for the main→renderer audio channels.
  const unsubsRef = useRef<Array<() => void>>([])

  // ── Wire the inbound playback channels ONCE, for the whole hook lifetime.
  // These are cheap subscriptions that route into whatever playback graph is
  // currently live; before `start()` (no graph yet) they harmlessly no-op.
  // Wiring them here — not inside start() — means a chunk that races ahead of
  // the graph being stored in the ref is simply dropped, never mis-routed.
  useEffect(() => {
    const { kazoo } = window

    const offChunk = kazoo.onAudioChunk((pcm: ArrayBuffer) => {
      playbackRef.current?.enqueue(pcm)
    })
    const offFlush = kazoo.onFlushAudio(() => {
      // Barge-in. Stop everything instantly and stop the speaking indicator.
      playbackRef.current?.flush()
      setIsSpeaking(false)
    })
    const offStarted = kazoo.onResponseStarted(() => {
      playbackRef.current?.responseStarted()
    })
    const offDone = kazoo.onAudioDone(() => {
      playbackRef.current?.markDone()
      setIsSpeaking(false)
    })

    unsubsRef.current = [offChunk, offFlush, offStarted, offDone]
    return () => {
      for (const off of unsubsRef.current) off()
      unsubsRef.current = []
    }
  }, [])

  // ── Level/animation sampling loop. One rAF reads both meters and the
  // speaking flag, so the audio graph drives the UI without per-chunk renders.
  const startLevelLoop = useCallback(() => {
    if (rafRef.current !== null) return
    const tick = (): void => {
      const cap = captureRef.current
      const pb = playbackRef.current
      if (cap) setMicLevel(cap.level())
      if (pb) {
        setOutputLevel(pb.level())
        setIsSpeaking(pb.isPlaying())
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const stopLevelLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setMicLevel(0)
    setOutputLevel(0)
    setIsSpeaking(false)
  }, [])

  const start = useCallback(async (): Promise<void> => {
    if (captureRef.current || status === 'starting' || status === 'live') return
    setStatus('starting')
    setError(null)

    // Build playback first so an AUDIO_CHUNK arriving the instant the call
    // starts has a graph to land in.
    const playback = createPlayback()
    playbackRef.current = playback

    try {
      // Resume the playback context off `suspended` — this call IS the user
      // gesture, so the unlock takes effect. Without it, output is silently
      // dead. (SURFACE_PLAN §5, Risk #4.)
      if (playback.context.state === 'suspended') await playback.context.resume()

      const capture = await startCapture({
        // Frames go straight to the preload bridge as transferable
        // ArrayBuffers; main base64-encodes once and calls realtime.sendAudio.
        onFrame: (frame) => {
          window.kazoo.sendMicFrame(frame)
        },
        onError: (err) => {
          // A mid-call worklet crash — surface but don't tear the whole call
          // down here; the user can hang up.
          setError(err instanceof Error ? err.message : String(err))
        },
      })
      captureRef.current = capture
      if (capture.context.state === 'suspended') await capture.context.resume()

      // Tell main to connect Realtime and begin the call.
      window.kazoo.start()

      startLevelLoop()
      setStatus('live')
    } catch (err) {
      // Capture failed (permission denied / no device) — unwind playback too.
      await playback.stop().catch(() => undefined)
      playbackRef.current = null
      captureRef.current = null
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [status, startLevelLoop])

  const stop = useCallback(async (): Promise<void> => {
    stopLevelLoop()
    // Hang up the call in main first (wrap-up + memory), then tear down audio.
    try {
      window.kazoo.hangup()
    } catch {
      /* bridge may be gone on teardown */
    }
    const cap = captureRef.current
    const pb = playbackRef.current
    captureRef.current = null
    playbackRef.current = null
    await Promise.allSettled([cap?.stop(), pb?.stop()])
    setStatus('idle')
  }, [stopLevelLoop])

  // ── Tear down on unmount (window close). Stop the loop + close the graphs;
  // don't call hangup here (the app is going away — main's lifecycle handles
  // the graceful stop on quit).
  useEffect(() => {
    return () => {
      stopLevelLoop()
      void captureRef.current?.stop()
      void playbackRef.current?.stop()
      captureRef.current = null
      playbackRef.current = null
    }
  }, [stopLevelLoop])

  return {
    status,
    error,
    micLevel,
    outputLevel,
    isSpeaking,
    start,
    stop,
  }
}
