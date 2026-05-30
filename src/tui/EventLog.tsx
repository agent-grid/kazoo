// Live tail of the executor + realtime event stream. The "what's happening
// behind the voice" pane. Color-coded by source.

import { Box, Text } from 'ink'
import type { BusEvent } from '../orchestrator/bus.ts'

export type EventLogProps = {
  events: BusEvent[]
  rows?: number
}

export function EventLog({ events, rows = 12 }: EventLogProps) {
  const slice = events.slice(-rows)
  return (
    <Box flexDirection="column">
      {slice.map((ev, i) => {
        const color = colorFor(ev)
        // Append-only log with a capped tail — items don't reorder, so the
        // visual row index IS the stable identity. Component state per-row
        // is fine to recycle when the tail slides.
        const key = i
        return (
          <Text key={key} dimColor={ev.type === 'log'} {...(color ? { color } : {})}>
            {format(ev)}
          </Text>
        )
      })}
    </Box>
  )
}

function colorFor(ev: BusEvent): string | undefined {
  switch (ev.type) {
    case 'realtime':
      return 'cyan'
    case 'executor':
      return 'magenta'
    case 'narration-spoken':
      return 'yellow'
    case 'state':
      return 'green'
    default:
      return undefined
  }
}

function format(ev: BusEvent): string {
  switch (ev.type) {
    case 'realtime':
      return `RT  ${ev.event.type}`
    case 'executor':
      return `EX  ${ev.event.type}`
    case 'narration-spoken':
      return `NAR "${ev.text.slice(0, 80)}"`
    case 'state':
      return `ST  ${ev.state}`
    case 'log':
      return `LOG ${ev.level} ${ev.message}`
  }
}
