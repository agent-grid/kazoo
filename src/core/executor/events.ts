// Normalized executor event surface.
//
// The Claude Agent SDK streams a rich message union (`SDKMessage`); we
// collapse it to a smaller, narration-shaped union here so the narration
// module never needs to know SDK internals. Mapping happens in `runner.ts`.

export type AssistantTextEvent = {
  type: 'assistant-text'
  /** The model's natural-language preamble — narration GOLD. */
  text: string
  /** Stable id from the SDK message, used for dedupe + correlation. */
  messageId: string
}

export type ToolUseEvent = {
  type: 'tool-use'
  toolUseId: string
  toolName: string
  /** Raw input the model passed to the tool. Render-aware narrators may
   *  inspect specific fields (path, command). */
  input: unknown
}

export type ToolResultEvent = {
  type: 'tool-result'
  toolUseId: string
  /** True if the tool reported an error / non-zero exit. */
  isError: boolean
  /** The textual outcome (file contents, stdout, etc.). May be large — the
   *  narration salience filter is responsible for summarizing. */
  content: string
}

export type TurnDoneEvent = {
  type: 'turn-done'
  /** Whether the agent finished a logical user-task vs. just one turn. */
  finalForTask: boolean
}

export type ExecutorErrorEvent = {
  type: 'executor-error'
  message: string
}

export type ExecutorEvent =
  | AssistantTextEvent
  | ToolUseEvent
  | ToolResultEvent
  | TurnDoneEvent
  | ExecutorErrorEvent

export type ExecutorEventHandler = (ev: ExecutorEvent) => void
