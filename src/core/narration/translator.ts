// Executor events → spoken-style phrases.
//
// Design principle (plan §04 — "Harvest preambles"): the executor already
// states intent in plain language before each tool call. That assistant
// text IS the narration. We don't build a command→English translator;
// we harvest preambles and add light glue for tool semantics.
//
// First-cut implementation — crude but real:
//   - assistant-text   → speak the preamble verbatim (trimmed, length-capped)
//   - tool-use         → "I'm reading auth.ts" / "running the tests" — a
//                        one-line semantic from toolName + key input
//   - tool-result      → only narrated when isError ("that didn't work")
//   - turn-done(final) → a short "done" milestone
//
// The salience filter (./salience.ts) decides which phrases actually reach
// the injector. This module only produces them.

import type { ExecutorEvent } from '../executor/events.ts'

export type NarrationPhrase = {
  text: string
  /** Source so the salience filter can decide whether to speak this one. */
  source: 'preamble' | 'tool-summary' | 'progress' | 'error'
  /** Estimated importance, 0..1. The injector batches/drops low-salience
   *  phrases in `high-level` mode. */
  salience: number
}

export type Translator = {
  ingest: (ev: ExecutorEvent) => NarrationPhrase[]
}

const PREAMBLE_MAX_CHARS = 400

export function createTranslator(): Translator {
  return {
    ingest(ev: ExecutorEvent): NarrationPhrase[] {
      switch (ev.type) {
        case 'assistant-text': {
          const text = truncate(ev.text.trim(), PREAMBLE_MAX_CHARS)
          if (!text) return []
          return [{ text, source: 'preamble', salience: 0.9 }]
        }
        case 'tool-use': {
          const text = describeToolUse(ev.toolName, ev.input)
          if (!text) return []
          return [{ text, source: 'tool-summary', salience: salienceForTool(ev.toolName) }]
        }
        case 'tool-result': {
          if (!ev.isError) return []
          const detail = truncate(ev.content.trim(), 200) || 'no further detail'
          return [
            {
              text: `That didn't work — ${detail}`,
              source: 'error',
              salience: 0.95,
            },
          ]
        }
        case 'turn-done': {
          if (!ev.finalForTask) return []
          return [{ text: 'Done.', source: 'progress', salience: 1.0 }]
        }
        case 'executor-error': {
          return [{ text: `The executor errored: ${ev.message}`, source: 'error', salience: 1.0 }]
        }
      }
    },
  }
}

// ────── helpers ──────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}…`
}

function salienceForTool(toolName: string): number {
  // Edits + commands deserve attention; reads are background noise.
  const name = toolName.toLowerCase()
  if (name === 'edit' || name === 'write' || name === 'multiedit' || name === 'notebookedit') {
    return 0.8
  }
  if (name === 'bash') return 0.7
  if (name === 'task' || name === 'agent') return 0.85
  if (name === 'read' || name === 'grep' || name === 'glob') return 0.35
  return 0.5
}

function describeToolUse(toolName: string, input: unknown): string {
  const inp = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const name = toolName.toLowerCase()

  switch (name) {
    case 'read': {
      const path = stringField(inp, 'file_path') ?? stringField(inp, 'path')
      return path ? `Opening ${basename(path)}.` : 'Reading a file.'
    }
    case 'write': {
      const path = stringField(inp, 'file_path') ?? stringField(inp, 'path')
      return path ? `Writing ${basename(path)}.` : 'Writing a file.'
    }
    case 'edit':
    case 'multiedit': {
      const path = stringField(inp, 'file_path') ?? stringField(inp, 'path')
      return path ? `Editing ${basename(path)}.` : 'Editing a file.'
    }
    case 'grep': {
      const pattern = stringField(inp, 'pattern')
      return pattern ? `Searching the code for ${shortQuote(pattern)}.` : 'Searching the code.'
    }
    case 'glob': {
      const pattern = stringField(inp, 'pattern')
      return pattern ? `Looking for files matching ${shortQuote(pattern)}.` : 'Listing files.'
    }
    case 'bash': {
      const command = stringField(inp, 'command') ?? ''
      const desc = stringField(inp, 'description')
      if (desc) return `${capitalizeFirst(desc)}.`
      return command ? `Running \`${truncate(command, 80)}\`.` : 'Running a command.'
    }
    case 'task':
    case 'agent': {
      const desc = stringField(inp, 'description') ?? stringField(inp, 'prompt')
      return desc ? `Delegating: ${truncate(desc, 120)}.` : 'Delegating to a subagent.'
    }
    case 'webfetch':
    case 'webfetchtool': {
      const url = stringField(inp, 'url')
      return url ? `Fetching ${url}.` : 'Fetching a URL.'
    }
    case 'websearch': {
      const q = stringField(inp, 'query')
      return q ? `Searching the web for ${shortQuote(q)}.` : 'Searching the web.'
    }
    case 'todowrite':
      return 'Updating the task list.'
    default:
      // Unknown tool — say something generic; the preamble (if any) already
      // covered intent.
      return `Using ${toolName}.`
  }
}

function stringField(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  return typeof v === 'string' && v.trim() ? v : null
}

function basename(path: string): string {
  // Last segment; drop trailing slashes. No node:path import — works
  // identically across forward/back slashes for the narration purposes.
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned
}

function shortQuote(s: string): string {
  const t = truncate(s, 60)
  return `"${t}"`
}

function capitalizeFirst(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
