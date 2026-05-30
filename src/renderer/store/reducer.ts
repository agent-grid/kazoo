// The renderer's single store. A pure reducer over the SAME `BusEvent` union
// the old Ink `src/tui/hooks.ts` consumed, forwarded verbatim over IPC by
// main's `bus.subscribe → CH.BUS` bridge (SURFACE_PLAN §6 "Bus bindings").
//
// Product principle: the EXECUTOR'S WORK is the hero. So the store's center of
// gravity is `workFeed` + `changedFiles` (what the agent actually did — the
// thing voice can't convey), not the transcript. The transcript (`turns`) is
// secondary and capped.
//
// Audio-derived signals (mic level, playback amplitude, isSpeaking) do NOT live
// here — they come from `useAudioIO`, sampled per animation frame, so 24 kHz
// audio never churns this reducer. The store only holds discrete, low-rate
// state pushed on the bus.

import type { ExecutorEvent } from '../../core/executor/events.ts'
import type { NarrationMode } from '../../core/narration/modes.ts'
import type { BusEvent } from '../../core/orchestrator/bus.ts'
import type { OrchestratorState } from '../../core/orchestrator/state.ts'
import type { RealtimeSessionState } from '../../core/realtime/events.ts'

// ── Work-feed blocks ────────────────────────────────────────────────────────
// The WorkStage classifies each `tool-use` by `toolName` into one of these
// block kinds. `input` is `unknown` on the wire, so classification + field
// extraction is defensive (see `coerceX` helpers below).

export type WorkBlockKind = 'file-edit' | 'file-read' | 'command' | 'tool' | 'error'

export type WorkBlockBase = {
  /** Stable key. For tool blocks this is the `toolUseId`; error-only blocks
   *  (executor-error) synthesize one. */
  id: string
  kind: WorkBlockKind
  /** Arrival time, stamped on receipt — the bus union has no timestamps
   *  (SURFACE_PLAN §6). Used for ordering + the optional time column. */
  at: number
  /** Resolution status, flipped when the matching `tool-result` lands. */
  status: 'pending' | 'ok' | 'error'
}

export type FileEditBlock = WorkBlockBase & {
  kind: 'file-edit'
  toolName: string
  filePath: string
  /** Per-line diff for the live +/− gutter. Computed from old/new_string
   *  (Edit) or the written content (Write). */
  diff: DiffLine[]
  adds: number
  dels: number
}

export type FileReadBlock = WorkBlockBase & {
  kind: 'file-read'
  toolName: string
  /** File path or glob/grep pattern — whatever the tool targeted. */
  target: string
  /** Collapsed peek of the result content (first lines), filled on tool-result. */
  peek: string | null
}

export type CommandBlock = WorkBlockBase & {
  kind: 'command'
  command: string
  /** stdout/stderr tail from the tool-result. */
  output: string | null
}

export type ToolBlock = WorkBlockBase & {
  kind: 'tool'
  toolName: string
  /** A one-line safe summary of the raw input. */
  summary: string
  result: string | null
}

export type ErrorBlock = WorkBlockBase & {
  kind: 'error'
  message: string
}

export type WorkBlock = FileEditBlock | FileReadBlock | CommandBlock | ToolBlock | ErrorBlock

export type DiffLine = { sign: '+' | '-' | ' '; text: string }

// ── Changed-files ledger ────────────────────────────────────────────────────

export type ChangedFile = {
  path: string
  adds: number
  dels: number
  edits: number
  /** Whether the file was only read (no edits). */
  readOnly: boolean
}

// ── Conversation turns ──────────────────────────────────────────────────────

export type Turn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Assistant turns can stream: a non-final ghost line replaced on final. */
  final: boolean
}

// ── The store ───────────────────────────────────────────────────────────────

