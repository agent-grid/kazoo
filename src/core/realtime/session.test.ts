// session.test.ts — locks the on-wire shape of `session.update`.
//
// Why: the `reasoning_effort` knob added with `gpt-realtime-2` ships NESTED
// (`reasoning: { effort }`) — a flat top-level `reasoning_effort` is silently
// dropped by the server. A previous build had it flat, and `tsc -b` and
// `vitest` were both green because the bug lives entirely in the JSON payload.
// This test exercises the payload directly so a regression to the flat shape
// (or any other shape drift) fails CI.
//
// We mock the `ws` module with a fake WebSocket that captures every `send()`
// call, then construct the session and trip `connect()` long enough to fire
// the initial `session.update`.

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../lib/logger.ts'

/** Captured `send()` calls across the suite — appended to by the fake's
 *  `send` impl. Reset in `beforeEach`. */
const sent: string[] = []

class FakeWebSocket extends EventEmitter {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  readyState = FakeWebSocket.OPEN
  constructor(_url: string, _opts?: unknown) {
    super()
    // Defer the 'open' emit one microtask so the connect() promise has time
    // to attach its handlers (mirrors the real ws.WebSocket cadence).
    queueMicrotask(() => this.emit('open'))
  }
  send(payload: string): void {
    sent.push(payload)
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', 1000, Buffer.from(''))
  }
  override off(event: string, listener: (...args: unknown[]) => void): this {
    return this.removeListener(event, listener)
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }))

function fakeLogger(): Logger {
  const noop = (): void => {}
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => fakeLogger() } as unknown as Logger
}

/** Pull the first parsed `session.update` payload out of the captured sends. */
function firstSessionUpdate(): Record<string, unknown> {
  for (const raw of sent) {
    const msg = JSON.parse(raw) as { type?: string; session?: Record<string, unknown> }
    if (msg.type === 'session.update' && msg.session) return msg.session
  }
  throw new Error('no session.update captured')
}

describe('RealtimeSession.session.update payload — reasoning_effort wire shape', () => {
  beforeEach(() => {
    sent.length = 0
  })
  afterEach(() => {
    sent.length = 0
  })

  it('nests reasoning effort as `reasoning.effort` (NOT a flat `reasoning_effort`)', async () => {
    const { RealtimeSession } = await import('./session.ts')
    const session = new RealtimeSession({
      apiKey: 'sk-test',
      instructions: 'be brief',
      reasoningEffort: 'high',
      onEvent: () => {},
      logger: fakeLogger(),
      suppressOpeningResponse: true,
    })
    await session.connect()
    const s = firstSessionUpdate()

    // The PRIMARY assertion — the shape OpenAI actually accepts.
    expect(s).toMatchObject({ reasoning: { effort: 'high' } })
    // Guard against the regressed flat shape sneaking back in.
    expect(s).not.toHaveProperty('reasoning_effort')

    session.close()
  })

  it('omits the `reasoning` object entirely when reasoningEffort is undefined', async () => {
    const { RealtimeSession } = await import('./session.ts')
    const session = new RealtimeSession({
      apiKey: 'sk-test',
      instructions: 'be brief',
      onEvent: () => {},
      logger: fakeLogger(),
      suppressOpeningResponse: true,
    })
    await session.connect()
    const s = firstSessionUpdate()

    // Backward-safe for `gpt-realtime` (the previous default) and any future
    // model that doesn't accept the knob.
    expect(s).not.toHaveProperty('reasoning')
    expect(s).not.toHaveProperty('reasoning_effort')

    session.close()
  })

  it('emits the documented top tier as `xhigh` on the wire', async () => {
    const { RealtimeSession } = await import('./session.ts')
    const session = new RealtimeSession({
      apiKey: 'sk-test',
      instructions: 'be brief',
      reasoningEffort: 'xhigh',
      onEvent: () => {},
      logger: fakeLogger(),
      suppressOpeningResponse: true,
    })
    await session.connect()
    const s = firstSessionUpdate()
    expect(s).toMatchObject({ reasoning: { effort: 'xhigh' } })
    session.close()
  })
})
