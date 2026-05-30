// User + assistant turns, append-only. Scrolls with the conversation.

import { Box, Text } from 'ink'
import type { Turn } from './hooks.ts'

export type TranscriptPaneProps = {
  turns: Turn[]
}

export function TranscriptPane({ turns }: TranscriptPaneProps) {
  if (turns.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>— say something to begin —</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {turns.map((t, i) => {
        // Append-only transcript — turns never reorder, so the visual row
        // index is a stable identity. `t.at` is monotonic but not unique
        // across same-ms turns, so we combine it with the index.
        const key = `${t.at}-${i}`
        return (
          <Box key={key} flexDirection="column" marginBottom={1}>
            <Text bold color={t.role === 'user' ? 'cyan' : 'magenta'}>
              {t.role === 'user' ? 'you' : 'kazoo'}
            </Text>
            <Text>{t.text}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
