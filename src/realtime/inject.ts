// Narration scheduler + Realtime injector.
//
// Sits between the translator (which produces `NarrationPhrase`s from
// executor events) and `RealtimeSession.injectNarration` (which speaks
// one phrase). Two responsibilities:
//
//   1. PACING. Realtime can only speak one phrase at a time (~2–3 s each).
//      The executor bursts events much faster — a "what's the project"
//      question can fire 20+ Reads in seconds. Naive FIFO would build a
//      backlog the user listens to long after the agent is done.
//
//      Policy:
//        - HIGH-SALIENCE phrases (preambles / edits / bash / errors / done)
//          go through in order, promptly. They're the substance.
//        - A run of LOW-SALIENCE phrases (Read/Grep/Glob/etc) at the queue
//          head gets COLLAPSED into a single accurate summary line —
//          e.g. "Reading through the project." — and the rest of the run
//          is dropped. We DON'T silently swallow exploration; we narrate
//          it as a summary so the voice tracks the present, not a
//          minute-old backlog.
//        - Consecutive identical coalesced summaries are dedup'd, so we
//          don't say "Reading the project" five times in a row.
//
//   2. HEARTBEAT. While the executor is `working` and the queue is empty
//      and Realtime isn't speaking, if no narration has fired in ~5 s we
//      emit a brief "still on it" line so the voice never goes dead during
//      a long bash/build/test. One heartbeat per quiet period; cycles
//      through variants so it doesn't repeat verbatim.
//
// Barge-in: `flush()` drops the queue and clears the busy flag.
// Realtime's server-VAD (`interrupt_response: true`) already cancelled
// whatever was playing.

import type { Logger } from '../lib/logger.ts'
import type { NarrationPhrase } from '../narration/translator.ts'
import type { RealtimeSession } from './session.ts'

export type NarrationInjector = {
  /** Enqueue a phrase. Scheduler decides when/how to actually speak. */
  speak: (phrase: NarrationPhrase) => void
  /** Drop everything queued — barge-in / new turn. */
  flush: () => void
  /** Called by the orchestrator on each realtime `response-done`. */
  onResponseDone: () => void
  /** Toggle the "executor is working" gate. Heartbeat only fires while
   *  this is true (and resets when toggled off). */
  setWorking: (working: boolean) => void
  /** Tear down the heartbeat timer. */
  close: () => void
}

/** Threshold separating "promptly through, in order" from "coalesce-eligible".
 *  Salience table (see narration/translator.ts):
 *    preamble       0.9     high
 *    edit/write     0.8     high
 *    task/agent     0.85    high
 *    bash           0.7     high
 *    tool-error     0.95    high
 *    turn-done      1.0     high
 *    read/grep/glob 0.35    low — coalesces
 *    default tool   0.5     low — coalesces
 */
const HIGH_SALIENCE_THRESHOLD = 0.6

/** Quiet-period before the heartbeat ("still working…") fires. */
const HEARTBEAT_MS = 5000

/** How often we poll for the heartbeat condition. Doesn't have to be tight. */
const HEARTBEAT_POLL_MS = 1500

const HEARTBEAT_PHRASES: readonly string[] = [
  'Still working on it…',
  'Still on it — hang tight.',
  'Still chewing through this…',
]