export type UiState = {
  /** Orchestrator FSM word — drives the resonator mode + status. */
  fsm: OrchestratorState
  /** Realtime WS health — drives the ConnectionPip. Distinct from `fsm`. */
  connection: RealtimeSessionState
  /** Narration batching mode, mirrored from the `narration-mode` bus event so
   *  the ModeToggle stays truthful even when toggled by voice. */
  mode: NarrationMode
  /** The single sticky "what's happening RIGHT NOW" line. */
  currentAction: string | null
  /** Ordered work blocks (newest last), capped. */
  workFeed: WorkBlock[]
  /** Session file ledger, insertion-ordered. */
  changedFiles: ChangedFile[]
  /** Spoken turns, secondary, capped. */
  turns: Turn[]
}

const WORK_FEED_CAP = 200
const TURNS_CAP = 50

export const INITIAL_STATE: UiState = {
  fsm: 'idle',
  connection: 'idle',
  mode: 'flow',
  currentAction: null,
  workFeed: [],
  changedFiles: [],
  turns: [],
}

/** Reduce one `BusEvent` into the next store. Pure — no side effects, no audio.
 *  `at` is injected (the receipt timestamp) so the reducer stays deterministic
 *  and testable rather than reading `Date.now()` itself. */
export function reduce(state: UiState, ev: BusEvent, at: number): UiState {
  switch (ev.type) {
    case 'state':
      return { ...state, fsm: ev.state, currentAction: actionForFsm(state, ev.state) }
    case 'narration-mode':
      return { ...state, mode: ev.mode }
    case 'narration-spoken':
      return { ...state, turns: pushAssistantTurn(state.turns, ev.text) }
    case 'realtime':
      return reduceRealtime(state, ev.event, at)
    case 'executor':
      return reduceExecutor(state, ev.event, at)
    case 'log':
      // Logs are diagnostics; the hero UI doesn't surface them. (A debug pane
      // could subscribe separately.) No store change.
      return state
    default: {
      const _never: never = ev
      void _never
      return state
    }
  }
}

// ── realtime sub-reducer ────────────────────────────────────────────────────

function reduceRealtime(
  state: UiState,
  ev: Extract<BusEvent, { type: 'realtime' }>['event'],
  _at: number,
): UiState {
  switch (ev.type) {
    case 'state':
      return { ...state, connection: ev.state }
    case 'caption':
      // User captions are always final → a committed user turn. Assistant
      // captions are voiced via `narration-spoken`, so we don't double-display
      // them here (SURFACE_PLAN §6 "prefer narration-spoken").
      if (ev.role === 'user' && ev.final) {
        return { ...state, turns: pushUserTurn(state.turns, ev.text) }
      }
      return state
    // audio-chunk / audio-done / speech-started / response-* are handled by
    // the audio path (useAudioIO) and the FSM `state` events; they carry no
    // store-visible payload here.
    default:
      return state
  }
}

// ── executor sub-reducer (the hero) ─────────────────────────────────────────

function reduceExecutor(state: UiState, ev: ExecutorEvent, at: number): UiState {
  switch (ev.type) {
    case 'assistant-text':
      // The model's preamble — the highest-priority "current action" label.
      return { ...state, currentAction: firstLine(ev.text) || state.currentAction }
    case 'tool-use': {
      const block = blockFromToolUse(ev.toolUseId, ev.toolName, ev.input, at)
      return {
        ...state,
        currentAction: actionForToolUse(ev.toolName, block),
        workFeed: capEnd([...state.workFeed, block], WORK_FEED_CAP),
        changedFiles: ledgerFromToolUse(state.changedFiles, ev.toolName, block),
      }
    }
    case 'tool-result':
      return { ...state, workFeed: applyResult(state.workFeed, ev) }
    case 'turn-done':
      // The agent finished a logical task → clear the sticky action so the bar
      // falls back to the FSM word rather than a stale verb.
      return ev.finalForTask ? { ...state, currentAction: null } : state
    case 'executor-error':
      return {
        ...state,
        workFeed: capEnd(
          [
            ...state.workFeed,
            { id: `err-${at}`, kind: 'error', at, status: 'error', message: ev.message },
          ],
          WORK_FEED_CAP,
        ),
      }
    default: {
      const _never: never = ev
      void _never
      return state
    }
  }
}

// ── tool-use → block classification ─────────────────────────────────────────

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS'])

