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
//                        one-line semantic from toolName + key input.
//                        BASH IS NEVER NARRATED AS A RAW COMMAND. We prefer
//                        the model's `description`; otherwise we derive a
//                        coarse semantic phrase from the leading verb of the
//                        command (find/grep/git/test/build/…). The voice
//                        must never read shell syntax aloud.
//   - tool-result      → only narrated when isError ("that didn't work")
//   - turn-done(final) → a short "done" milestone
//
// The salience filter (./salience.ts) decides which phrases actually reach
// the injector. This module only produces them. Salience for bash is also
// derived from the command verb — read-only/exploration verbs are LOW
// (coalesces); mutating/notable verbs are HIGH (voiced individually).

import type { ExecutorEvent } from '../executor/events.ts'

/** Phrase "kind" — a structured tag so the injector can coalesce a low-
 *  salience run without string-matching on the human-readable text. */
export type NarrationKind = 'read' | 'search' | 'list' | 'shell' | 'edit' | 'other'

export type NarrationPhrase = {
  text: string
  /** Source so the salience filter can decide whether to speak this one. */
  source: 'preamble' | 'tool-summary' | 'progress' | 'error'
  /** Estimated importance, 0..1. The injector batches/drops low-salience
   *  phrases in `high-level` mode. */
  salience: number
  /** Optional structured tag describing the kind of action this phrase
   *  is about. The injector uses it (when present) to merge a run of
   *  low-salience phrases into one accurate summary line. */
  kind?: NarrationKind
}

export type Translator = {
  ingest: (ev: ExecutorEvent) => NarrationPhrase[]
}

const PREAMBLE_MAX_CHARS = 400

/** Low salience — coalesce-eligible. Reads/searches/lists are background. */
const LOW_SALIENCE = 0.35
/** High salience — speak individually. Edits / shell-with-side-effects. */
const HIGH_TOOL_SALIENCE = 0.7

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
          const phrase = describeToolUse(ev.toolName, ev.input)
          if (!phrase?.text) return []
          return [{ ...phrase, source: 'tool-summary' }]
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

/** Output of the tool-use describer — everything except `source`, which
 *  the caller fills in (`tool-summary` for normal phrases). */
type ToolPhrase = {
  text: string
  salience: number
  kind: NarrationKind
}

function describeToolUse(toolName: string, input: unknown): ToolPhrase | null {
  const inp = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const name = toolName.toLowerCase()

  switch (name) {
    case 'read': {
      const path = stringField(inp, 'file_path') ?? stringField(inp, 'path')
      return {
        text: path ? `Opening ${basename(path)}.` : 'Reading a file.',
        salience: LOW_SALIENCE,
        kind: 'read',
      }
    }
    case 'write': {
      const path = stringField(inp, 'file_path') ?? stringField(inp, 'path')
      return {
        text: path ? `Writing ${basename(path)}.` : 'Writing a file.',
        salience: 0.8,
        kind: 'edit',
      }
    }
    case 'edit':
    case 'multiedit':
    case 'notebookedit': {
      const path = stringField(inp, 'file_path') ?? stringField(inp, 'path')
      return {
        text: path ? `Editing ${basename(path)}.` : 'Editing a file.',
        salience: 0.8,
        kind: 'edit',
      }
    }
    case 'grep': {
      const pattern = stringField(inp, 'pattern')
      return {
        text: pattern ? `Searching the code for ${shortQuote(pattern)}.` : 'Searching the code.',
        salience: LOW_SALIENCE,
        kind: 'search',
      }
    }
    case 'glob': {
      const pattern = stringField(inp, 'pattern')
      return {
        text: pattern ? `Looking for files matching ${shortQuote(pattern)}.` : 'Listing files.',
        salience: LOW_SALIENCE,
        kind: 'list',
      }
    }
    case 'bash': {
      // BASH IS NEVER NARRATED AS A RAW COMMAND. We prefer the model's
      // own `description` field; otherwise we derive a semantic phrase
      // from the command's leading verb. We never include the command,
      // backticks, paths, or flags in spoken text.
      const command = stringField(inp, 'command') ?? ''
      const desc = stringField(inp, 'description')
      if (desc) {
        return {
          text: `${capitalizeFirst(desc.trim())}${endsWithTerminal(desc) ? '' : '.'}`,
          salience: salienceForBash(command),
          kind: 'shell',
        }
      }
      const semantic = describeBashCommand(command)
      if (!semantic) return null
      return {
        text: semantic,
        salience: salienceForBash(command),
        kind: 'shell',
      }
    }
    case 'task':
    case 'agent': {
      const desc = stringField(inp, 'description') ?? stringField(inp, 'prompt')
      return {
        text: desc ? `Delegating: ${truncate(desc, 120)}.` : 'Delegating to a subagent.',
        salience: 0.85,
        kind: 'other',
      }
    }
    case 'webfetch':
    case 'webfetchtool': {
      const url = stringField(inp, 'url')
      return {
        text: url ? `Fetching ${url}.` : 'Fetching a URL.',
        salience: 0.5,
        kind: 'other',
      }
    }
    case 'websearch': {
      const q = stringField(inp, 'query')
      return {
        text: q ? `Searching the web for ${shortQuote(q)}.` : 'Searching the web.',
        salience: 0.5,
        kind: 'search',
      }
    }
    case 'todowrite':
      return { text: 'Updating the task list.', salience: 0.5, kind: 'other' }
    default:
      // Unknown tool — say something generic; the preamble (if any) already
      // covered intent.
      return { text: `Using ${toolName}.`, salience: 0.5, kind: 'other' }
  }
}

