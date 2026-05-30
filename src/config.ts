// Typed config loader. Reads from `process.env` (Bun loads `.env`
// automatically). Crashes fast on missing required keys so we never hit
// half-initialized state.

import { KazooError } from './lib/errors.ts'
import { resolveMemoryPaths } from './memory/store.ts'

export type Config = {
  openaiApiKey: string
  anthropicApiKey: string
  realtime: {
    model: string
    voice: string
    speed: number | undefined
  }
  executor: {
    model: string
  }
  memory: {
    userMemoryPath: string
    projectMemoryPath: string
  }
  log: {
    file: string
    level: string
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const openaiApiKey = required(env, 'OPENAI_API_KEY')
  const anthropicApiKey = required(env, 'ANTHROPIC_API_KEY')

  const speedRaw = env.KAZOO_REALTIME_SPEED?.trim()
  const speed = speedRaw ? Number(speedRaw) : undefined
  if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.25 || speed > 1.5)) {
    throw new KazooError(
      'config/missing-env',
      `KAZOO_REALTIME_SPEED must be in [0.25, 1.5], got "${speedRaw}"`,
    )
  }

  const memory = resolveMemoryPaths({
    userMemoryPath: env.KAZOO_USER_MEMORY_PATH,
    projectMemoryPath: env.KAZOO_PROJECT_MEMORY_PATH,
  })

  return {
    openaiApiKey,
    anthropicApiKey,
    realtime: {
      model: env.KAZOO_REALTIME_MODEL || 'gpt-realtime',
      voice: env.KAZOO_REALTIME_VOICE || 'alloy',
      speed,
    },
    executor: {
      model: env.KAZOO_EXECUTOR_MODEL || 'claude-sonnet-4-6',
    },
    memory: {
      userMemoryPath: memory.userMemory,
      projectMemoryPath: memory.projectMemory,
    },
    log: {
      file: env.KAZOO_LOG_FILE || './.kazoo/log.ndjson',
      level: env.KAZOO_LOG_LEVEL || 'info',
    },
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]
  if (!v) {
    throw new KazooError('config/missing-env', `Missing required env var ${key}`)
  }
  return v
}
