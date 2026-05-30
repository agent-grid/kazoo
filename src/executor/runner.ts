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
}

export type ExecutorRunner = {
  /** Submit a user-spoken task. Returns immediately; events stream via
   *  the `onEvent` handler. Calling while a turn is in flight queues. */
  submit: (text: string) => void
  /** Cancel the in-flight turn (does NOT close the session). */
  cancelTurn: () => void
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

  // canUseTool — enforces the bash allowlist. Everything non-bash is allowed
  // (acceptEdits handles file edits implicitly). Returning behavior:'allow'
  // for all non-Bash tools matches the "minimal/permissive" brief; harden
  // here when security-review lands.
  const canUseTool: CanUseTool = async (toolName, input, _options): Promise<PermissionResult> => {
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
    }
    return { behavior: 'allow', updatedInput: input }
  }

  // Build subprocess env. The SDK doc says `env` REPLACES process.env if
  // provided — so we have to spread it ourselves. Then layer our auth on top.
  const subprocessEnv: Record<string, string | undefined> = { ...process.env }
  if (cfg.oauthToken) subprocessEnv.CLAUDE_CODE_OAUTH_TOKEN = cfg.oauthToken
  if (cfg.apiKey) subprocessEnv.ANTHROPIC_API_KEY = cfg.apiKey
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
  // submit() or close(). Errors bubble out as an `executor-error` event.
  void (async () => {
    try {
      for await (const msg of q) {
        if (closed) break
        for (const ev of mapSDKMessage(msg, logger)) {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
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
      logger.info({ text: trimmed.slice(0, 200) }, 'executor: submit')
      userMessages.push({
        type: 'user',
        message: { role: 'user', content: trimmed },
        parent_tool_use_id: null,
      })
    },
    cancelTurn(): void {
      logger.info('executor: cancelTurn')
      void q.interrupt().catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'executor: interrupt threw',
        )
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
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'text' in block) {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** Public type re-exports so callers only import from this file. */
export type { ExecutorEvent, ExecutorEventHandler } from './events.ts'
export type { ExecutorPermissionPolicy } from './tools.ts'
