// Markdown memory store. Two files, two scopes:
//
//   ~/.kazoo/voice-memory.md   — per-user voice/narration preferences
//                                (e.g. "be terse", "don't read paths aloud").
//                                Survives across project clones.
//
//   ./KAZOO.md                 — repo-local project facts (parallel to
//                                CLAUDE.md). Recalled into the executor's
//                                system prompt.
//
// Both are appended-on-wrap-up, recalled-on-connect. Zero training infra —
// just markdown the agent owns.
//
// STATUS: interface + a thin synchronous read scaffold. Distill+append lands
// in distill.ts; the orchestrator calls it on hangup.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Logger } from '../lib/logger.ts'

export type MemoryPaths = {
  userMemory: string
  projectMemory: string
}

export function resolveMemoryPaths(env: {
  userMemoryPath?: string | undefined
  projectMemoryPath?: string | undefined
}): MemoryPaths {
  return {
    userMemory: env.userMemoryPath
      ? resolve(env.userMemoryPath)
      : join(homedir(), '.kazoo', 'voice-memory.md'),
    projectMemory: resolve(env.projectMemoryPath ?? './KAZOO.md'),
  }
}

export type RecalledMemory = {
  /** Voice / narration preferences (free-form markdown). */
  voicePrefs: string
  /** Project facts (free-form markdown). */
  projectFacts: string
}

/** Synchronously load both memory files. Missing files are NOT an error —
 *  this is a brand-new install path. Returns empty strings instead. */
export function recall(paths: MemoryPaths, logger: Logger): RecalledMemory {
  const voicePrefs = safeRead(paths.userMemory, logger)
  const projectFacts = safeRead(paths.projectMemory, logger)
  return { voicePrefs, projectFacts }
}

function safeRead(path: string, logger: Logger): string {
  // No `existsSync` first — that's TOCTOU and the catch handles ENOENT
  // anyway. ENOENT for a missing memory file is expected on a fresh install
  // and we silently treat it as empty; any other error we log + degrade.
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    if (isMissingFileError(err)) return ''
    logger.warn({ path, err: String(err) }, 'memory: read failed; treating as empty')
    return ''
  }
}

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}
