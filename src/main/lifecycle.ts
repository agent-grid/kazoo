// App shutdown plumbing. (SURFACE_PLAN §3 — there is no `src/lib/
// subprocesses.ts`; the SDK-child cleanup hook is THIS file, wired to
// Electron's quit lifecycle.)
//
// The Claude Agent SDK manages its own native child, but we still must call
// `executor.close()` (and a best-effort orchestrator `stop()`) so the SDK
// tears the child down cleanly instead of leaving a 230 MB orphan, and so the
// query iterator/input stream drain rather than hang. This replaces the old
// CLI's SIGINT/SIGTERM TTY-shutdown path.
//
// `before-quit` is async-hostile (Electron won't await our promise), so we use
// the standard pattern: on the FIRST quit request, preventDefault, run the
// async teardown, then call `app.quit()` again to let it proceed.

import type { App } from 'electron'
import type { ExecutorRunner } from '../core/executor/runner.ts'
import type { Logger } from '../core/lib/logger.ts'
import type { Orchestrator } from '../core/orchestrator/loop.ts'

export type LifecycleDeps = {
  app: App
  orchestrator: Orchestrator
  executor: ExecutorRunner
  logger: Logger
}

/** Register the graceful-shutdown hook. Idempotent teardown — repeated quit
 *  requests during shutdown are ignored. */
export function installLifecycle(deps: LifecycleDeps): void {
  const { app, orchestrator, executor } = deps
  const log = deps.logger.child({ mod: 'lifecycle' })

  let shuttingDown = false
  let teardownComplete = false

  app.on('before-quit', (event) => {
    if (teardownComplete) return // second pass — let the quit proceed
    event.preventDefault()
    if (shuttingDown) return
    shuttingDown = true
    log.info('lifecycle: shutdown initiated')

    void (async () => {
      try {
        await orchestrator.stop()
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'lifecycle: orchestrator.stop threw',
        )
      }
      try {
        await executor.close()
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'lifecycle: executor.close threw',
        )
      }
      teardownComplete = true
      log.info('lifecycle: teardown complete; quitting')
      app.quit()
    })()
  })

  // Quit when all windows close (standard desktop behavior; this app has no
  // dock-relaunch story).
  app.on('window-all-closed', () => {
    app.quit()
  })
}