export function createQueuedInjector(session: RealtimeSession, logger: Logger): NarrationInjector {
  const queue: NarrationPhrase[] = []
  // Set true between the moment we call session.injectNarration() and the
  // matching `response-done` event. Server rejects overlapping responses.
  let injecting = false
  let working = false
  let closed = false
  let lastSpokenAt = Date.now()
  // For "don't say the same coalesced summary back-to-back".
  let lastSpokenText = ''
  // Marker so a single quiet period only emits one heartbeat. Reset on any
  // non-heartbeat phrase being spoken (because lastSpokenAt advances).
  let lastHeartbeatAt = 0
  let heartbeatIndex = 0

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  function tryNext(): void {
    if (closed || injecting) return
    if (session.state !== 'active') return
    const next = selectNext()
    if (!next) return
    // Dedupe identical-to-last-spoken (catches consecutive coalesces).
    if (next.text === lastSpokenText && next.source === 'tool-summary') {
      logger.debug({ text: next.text }, 'injector: suppressing duplicate coalesced phrase')
      // Try again — there may be more behind it (though in practice the
      // coalesce just consumed the whole low-salience run).
      tryNext()
      return
    }
    injecting = true
    lastSpokenAt = Date.now()
    lastSpokenText = next.text
    logger.debug(
      { phrase: next.text.slice(0, 120), src: next.source, q: queue.length },
      'injector: speak',
    )
    session.injectNarration(next.text)
  }

  // Pull the next phrase the scheduler should actually speak.
  //   - Head high-salience → deliver in order.
  //   - Head low-salience  → collapse the whole low-salience run into one
  //     summary line, drop the rest of the run, return the summary.
  function selectNext(): NarrationPhrase | null {
    if (queue.length === 0) return null
    const head = queue[0]
    if (!head) return null
    if (isHigh(head)) {
      queue.shift()
      return head
    }
    // Low-salience run from index 0 up to (but not including) first high.
    let i = 0
    while (i < queue.length) {
      const p = queue[i]
      if (!p || isHigh(p)) break
      i++
    }
    const run = queue.splice(0, i)
    if (run.length === 0) return null
    if (run.length === 1 && run[0]) return run[0]
    const coalesced = coalesceRun(run)
    logger.debug(
      {
        collapsed: run.length,
        kinds: run.map((p) => p.source),
        out: coalesced.text,
      },
      'injector: coalesced low-salience run',
    )
    return coalesced
  }

  function maybeHeartbeat(): void {
    if (closed || !working || injecting) return
    if (queue.length > 0) return
    const now = Date.now()
    if (now - lastSpokenAt < HEARTBEAT_MS) return
    if (lastHeartbeatAt > lastSpokenAt) return // already heartbeated this quiet period
    const text = HEARTBEAT_PHRASES[heartbeatIndex % HEARTBEAT_PHRASES.length]
    if (!text) return
    heartbeatIndex++
    lastHeartbeatAt = now
    queue.push({ text, source: 'progress', salience: 0.55 })
    tryNext()
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(maybeHeartbeat, HEARTBEAT_POLL_MS)
    heartbeatTimer.unref?.()
  }
  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  return {
    speak(phrase: NarrationPhrase): void {
      if (closed) return
      if (!phrase.text.trim()) return
      queue.push(phrase)
      tryNext()
    },
    flush(): void {
      if (queue.length > 0) {
        logger.debug({ dropped: queue.length }, 'injector: flushed queue')
        queue.length = 0
      }
      injecting = false
      lastSpokenText = ''
      // Don't reset lastSpokenAt — heartbeat gating off lastHeartbeatAt
      // vs lastSpokenAt is still correct.
    },
    onResponseDone(): void {
      injecting = false
      tryNext()
    },
    setWorking(next: boolean): void {
      if (working === next) return
      working = next
      if (next) {
        lastSpokenAt = Date.now()
        lastHeartbeatAt = 0
        heartbeatIndex = 0
        startHeartbeat()
      } else {
        stopHeartbeat()
      }
    },
    close(): void {
      closed = true
      stopHeartbeat()
      queue.length = 0
    },
  }
}

/** Classification used by both the threshold check and the "preambles always
 *  win" rule. Preambles + errors + completion milestones always go through
 *  in order regardless of salience score. */
function isHigh(p: NarrationPhrase): boolean {
  if (p.source === 'preamble') return true
  if (p.source === 'error') return true
  if (p.salience >= HIGH_SALIENCE_THRESHOLD) return true
  return false
}

/** Pick a single summary phrase for a run of low-salience tool actions.
 *  Crude classifier on the phrase text — translator already shaped the
 *  per-tool descriptions to be recognizable. */
function coalesceRun(run: readonly NarrationPhrase[]): NarrationPhrase {
  let reads = 0
  let greps = 0
  let globs = 0
  let other = 0
  for (const p of run) {
    const t = p.text.toLowerCase()
    if (t.startsWith('opening ') || t.startsWith('reading ')) reads++
    else if (t.startsWith('searching ')) greps++
    else if (t.startsWith('looking for ') || t.startsWith('listing ')) globs++
    else other++
  }
  let text: string
  if (reads > 0 && greps === 0 && globs === 0 && other === 0) {
    text = 'Reading through the project.'
  } else if (greps > 0 && reads === 0 && globs === 0 && other === 0) {
    text = 'Searching the code.'
  } else if (globs > 0 && reads === 0 && greps === 0 && other === 0) {
    text = 'Looking through the project files.'
  } else if (reads + greps + globs > 0 && other === 0) {
    text = 'Looking around the project.'
  } else {
    text = 'Working through some things.'
  }
  return { text, source: 'tool-summary', salience: 0.55 }
}

/** Naive passthrough — kept for tests / non-queueing callers. Not used by
 *  cli.tsx after the scheduler landed. */
export function createPassthroughInjector(session: RealtimeSession): NarrationInjector {
  return {
    speak(phrase) {
      if (!phrase.text) return
      session.injectNarration(phrase.text)
    },
    flush() {
      /* no queue */
    },
    onResponseDone() {
      /* no queue */
    },
    setWorking() {
      /* no heartbeat */
    },
    close() {
      /* nothing */
    },
  }
}
