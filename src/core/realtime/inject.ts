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
//      a long bash/build/test. EXACTLY one heartbeat per quiet period —
//      heartbeats are tagged distinctly and do NOT advance the
//      `lastSpokenAt` clock the gate uses; otherwise a fired heartbeat
//      would re-arm itself 5 s later and we'd loop forever.
//
// Barge-in: `flush()` drops the queue and clears the busy flag.
// Realtime's server-VAD (`interrupt_response: true`) already cancelled
// whatever was playing.

import type { Logger } from '../lib/logger.ts'
import type { NarrationPhrase } from '../narration/translator.ts'
import type { RealtimeSession } from './session.ts'

export type NarrationInjectorOptions = {
  /** Fires AFTER `session.injectNarration(text)` actually runs for a
   *  phrase that won pacing/dedup. The bus's `narration-spoken` event
   *  uses this — emitting from inside the orchestrator's translator
   *  loop would fire for phrases that got coalesced/dropped. */
  onSpoken?: (text: string) => void
}

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
/** Identity check: a phrase is one of OURS (a heartbeat we generated)
 *  iff its text appears here AND source === 'progress'. Used to decide
 *  whether to bump `lastSpokenAt` (heartbeats don't) and to reset the
 *  one-per-quiet-period gate. */
const HEARTBEAT_SET: ReadonlySet<string> = new Set(HEARTBEAT_PHRASES)
function isHeartbeatPhrase(p: NarrationPhrase): boolean {
  return p.source === 'progress' && HEARTBEAT_SET.has(p.text)
}

export function createQueuedInjector(
  session: RealtimeSession,
  logger: Logger,
  opts: NarrationInjectorOptions = {},
): NarrationInjector {
  const queue: NarrationPhrase[] = []
  // Set true between the moment we call session.injectNarration() and the
  // matching `response-done` event. Server rejects overlapping responses.
  let injecting = false
  let working = false
  let closed = false
  // Wall-clock of the last NON-HEARTBEAT phrase that was actually spoken.
  // Heartbeats do not advance this — otherwise a heartbeat fire would
  // restart the 5-second window from itself and we'd heartbeat every 5 s
  // forever (the old bug: B1).
  let lastSpokenAt = Date.now()
  // True between when we enqueue a heartbeat and when a real phrase next
  // gets through. Ensures at most one heartbeat per quiet period.
  let heartbeatFiredInQuietPeriod = false
  let heartbeatIndex = 0
  // Dedup the same coalesced summary back-to-back.
  let lastSpokenText = ''

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  function tryNext(): void {
    if (closed || injecting) return
    if (session.state !== 'active') return
    const next = selectNext()
    if (!next) return
    // Dedupe identical-to-last-spoken (catches consecutive coalesces).
    if (next.text === lastSpokenText && next.source === 'tool-summary') {
      logger.debug({ text: next.text }, 'injector: suppressing duplicate coalesced phrase')
      tryNext()
      return
    }
    injecting = true
    const wasHeartbeat = isHeartbeatPhrase(next)
    if (!wasHeartbeat) {
      // Any REAL phrase resets the quiet period: bump lastSpokenAt so
      // the next heartbeat must wait another HEARTBEAT_MS, and clear
      // the once-per-period gate so the next quiet period can fire.
      lastSpokenAt = Date.now()
      heartbeatFiredInQuietPeriod = false
    }
    lastSpokenText = next.text
    logger.debug(
      {
        phrase: next.text.slice(0, 120),
        src: next.source,
        q: queue.length,
        heartbeat: wasHeartbeat,
      },
      'injector: speak',
    )
    session.injectNarration(next.text)
    // Notify orchestrator (bus) AFTER the injection actually fired — fixes
    // C2 (was previously emitted per-phrase from the translator loop,
    // including phrases that got coalesced/dropped).
    opts.onSpoken?.(next.text)
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
    if (heartbeatFiredInQuietPeriod) return
    if (Date.now() - lastSpokenAt < HEARTBEAT_MS) return
    const text = HEARTBEAT_PHRASES[heartbeatIndex % HEARTBEAT_PHRASES.length]
    if (!text) return
    heartbeatIndex++
    heartbeatFiredInQuietPeriod = true
    // Salience 0.7 (above the high-salience threshold) so the scheduler
    // delivers it without trying to coalesce it with anything that
    // might race in alongside. Marked `progress` source for the bus.
    queue.push({ text, source: 'progress', salience: 0.7 })
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
      // After barge-in: fresh quiet period; heartbeat can fire again.
      heartbeatFiredInQuietPeriod = false
      lastSpokenAt = Date.now()
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
        heartbeatFiredInQuietPeriod = false
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
 *
 *  Strategy: switch on the structured `kind` tag the translator attaches to
 *  each phrase (read/search/list/shell/edit/other). If every phrase in the
 *  run shares one kind we use that kind's specific summary; a mix of
 *  exploration kinds (read + search + list + read-only shell) merges into
 *  a single natural line. We fall back on the human text only for legacy
 *  phrases that arrived without a `kind`. */
function coalesceRun(run: readonly NarrationPhrase[]): NarrationPhrase {
  const counts: Record<NarrationKindLocal, number> = {
    read: 0,
    search: 0,
    list: 0,
    shell: 0,
    edit: 0,
    other: 0,
  }
  for (const p of run) {
    const k = inferKind(p)
    counts[k]++
  }
  const text = pickSummary(counts)
  return { text, source: 'tool-summary', salience: 0.55, kind: 'other' }
}

type NarrationKindLocal = NonNullable<NarrationPhrase['kind']>

/** Map a phrase to its kind. If `kind` is set we trust it; otherwise we
 *  fall back to the same string-prefix heuristic the previous coalescer
 *  used so legacy callers don't regress. */
function inferKind(p: NarrationPhrase): NarrationKindLocal {
  if (p.kind) return p.kind
  const t = p.text.toLowerCase()
  if (t.startsWith('opening ') || t.startsWith('reading ')) return 'read'
  if (t.startsWith('searching ')) return 'search'
  if (t.startsWith('looking for ') || t.startsWith('listing ')) return 'list'
  if (t.startsWith('editing ') || t.startsWith('writing ')) return 'edit'
  if (t.startsWith('running ')) return 'shell'
  return 'other'
}

function pickSummary(counts: Record<NarrationKindLocal, number>): string {
  const { read, search, list, shell, edit, other } = counts
  const exploration = read + search + list + shell
  // Pure single-kind runs: use the specific summary.
  if (read > 0 && search === 0 && list === 0 && shell === 0 && edit === 0 && other === 0) {
    return 'Reading through the project.'
  }
  if (search > 0 && read === 0 && list === 0 && shell === 0 && edit === 0 && other === 0) {
    return 'Searching the code.'
  }
  if (list > 0 && read === 0 && search === 0 && shell === 0 && edit === 0 && other === 0) {
    return 'Looking through the project files.'
  }
  if (shell > 0 && read === 0 && search === 0 && list === 0 && edit === 0 && other === 0) {
    return 'Poking around in the shell.'
  }
  // Mixed exploration (reads + finds + greps + read-only shell) → one line.
  if (exploration > 0 && edit === 0 && other === 0) {
    return 'Looking around the project.'
  }
  // Anything with `other` in it — keep the catch-all but make it sound
  // less like a shrug. Empty-run is impossible (coalesceRun is only called
  // with run.length >= 2).
  return 'Working through a few things.'
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
