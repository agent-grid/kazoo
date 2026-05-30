// Preload — the ONLY bridge between the sandboxed renderer and main.
//
// Runs with `contextIsolation: true` + `sandbox: true`, so it has no Node
// access beyond the `electron` preload API. It exposes a FROZEN, FUNCTIONS-ONLY
// surface at `window.kazoo`:
//   - the renderer can call a fixed set of functions (send a mic frame, start,
//     hangup, set mode, subscribe to a fixed set of channels);
//   - it can NEVER reach `ipcRenderer` directly, so it can't send an arbitrary
//     channel, and it never receives the raw Electron `event` object (every
//     subscription strips it — see `sub`), so it can't pull `event.sender` and
//     escape the sandbox.
//
// No secrets cross this boundary. Secrets live in main only (SURFACE_PLAN §7).

import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import {
  type BusEvent,
  CH,
  type KazooBridge,
  type NarrationMode,
  type SessionInfo,
} from '../shared/ipc-types'

/** Subscribe to a main→renderer channel, stripping the raw `event` arg so the
 *  renderer only ever sees the payload. Returns an unsubscribe function. */
function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => {
    cb(payload)
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

/** Subscribe to a payload-less main→renderer signal. */
function subSignal(channel: string, cb: () => void): () => void {
  const handler = (): void => {
    cb()
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

const api: KazooBridge = {
  // renderer → main
  sendMicFrame: (frame: ArrayBuffer): void => {
    // `postMessage` serializes with the Structured Clone Algorithm, which
    // ships an `ArrayBuffer` by reference into main's V8 without a base64
    // round-trip — the 20 ms mic frame stays cheap. (The `transfer` list is
    // for `MessagePort`s only, so it's omitted.) Main encodes to base64 once,
    // at the WS boundary, where `Buffer` exists — never in the sandboxed
    // renderer.
    ipcRenderer.postMessage(CH.MIC_FRAME, frame)
  },
  start: (): void => {
    ipcRenderer.send(CH.CONTROL, { kind: 'start' })
  },
  hangup: (): void => {
    ipcRenderer.send(CH.CONTROL, { kind: 'hangup' })
  },
  setMode: (mode: NarrationMode): void => {
    ipcRenderer.send(CH.CONTROL, { kind: 'set-mode', mode })
  },
  ready: (): void => {
    ipcRenderer.send(CH.RENDERER_READY)
  },

  // main → renderer
  onBus: (cb: (ev: BusEvent) => void): (() => void) => sub<BusEvent>(CH.BUS, cb),
  onAudioChunk: (cb: (pcm: ArrayBuffer) => void): (() => void) =>
    sub<ArrayBuffer>(CH.AUDIO_CHUNK, cb),
  onFlushAudio: (cb: () => void): (() => void) => subSignal(CH.FLUSH_AUDIO, cb),
  onResponseStarted: (cb: () => void): (() => void) => subSignal(CH.RESPONSE_STARTED, cb),
  onAudioDone: (cb: () => void): (() => void) => subSignal(CH.AUDIO_DONE, cb),
  onSessionInfo: (cb: (info: SessionInfo) => void): (() => void) =>
    sub<SessionInfo>(CH.SESSION_INFO, cb),
}

contextBridge.exposeInMainWorld('kazoo', api)
