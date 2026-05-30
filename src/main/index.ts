// Composition root — the Electron MAIN entry. Ports the old `cli.tsx` wiring
// sequence verbatim, swapping the two surface seams:
//   - `render(<App/>)`  → `createWindow()` (a BrowserWindow);
//   - the subprocess `mic`/`speaker`  → an IPC-backed `AudioSink` (audio-sink.ts)
//     plus the renderer-driven mic path (frames arrive over IPC and are pushed
//     to `realtime.sendAudio` in `ipc.ts`).
//
// Stays wiring-only; no logic. SECRETS (OPENAI_API_KEY + the Anthropic
// credential) are read here via dotenv + loadConfig and handed straight into
// `RealtimeSession` / `createExecutor` — they NEVER cross an IPC channel and
// never reach the renderer. (SURFACE_PLAN §1, §7.)
//
// Wiring order (mirrors cli.tsx):
//   dotenv → loadConfig → (Anthropic auth fail-fast) → logger → workspace
//   safety → memory recall → personas → bus → distiller → audioSink →
//   deferred handler proxies → realtime → injector → executor → orchestrator →
//   bind handlers → BrowserWindow → wire IPC → lifecycle.

import 'dotenv/config' // MUST precede loadConfig — Node doesn't auto-load .env.

import { mkdirSync, realpathSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { loadConfig } from '../core/config.ts'
import type { ExecutorEvent } from '../core/executor/events.ts'
import { createExecutor } from '../core/executor/runner.ts'
import { defaultPermissionPolicy } from '../core/executor/tools.ts'
import { isKazooError } from '../core/lib/errors.ts'
import { createLogger } from '../core/lib/logger.ts'
import { createDistiller } from '../core/memory/distill.ts'
import { recall } from '../core/memory/store.ts'
import { executorSystemPrompt, realtimeInstructions } from '../core/narration/persona.ts'
import { createBus } from '../core/orchestrator/bus.ts'
import { createOrchestrator } from '../core/orchestrator/loop.ts'
import type { RealtimeEvent } from '../core/realtime/events.ts'
import { createQueuedInjector } from '../core/realtime/inject.ts'
import { RealtimeSession } from '../core/realtime/session.ts'
import type { SessionInfo } from '../shared/ipc-types.ts'
import { createAudioSink } from './audio-sink.ts'
import { resolveExecutorAuth } from './executor-auth.ts'
import { wireIpc } from './ipc.ts'
import { installLifecycle } from './lifecycle.ts'
import { resolveSdkExecutable } from './sdk-paths.ts'
import { createWindow } from './window.ts'
import { assertWorkspaceSafe } from './workspace.ts'

async function bootstrap(): Promise<void> {
  // 1. Config — fail-fast on missing OPENAI_API_KEY (loadConfig throws), then
  //    explicitly on missing Claude auth so the operator gets a clear message
  //    before the SDK fails opaquely. `resolveExecutorAuth` throws a
  //    KazooError if neither credential is set.
  const config = loadConfig()
  const auth = resolveExecutorAuth(config)

  // 2. Logger first — file-backed pino with the redaction list. (In main,
  //    stdout is free; a dev console transport could be added later.)
  const logger = createLogger({ file: config.log.file, level: config.log.level })
  logger.info(
    {
      config: {
        ...config,
        openaiApiKey: '***',
        anthropic: {
          oauthToken: config.anthropic.oauthToken ? '***' : undefined,
          apiKey: config.anthropic.apiKey ? '***' : undefined,
        },
      },
    },
    'kazoo: boot',
  )

  // 3. Workspace dir for the executor. Scoped OUTSIDE Kazoo's own source.
  //    Mode 0o700 so other users on the box can't read work in flight.
  //    realpath after mkdir so the runner's path-scope check operates on the
  //    canonical path; preflight refuses dangerous roots.
  mkdirSync(config.executor.workspace, { recursive: true, mode: 0o700 })
  const workspaceReal = realpathSync(config.executor.workspace)
  assertWorkspaceSafe(workspaceReal)
  logger.info(
    { workspace: workspaceReal, configured: config.executor.workspace },
    'kazoo: executor workspace ready',
  )

  // 4. Recall memory + build personas. (No audio-backend preflight — capture
  //    is the renderer's job now; the old `detectBackend()` is gone.)
  const memory = recall(
    { userMemory: config.memory.userMemoryPath, projectMemory: config.memory.projectMemoryPath },
    logger,
  )
  const personaPrefs = { voicePrefs: memory.voicePrefs, projectFacts: memory.projectFacts }
  const rtInstructions = realtimeInstructions(personaPrefs)
  const execPrompt = executorSystemPrompt(personaPrefs)

  // 5. Bus + memory distiller.
  const bus = createBus({
    onListenerError(err, ev) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), ev: ev.type },
        'bus: listener threw',
      )
    },
  })
  const distiller = createDistiller(
    { userMemory: config.memory.userMemoryPath, projectMemory: config.memory.projectMemoryPath },
    logger,
  )

  // 6. AudioSink — the Electron seam replacing the subprocess speaker. It
  //    targets the window's webContents once the window exists (set below).
  const audioSink = createAudioSink()

  // 7. Deferred-handler proxies. The orchestrator needs realtime + executor in
  //    its deps, but those objects need an onEvent at construction time, so we
  //    bind the proxies once the orchestrator exists. Nothing emits before
  //    `orchestrator.start()`, so no event is lost.
  let realtimeHandler: (ev: RealtimeEvent) => void = () => {}
  let executorHandler: (ev: ExecutorEvent) => void = () => {}

  // 8. Realtime — the narrator (ears + mouth). Persona tells it NOT to answer
  //    coding questions; it voices our injected narration phrases. Opening
  //    response suppressed so the agent waits for the user to speak first.
  const realtime = new RealtimeSession({
    apiKey: config.openaiApiKey,
    model: config.realtime.model,
    voice: config.realtime.voice,
    ...(config.realtime.speed !== undefined ? { speed: config.realtime.speed } : {}),
    instructions: rtInstructions,
    logger,
    onEvent: (ev) => realtimeHandler(ev),
  })

  // 9. Injector — scheduler/pacing. `onSpoken` fires AFTER a phrase actually
  //    goes out, so `narration-spoken` bus events stay truthful when the
  //    scheduler coalesces a burst.
  const injector = createQueuedInjector(realtime, logger, {
    onSpoken: (text) => bus.emit({ type: 'narration-spoken', text }),
  })

  // 10. Executor — the brain. Sandboxed to the RESOLVED workspace. Auth is the
  //     single resolved credential (OAuth preferred). The SDK child env is
  //     built from an allowlist inside the runner.
  const policy = defaultPermissionPolicy(workspaceReal)
  // Resolve the native SDK binary path. `undefined` in dev (SDK self-resolves);
  // the unpacked-asar path in a packaged build (SURFACE_PLAN §A / Risk #1).
  const executablePath = resolveSdkExecutable(app.isPackaged)
  if (app.isPackaged && !executablePath) {
    logger.warn(
      'kazoo: packaged build but SDK executable not found under app.asar.unpacked; ' +
        'deferring to SDK default resolution',
    )
  }
  const executor = createExecutor({
    oauthToken: auth.oauthToken,
    apiKey: auth.apiKey,
    model: config.executor.model,
    systemPrompt: execPrompt,
    policy,
    executablePath,
    onEvent: (ev) => executorHandler(ev),
    logger,
  })

  // 11. Orchestrator — wire the two handler slots. The loop is surface-free:
  //     it talks audio through `audioSink`, never Electron.
  const orchestrator = createOrchestrator({
    realtime,
    executor,
    injector,
    audioSink,
    distiller,
    bus,
    logger,
  })
  realtimeHandler = orchestrator.onRealtimeEvent
  executorHandler = orchestrator.onExecutorEvent

  // 12. App lifecycle — graceful shutdown on quit → orchestrator.stop +
  //     executor.close (no `src/lib/subprocesses.ts`; this is the hook).
  installLifecycle({ app, orchestrator, executor, logger })

  // 13. Window + IPC. The window is the surface; IPC is the only bridge.
  await app.whenReady()
  const { window }: { window: BrowserWindow } = createWindow()
  audioSink.setWebContents(window.webContents)

  const sessionInfo: SessionInfo = {
    cwd: workspaceReal,
    model: config.realtime.model,
  }
  const teardownIpc = wireIpc({
    webContents: window.webContents,
    realtime,
    orchestrator,
    bus,
    setMode: (msg) => {
      // No mode-aware narration logic is wired in the loop yet; emitting the
      // bus event keeps the StatusBar mirror truthful and is the seam for when
      // mode-batching lands.
      bus.emit({ type: 'narration-mode', mode: msg.mode })
    },
    sessionInfo,
    logger,
  })

  // If the renderer reloads (dev HMR) the webContents survive but listeners
  // could double-bind; retarget the sink and rewire IPC on a fresh load.
  window.webContents.on('destroyed', () => {
    teardownIpc()
    audioSink.setWebContents(null)
  })

  logger.info('kazoo: window created; awaiting renderer-ready')
}

// Single-instance: a second launch focuses the existing window instead of
// spawning a parallel Realtime session + SDK child.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  bootstrap().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    if (isKazooError(err)) {
      process.stderr.write(`kazoo: ${msg}\n`)
    } else {
      process.stderr.write(`kazoo: fatal — ${msg}\n`)
    }
    // dialog isn't guaranteed before app-ready; stderr + exit is the floor.
    app.exit(1)
  })
}
