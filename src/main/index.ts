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
//
// SESSION REBUILD: the realtime / injector / executor / orchestrator quartet
// is per-workspace state — when the user picks a new workspace via the
// renderer's picker we tear that quartet down and rebuild it with the new cwd
// (see `rebuildSession` below). The audio sink, bus, distiller, logger,
// window, and IPC wiring survive the swap; the IPC layer reads the active
// stack through a `getSession()` accessor so we never have to unwire/rewire.

import 'dotenv/config' // MUST precede loadConfig — Node doesn't auto-load .env.

import { mkdirSync, realpathSync } from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import { type Config, loadConfig } from '../core/config.ts'
import type { ExecutorEvent } from '../core/executor/events.ts'
import { createExecutor, type ExecutorRunner } from '../core/executor/runner.ts'
import { defaultPermissionPolicy } from '../core/executor/tools.ts'
import { isKazooError } from '../core/lib/errors.ts'
import { createLogger, type Logger } from '../core/lib/logger.ts'
import { createDistiller, type Distiller } from '../core/memory/distill.ts'
import { recall } from '../core/memory/store.ts'
import { executorSystemPrompt, realtimeInstructions } from '../core/narration/persona.ts'
import type { Bus } from '../core/orchestrator/bus.ts'
import { createBus } from '../core/orchestrator/bus.ts'
import { createOrchestrator, type Orchestrator } from '../core/orchestrator/loop.ts'
import type { RealtimeEvent } from '../core/realtime/events.ts'
import { createQueuedInjector } from '../core/realtime/inject.ts'
import { RealtimeSession } from '../core/realtime/session.ts'
import { CH, type SessionInfo, type WorkspacePickResult } from '../shared/ipc-types.ts'
import { createAudioSink } from './audio-sink.ts'
import { type ExecutorAuth, resolveExecutorAuth } from './executor-auth.ts'
import { wireIpc } from './ipc.ts'
import { installLifecycle } from './lifecycle.ts'
import { resolveSdkExecutable } from './sdk-paths.ts'
import { createWindow } from './window.ts'
import { assertWorkspaceSafe } from './workspace.ts'
import { pickWorkspace } from './workspace-picker.ts'

/** Per-workspace state. Replaced atomically by `rebuildSession`. */
type SessionStack = {
  realtime: RealtimeSession
  executor: ExecutorRunner
  orchestrator: Orchestrator
  workspaceReal: string
}

/** Inputs that don't change across a workspace swap. */
type StackBuildDeps = {
  config: Config
  auth: ExecutorAuth
  logger: Logger
  bus: Bus
  distiller: Distiller
  rtInstructions: string
  execPrompt: string
  audioSink: ReturnType<typeof createAudioSink>
  executablePath: string | undefined
}

/** Build a complete session quartet bound to `workspaceReal`. The caller is
 *  responsible for ensuring the dir exists and has been canonicalized +
 *  safety-validated already. */
