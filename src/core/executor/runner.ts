// Claude Agent SDK wrapper — the "brain".
//
// Long-lived `query()` session with a streaming user-message input so one
// SDK process serves multiple user turns over the lifetime of a call.
//
// Threading model:
//   - `userMessages` is an AsyncQueue<SDKUserMessage>. `submit(text)` pushes
//     onto it; the SDK pulls when it's ready for the next turn.
//   - A background `for await` loop consumes SDKMessages, maps them to our
//     normalized `ExecutorEvent` union (see ./events.ts), and calls
//     `cfg.onEvent` for each. Non-blocking — `submit()` returns immediately.
//   - `close()` ends the input stream, calls `Query.close()`, and the
//     consumer loop drains naturally.
//
// Auth: SDK reads `CLAUDE_CODE_OAUTH_TOKEN` (Claude subscription, preferred)
// or `ANTHROPIC_API_KEY` (pay-as-you-go) from the subprocess env. We
// forward whichever is present. We validate "at least one" in `cli.tsx`
// before constructing the executor.
//
// Permission policy: `acceptEdits` + `canUseTool` callback that runs the
// bash-allowlist matcher. The matcher is intentionally a minimal first
// cut — see `tools.ts` for the contract. Flagged for security-review.
//
// Safety: the SDK runs in a scoped workspace dir (see `cli.tsx`) so a
// hallucinated edit can't damage Kazoo's own source.

import { realpathSync } from 'node:fs'
import { dirname, sep as pathSep, resolve } from 'node:path'
import {
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../lib/async.ts'
import { KazooError } from '../lib/errors.ts'
import type { Logger } from '../lib/logger.ts'
import type { ExecutorEvent, ExecutorEventHandler } from './events.ts'
import { type ExecutorPermissionPolicy, isBashCommandAllowed } from './tools.ts'

/** Tools that touch the filesystem and need a path-scope check. The value
 *  is the input field where the model puts the path. Mapped explicitly
 *  (vs sniffing fields) so adding a new tool requires a deliberate review. */
const FILE_TOOL_PATH_FIELDS: Record<string, string> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'path',
  Glob: 'path',
  LS: 'path',
}

/** Tools that go to the network or spawn subagents — denied by default
 *  (SSRF, data exfil, remote-prompt-injection vectors). The model can
 *  describe what it WOULD do; the user can explicitly grant later. */
const DENY_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch', 'Task'])

/** Bound on tool-result text we forward into `ExecutorEvent.content`.
 *  8 KB is enough for "what we narrated about" without bloating logs or
 *  giving an attacker an easy memory-pressure vector. Anything past this
 *  is truncated with an ellipsis. */
const MAX_TOOL_RESULT_BYTES = 8192

export type ExecutorConfig = {
  /** EITHER `oauthToken` OR `apiKey` must be set. Caller (cli.tsx) is
   *  responsible for the either/or check; this constructor only checks
   *  that at least one is non-empty. */
  oauthToken?: string | undefined
  apiKey?: string | undefined
  model: string
  systemPrompt: string
  policy: ExecutorPermissionPolicy
  onEvent: ExecutorEventHandler
  logger: Logger
  /** Absolute path to the SDK's native `claude` executable. In dev this is
   *  `undefined` — the SDK's own resolution finds it under `node_modules`. In
   *  a PACKAGED build the binary lives under `app.asar.unpacked`, where the
   *  SDK's `require.resolve` walk can't reach it, so `main/index.ts` computes
   *  the path (see `main/sdk-paths.ts`) and passes it here; we forward it as
   *  `Options.pathToClaudeCodeExecutable`. (SURFACE_PLAN §A / Risk #1.) */
  executablePath?: string | undefined
}

export type CancelTurnOptions = {
  /** Also drain any pending (queued-but-not-started) user turns — the
   *  "drop everything / cancel all" path (SUPERVISOR_SPEC §3c.3). Plain stop
   *  (omitted/false) cancels only the in-flight turn. */
  dropQueue?: boolean
}

