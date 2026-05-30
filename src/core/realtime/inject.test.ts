// Tests for the queued narration injector — queue + flush() semantics
// (SURFACE_PLAN §B: "inject.ts queue/flush() semantics (the barge-in drop
// behavior)").
//
// We drive the injector with a FAKE RealtimeSession that records the phrases it
// is told to speak and lets the test control its `state` and `injectNarration`
// → `onResponseDone` cadence (the server only accepts one response at a time).

import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../lib/logger.ts'
import type { NarrationPhrase } from '../narration/translator.ts'
import { createQueuedInjector } from './inject.ts'
import type { RealtimeSession } from './session.ts'

// A no-op logger — the injector only calls `.debug`. Cast through unknown
// because we deliberately stub just the methods it touches.
function fakeLogger(): Logger {
  const noop = () => {}
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger
}

type FakeSession = {
  session: RealtimeSession
  spoken: string[]
  setState: (s: string) => void
}

function fakeSession(): FakeSession {
  const spoken: string[] = []
  const obj = {
    state: 'active' as string,
    injectNarration(text: string) {
      spoken.push(text)
    },
  }
  return {
    session: obj as unknown as RealtimeSession,
    spoken,
    setState: (s: string) => {
      obj.state = s
    },
  }
}

function high(text: string): NarrationPhrase {
  return { text, source: 'preamble', salience: 0.9 }
}
function low(text: string): NarrationPhrase {
  return { text, source: 'tool-summary', salience: 0.35 }
}

describe('queued injector — basic delivery', () => {
  it('speaks a single high-salience phrase immediately', () => {
    const f = fakeSession()
    const inj = createQueuedInjector(f.session, fakeLogger())
    inj.speak(high('Opening the auth module.'))
    expect(f.spoken).toEqual(['Opening the auth module.'])
    inj.close()
  })

  it('does not speak a second phrase until onResponseDone (one at a time)', () => {
    const f = fakeSession()
    const inj = createQueuedInjector(f.session, fakeLogger())
    inj.speak(high('First.'))
    inj.speak(high('Second.'))
    // Still injecting the first — the server only takes one response.
    expect(f.spoken).toEqual(['First.'])
    inj.onResponseDone()
    expect(f.spoken).toEqual(['First.', 'Second.'])
    inj.close()
  })

  it('does not speak while the session is not active', () => {
    const f = fakeSession()
    f.setState('connecting')
    const inj = createQueuedInjector(f.session, fakeLogger())
    inj.speak(high('Held back.'))
    expect(f.spoken).toEqual([])
    // Once active, a response-done nudge drains the queue.
    f.setState('active')
    inj.onResponseDone()
    expect(f.spoken).toEqual(['Held back.'])
    inj.close()
  })

  it('fires onSpoken AFTER a phrase actually goes out (not for dropped ones)', () => {
    const f = fakeSession()
    const onSpoken = vi.fn()
    const inj = createQueuedInjector(f.session, fakeLogger(), { onSpoken })
    inj.speak(high('Spoken once.'))
    expect(onSpoken).toHaveBeenCalledTimes(1)
    expect(onSpoken).toHaveBeenCalledWith('Spoken once.')
    inj.close()
  })
})

describe('queued injector — low-salience coalescing', () => {
  it('collapses a run of low-salience reads into a single summary', () => {
    const f = fakeSession()
    const inj = createQueuedInjector(f.session, fakeLogger())
    // First phrase injects immediately (becomes the in-flight one).
    inj.speak(low('Opening a.ts.'))
    expect(f.spoken).toEqual(['Opening a.ts.'])
    // Queue up a burst of low-salience reads behind it.
    inj.speak(low('Opening b.ts.'))
    inj.speak(low('Opening c.ts.'))
    inj.speak(low('Opening d.ts.'))
    // They wait (still injecting). On response-done the run coalesces to one.
    inj.onResponseDone()
    expect(f.spoken).toHaveLength(2)
    expect(f.spoken[1]).toBe('Reading through the project.')
    inj.close()
  })

  it('lets a high-salience phrase break out of a low-salience run, in order', () => {
    const f = fakeSession()
    const inj = createQueuedInjector(f.session, fakeLogger())
    inj.speak(high('Starting.')) // in-flight
    inj.speak(low('Opening a.ts.'))
    inj.speak(low('Opening b.ts.'))
    inj.speak(high('Editing config.ts.')) // must survive, not be coalesced away
    inj.onResponseDone() // -> coalesced summary of the two reads
    expect(f.spoken[1]).toBe('Reading through the project.')
    inj.onResponseDone() // -> the high-salience edit
    expect(f.spoken[2]).toBe('Editing config.ts.')
    inj.close()
  })
})

describe('queued injector — flush() (barge-in drop)', () => {
  it('drops everything queued and lets a fresh phrase through afterward', () => {
    const f = fakeSession()
    const inj = createQueuedInjector(f.session, fakeLogger())
    inj.speak(high('In flight.'))
    inj.speak(high('Queued 1.'))
    inj.speak(high('Queued 2.'))
    expect(f.spoken).toEqual(['In flight.'])

    // Barge-in: drop the queue AND clear the injecting gate.
    inj.flush()

    // The queued items are gone — a response-done must NOT replay them.
    inj.onResponseDone()
    expect(f.spoken).toEqual(['In flight.'])

    // A brand-new phrase after the flush speaks immediately (gate was cleared).
    inj.speak(high('After barge-in.'))
    expect(f.spoken).toEqual(['In flight.', 'After barge-in.'])
    inj.close()
  })

  it('flush on an empty queue is a no-op but still clears the injecting gate', () => {
    const f = fakeSession()
    const inj = createQueuedInjector(f.session, fakeLogger())
    inj.speak(high('One.')) // sets injecting = true
    inj.flush() // clears injecting even though queue was empty
    inj.speak(high('Two.')) // should go straight out, not wait
    expect(f.spoken).toEqual(['One.', 'Two.'])
    inj.close()
  })
})

describe('queued injector — close()', () => {
  it('stops accepting phrases after close', () => {
    const f = fakeSession()
    const inj = createQueuedInjector(f.session, fakeLogger())
    inj.close()
    inj.speak(high('Too late.'))
    expect(f.spoken).toEqual([])
  })

  it('ignores empty/whitespace phrases', () => {
    const f = fakeSession()
    const inj = createQueuedInjector(f.session, fakeLogger())
    inj.speak(high('   '))
    expect(f.spoken).toEqual([])
    inj.close()
  })
})
