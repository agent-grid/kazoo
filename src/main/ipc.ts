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
import {
  CH,
  type ControlMsg,
  type SessionInfo,
  type WorkspacePickResult,
} from '../shared/ipc-types.ts'

/** The bits of the session stack that swap when the workspace changes. The
 *  IPC layer reads through `getSession()` each time so a workspace swap is
 *  just an atomic pointer flip; we never have to unwire/rewire IPC. */
export type SessionStack = {
  realtime: RealtimeSession
  orchestrator: Orchestrator
}

export type IpcDeps = {
  webContents: WebContents
  /** Returns the CURRENT session stack. Indirected through a getter so a
   *  workspace swap (`rebuildSession`) doesn't require re-wiring IPC. */
  getSession: () => SessionStack
  bus: Bus
  /** Switch narration batching mode. Emits the `narration-mode` bus variant
   *  itself so the StatusBar mirror stays truthful. */
  setMode: (msg: Extract<ControlMsg, { kind: 'set-mode' }>) => void
  /** Returns the CURRENT `SessionInfo` (cwd/model). Re-read each time the
   *  renderer sends `renderer-ready` so a reload after a workspace swap sees
   *  the new cwd. */
  getSessionInfo: () => SessionInfo
  /** Open the native directory picker, validate, then swap the executor's
   *  workspace. Result is forwarded verbatim to the renderer. Resolves with
   *  the discriminated outcome; never throws. */
  pickWorkspace: () => Promise<WorkspacePickResult>
  logger: Logger
}

/** Wire every channel. Returns a teardown that removes the ipcMain listeners
 *  and the bus subscription, so a window recreate doesn't double-bind. */
export function wireIpc(deps: IpcDeps): () => void {
  const { webContents, getSession, bus, setMode, getSessionInfo, pickWorkspace } = deps
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
    // Indirect through getSession() — after a workspace swap, `realtime`
    // points at the freshly-built session. The new session may still be in
    // 'idle'; `sendAudio` no-ops in non-active states.
    getSession().realtime.sendAudio(b64)
  }
  ipcMain.on(CH.MIC_FRAME, onMicFrame)

  // ── renderer → main: control ──
  const onControl = (_e: unknown, msg: ControlMsg): void => {
    switch (msg.kind) {
      case 'start':
        void getSession()
          .orchestrator.start()
          .catch((err: unknown) => {
            log.error(
              { err: err instanceof Error ? err.message : String(err) },
              'ipc: orchestrator.start threw',
            )
          })
        return
      case 'hangup':
        void getSession()
          .orchestrator.stop()
          .catch((err: unknown) => {
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
  // The renderer announces it has mounted; flush the CURRENT SESSION_INFO so
  // the StatusBar can render the workspace + model immediately. Read through
  // `getSessionInfo()` so a renderer reload after a workspace swap sees the
  // new cwd.
  const onReady = (e: { sender: WebContents }): void => {
    if (e.sender.isDestroyed()) return
    e.sender.send(CH.SESSION_INFO, getSessionInfo())
  }
  ipcMain.on(CH.RENDERER_READY, onReady)

  // ── renderer → main: workspace picker (two-way, ipcMain.handle) ──
  // The dialog runs in main; the renderer just gets the typed result. We use
  // `handle` (not `on`) so the renderer can `await` the outcome and surface a
  // toast — cancel/unsafe/error are distinguishable.
  const onPickWorkspace = async (
    _e: Electron.IpcMainInvokeEvent,
  ): Promise<WorkspacePickResult> => {
    try {
      return await pickWorkspace()
    } catch (err) {
      // Defensive: pickWorkspace itself should encode every failure into the
      // discriminated result, but a programming error mustn't crash the
      // renderer's invoke promise into an opaque "Error invoking remote
      // method" string.
      const message = err instanceof Error ? err.message : String(err)
      log.error({ err: message }, 'ipc: pickWorkspace threw unexpectedly')
      return { ok: false, reason: 'error', message }
    }
  }
  ipcMain.handle(CH.PICK_WORKSPACE, onPickWorkspace)

  return () => {
    unsubscribeBus()
    ipcMain.off(CH.MIC_FRAME, onMicFrame)
    ipcMain.off(CH.CONTROL, onControl)
    ipcMain.off(CH.RENDERER_READY, onReady)
    ipcMain.removeHandler(CH.PICK_WORKSPACE)
  }
}