export type ExecutorRunner = {
  /** Submit a user-spoken task. Returns immediately; events stream via
   *  the `onEvent` handler. Calling while a turn is in flight queues. */
  submit: (text: string) => void
  /** Cancel the in-flight turn (does NOT close the session). The sole
   *  preemption path — wired only to the orchestrator's STOP flow
   *  (SUPERVISOR_SPEC §3a). Synthesizes a terminal `turn-done` if the SDK
   *  yields no `result` after `interrupt()`, so the orchestrator always
   *  returns from `working` → `listening`. */
  cancelTurn: (opts?: CancelTurnOptions) => void
  /** Tear down the SDK session. */
  close: () => Promise<void>
}

export function createExecutor(cfg: ExecutorConfig): ExecutorRunner {
  if (!cfg.oauthToken && !cfg.apiKey) {
    throw new KazooError(
      'config/missing-env',
      'executor: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set',
    )
  }

  const logger = cfg.logger.child({ mod: 'executor' })
  const userMessages = new AsyncQueue<SDKUserMessage>()
  let closed = false
  let consumerDead = false
  let consumerDeathReason: string | null = null
  // Set true while a turn is actually in flight (between the first event of a
  // turn and its `turn-done`). `cancelTurn` reads this to decide whether to
  // synthesize a terminal `turn-done` (SUPERVISOR_SPEC §3c.1): if `interrupt()`
  // produces a real `result` the SDK's own `turn-done` clears this and the
  // synthesized fallback is suppressed; if it produces nothing, the fallback
  // fires so the orchestrator never hangs in `working`.
  let turnActive = false

  // Realpath the workspace ONCE at construction. We compare against this
  // string for the path-scope check. If the workspace dir doesn't exist
  // yet (cli.tsx is supposed to mkdir it first) this throws and we surface
  // it — better than silently degrading to a different sandbox root.
  let workspaceReal: string
  try {
    workspaceReal = realpathSync(cfg.policy.cwd)
  } catch (err) {
    throw new KazooError(
      'executor/sdk',
      `executor: workspace dir does not exist or is unreadable: ${cfg.policy.cwd}`,
      err,
    )
  }

  // canUseTool enforces:
  //   1. Bash: full argv-prefix allowlist (see ./tools.ts) — parsed with
  //      shell-quote, no string-prefix bypass.
  //   2. File tools (Read/Write/Edit/MultiEdit/NotebookEdit/Grep/Glob/LS):
  //      path must resolve INSIDE the workspace after symlink expansion.
  //   3. WebFetch / WebSearch / Task: denied — they're SSRF / exfil /
  //      remote-prompt-injection vectors. The user can describe what they
  //      want and the executor can suggest it; an explicit grant comes
  //      later via a real surface (not voice-blind).
  //   4. Everything else: allow (covered by `acceptEdits`).
  const canUseTool: CanUseTool = async (toolName, input, _options): Promise<PermissionResult> => {
    if (DENY_TOOLS.has(toolName)) {
      logger.warn({ toolName }, 'executor: tool denied by policy')
      return {
        behavior: 'deny',
        message:
          `${toolName} is not allowed in this Kazoo session. ` +
          'Describe what you would do; the user can grant access explicitly later.',
      }
    }

    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : ''
      if (!isBashCommandAllowed(command, cfg.policy)) {
        logger.warn(
          { command: command.slice(0, 200) },
          'executor: bash command denied by allowlist',
        )
        return {
          behavior: 'deny',
          message: `Command not on Kazoo's bash allowlist: \`${command.slice(0, 80)}\``,
        }
      }
      return { behavior: 'allow', updatedInput: input }
    }

    const pathField = FILE_TOOL_PATH_FIELDS[toolName]
    if (pathField !== undefined) {
      const raw = input[pathField]
      // Grep/Glob/LS treat an absent path as "scan the workspace" — that's
      // safe; the cwd is already the workspace.
      const optional = toolName === 'Grep' || toolName === 'Glob' || toolName === 'LS'
      if (raw === undefined || raw === null || raw === '') {
        if (optional) return { behavior: 'allow', updatedInput: input }
        return {
          behavior: 'deny',
          message: `${toolName} requires a ${pathField} argument.`,
        }
      }
      if (typeof raw !== 'string') {
        return {
          behavior: 'deny',
          message: `${toolName}: ${pathField} must be a string.`,
        }
      }
      if (!isInsideWorkspace(raw, workspaceReal)) {
        logger.warn(
          { toolName, path: raw.slice(0, 200) },
          'executor: file tool path outside workspace — denied',
        )
        return {
          behavior: 'deny',
          message:
            `${toolName}: path \`${raw.slice(0, 80)}\` is outside the workspace ` +
            `(${workspaceReal}). Stay inside the workspace.`,
        }
      }
      return { behavior: 'allow', updatedInput: input }
    }

    return { behavior: 'allow', updatedInput: input }
  }

  // Build the subprocess env from an ALLOWLIST. The SDK doc says the `env`
  // option REPLACES process.env entirely; spreading process.env (the
  // previous behavior) leaked OPENAI_API_KEY, AWS_*, GITHUB_TOKEN, etc.
  // to the Claude subprocess. A model that can be tricked into reading
  // /proc/self/environ then has those secrets in-context and a clear path
  // to exfiltrate them. We pass only what the SDK actually needs:
  //   - PATH/HOME/USER/LANG/TZ/TMPDIR + term: required for CLI subprocess
  //     bookkeeping (git invocations, locale-aware tools, tmpfile paths).
  //   - The ONE Claude auth credential the SDK uses. We prefer
  //     CLAUDE_CODE_OAUTH_TOKEN when present; otherwise ANTHROPIC_API_KEY.
  //     Never both.
  //   - CLAUDE_AGENT_SDK_CLIENT_APP for the SDK's User-Agent.
  const ENV_ALLOWLIST: readonly string[] = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'TERM',
    'TERMINFO',
    'SHELL',
  ]
  const subprocessEnv: Record<string, string | undefined> = {}
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key]
    if (typeof v === 'string') subprocessEnv[key] = v
  }
  if (cfg.oauthToken) {
    subprocessEnv.CLAUDE_CODE_OAUTH_TOKEN = cfg.oauthToken
  } else if (cfg.apiKey) {
    subprocessEnv.ANTHROPIC_API_KEY = cfg.apiKey
  }
  subprocessEnv.CLAUDE_AGENT_SDK_CLIENT_APP = 'kazoo/0.0.0'

  const options: Options = {
    cwd: cfg.policy.cwd,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    permissionMode: cfg.policy.permissionMode,
    canUseTool,
    env: subprocessEnv,
    stderr: (data) => {
      // CLI subprocess stderr — useful for diagnosing SDK weirdness.
      const text = data.trim()
      if (text) logger.debug({ stderr: text }, 'executor: cli stderr')
    },
  }

  // Packaged-build only: point the SDK at the unpacked native binary. In dev
  // `cfg.executablePath` is undefined and the SDK's default resolution runs.
  // (SURFACE_PLAN §A / Risk #1.)
  if (cfg.executablePath) {
    options.pathToClaudeCodeExecutable = cfg.executablePath
    logger.info({ executablePath: cfg.executablePath }, 'executor: using explicit SDK executable')
  }

  logger.info(
    { model: cfg.model, cwd: cfg.policy.cwd, permissionMode: cfg.policy.permissionMode },
    'executor: starting query session',
  )

  let q: Query
  try {
    q = query({ prompt: asyncIterable(userMessages), options })
  } catch (err) {
    throw new KazooError('executor/sdk', 'executor: failed to start query', err)
  }

  // Background consumer — pulls SDKMessages, maps, emits. Never blocks
  // submit() or close(). On error OR natural end we set `consumerDead`
  // so subsequent `submit()`s fail loudly instead of hanging forever
  // (the orchestrator was previously waiting on events that would never
  // come).
  void (async () => {
    try {
      for await (const msg of q) {
        if (closed) break
        for (const ev of mapSDKMessage(msg, logger)) {
          // Track turn liveness for cancelTurn's terminal-event synthesis
          // (SUPERVISOR_SPEC §3c.1). A real `turn-done` (including the one
          // produced when `interrupt()` makes the SDK emit a `result`) clears
          // the flag, which suppresses the synthesized fallback.
          turnActive = ev.type !== 'turn-done'
          try {
            cfg.onEvent(ev)
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'executor: onEvent threw',
            )
          }
        }
      }
      if (!closed) {
        consumerDead = true
        consumerDeathReason = 'consumer loop ended (SDK closed iterator)'
        logger.warn({ reason: consumerDeathReason }, 'executor: consumer ended unexpectedly')
        try {
          cfg.onEvent({ type: 'executor-error', message: consumerDeathReason })
        } catch {
          /* swallow */
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      consumerDead = true
      consumerDeathReason = message
      logger.error({ err: message }, 'executor: consumer loop errored')
      try {
        cfg.onEvent({ type: 'executor-error', message })
      } catch {
        /* swallow */
      }
    } finally {
      logger.info('executor: consumer loop ended')
    }
  })()

  return {
    submit(text: string): void {
      if (closed) return
      const trimmed = text.trim()
      if (!trimmed) return
      if (consumerDead) {
        // SDK died; don't enqueue (the SDK won't read it). Surface the
        // failure each time so the orchestrator transitions out of
        // 'working' instead of waiting forever for a turn-done.
        const reason = consumerDeathReason ?? 'consumer loop ended'
        logger.warn({ reason }, 'executor: submit dropped — consumer dead')
        try {
          cfg.onEvent({ type: 'executor-error', message: `executor unavailable: ${reason}` })
        } catch {
          /* swallow */
        }
        return
      }
      logger.info({ text: trimmed.slice(0, 200) }, 'executor: submit')
      userMessages.push({
        type: 'user',
        message: { role: 'user', content: trimmed },
        parent_tool_use_id: null,
      })
    },
    cancelTurn(opts?: CancelTurnOptions): void {
      if (closed) return
      const dropQueue = opts?.dropQueue === true
      logger.info({ dropQueue }, 'executor: cancelTurn')

      // Drop everything / cancel all: drain pending (not-yet-started) turns so
      // they don't run after the stop (SUPERVISOR_SPEC §3c.3).
      if (dropQueue) {
        const dropped = userMessages.clear()
        if (dropped > 0) logger.info({ dropped }, 'executor: drained pending turns')
      }

      // Snapshot whether a turn was in flight BEFORE interrupting. `interrupt()`
      // is idempotent/safe on an idle query (it may reject — swallowed below),
      // so a double-stop (reflexive guard + tool race, §3a) is harmless.
      const wasActive = turnActive

      void q
        .interrupt()
        .then(() => {
          // §3c.1: if the SDK yielded a `result` for the interrupt, its own
          // `turn-done` already cleared `turnActive` and reset the orchestrator
          // to listening. If `turnActive` is STILL true here, `interrupt()`
          // produced no terminal event — synthesize one so state always
          // resets and the spoken "Stopped" doesn't lie.
          if (wasActive && turnActive && !closed) {
            turnActive = false
            logger.info('executor: interrupt yielded no result; synthesizing turn-done')
            try {
              cfg.onEvent({ type: 'turn-done', finalForTask: false })
            } catch {
              /* swallow */
            }
          }
        })
        .catch((err: unknown) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'executor: interrupt threw',
          )
          // Even on a rejected interrupt, guarantee the state reset if a turn
          // was in flight — otherwise the orchestrator hangs in `working`.
          if (wasActive && turnActive && !closed) {
            turnActive = false
            try {
              cfg.onEvent({ type: 'turn-done', finalForTask: false })
            } catch {
              /* swallow */
            }
          }
        })
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      logger.info('executor: closing')
      userMessages.close()
      try {
        q.close()
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'executor: query.close threw',
        )
      }
    },
  }
}

