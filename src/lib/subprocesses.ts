// Subprocess registry — kills tracked children on process.on('exit').
//
// We spawn long-lived helper processes (mic recorder, speaker player, the
// claude CLI subprocess inside the SDK). Each module has its own teardown
// path (SIGTERM with SIGKILL fallback), but those run from `await`s in
// `stop()` paths. If Node exits abruptly — uncaught exception, parent
// SIGKILL, a host crash — those teardown paths never fire and we leak
// long-lived processes that keep holding the mic / sound device / SDK
// session.
//
// `process.on('exit')` is the last hook Node fires before it actually
// terminates. It runs SYNCHRONOUSLY — no awaits, no event loop — so the
// only termination signal we can effectively send is SIGKILL. This is
// the cleanup of last resort, not the primary path.

import type { ChildProcess } from 'node:child_process'

const tracked = new Set<ChildProcess>()
let installed = false

function killAll(): void {
  for (const child of tracked) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already dead */
    }
  }
  tracked.clear()
}

function install(): void {
  if (installed) return
  installed = true
  process.on('exit', killAll)
}

/** Register a child process. Auto-removes the entry when the child exits
 *  on its own. On `process.exit`, any still-tracked children are SIGKILLed. */
export function trackSubprocess(child: ChildProcess): void {
  install()
  tracked.add(child)
  child.once('exit', () => {
    tracked.delete(child)
  })
}
