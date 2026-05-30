// Entry point. `bun run dev` runs this.
//
// Composes every module into a running loop and mounts Ink on top.
// Stays small — wiring only; no logic. The orchestrator (./orchestrator/
// loop.ts) owns the actual call.

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink'
import { createMic, createSpeaker, detectBackend } from './audio/index.ts'
import { loadConfig } from './config.ts'
import type { ExecutorEvent } from './executor/events.ts'
import { createExecutor } from './executor/runner.ts'
import { defaultPermissionPolicy } from './executor/tools.ts'
import { isKazooError, KazooError } from './lib/errors.ts'
import { createLogger } from './lib/logger.ts'
import { createDistiller } from './memory/distill.ts'
import { recall } from './memory/store.ts'
import { executorSystemPrompt, realtimeInstructions } from './narration/persona.ts'
import { createBus } from './orchestrator/bus.ts'
import { createOrchestrator } from './orchestrator/loop.ts'
import type { RealtimeEvent } from './realtime/events.ts'
import { createQueuedInjector } from './realtime/inject.ts'
import { RealtimeSession } from './realtime/session.ts'
import { App } from './tui/App.tsx'

/** Where the executor is allowed to read and edit. Scoped OUTSIDE Kazoo's
 *  own source tree so a hallucinated edit can't damage the codebase that
 *  runs the agent. Created on first run. */
const WORKSPACE_DIR = join(homedir(), 'kazoo-workspace')

async function main(): Promise<void> {
  // 1. Config — fail-fast on missing OPENAI_API_KEY (loadConfig throws),
  //    and explicitly on missing Claude auth (we do that here so the
  //    operator sees a clear message before the SDK fails opaquely).
  const config = loadConfig()
  if (!config.anthropic.oauthToken && !config.anthropic.apiKey) {
    throw new KazooError(
      'config/missing-env',
      'set CLAUDE_CODE_OAUTH_TOKEN (preferred — Claude subscription) ' +
        'OR ANTHROPIC_API_KEY (API key) so the executor can authenticate. ' +
        'See .env.example.',
    )
  }

  // 2. Logger first — Ink owns stdout, everything else goes to file.
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

  // 3. Workspace dir for the executor. Idempotent.
  mkdirSync(WORKSPACE_DIR, { recursive: true })
  logger.info({ workspace: WORKSPACE_DIR }, 'kazoo: executor workspace ready')

  // 4. Audio backend — preflight check so a missing toolchain fails before
  //    we open a Realtime connection.
  const audioBackend = detectBackend()
  logger.info({ backend: audioBackend.kind }, 'kazoo: audio backend detected')

  // 5. Recall memory + build personas.
  const memory = recall(
    { userMemory: config.memory.userMemoryPath, projectMemory: config.memory.projectMemoryPath },
    logger,
  )
  const personaPrefs = { voicePrefs: memory.voicePrefs, projectFacts: memory.projectFacts }
  const rtInstructions = realtimeInstructions(personaPrefs)
  const execPrompt = executorSystemPrompt(personaPrefs)

  // 6. Bus + memory distiller.
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

  // 7. Audio devices.
  const speaker = createSpeaker({ logger, backend: audioBackend })
  const mic = createMic({ logger, backend: audioBackend })

  // 8. Deferred-handler proxies. The orchestrator needs realtime + executor
  //    in its deps but those objects need an onEvent at construction time.
  //    We bind the proxies once the orchestrator exists. Events that fire
  //    before binding (none, in practice — nothing emits until we call
  //    start()) are silently dropped.
  let realtimeHandler: (ev: RealtimeEvent) => void = () => {}
  let executorHandler: (ev: ExecutorEvent) => void = () => {}

  // 9. Realtime — narrator. Note: persona instructions tell the model NOT
  //    to answer coding questions; it just acknowledges and waits for our
  //    injected narration phrases.
  const realtime = new RealtimeSession({
    apiKey: config.openaiApiKey,
    model: config.realtime.model,
    voice: config.realtime.voice,
    ...(config.realtime.speed !== undefined ? { speed: config.realtime.speed } : {}),
    instructions: rtInstructions,
    logger,
    onEvent: (ev) => realtimeHandler(ev),
  })

  const injector = createQueuedInjector(realtime, logger)

  // 10. Executor — brain. Sandboxed to WORKSPACE_DIR.
  const policy = defaultPermissionPolicy(WORKSPACE_DIR)
  const executor = createExecutor({
    oauthToken: config.anthropic.oauthToken,
    apiKey: config.anthropic.apiKey,
    model: config.executor.model,
    systemPrompt: execPrompt,
    policy,
    onEvent: (ev) => executorHandler(ev),
    logger,
  })

  // 11. Orchestrator — wire the two handler slots to it.
  const orchestrator = createOrchestrator({
    realtime,
    executor,
    injector,
    mic,
    speaker,
    distiller,
    bus,
    logger,
  })
  realtimeHandler = orchestrator.onRealtimeEvent
  executorHandler = orchestrator.onExecutorEvent

  // 12. Mount the TUI. Render starts immediately — banner first frame on
  //    screen before we even open the WS.
  const { waitUntilExit, unmount } = render(<App bus={bus} />)

  // 13. Start the orchestrator. Connects Realtime, kicks off the mic pump.
  try {
    await orchestrator.start()
  } catch (err) {
    unmount()
    throw err
  }

  // 14. Shutdown path. SIGINT/SIGTERM trigger graceful stop → wrap-up →
  //     teardown. The executor isn't owned by the orchestrator so we close
  //     it here.
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'kazoo: shutdown initiated')
    try {
      await orchestrator.stop()
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'kazoo: orchestrator.stop threw',
      )
    }
    try {
      await executor.close()
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'kazoo: executor.close threw',
      )
    }
    unmount()
  }
  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  await waitUntilExit()
  logger.info('kazoo: exit')
}

main().catch((err) => {
  // Ink may have taken stdout; write to stderr regardless. KazooError
  // messages are already operator-readable; raw errors get the "fatal" prefix.
  const msg = err instanceof Error ? err.message : String(err)
  if (isKazooError(err)) {
    process.stderr.write(`kazoo: ${msg}\n`)
  } else {
    process.stderr.write(`kazoo: fatal — ${msg}\n`)
  }
  process.exit(1)
})