// Wrap our AsyncQueue in something that matches AsyncIterable<SDKUserMessage>
// in a way the SDK's iteration code can use directly.
function asyncIterable(queue: AsyncQueue<SDKUserMessage>): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  }
}

// SDK message → 0..N ExecutorEvents. Pure function; safe to test in isolation.
function mapSDKMessage(msg: SDKMessage, logger: Logger): ExecutorEvent[] {
  const events: ExecutorEvent[] = []

  if (msg.type === 'assistant') {
    const content = msg.message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          const text = block.text.trim()
          if (text) {
            events.push({ type: 'assistant-text', text, messageId: msg.uuid })
          }
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool-use',
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
          })
        }
      }
    }
    return events
  }

  if (msg.type === 'user') {
    // Synthetic user messages carry tool_result blocks (the SDK feeds the
    // tool's output back into the conversation as a user-role message).
    const content = msg.message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue
        if ((block as { type?: string }).type === 'tool_result') {
          const tr = block as {
            tool_use_id?: string
            is_error?: boolean
            content?: unknown
          }
          if (!tr.tool_use_id) continue
          events.push({
            type: 'tool-result',
            toolUseId: tr.tool_use_id,
            isError: tr.is_error === true,
            content: stringifyToolResult(tr.content),
          })
        }
      }
    }
    return events
  }

  if (msg.type === 'result') {
    const isError = msg.subtype !== 'success'
    if (isError) {
      logger.warn({ subtype: msg.subtype }, 'executor: result subtype indicates failure')
    }
    events.push({ type: 'turn-done', finalForTask: !isError })
    return events
  }

  // Other SDKMessage variants (status, hooks, partial_assistant, etc.) are
  // not narration-relevant. Logged at debug for the curious.
  logger.debug({ type: msg.type }, 'executor: unhandled SDK message type')
  return events
}

