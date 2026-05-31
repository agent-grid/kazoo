// Typed config loader. Reads from `process.env` (Bun loads `.env`
// automatically). Crashes fast on missing required keys so we never hit
// half-initialized state.

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { KazooError } from './lib/errors.ts'
import { resolveMemoryPaths } from './memory/store.ts'

/** Per-session reasoning effort knob introduced by `gpt-realtime-2` (GA
 *  2026-05). Mirrors the Responses-API effort scale. The wire field name is
 *  `reasoning_effort` and lives directly on the `session` object in
 *  `session.update` (see `src/core/realtime/session.ts`). When unset we OMIT
 *  the field — backward-safe for any realtime model that doesn't accept it. */
export const REALTIME_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'very-high',
] as const
export type RealtimeReasoningEffort = (typeof REALTIME_REASONING_EFFORTS)[number]

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
    /** OpenAI `gpt-realtime-2` (GA 2026-05) added per-session reasoning effort.
     *  Valid: minimal | low | medium | high | very-high. `undefined` means
     *  "don't send the field" — keeps the wire payload backward-safe for any
     *  realtime model that doesn't accept it. */
    reasoningEffort: RealtimeReasoningEffort | undefined
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

  // `gpt-realtime-2` added a `reasoning_effort` knob. Default to `low` so the
  // narrator stays snappy out of the box; set explicitly to opt into deeper
  // (slower) reasoning. We accept the value even on the older `gpt-realtime`
  // model — the realtime session simply omits it from the wire payload when
  // the field is `undefined`, so misconfiguring the model name won't crash;
  // it just means the operator's effort knob is ignored.
  const effortRaw = env.KAZOO_REALTIME_REASONING_EFFORT?.trim()
  const reasoningEffort = parseReasoningEffort(effortRaw)

  const memory = resolveMemoryPaths({
    userMemoryPath: env.KAZOO_USER_MEMORY_PATH,
    projectMemoryPath: env.KAZOO_PROJECT_MEMORY_PATH,
  })

  return {
    openaiApiKey,
    anthropic: { oauthToken, apiKey },
    realtime: {
      // `gpt-realtime-2` is OpenAI's GA speech-to-speech model (released
      // 2026-05). It supersedes `gpt-realtime` and adds per-session
      // `reasoning_effort`. Operators on the older model can pin via
      // `KAZOO_REALTIME_MODEL=gpt-realtime`.
      model: env.KAZOO_REALTIME_MODEL || 'gpt-realtime-2',
      voice: env.KAZOO_REALTIME_VOICE || 'alloy',
      speed,
      reasoningEffort,
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
      // Default lives under ~/.kazoo so an `rm -rf .` in a workspace clone
      // can't blow away the operator's debug history, and we don't
      // accidentally check log files into a git repo. Override with
      // KAZOO_LOG_FILE to put it anywhere (e.g. ./.kazoo/log.ndjson during
      // development).
      file: expandTilde(env.KAZOO_LOG_FILE?.trim() || '~/.kazoo/log.ndjson'),
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

/** Parse + validate `KAZOO_REALTIME_REASONING_EFFORT`. Empty/unset → `low`
 *  (the snappy default for the narrator persona). An unrecognized value is a
 *  fail-fast `KazooError` rather than a silent fallback so a typo can't get
 *  shipped to OpenAI and rejected at session.update time. */
function parseReasoningEffort(raw: string | undefined): RealtimeReasoningEffort | undefined {
  if (raw === undefined || raw === '') return 'low'
  const lower = raw.toLowerCase() as RealtimeReasoningEffort
  if ((REALTIME_REASONING_EFFORTS as readonly string[]).includes(lower)) return lower
  throw new KazooError(
    'config/missing-env',
    `KAZOO_REALTIME_REASONING_EFFORT must be one of ${REALTIME_REASONING_EFFORTS.join(' | ')}; got "${raw}"`,
  )
}

/** Resolve the executor workspace path. Default: `~/kazoo-workspace`.
 *  A leading `~` (alone or followed by `/`) is expanded to the home dir.
 *  Other paths are resolved against the current cwd. */
function resolveWorkspacePath(raw: string | undefined): string {
  const trimmed = raw?.trim()
  const candidate = trimmed && trimmed.length > 0 ? trimmed : '~/kazoo-workspace'
  return resolve(expandTilde(candidate))
}

/** Expand a leading `~` or `~/` against the user's home dir. Other paths
 *  are returned unchanged. */
function expandTilde(candidate: string): string {
  if (candidate === '~') return homedir()
  if (candidate.startsWith('~/')) return `${homedir()}/${candidate.slice(2)}`
  return candidate
}
