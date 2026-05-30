// Awareness work-log — the second consumer off the raw executor event stream
// (SUPERVISOR_SPEC §4).
//
// The voice already has its spoken-narration history ("what did I just say").
// What it lacks is a reliable "what files did I change / what am I doing now",
// because narration is lossy BY DESIGN: the injector coalesces low-salience
// runs and drops the rest, and the translator narrates a tool-result only on
// error. So successful file-level facts never reach the spoken history.
//
// This module is the SECOND consumer off the same `ExecutorEvent` stream the
// narration pipeline reads (§4a). It does NOT go through the lossy translator —
// it reads the structured tool inputs directly and maintains one compacted,
// timestamped `[WORK-LOG]` record that the orchestrator injects SILENTLY into
// the Realtime conversation (`session.injectAwareness`, no response.create).
//
// Two independent consumers, one stream: narration (semantic, lossy, for the
// mouth) and awareness (structured, for the model's memory). They share the
// event source, never the translator.
//
// What we record (§4a):
//   - tool-use Write/Edit/MultiEdit/NotebookEdit → file path + one-line "what"
//   - turn-done{finalForTask} → mark the task complete
//   - executor-error / error tool-result → record the error
// What we DON'T record: every Read/Grep/Glob, raw command lines, successful
// non-mutating tool-results.

import type { ExecutorEvent } from '../executor/events.ts'

/** Tools whose use mutates the workspace — the only tool-uses worth a work-log
 *  entry. Maps tool name → the input field carrying the path. */
const MUTATING_TOOL_PATH_FIELDS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** Keep the granular tail bounded; older entries fold into a summary line
 *  (§4c — summarize-and-evict) so the injected item is "summary + recent
 *  detail", not an ever-growing transcript. */
const MAX_GRANULAR_ENTRIES = 12

type WorkLogEntry = {
  /** Wall-clock ms when recorded — so the model can hedge on recency (§4d). */
  at: number
  /** One observational line, e.g. "changed src/auth/login.ts" or
   *  "tests step failed". */
  text: string
}

export type AwarenessLog = {
  /** Feed one raw executor event. Returns true if the work-log changed and
   *  should be re-injected (the caller decides when to actually inject). */
  ingest: (ev: ExecutorEvent) => boolean
  /** Render the current compacted work-log as the marked, injectable text.
   *  Empty string when there's nothing worth saying yet. */
  render: () => string
}

export function createAwarenessLog(now: () => number = Date.now): AwarenessLog {
  // A single rolled-up summary of evicted detail, plus a bounded granular tail.
  let summary = ''
  const entries: WorkLogEntry[] = []

  function record(text: string): boolean {
    entries.push({ at: now(), text })
    // Summarize-and-evict: once the granular tail is too long, fold the oldest
    // half into the one living summary line and drop them.
    if (entries.length > MAX_GRANULAR_ENTRIES) {
      const evicted = entries.splice(0, entries.length - MAX_GRANULAR_ENTRIES)
      const folded = evicted.map((e) => e.text).join('; ')
      summary = summary ? `${summary}; ${folded}` : folded
    }
    return true
  }

  return {
    ingest(ev: ExecutorEvent): boolean {
      switch (ev.type) {
        case 'tool-use': {
          const pathField = MUTATING_TOOL_PATH_FIELDS[ev.toolName]
          if (!pathField) return false // not a mutation — don't record
          const input =
            typeof ev.input === 'object' && ev.input !== null
              ? (ev.input as Record<string, unknown>)
              : {}
          const rawPath = input[pathField]
          const path = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : null
          const verb = ev.toolName === 'Write' ? 'wrote' : 'changed'
          return record(path ? `${verb} ${path}` : `${verb} a file`)
        }
        case 'tool-result': {
          // Only errors are work-log-worthy; successful reads/edits are
          // captured by the tool-use / turn-done entries.
          if (!ev.isError) return false
          const detail = ev.content.trim().slice(0, 120)
          return record(detail ? `a step failed: ${detail}` : 'a step failed')
        }
        case 'executor-error':
          return record(`error: ${ev.message.slice(0, 160)}`)
        case 'turn-done':
          if (!ev.finalForTask) return false
          return record('finished the current task')
        default:
          return false
      }
    },

    render(): string {
      if (!summary && entries.length === 0) return ''
      const parts: string[] = []
      if (summary) parts.push(`Earlier: ${summary}.`)
      for (const e of entries) {
        const ago = Math.max(0, Math.round((now() - e.at) / 1000))
        parts.push(`${e.text} (~${ago}s ago)`)
      }
      return `[WORK-LOG] ${parts.join(' ')}`
    },
  }
}
