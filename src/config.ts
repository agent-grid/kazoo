// Typed config loader. Reads from `process.env` (Bun loads `.env`
// automatically). Crashes fast on missing required keys so we never hit
// half-initialized state.

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { KazooError } from './lib/errors.ts'
import { resolveMemoryPaths } from './memory/store.ts'

export type Config = {
  openaiApiKey: string
  /** Executor auth — at least one is required to actually USE the executor,
   *  but we don't enforce that here. The executor PR resolves the
   *  either/or (preferring oauthToken over apiKey) and crashes if neither
   *  is present. Phase 0 / audio-loopback only needs `openaiApiKey`. */
  anthropic: {
    oauthToken: string | undefined
    apiKey: string | undefined
  }
  realtime: {
    model: string
    voice: string
    speed: number | undefined
  }
  executor: {
    model: string
    /** Absolute path the executor's cwd is pinned to. Defaults to
     *  `~/kazoo-workspace`; overridable via `KAZOO_WORKSPACE`. A leading
     *  `~` is expanded. The directory is created on first run by cli.tsx. */
    workspace: string
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
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined

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
    anthropic: { oauthToken, apiKey },
    realtime: {
      model: env.KAZOO_REALTIME_MODEL || 'gpt-realtime',
      voice: env.KAZOO_REALTIME_VOICE || 'alloy',
      speed,
    },
    executor: {
      model: env.KAZOO_EXECUTOR_MODEL || 'claude-sonnet-4-6',
      workspace: resolveWorkspacePath(env.KAZOO_WORKSPACE),
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

/** Resolve the executor workspace path. Default: `~/kazoo-workspace`.
 *  A leading `~` (alone or followed by `/`) is expanded to the home dir.
 *  Other paths are resolved against the current cwd. */
function resolveWorkspacePath(raw: string | undefined): string {
  const trimmed = raw?.trim()
  const candidate = trimmed && trimmed.length > 0 ? trimmed : '~/kazoo-workspace'
  const expanded =
    candidate === '~'
      ? homedir()
      : candidate.startsWith('~/')
        ? `${homedir()}/${candidate.slice(2)}`
        : candidate
  return resolve(expanded)
}
