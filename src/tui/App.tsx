// Top-level Ink layout. Three regions:
//   ┌─────────────────────────────────────────┐
//   │ TranscriptPane (flex 1, scrolls)        │
//   ├─────────────────────────────────────────┤
//   │ EventLog (fixed 12 rows)                │
//   ├─────────────────────────────────────────┤
//   │ StatusBar (single line)                 │
//   └─────────────────────────────────────────┘

import { Box, Text, useApp, useInput, useStdin } from 'ink'
import { useState } from 'react'
import { DEFAULT_MODE, type NarrationMode } from '../narration/modes.ts'
import type { Bus } from '../orchestrator/bus.ts'
import {
  BRAND_TEAL,
  KAZOO_GLYPH_BOTTOM,
  KAZOO_GLYPH_MID_DOTS,
  KAZOO_GLYPH_MID_LEFT,
  KAZOO_GLYPH_MID_RIGHT,
  KAZOO_GLYPH_TOP,
  KAZOO_WORDMARK,
} from './banner.ts'
import { EventLog } from './EventLog.tsx'
import { useEventLog, useOrchestratorState, useTranscript } from './hooks.ts'
import { StatusBar } from './StatusBar.tsx'
import { TranscriptPane } from './TranscriptPane.tsx'

export type AppProps = {
  bus: Bus
}

/** Startup banner — teal kazoo glyph + white pixel KAZOO wordmark.
 *  Matches assets/logo.png. The `···` inside the resonator box is
 *  static for now; it becomes the live speaking indicator later. */
function Banner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={BRAND_TEAL}>{KAZOO_GLYPH_TOP}</Text>
      <Box>
        <Text color={BRAND_TEAL}>{KAZOO_GLYPH_MID_LEFT}</Text>
        <Text color="white">{KAZOO_GLYPH_MID_DOTS}</Text>
        <Text color={BRAND_TEAL}>{KAZOO_GLYPH_MID_RIGHT}</Text>
      </Box>
      <Text color={BRAND_TEAL}>{KAZOO_GLYPH_BOTTOM}</Text>
      <Text color="white">{KAZOO_WORDMARK}</Text>
      <Text dimColor>voice-native coding agent</Text>
    </Box>
  )
}

export function App({ bus }: AppProps) {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const turns = useTranscript(bus)
  const events = useEventLog(bus)
  const state = useOrchestratorState(bus)
  const [mode] = useState<NarrationMode>(DEFAULT_MODE)

  // Subscribing to input puts stdin into raw mode, which is what keeps the
  // Ink process alive — without it the event loop drains and `bun dev` exits
  // immediately after the first paint. Also gives us a quit key. Guarded on
  // raw-mode support so piped/CI runs (no TTY) don't crash on mount.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') exit()
      else if (input === 'q') exit()
    },
    { isActive: isRawModeSupported === true },
  )

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner />

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