/** Read-only / exploration verbs. These do nothing the user needs to hear
 *  about individually — they coalesce into "Looking around the project". */
const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  'find',
  'ls',
  'tree',
  'stat',
  'du',
  'grep',
  'rg',
  'ag',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'wc',
  'pwd',
  'which',
  'whereis',
  'echo',
  'printf',
  'env',
  'whoami',
  'date',
  'hostname',
  'uname',
  'true',
  'false',
  'file',
])

/** Two-word git subcommands that are read-only (so `git status` is LOW
 *  even though `git commit` is HIGH). */
const READ_ONLY_GIT_SUBS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'config',
  'reflog',
  'blame',
  'tag',
])

/** Decide bash salience from the command's leading verb. Read-only/explore
 *  verbs are LOW (so a burst of them coalesces). Anything mutating —
 *  test runners, builds, package managers, rm/mv/cp, git mutators — is
 *  HIGH and gets its own spoken line. */
export function salienceForBash(command: string): number {
  const verb = leadingVerb(command)
  if (!verb) return HIGH_TOOL_SALIENCE
  if (verb === 'git') {
    const sub = nthToken(command, 1)?.toLowerCase() ?? ''
    if (READ_ONLY_GIT_SUBS.has(sub)) return LOW_SALIENCE
    return HIGH_TOOL_SALIENCE
  }
  if (READ_ONLY_VERBS.has(verb)) return LOW_SALIENCE
  return HIGH_TOOL_SALIENCE
}

/** Map a raw command string to a coarse semantic phrase. NEVER includes
 *  the command, backticks, paths, or flags. Returns `null` for an empty
 *  command (caller drops the phrase rather than say "Running a command"
 *  for literally nothing). */
