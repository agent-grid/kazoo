// Pino → ND-JSON file. Ink owns stdout (TUI render target); we cannot log
// to console without trashing the UI. Every module receives a logger via
// dependency injection so tests can swap in a no-op or in-memory recorder.

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
    },
    dest,
  )
}

/** A logger that swallows everything — for tests and stub paths. */
export function nullLogger(): Logger {
  return pino({ level: 'silent' })
}
