// Tagged error types. Lets callers `switch (err.tag)` instead of regexing
// messages. Add new variants here rather than throwing bare `Error`.

export type ErrorTag =
  | 'config/missing-env'
  | 'realtime/connect-failed'
  | 'realtime/protocol'
  | 'audio/device'
  | 'audio/format'
  | 'executor/sdk'
  | 'memory/io'

export class KazooError extends Error {
  readonly tag: ErrorTag
  override readonly cause?: unknown
  override readonly name = 'KazooError'

  constructor(tag: ErrorTag, message: string, cause?: unknown) {
    super(message)
    this.tag = tag
    if (cause !== undefined) this.cause = cause
  }
}

export function isKazooError(x: unknown): x is KazooError {
  return x instanceof KazooError
}
