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

/** Session metadata sent to the renderer on init AND re-emitted whenever the
 *  workspace is swapped via the picker. DELIBERATELY minimal — widening this
 *  is a secret-leak vector (Risk #10). */
export type SessionInfo = {
  /** The executor's pinned workspace dir, for the StatusBar. */
  cwd: string
  /** The Realtime model id, for display only. */
  model: string
}

/** Result of `kazoo.pickWorkspace()`. Discriminated so the renderer can render
 *  each outcome (success / user-cancelled / invalid / unsafe / error) without
 *  any string parsing. Crucially this is FLAT DATA — nothing throws across
 *  the IPC seam. Sensitive details (full path of the rejected root, etc.) stay
 *  in the main-process log; the message here is a short human string. */
export type WorkspacePickResult =
  | { ok: true; cwd: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'unsafe'; message: string }
  | { ok: false; reason: 'busy'; message: string }
  | { ok: false; reason: 'error'; message: string }

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
  /** Two-way (ipcRenderer.invoke / ipcMain.handle). The renderer asks main to
   *  show the native directory picker; main returns a `WorkspacePickResult`
   *  and, on success, re-emits `SESSION_INFO`. */
  PICK_WORKSPACE: 'pick-workspace',

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
  [CH.PICK_WORKSPACE]: WorkspacePickResult
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
  /** Open the native directory picker. Returns a `WorkspacePickResult` (never
   *  rejects — failure modes are encoded into the result). On success, main
   *  swaps the executor's cwd and re-emits `SESSION_INFO`. The renderer can
   *  treat this as fire-and-forget plus listening to `onSessionInfo`, OR await
   *  the returned result to drive a toast / error banner. */
  pickWorkspace: () => Promise<WorkspacePickResult>

  // main → renderer (each returns an unsubscribe)
  onBus: (cb: (ev: BusEvent) => void) => () => void
  onAudioChunk: (cb: (pcm: ArrayBuffer) => void) => () => void
  onFlushAudio: (cb: () => void) => () => void
  onResponseStarted: (cb: () => void) => () => void
  onAudioDone: (cb: () => void) => () => void
  onSessionInfo: (cb: (info: SessionInfo) => void) => () => void
}
