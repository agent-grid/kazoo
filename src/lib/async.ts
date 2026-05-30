// Small async utilities used by orchestrator + audio modules.

/** A promise + its resolver, for hand-rolled async coordination. */
export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Cancellable sleep — resolves on timeout, rejects on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Minimal async queue. UNBOUNDED — `push()` always enqueues, never
 *  blocks. Don't use this where producers can outpace consumers without
 *  back-pressure for long stretches (e.g. ingesting megabyte-sized tool
 *  outputs into narration). For the call paths it serves today —
 *  mic frames (20 ms; consumer always ready), executor SDK messages
 *  (SDK paces itself), executor user-message stream (push from voice
 *  turns, ~1/s peak) — bounded growth is in practice driven by the SDK.
 *
 *  TODO(perf): add an optional `maxSize` + drop-oldest / await-room
 *  policy if a real back-pressure case shows up. Don't add it
 *  speculatively — the right behavior is call-site-dependent. */
export class AsyncQueue<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: item, done: false })
      return
    }
    this.items.push(item)
  }

  close(): void {
    this.closed = true
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()
      w?.({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Check by length, NOT by `value !== undefined` — `T` may legitimately
        // carry undefined (e.g. an Int16Array end-marker pattern) and we
        // mustn't treat a real queued item as an empty queue.
        if (this.items.length > 0) {
          const item = this.items.shift() as T
          return Promise.resolve({ value: item, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}
