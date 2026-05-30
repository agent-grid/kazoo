// Single-line status: state · mode · key hint.

import { Box, Text } from 'ink'
import type { NarrationMode } from '../narration/modes.ts'
import type { OrchestratorState } from '../orchestrator/state.ts'

export type StatusBarProps = {
  state: OrchestratorState
  mode: NarrationMode
}

export function StatusBar({ state, mode }: StatusBarProps) {
  return (
    <Box>
      <Text color={stateColor(state)}>{state.padEnd(14)}</Text>
      <Text dimColor>· mode </Text>
      <Text>{mode.padEnd(12)}</Text>
      <Text dimColor>· ^C to hang up</Text>
    </Box>
  )
}

function stateColor(s: OrchestratorState): string {
  switch (s) {
    case 'listening':
      return 'cyan'
    case 'user-speaking':
      return 'yellow'
    case 'working':
      return 'magenta'
    case 'narrating':
      return 'green'
    case 'wrapping-up':
    case 'ended':
      return 'red'
    default:
      return 'gray'
  }
}
