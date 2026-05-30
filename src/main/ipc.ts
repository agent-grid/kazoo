// IPC wiring — the two-way bridge between main's hardened core and the
// sandboxed renderer. (SURFACE_PLAN §4.)
//
// Inbound (renderer → main):
//   MIC_FRAME(ArrayBuffer) → base64 (encoded HERE, in main) → realtime.sendAudio
//   CONTROL(ControlMsg)    → orchestrator.start / .stop / setMode
//   RENDERER_READY         → flush SESSION_INFO (+ optional auto-start)
//
// Outbound (main → renderer):
//   bus.subscribe(...)     → BUS(BusEvent)        [display/state — this file]
//   AUDIO_CHUNK / FLUSH_AUDIO / RESPONSE_STARTED / AUDIO_DONE
//                          → sent by the AudioSink (audio-sink.ts), held by
//                            the orchestrator, so the loop stays surface-free.
//
// The orchestrator's `start`/`stop` are async; we fire-and-forget with a
// logged catch so a control message never rejects into Electron's IPC layer.
// Mic frames are dropped silently before `start()` (realtime.sendAudio no-ops
// unless the session is `active`).

import { ipcMain, type WebContents } from 'electron'
import type { Logger } from '../core/lib/logger.ts'
import type { Bus } from '../core/orchestrator/bus.ts'
import type { Orchestrator } from '../core/orchestrator/loop.ts'
import type { RealtimeSession } from '../core/realtime/session.ts'
import { CH, type ControlMsg, type SessionInfo } from '../shared/ipc-types.ts'

export type IpcDeps = {
  webContents: WebContents
  realtime: RealtimeSession
  orchestrator: Orchestrator
  bus: Bus
  /** Switch narration batching mode. Emits the `narration-mode` bus variant
   *  itself so the StatusBar mirror stays truthful. */
  setMode: (msg: Extract<ControlMsg, { kind: 'set-mode' }>) => void
  /** One-shot metadata for the renderer's StatusBar. */
  sessionInfo: SessionInfo
  logger: Logger
}

/** Wire every channel. Returns a teardown that removes the ipcMain listeners
 *  and the bus subscription, so a window recreate doesn't double-bind. */
export function wireIpc(deps: IpcDeps): () => void {
  const { webContents, realtime, orchestrator, bus, setMode, sessionInfo } = deps
  const log = deps.logger.child({ mod: 'ipc' })

  // ── main → renderer: the display/state bus ──
  const unsubscribeBus = bus.subscribe((ev) => {
    if (webContents.isDestroyed()) return
    webContents.send(CH.BUS, ev)
  })

  // ── renderer → main: mic frames (arrive via ipcRenderer.postMessage) ──
  // The payload is a transferable ArrayBuffer; base64-encode it HERE, where
  // `Buffer` exists, and feed the Realtime WS. Guard the type so a malformed
  // frame can't crash the handler.
  const onMicFrame = (_e: unknown, frame: unknown): void => {
    if (!(frame instanceof ArrayBuffer)) return
    if (frame.byteLength === 0) return
    const b64 = Buffer.from(frame).toString('base64')
    realtime.sendAudio(b64)
  }
  ipcMain.on(CH.MIC_FRAME, onMicFrame)

  // ── renderer → main: control ──
  const onControl = (_e: unknown, msg: ControlMsg): void => {
    switch (msg.kind) {
      case 'start':
        void orchestrator.start().catch((err: unknown) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'ipc: orchestrator.start threw',
          )
        })
        return
      case 'hangup':
        void orchestrator.stop().catch((err: unknown) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'ipc: orchestrator.stop threw',
          )
        })
        return
      case 'set-mode':
        setMode(msg)
        return
      default: {
        // Exhaustiveness guard — a new ControlMsg variant must be handled.
        const _never: never = msg
        log.warn({ msg: _never }, 'ipc: unknown control message')
      }
    }
  }
  ipcMain.on(CH.CONTROL, onControl)

  // ── renderer → main: ready handshake ──
  // The renderer announces it has mounted; flush the one-shot SESSION_INFO so
  // the StatusBar can render the workspace + model immediately.
  const onReady = (e: { sender: WebContents }): void => {
    if (e.sender.isDestroyed()) return
    e.sender.send(CH.SESSION_INFO, sessionInfo)
  }
  ipcMain.on(CH.RENDERER_READY, onReady)

  return () => {
    unsubscribeBus()
    ipcMain.off(CH.MIC_FRAME, onMicFrame)
    ipcMain.off(CH.CONTROL, onControl)
    ipcMain.off(CH.RENDERER_READY, onReady)
  }
}