function blockFromToolUse(
  toolUseId: string,
  toolName: string,
  input: unknown,
  at: number,
): WorkBlock {
  const base = { id: toolUseId, at, status: 'pending' as const }

  if (EDIT_TOOLS.has(toolName)) {
    const filePath = coerceString(field(input, 'file_path')) ?? '(unknown file)'
    const diff = diffFromEditInput(toolName, input)
    const adds = diff.filter((d) => d.sign === '+').length
    const dels = diff.filter((d) => d.sign === '-').length
    return { ...base, kind: 'file-edit', toolName, filePath, diff, adds, dels }
  }

  if (READ_TOOLS.has(toolName)) {
    const target =
      coerceString(field(input, 'file_path')) ??
      coerceString(field(input, 'pattern')) ??
      coerceString(field(input, 'path')) ??
      '(unknown)'
    return { ...base, kind: 'file-read', toolName, target, peek: null }
  }

  if (toolName === 'Bash') {
    const command = coerceString(field(input, 'command')) ?? '(no command)'
    return { ...base, kind: 'command', command, output: null }
  }

  return { ...base, kind: 'tool', toolName, summary: summarizeInput(input), result: null }
}

/** Compute a line-level diff for the edit gutter. For `Edit`/`MultiEdit` we
 *  diff old_string vs new_string; for `Write` every line is an addition. Kept
 *  intentionally simple — line adds/removes, no LCS — since the bus delivers
 *  the exact strings and the WorkFeed wants a fast, readable +/− gutter. */
function diffFromEditInput(toolName: string, input: unknown): DiffLine[] {
  if (toolName === 'Write') {
    const content = coerceString(field(input, 'content')) ?? ''
    return splitLines(content).map((text) => ({ sign: '+' as const, text }))
  }
  // MultiEdit carries an `edits` array; Edit carries top-level old/new_string.
  if (toolName === 'MultiEdit') {
    const edits = field(input, 'edits')
    if (Array.isArray(edits)) {
      return edits.flatMap((e) => editPairToDiff(field(e, 'old_string'), field(e, 'new_string')))
    }
  }
  return editPairToDiff(field(input, 'old_string'), field(input, 'new_string'))
}

function editPairToDiff(oldRaw: unknown, newRaw: unknown): DiffLine[] {
  const oldLines = splitLines(coerceString(oldRaw) ?? '')
  const newLines = splitLines(coerceString(newRaw) ?? '')
  const removed: DiffLine[] = oldLines
    .filter((l) => l.length > 0 || oldLines.length > 1)
    .map((text) => ({ sign: '-' as const, text }))
  const added: DiffLine[] = newLines
    .filter((l) => l.length > 0 || newLines.length > 1)
    .map((text) => ({ sign: '+' as const, text }))
  return [...removed, ...added]
}

// ── tool-result correlation ─────────────────────────────────────────────────

function applyResult(
  feed: WorkBlock[],
  ev: Extract<ExecutorEvent, { type: 'tool-result' }>,
): WorkBlock[] {
  let matched = false
  const next = feed.map((b): WorkBlock => {
    if (b.id !== ev.toolUseId) return b
    matched = true
    const status: WorkBlockBase['status'] = ev.isError ? 'error' : 'ok'
    switch (b.kind) {
      case 'file-read':
        return { ...b, status, peek: peekOf(ev.content) }
      case 'command':
        return { ...b, status, output: tailOf(ev.content) }
      case 'tool':
        return { ...b, status, result: tailOf(ev.content) }
      case 'file-edit':
        return { ...b, status }
      default:
        return { ...b, status }
    }
  })
  // A result with no matching block (e.g. capped out) → surface as an error
  // block only if it errored; otherwise drop silently.
  if (!matched && ev.isError) {
    return capEnd(
      [
        ...next,
        {
          id: `res-${ev.toolUseId}`,
          kind: 'error',
          at: Date.now(),
          status: 'error',
          message: tailOf(ev.content) || 'tool failed',
        },
      ],
      WORK_FEED_CAP,
    )
  }
  return next
}

// ── changed-files ledger ────────────────────────────────────────────────────