function stringifyToolResult(content: unknown): string {
  let raw: string
  if (typeof content === 'string') {
    raw = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'object' && block !== null && 'text' in block) {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    raw = parts.join('\n')
  } else {
    return ''
  }
  // Cap size: tool outputs (a long Read, an `ls -R`, etc) can be huge.
  // Downstream consumers — narration, the bus, the log — don't need the
  // whole thing, and an attacker who can fill the context with megabytes
  // of crafted output has a memory-pressure vector. Truncate with a marker.
  if (raw.length <= MAX_TOOL_RESULT_BYTES) return raw
  return `${raw.slice(0, MAX_TOOL_RESULT_BYTES)}\n…[truncated; ${raw.length - MAX_TOOL_RESULT_BYTES} more chars]`
}

/** Path-scope check: does `rawPath` resolve to somewhere inside the
 *  workspace, accounting for relative paths, `..`, and symlinks?
 *
 *  Strategy: resolve relative paths against the workspace; then walk up
 *  the path until we find an existing component, realpath that, append
 *  the non-existent tail, and check the final string is the workspace or
 *  a child of it. This handles all of:
 *   - `/etc/passwd`              → realpath exists, not in workspace → deny
 *   - `../../etc/passwd`         → resolve climbs out → deny
 *   - `subdir/file-that-DNE.ts`  → walk up to existing parent, append tail → allow
 *   - `link-out -> /etc`         → realpath of the link target is /etc → deny */
function isInsideWorkspace(rawPath: string, workspaceReal: string): boolean {
  if (!rawPath) return false
  // Resolve relative paths against the workspace, not process.cwd. Even if
  // the SDK uses the workspace as cwd, explicit anchoring is clearer.
  const abs = resolve(workspaceReal, rawPath)

  // Walk up to the first existing prefix. realpath that. Append the
  // remaining (non-existent) suffix. Normalize and compare.
  let probe = abs
  let suffix = ''
  while (true) {
    try {
      const real = realpathSync(probe)
      const candidate = resolve(real + suffix)
      if (candidate === workspaceReal) return true
      return candidate.startsWith(workspaceReal + pathSep)
    } catch (err) {
      if (!isMissingPath(err)) return false
      const parent = dirname(probe)
      if (parent === probe) return false // hit filesystem root
      suffix = probe.slice(parent.length) + suffix
      probe = parent
    }
  }
}

function isMissingPath(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Public type re-exports so callers only import from this file. */
export type { ExecutorEvent, ExecutorEventHandler } from './events.ts'
export type { ExecutorPermissionPolicy } from './tools.ts'