function buildSession(deps: StackBuildDeps, workspaceReal: string): SessionStack {
  // Deferred-handler proxies, identical to the original bootstrap. The
  // realtime session and executor runner need an `onEvent` at construction
  // time, but the orchestrator needs them in its deps, so we bind the proxies
  // once the orchestrator exists. Nothing emits before `orchestrator.start()`,
  // so no event is lost.
  let realtimeHandler: (ev: RealtimeEvent) => void = () => {}
  let executorHandler: (ev: ExecutorEvent) => void = () => {}

  const realtime = new RealtimeSession({
    apiKey: deps.config.openaiApiKey,
    model: deps.config.realtime.model,
    voice: deps.config.realtime.voice,
    ...(deps.config.realtime.speed !== undefined ? { speed: deps.config.realtime.speed } : {}),
    ...(deps.config.realtime.reasoningEffort !== undefined
      ? { reasoningEffort: deps.config.realtime.reasoningEffort }
      : {}),
    instructions: deps.rtInstructions,
    logger: deps.logger,
    onEvent: (ev) => realtimeHandler(ev),
  })

  const injector = createQueuedInjector(realtime, deps.logger, {
    onSpoken: (text) => deps.bus.emit({ type: 'narration-spoken', text }),
  })

  const policy = defaultPermissionPolicy(workspaceReal)
  const executor = createExecutor({
    oauthToken: deps.auth.oauthToken,
    apiKey: deps.auth.apiKey,
    model: deps.config.executor.model,
    systemPrompt: deps.execPrompt,
    policy,
    executablePath: deps.executablePath,
    onEvent: (ev) => executorHandler(ev),
    logger: deps.logger,
  })

  const orchestrator = createOrchestrator({
    realtime,
    executor,
    injector,
    audioSink: deps.audioSink,
    distiller: deps.distiller,
    bus: deps.bus,
    logger: deps.logger,
  })
  realtimeHandler = orchestrator.onRealtimeEvent
  executorHandler = orchestrator.onExecutorEvent

  return { realtime, executor, orchestrator, workspaceReal }
}

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
  const initialWorkspaceReal = realpathSync(config.executor.workspace)
  assertWorkspaceSafe(initialWorkspaceReal)
  logger.info(
    { workspace: initialWorkspaceReal, configured: config.executor.workspace },
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

  // 5. Bus + memory distiller. Bus + distiller persist across a workspace
  //    swap (no workspace coupling).
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
  //    Lives across workspace swaps; webContents lifetime is the window's.
  const audioSink = createAudioSink()

  // 7. Resolve the native SDK binary path once. `undefined` in dev (SDK
  //    self-resolves); the unpacked-asar path in a packaged build.
  const executablePath = resolveSdkExecutable(app.isPackaged)
  if (app.isPackaged && !executablePath) {
    logger.warn(
      'kazoo: packaged build but SDK executable not found under app.asar.unpacked; ' +
        'deferring to SDK default resolution',
    )
  }

  // 8. First session stack — bound to the initial workspace. A
  //    `sessionRef`-style holder lets IPC + lifecycle indirect through the
  //    "current" stack so the workspace picker can swap it later without
  //    re-wiring anything.
  const buildDeps: StackBuildDeps = {
    config,
    auth,
    logger,
    bus,
    distiller,
    rtInstructions,
    execPrompt,
    audioSink,
    executablePath,
  }
  let session: SessionStack = buildSession(buildDeps, initialWorkspaceReal)
  let sessionInfo: SessionInfo = {
    cwd: session.workspaceReal,
    model: config.realtime.model,
  }

  // 9. App lifecycle — graceful shutdown reads the CURRENT session so a swap
  //    mid-call (impossible by the in-call guard, but still) tears down the
  //    right pair.
  installLifecycle({
    app,
    getOrchestrator: () => session.orchestrator,
    getExecutor: () => session.executor,
    logger,
  })

  // 10. Window + IPC.
  await app.whenReady()
  const { window }: { window: BrowserWindow } = createWindow()
  audioSink.setWebContents(window.webContents)

  // The workspace-swap handler. Hot-swaps the per-workspace quartet:
  //   - refuses if a call is live (anything other than idle/ended);
  //   - shows the dialog + safety-validates (workspace-picker.ts);
  //   - tears down the OLD orchestrator + executor;
  //   - builds a fresh stack at the new cwd;
  //   - re-emits SESSION_INFO so the StatusBar updates.
  // Returns a discriminated result; the renderer can surface cancel/unsafe
  // distinctly from "you have to hang up first".
  const handlePickWorkspace = async (): Promise<WorkspacePickResult> => {
    const state = session.orchestrator.state
    if (state !== 'idle' && state !== 'ended') {
      return {
        ok: false,
        reason: 'busy',
        message: `Hang up first — workspace can't be changed while the call is ${state}.`,
      }
    }

    const result = await pickWorkspace({ window, logger })
    if (!result.ok) return result

    if (result.cwd === session.workspaceReal) {
      // No-op selection (operator picked the same dir). Still emit
      // SESSION_INFO so the UI clears any "loading" affordance.
      window.webContents.send(CH.SESSION_INFO, sessionInfo)
      return result
    }

    logger.info(
      { from: session.workspaceReal, to: result.cwd },
      'kazoo: swapping executor workspace',
    )

    // Ensure the picked dir exists and is canonical for the executor. The
    // picker already realpath'd; mkdir is a defensive no-op (the dir
    // exists, since the picker selected it) that also makes the operation
    // resilient to the dir being deleted between pick and swap.
    try {
      mkdirSync(result.cwd, { recursive: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ cwd: result.cwd, err: message }, 'kazoo: workspace mkdir failed')
      return { ok: false, reason: 'error', message }
    }

    // Tear down old stack. Orchestrator may not have been started; .stop()
    // is safe in that case (it's idempotent on idle).
    const old = session
    try {
      await old.orchestrator.stop()
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'kazoo: old orchestrator.stop threw during swap',
      )
    }
    try {
      await old.executor.close()
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'kazoo: old executor.close threw during swap',
      )
    }

    // Build new stack + atomically replace.
    try {
      session = buildSession(buildDeps, result.cwd)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err: message }, 'kazoo: buildSession threw during swap')
      return { ok: false, reason: 'error', message }
    }
    sessionInfo = { cwd: result.cwd, model: config.realtime.model }
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(CH.SESSION_INFO, sessionInfo)
    }
    logger.info({ workspace: result.cwd }, 'kazoo: workspace swap complete')
    return result
  }

  const teardownIpc = wireIpc({
    webContents: window.webContents,
    getSession: () => ({
      realtime: session.realtime,
      orchestrator: session.orchestrator,
    }),
    bus,
    setMode: (msg) => {
      bus.emit({ type: 'narration-mode', mode: msg.mode })
    },
    getSessionInfo: () => sessionInfo,
    pickWorkspace: handlePickWorkspace,
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
