// Mode = batching policy for narration. Two values today; room to grow.
//
//   `flow`        — live play-by-play. Speak each salient phrase as it
//                   arrives. Best for short tasks the user wants to follow
//                   beat by beat.
//   `high-level`  — let the executor work, then summarize at milestones.
//                   Best for long-running tasks where minute-by-minute
//                   narration would be noise.
//
// The user can toggle this mid-call via voice ("be quieter", "talk me
// through it"). The TUI also exposes it on the status bar.

export type NarrationMode = 'flow' | 'high-level'

export const DEFAULT_MODE: NarrationMode = 'flow'
