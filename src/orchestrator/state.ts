// Tiny finite-state model for the call. Drives the status bar and gates
// what the orchestrator does next (e.g. don't inject narration while
// `user-speaking`; the speaker is muted for barge-in).

export type OrchestratorState =
  | 'idle' // before connect()
  | 'listening' // waiting for the user to speak
  | 'user-speaking' // mid-utterance — barge-in flushed speaker
  | 'working' // executor is running tools
  | 'narrating' // realtime is voicing a phrase
  | 'wrapping-up' // hangup in progress
  | 'ended'

export type StateTransition = {
  from: OrchestratorState
  to: OrchestratorState
  reason: string
}

export const VALID_TRANSITIONS: ReadonlyArray<readonly [OrchestratorState, OrchestratorState]> = [
  ['idle', 'listening'],
  ['listening', 'user-speaking'],
  ['listening', 'narrating'], // greeting / ack with no prior 'working'
  ['user-speaking', 'working'],
  ['user-speaking', 'listening'],
  ['working', 'narrating'],
  ['working', 'listening'],
  ['narrating', 'listening'],
  ['narrating', 'working'], // realtime response-done while executor still busy
  ['narrating', 'user-speaking'], // barge-in
  ['working', 'user-speaking'], // barge-in
  ['listening', 'wrapping-up'],
  ['working', 'wrapping-up'],
  ['narrating', 'wrapping-up'],
  ['wrapping-up', 'ended'],
]

export function canTransition(from: OrchestratorState, to: OrchestratorState): boolean {
  if (from === to) return true
  return VALID_TRANSITIONS.some(([f, t]) => f === from && t === to)
}
