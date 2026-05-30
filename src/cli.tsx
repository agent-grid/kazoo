// Entry point. `bun run dev` runs this.
//
// Wires every module into the orchestrator, mounts Ink, then waits for SIGINT.
// Stays small — composition only; no logic.
//
// Currently exits with a friendly message until the audio + executor modules
// land (this PR is scaffold). The composition shape below is the contract
// the next PR fills in.

import { render } from 'ink'
import { loadConfig } from './config.ts'
import { createLogger } from './lib/logger.ts'
import { recall } from './memory/store.ts'
import { executorSystemPrompt, realtimeInstructions } from './narration/persona.ts'
import { createBus } from './orchestrator/bus.ts'
import { App } from './tui/App.tsx'

async function main(): Promise<void> {
  const config = loadConfig()
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

  const memory = recall(
    { userMemory: config.memory.userMemoryPath, projectMemory: config.memory.projectMemoryPath },
    logger,
  )
  const persona = { voicePrefs: memory.voicePrefs, projectFacts: memory.projectFacts }

  // These two will feed into RealtimeSession + the executor system prompt
  // once those wires are connected in the next PR.
  const _rtInstructions = realtimeInstructions(persona)
  const _execPrompt = executorSystemPrompt(persona)

  const bus = createBus({
    onListenerError(err, ev) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), ev: ev.type },
        'bus: listener threw',
      )
    },
  })

  // TODO(next PR): construct audio (mic + speaker), realtime, executor,
  // injector, distiller, orchestrator — then `await orchestrator.start()`.
  // For the scaffold we mount the TUI shell so `bun run dev` produces a
  // visible result, and exit cleanly on Ctrl-C.

  const { waitUntilExit, unmount } = render(<App bus={bus} />)

  const onSigint = (): void => {
    logger.info('kazoo: SIGINT received, shutting down')
    unmount()
  }
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigint)

  await waitUntilExit()
  logger.info('kazoo: exit')
}

main().catch((err) => {
  // Ink may have taken stdout; write to stderr regardless.
  process.stderr.write(`kazoo: fatal — ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
