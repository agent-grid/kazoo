// The IPC contract — the SINGLE source of truth for channel names + payload
// types shared across main, preload, and renderer. (SURFACE_PLAN §4.)
//
// Two tiers:
//   - a BUS channel carrying the serialized `BusEvent` union for display/state
//     (React-driven; re-render churn is fine here);
//   - dedicated AUDIO channels carrying raw PCM bytes as transferable
//     `ArrayBuffer`s (low latency, no React in the hot path).
//
// SECURITY: every import here is `type`-only (enforced by
// `verbatimModuleSyntax`), so pulling this module into the renderer bundle
// drags in NO core runtime and NO secret path. Payload shapes are kept
// deliberately narrow — `SessionInfo` must NEVER be widened to carry `Config`
// or anything secret-bearing (it crosses to the renderer). See §7.

import type { NarrationMode } from '../core/narration/modes.ts'
import type { BusEvent } from '../core/orchestrator/bus.ts'

export type { NarrationMode } from '../core/narration/modes.ts'
/** Re-exported so preload/renderer can name the bus payload without reaching
 *  into `src/core` directly. Type-only — no runtime crosses with it. */
export type { BusEvent } from '../core/orchestrator/bus.ts'

/** One-shot session metadata sent to the renderer on init. DELIBERATELY
 *  minimal — widening this is a secret-leak vector (Risk #10). */
export type SessionInfo = {
  /** The executor's pinned workspace dir, for the StatusBar. */
  cwd: string
  /** The Realtime model id, for display only. */
  model: string
}

/** Renderer → main control messages. The renderer can only express these
 *  shapes; it can never send an arbitrary channel (preload exposes functions,
 *  not `ipcRenderer`). */
export type ControlMsg =
  | { kind: 'start' }
  | { kind: 'hangup' }
  | { kind: 'set-mode'; mode: NarrationMode }

/** Channel names. Frozen object so a typo is a compile error, not a silent
 *  no-op subscription. */
export const CH = {
  // ── renderer → main ──
  /** Raw mic frame: PCM16 LE 24 kHz mono, 480-sample / 20 ms, as a
   *  transferable `ArrayBuffer` (NOT base64 — the renderer has no `Buffer`;
   *  main encodes once at the WS boundary). */
  MIC_FRAME: 'mic-frame',
  /** A `ControlMsg`. */
  CONTROL: 'control',
  /** Fired once when the renderer's React tree + preload bridge are live, so
   *  main can flush `SESSION_INFO` and (optionally) auto-start. */
  RENDERER_READY: 'renderer-ready',

  // ── main → renderer ──
  /** A serialized `BusEvent` (display / state). */
  BUS: 'bus',
  /** Decoded playback PCM as a transferable `ArrayBuffer` (PCM16 LE 24 kHz
   *  mono). Separate from the bus so 24 kHz audio never churns React. */
  AUDIO_CHUNK: 'audio-chunk',
  /** Barge-in: stop + clear all queued/playing audio NOW. */
  FLUSH_AUDIO: 'flush-audio',
  /** A fresh narration response began — lifts the renderer's post-flush gate. */
  RESPONSE_STARTED: 'response-started',
  /** End of the current audio turn — stop the speaking indicator. */
  AUDIO_DONE: 'audio-done',
  /** `SessionInfo`, sent once on init. */
  SESSION_INFO: 'session-info',
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]

/** Payload-by-channel map. Lets preload/main keep their `send`/`on` calls
 *  honest without re-deriving the shapes. (Documentation + a single place to
 *  audit; the preload bridge is the runtime enforcement point.) */
export type IpcPayloads = {
  [CH.MIC_FRAME]: ArrayBuffer
  [CH.CONTROL]: ControlMsg
  [CH.RENDERER_READY]: undefined
  [CH.BUS]: BusEvent
  [CH.AUDIO_CHUNK]: ArrayBuffer
  [CH.FLUSH_AUDIO]: undefined
  [CH.RESPONSE_STARTED]: undefined
  [CH.AUDIO_DONE]: undefined
  [CH.SESSION_INFO]: SessionInfo
}

/** The typed surface preload mounts at `window.kazoo`. Declared here (shared)
 *  so the renderer can augment `Window` from one source of truth and main can
 *  reference the same contract. FUNCTIONS ONLY — no `ipcRenderer`, no raw
 *  event objects. Every `on*` returns an unsubscribe function. */
export type KazooBridge = {
  // renderer → main
  /** Push one mic frame (transferable `ArrayBuffer`). */
  sendMicFrame: (frame: ArrayBuffer) => void
  /** Begin the call. */
  start: () => void
  /** Graceful hangup. */
  hangup: () => void
  /** Change narration batching mode. */
  setMode: (mode: NarrationMode) => void
  /** Announce the renderer is mounted and ready for events. */
  ready: () => void

  // main → renderer (each returns an unsubscribe)
  onBus: (cb: (ev: BusEvent) => void) => () => void
  onAudioChunk: (cb: (pcm: ArrayBuffer) => void) => () => void
  onFlushAudio: (cb: () => void) => () => void
  onResponseStarted: (cb: () => void) => () => void
  onAudioDone: (cb: () => void) => () => void
  onSessionInfo: (cb: (info: SessionInfo) => void) => () => void
}
