// ConversationStrip — the SECONDARY region: the spoken turns, compact and
// de-emphasized. Explicitly NOT the hero — work is (SURFACE_PLAN §6 "transcript
// secondary"). Capped to ~22vh via CSS; auto-scrolls to the latest turn.
//
//   user turns      ← realtime.caption (role==='user', final) — reducer
//   assistant turns ← narration-spoken (the exact phrase voiced) — reducer

import { useEffect, useRef } from 'react'
import type { Turn } from '../store/reducer.ts'

export function ConversationStrip(props: { turns: Turn[] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on count change
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [props.turns.length])

  return (
    <section className="conversation scroll" ref={ref}>
      {props.turns.length === 0 ? (
        <div className="conversation-empty">conversation will appear here</div>
      ) : (
        props.turns.map((t) => <TurnView key={t.id} turn={t} />)
      )}
    </section>
  )
}

function TurnView(props: { turn: Turn }): React.JSX.Element {
  const { turn } = props
  const isUser = turn.role === 'user'
  return (
    <div className={`turn ${turn.role}`}>
      <span className="who">{isUser ? 'you' : 'kazoo'}</span>
      <span className="glyph">{isUser ? '▸' : '◍'}</span>
      <span className="text">{turn.text}</span>
    </div>
  )
}
