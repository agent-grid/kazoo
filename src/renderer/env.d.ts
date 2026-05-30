// Renderer ambient declarations.
//
// 1. Augment `Window` with the `kazoo` bridge the preload mounts via
//    `contextBridge.exposeInMainWorld('kazoo', api)`. Typed from the SHARED
//    contract (`KazooBridge`) so renderer, preload, and main all speak the
//    same shape from one source of truth. This is TYPE-ONLY — importing the
//    type drags in no runtime (verbatimModuleSyntax keeps it erased).
//
// 2. Vite client types (import.meta.env, ?worker/?url asset imports, etc.).

/// <reference types="vite/client" />

import type { KazooBridge } from '../shared/ipc-types.ts'

declare global {
  interface Window {
    /** The frozen, functions-only IPC surface the preload exposes. The only
     *  channel between the sandboxed renderer and main. */
    readonly kazoo: KazooBridge
  }
}
