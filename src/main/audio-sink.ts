// The Electron implementation of the orchestrator's `AudioSink` seam.
//
// The orchestrator (src/core/orchestrator/loop.ts) is surface-agnostic: it
// hands base64 PCM16 chunks to an injected `AudioSink` and never touches
// Electron. This is that sink. It decodes the base64 to raw bytes in MAIN
// (where `Buffer` exists — the sandboxed renderer has none) and ships a
// transferable `ArrayBuffer` to the renderer's WebAudio playback queue over a
// DEDICATED channel, kept off the React bus so 24 kHz audio never churns the
// UI tree. (SURFACE_PLAN §5.)
//
// The four methods map 1:1 to the renderer playback contract:
//   play(b64)        → AUDIO_CHUNK(ArrayBuffer)  — enqueue + schedule
//   flush()          → FLUSH_AUDIO                — barge-in: stop+clear now
//   responseStarted()→ RESPONSE_STARTED          — lift the renderer tail-gate
//   done()           → AUDIO_DONE                 — stop the speaking indicator
//
// `setWebContents` lets main retarget the sink if the window is recreated;
// before any target is set (or after the contents are destroyed) every method
// is a safe no-op.

import type { WebContents } from 'electron'
import type { AudioSink } from '../core/orchestrator/loop.ts'
import { CH } from '../shared/ipc-types.ts'

export type MainAudioSink = AudioSink & {
  /** Point the sink at a (new) renderer. */
  setWebContents: (wc: WebContents | null) => void
}

/** Decode base64 PCM16 → a fresh `ArrayBuffer` (its own backing store, so the
 *  structured-clone hand-off to the renderer is clean). */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const buf = Buffer.from(b64, 'base64')
  // Slice to the exact view — `Buffer.from(base64)` may sit in a larger
  // pooled allocation, and we must not ship the pool's tail to the renderer.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

export function createAudioSink(initial?: WebContents | null): MainAudioSink {
  let target: WebContents | null = initial ?? null

  function send(channel: string, payload?: unknown): void {
    const wc = target
    if (!wc || wc.isDestroyed()) return
    if (payload === undefined) wc.send(channel)
    else wc.send(channel, payload)
  }

  return {
    setWebContents(wc: WebContents | null): void {
      target = wc
    },
    play(b64Pcm16: string): void {
      if (!b64Pcm16) return
      send(CH.AUDIO_CHUNK, base64ToArrayBuffer(b64Pcm16))
    },
    flush(): void {
      send(CH.FLUSH_AUDIO)
    },
    responseStarted(): void {
      send(CH.RESPONSE_STARTED)
    },
    done(): void {
      send(CH.AUDIO_DONE)
    },
  }
}
