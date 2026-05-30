// Pino → ND-JSON file. Ink owns stdout (TUI render target); we cannot log
// to console without trashing the UI. Every module receives a logger via
// dependency injection so tests can swap in a no-op or in-memory recorder.
//
// Redaction (security-review): we deliberately log a lot at debug — bash
// commands the model wanted to run, tool inputs, narration text, mic
// stderr. Some of that can carry secrets if the model is tricked into
// echoing them, OR if a tool result happens to contain credentials. Pino
// `redact` masks the high-risk paths even in debug mode. Add to the list
// rather than removing — silence by default is the safer bias.

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import pino, { type Logger as PinoLogger } from 'pino'

export type Logger = PinoLogger

export type LoggerConfig = {
  /** File path for the ND-JSON log. Directory is created if missing. */
  file: string
  /** Pino level. Default 'info'. */
  level?: string
}

/** Paths in the log object tree to mask. Pino navigates `*.foo` as
 *  "any-key.foo" and `*.*.foo` two levels deep. Order matches the call
 *  sites that produce these fields. */
const REDACT_PATHS: readonly string[] = [
  // executor: the literal bash command + parsed parts
  '*.command',
  '*.input.command',
  // executor / narration: tool-result contents + assistant text we ferry around
  '*.content',
  '*.input.content',
  '*.text',
  '*.phrase',
  // mic / speaker subprocess stderr (may print device IDs etc — low risk
  // but cheap to mask)
  '*.stderr',
  // auth-shaped fields, defense-in-depth — we never log them directly,
  // but a future caller might
  '*.apiKey',
  '*.oauthToken',
  '*.token',
  '*.authorization',
  '*.Authorization',
  // header bags from the WS unexpected-response path
  '*.headers.authorization',
  '*.headers.Authorization',
]

/** Create the root logger. Call once in `cli.tsx`; pass `.child({ mod: '…' })`
 *  to each module so log lines self-identify. */
export function createLogger(cfg: LoggerConfig): Logger {
  const file = resolve(cfg.file)
  mkdirSync(dirname(file), { recursive: true })

  const dest = pino.destination({ dest: file, sync: false, mkdir: true, append: true })
  return pino(
    {
      level: cfg.level ?? 'info',
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [...REDACT_PATHS],
        censor: '[redacted]',
      },
    },
    dest,
  )
}

/** A logger that swallows everything — for tests and stub paths. */
export function nullLogger(): Logger {
  return pino({ level: 'silent' })
}
