// Top-level Ink layout. Three regions:
//   ┌─────────────────────────────────────────┐
//   │ TranscriptPane (flex 1, scrolls)        │
//   ├─────────────────────────────────────────┤
//   │ EventLog (fixed 12 rows)                │
//   ├─────────────────────────────────────────┤
//   │ StatusBar (single line)                 │
//   └─────────────────────────────────────────┘

import { Box, Text } from 'ink'
import { useState } from 'react'
import { DEFAULT_MODE, type NarrationMode } from '../narration/modes.ts'
import type { Bus } from '../orchestrator/bus.ts'
import { EventLog } from './EventLog.tsx'
import { useEventLog, useOrchestratorState, useTranscript } from './hooks.ts'
import { StatusBar } from './StatusBar.tsx'
import { TranscriptPane } from './TranscriptPane.tsx'

export type AppProps = {
  bus: Bus
}

export function App({ bus }: AppProps) {
  const turns = useTranscript(bus)
  const events = useEventLog(bus)
  const state = useOrchestratorState(bus)
  const [mode] = useState<NarrationMode>(DEFAULT_MODE)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>kazoo</Text>
        <Text dimColor> · voice-native coding agent</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <TranscriptPane turns={turns} />
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <EventLog events={events} />
      </Box>

      <Box marginTop={1}>
        <StatusBar state={state} mode={mode} />
      </Box>
    </Box>
  )
}