function ledgerFromToolUse(
  ledger: ChangedFile[],
  toolName: string,
  block: WorkBlock,
): ChangedFile[] {
  if (block.kind === 'file-edit') {
    return upsertFile(ledger, block.filePath, (f) => ({
      ...f,
      adds: f.adds + block.adds,
      dels: f.dels + block.dels,
      edits: f.edits + 1,
      readOnly: false,
    }))
  }
  if (block.kind === 'file-read' && (toolName === 'Read' || toolName === 'LS')) {
    // Only Read/LS target a concrete path worth tracking; Glob/Grep are queries.
    if (block.target === '(unknown)') return ledger
    return upsertFile(ledger, block.target, (f) => f)
  }
  return ledger
}

function upsertFile(
  ledger: ChangedFile[],
  path: string,
  update: (f: ChangedFile) => ChangedFile,
): ChangedFile[] {
  const idx = ledger.findIndex((f) => f.path === path)
  if (idx === -1) {
    return [...ledger, update({ path, adds: 0, dels: 0, edits: 0, readOnly: true })]
  }
  const existing = ledger[idx]
  if (existing === undefined) return ledger
  const next = ledger.slice()
  next[idx] = update(existing)
  return next
}

// ── current-action derivation ───────────────────────────────────────────────

function actionForToolUse(toolName: string, block: WorkBlock): string {
  switch (block.kind) {
    case 'file-edit':
      return `${verb(toolName)} ${baseName(block.filePath)}`
    case 'file-read':
      return `${verb(toolName)} ${baseName(block.target)}`
    case 'command':
      return `Running ${truncate(block.command, 48)}`
    default:
      return `${toolName}`
  }
}

function actionForFsm(prev: UiState, fsm: OrchestratorState): string | null {
  // On listening/idle, clear any stale verb; otherwise keep the current label.
  if (fsm === 'listening' || fsm === 'idle' || fsm === 'ended') return null
  return prev.currentAction
}

function verb(toolName: string): string {
  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
      return 'Editing'
    case 'Write':
      return 'Writing'
    case 'Read':
      return 'Reading'
    case 'Glob':
    case 'Grep':
      return 'Searching'
    case 'LS':
      return 'Listing'
    default:
      return toolName
  }
}

// ── conversation turns ──────────────────────────────────────────────────────

function pushUserTurn(turns: Turn[], text: string): Turn[] {
  const t = text.trim()
  if (t.length === 0) return turns
  return capStart(
    [...turns, { id: `u-${turns.length}-${t.slice(0, 8)}`, role: 'user', text: t, final: true }],
    TURNS_CAP,
  )
}

function pushAssistantTurn(turns: Turn[], text: string): Turn[] {
  const t = text.trim()
  if (t.length === 0) return turns
  return capStart(
    [
      ...turns,
      { id: `a-${turns.length}-${t.slice(0, 8)}`, role: 'assistant', text: t, final: true },
    ],
    TURNS_CAP,
  )
}

// ── small pure helpers ──────────────────────────────────────────────────────

function field(obj: unknown, key: string): unknown {
  if (obj !== null && typeof obj === 'object' && key in obj) {
    return (obj as Record<string, unknown>)[key]
  }
  return undefined
}

function coerceString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return truncate(input, 80)
  try {
    return truncate(JSON.stringify(input), 80)
  } catch {
    return '(uninspectable input)'
  }
}

function splitLines(s: string): string[] {
  if (s.length === 0) return []
  return s.split('\n')
}

function firstLine(s: string): string {
  const i = s.indexOf('\n')
  return (i === -1 ? s : s.slice(0, i)).trim()
}

function peekOf(content: string): string {
  return splitLines(content).slice(0, 3).join('\n')
}

function tailOf(content: string): string {
  const lines = splitLines(content)
  return lines.slice(Math.max(0, lines.length - 6)).join('\n')
}

function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

/** Keep the last `n` items (drop oldest). For append-newest-at-end lists. */
function capEnd<T>(arr: T[], n: number): T[] {
  return arr.length <= n ? arr : arr.slice(arr.length - n)
}

/** Alias of capEnd for the turns list — newest at the end, oldest dropped. */
function capStart<T>(arr: T[], n: number): T[] {
  return capEnd(arr, n)
}
