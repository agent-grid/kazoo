// Claude Agent SDK wrapper — the "brain".
//
// Responsibilities:
//   - Spin up a `query()` session against the SDK with our model + permission
//     policy + system prompt (persona + recalled memory).
//   - Forward user transcripts in as the next user message.
//   - Map SDK messages → our normalized `ExecutorEvent` union (see events.ts).
//   - Stay non-blocking. The orchestrator MUST be able to keep narrating
//     while a long tool call is in flight (plan §04).
//
// STATUS: interface + skeleton. Wiring to `@anthropic-ai/claude-agent-sdk`
// lands in the next PR alongside Phase 0.

import type { Logger } from '../lib/logger.ts'
import type { ExecutorEventHandler } from './events.ts'
import type { ExecutorPermissionPolicy } from './tools.ts'

export type ExecutorConfig = {
  apiKey: string
  model: string
  systemPrompt: string
  policy: ExecutorPermissionPolicy
  onEvent: ExecutorEventHandler
  logger: Logger
}

export type ExecutorRunner = {
  /** Submit a user-spoken task. Returns immediately; events stream via the
   *  `onEvent` handler. Calling while a turn is in flight queues. */
  submit: (text: string) => void
  /** Cancel the in-flight turn (does NOT close the session). */
  cancelTurn: () => void
  /** Tear down the SDK session. */
  close: () => Promise<void>
}

/** Construct a runner.
 *
 *  TODO(integration): bind to `@anthropic-ai/claude-agent-sdk`. The SDK
 *  exposes a `query()` async generator that yields `SDKMessage` objects;
 *  we want a long-lived session with `streamInput` so the user can submit
 *  multiple turns over the lifetime of one voice call.
 *
 *  Mapping sketch (lock down in the integration PR):
 *    - SDKAssistantMessage → emit `assistant-text` events for each text block.
 *    - SDKAssistantMessage tool_use block → `tool-use` event.
 *    - SDKUserMessage tool_result block → `tool-result` event.
 *    - SDKResultMessage → `turn-done` (finalForTask = !is_error).
 *
 *  The mapping function should be pure + unit-testable separately from the
 *  SDK lifecycle. */
export function createExecutor(_cfg: ExecutorConfig): ExecutorRunner {
  throw new Error('executor/runner: not implemented (next PR)')
}

/** Public type re-exports so callers only import from this file. */
export type { ExecutorEvent, ExecutorEventHandler } from './events.ts'
export type { ExecutorPermissionPolicy } from './tools.ts'