export function describeBashCommand(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const verb = leadingVerb(trimmed)
  if (!verb) return 'Running a quick command.'

  // Two-token specials first (git subcommands, package-manager scripts).
  if (verb === 'git') {
    const sub = nthToken(trimmed, 1)?.toLowerCase() ?? ''
    if (READ_ONLY_GIT_SUBS.has(sub)) return "Checking what's changed."
    if (sub === 'commit' || sub === 'add' || sub === 'stash') return 'Saving the work in git.'
    if (sub === 'push' || sub === 'pull' || sub === 'fetch') return 'Syncing with the remote.'
    if (sub === 'checkout' || sub === 'switch' || sub === 'restore' || sub === 'reset') {
      return 'Moving things around in git.'
    }
    if (sub === 'merge' || sub === 'rebase' || sub === 'cherry-pick') return 'Reconciling branches.'
    return 'Working with git.'
  }

  // Package-manager test runners: `npm test`, `bun test`, etc.
  const runnerVerbs = new Set(['npm', 'bun', 'pnpm', 'yarn', 'deno'])
  if (runnerVerbs.has(verb)) {
    const sub = nthToken(trimmed, 1)?.toLowerCase() ?? ''
    if (sub === 'test' || sub === 'run' || sub === 'exec') {
      if (sub === 'test' || /\btest\b/.test(trimmed)) return 'Running the tests.'
      if (/\bbuild\b/.test(trimmed) || /\btsc\b/.test(trimmed)) return 'Building the project.'
      return 'Running a project script.'
    }
    if (sub === 'install' || sub === 'add' || sub === 'i' || sub === 'remove' || sub === 'rm') {
      return 'Updating project dependencies.'
    }
    if (sub === 'build') return 'Building the project.'
    return 'Running a project script.'
  }

  // Direct test/build runners.
  if (['vitest', 'jest', 'pytest', 'mocha', 'gotest'].includes(verb)) return 'Running the tests.'
  if (verb === 'go' && nthToken(trimmed, 1) === 'test') return 'Running the tests.'
  if (verb === 'cargo') {
    const sub = nthToken(trimmed, 1)?.toLowerCase() ?? ''
    if (sub === 'test') return 'Running the tests.'
    if (sub === 'build' || sub === 'check') return 'Building the project.'
    return 'Running a cargo command.'
  }
  if (verb === 'tsc' || /\bbuild\b/.test(trimmed)) return 'Building the project.'
  if (verb === 'make') return 'Building the project.'

  // Lookup / exploration.
  if (['find', 'ls', 'tree', 'stat', 'du', 'file'].includes(verb)) {
    return 'Looking through the project files.'
  }
  if (['grep', 'rg', 'ag'].includes(verb)) return 'Searching the code.'
  if (['cat', 'head', 'tail', 'less', 'more', 'bat', 'wc'].includes(verb)) {
    return 'Taking a look at a file.'
  }

  // Bearings.
  if (
    [
      'pwd',
      'cd',
      'which',
      'whereis',
      'echo',
      'printf',
      'env',
      'whoami',
      'date',
      'hostname',
      'uname',
    ].includes(verb)
  ) {
    return 'Getting my bearings.'
  }

  // FS mutations.
  if (['mkdir', 'touch', 'cp', 'mv', 'ln'].includes(verb)) return 'Setting up some files.'
  if (verb === 'rm' || verb === 'rmdir') return 'Cleaning up some files.'
  if (verb === 'chmod' || verb === 'chown') return 'Adjusting file permissions.'

  return 'Running a quick command.'
}

/** Pull the first whitespace-separated token, normalised. Strips a leading
 *  `sudo` and a leading env-var assignment so we classify the real verb. */
function leadingVerb(command: string): string {
  const tokens = tokenize(command)
  let i = 0
  // Skip env-var assignments (`FOO=bar baz`) at the head of the line.
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i] ?? '')) i++
  // Skip a leading `sudo` (the underlying verb is what matters).
  if (tokens[i]?.toLowerCase() === 'sudo') i++
  const raw = tokens[i] ?? ''
  // Path-prefixed binary? Take the basename.
  const base = raw.includes('/') ? (raw.split('/').pop() ?? raw) : raw
  return base.toLowerCase()
}

function nthToken(command: string, n: number): string | null {
  const tokens = tokenize(command).filter((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t))
  // Also skip leading `sudo`.
  const head = tokens[0]?.toLowerCase() === 'sudo' ? tokens.slice(1) : tokens
  return head[n] ?? null
}

function tokenize(command: string): string[] {
  // Cheap & sufficient: split on whitespace. We're not executing; we
  // just need the leading verb. Sub-pipes ("foo | bar") classify by the
  // FIRST command — that's the right semantics for narration.
  return command.trim().split(/\s+/)
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

function endsWithTerminal(s: string): boolean {
  const last = s.trim().slice(-1)
  return last === '.' || last === '!' || last === '?' || last === '…'
}
