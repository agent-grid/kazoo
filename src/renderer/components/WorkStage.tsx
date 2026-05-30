// WorkStage — THE HERO. The executor's real work: files touched, the current
// action, command output, results. NOT a transcript echo. (SURFACE_PLAN §6
// "executor work is the HERO".)
//
//   <CurrentActionBar>   sticky one-liner: what the agent is doing RIGHT NOW
//   <WorkFeed>           the ordered stream of typed work blocks
//   <ChangedFilesRail>   right gutter: session file ledger (± counts)
//
// Everything here is bound to the executor sub-stream of the bus, reduced into
// blocks by `store/reducer.ts`. This component is pure presentation over that
// derived state.

import { useEffect, useRef } from 'react'
import type { OrchestratorState } from '../../core/orchestrator/state.ts'
import type {
  ChangedFile,
  CommandBlock,
  DiffLine,
  ErrorBlock,
  FileEditBlock,
  FileReadBlock,
  ToolBlock,
  WorkBlock,
} from '../store/reducer.ts'

export type WorkStageProps = {
  currentAction: string | null
  fsm: OrchestratorState
  workFeed: WorkBlock[]
  changedFiles: ChangedFile[]
}

export function WorkStage(props: WorkStageProps): React.JSX.Element {
  return (
    <section className="work-stage">
      <CurrentActionBar action={props.currentAction} fsm={props.fsm} />
      <div className="stage-body">
        <WorkFeed blocks={props.workFeed} />
        <ChangedFilesRail files={props.changedFiles} />
      </div>
    </section>
  )
}

/** Sticky one-line "current action". Falls back to the FSM word when no live
 *  verb is set (cleared on turn-done / listening by the reducer). */
function CurrentActionBar(props: {
  action: string | null
  fsm: OrchestratorState
}): React.JSX.Element {
  const label = props.action ?? fsmLabel(props.fsm)
  const idle = props.action === null
  return (
    <div className={`current-action${idle ? ' idle' : ''}`}>
      <span className="arrow">▷</span>
      <span className="label">{label}</span>
      <span className="fsm">{props.fsm}</span>
    </div>
  )
}

function fsmLabel(fsm: OrchestratorState): string {
  switch (fsm) {
    case 'idle':
      return 'idle — start a call to begin'
    case 'listening':
      return 'listening…'
    case 'user-speaking':
      return 'hearing you out…'
    case 'working':
      return 'working…'
    case 'narrating':
      return 'narrating…'
    case 'wrapping-up':
      return 'wrapping up…'
    case 'ended':
      return 'call ended'
    default:
      return fsm
  }
}

/** The block stream, auto-scrolled to follow the newest work. */
function WorkFeed(props: { blocks: WorkBlock[] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Follow the tail as new blocks land — the agent's latest move stays visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on count change
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [props.blocks.length])

  if (props.blocks.length === 0) {
    return (
      <div className="work-feed scroll" ref={ref}>
        <div className="work-feed-empty">No work yet — the executor's actions appear here.</div>
      </div>
    )
  }
  return (
    <div className="work-feed scroll" ref={ref}>
      {props.blocks.map((b) => (
        <WorkBlockView key={b.id} block={b} />
      ))}
    </div>
  )
}

function WorkBlockView(props: { block: WorkBlock }): React.JSX.Element {
  const { block } = props
  switch (block.kind) {
    case 'file-edit':
      return <FileEditView block={block} />
    case 'file-read':
      return <FileReadView block={block} />
    case 'command':
      return <CommandView block={block} />
    case 'tool':
      return <ToolView block={block} />
    case 'error':
      return <ErrorView block={block} />
    default: {
      const _never: never = block
      void _never
      return <span />
    }
  }
}

function FileEditView(props: { block: FileEditBlock }): React.JSX.Element {
  const { block } = props
  return (
    <div className={`block${block.status === 'error' ? ' error-state' : ''}`}>
      <div className="block-head">
        <span className="glyph">✎</span>
        <span className="path">{block.filePath}</span>
        <span className="count">
          +{block.adds} −{block.dels}
        </span>
        <StatusTag status={block.status} />
      </div>
      <DiffView diff={block.diff} />
    </div>
  )
}

function DiffView(props: { diff: DiffLine[] }): React.JSX.Element {
  if (props.diff.length === 0) {
    return <div className="peek">(no textual change)</div>
  }
  // Cap the rendered diff so a giant Write doesn't blow the layout; the count
  // in the head already conveys magnitude.
  const shown = props.diff.slice(0, 60)
  const more = props.diff.length - shown.length
  return (
    <pre className="diff">
      {shown.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
        <div key={`d-${i}`} className={`line ${diffClass(line.sign)}`}>
          {line.sign}
          {line.text}
        </div>
      ))}
      {more > 0 && <div className="line ctx"> …{more} more lines</div>}
    </pre>
  )
}

function diffClass(sign: DiffLine['sign']): string {
  return sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx'
}

function FileReadView(props: { block: FileReadBlock }): React.JSX.Element {
  const { block } = props
  return (
    <div className={`block${block.status === 'error' ? ' error-state' : ''}`}>
      <div className="block-head">
        <span className="glyph">⌕</span>
        <span className="path">
          {block.toolName} {block.target}
        </span>
        <StatusTag status={block.status} />
      </div>
      {block.peek !== null && block.peek.length > 0 && <pre className="peek">{block.peek}</pre>}
    </div>
  )
}

function CommandView(props: { block: CommandBlock }): React.JSX.Element {
  const { block } = props
  return (
    <div className={`block${block.status === 'error' ? ' error-state' : ''}`}>
      <div className="command-line">
        <span className="prompt">$</span>
        {block.command}
      </div>
      {block.output !== null && block.output.length > 0 && (
        <pre className={`output${block.status === 'error' ? ' error-out' : ''}`}>
          {block.output}
        </pre>
      )}
      <div
        className="block-head"
        style={{ borderBottom: 'none', borderTop: '1px solid var(--line)' }}
      >
        <StatusTag status={block.status} />
      </div>
    </div>
  )
}

function ToolView(props: { block: ToolBlock }): React.JSX.Element {
  const { block } = props
  return (
    <div className={`block${block.status === 'error' ? ' error-state' : ''}`}>
      <div className="block-head">
        <span className="glyph">⚙</span>
        <span className="path">{block.toolName}</span>
        <StatusTag status={block.status} />
      </div>
      {block.summary.length > 0 && <pre className="peek">{block.summary}</pre>}
      {block.result !== null && block.result.length > 0 && (
        <pre className={`output${block.status === 'error' ? ' error-out' : ''}`}>
          {block.result}
        </pre>
      )}
    </div>
  )
}

function ErrorView(props: { block: ErrorBlock }): React.JSX.Element {
  return (
    <div className="block error-state">
      <div className="error-block">⚠ {props.block.message}</div>
    </div>
  )
}

function StatusTag(props: { status: WorkBlock['status'] }): React.JSX.Element {
  const glyph = props.status === 'ok' ? '✓' : props.status === 'error' ? '✗' : '◐'
  return <span className={`status ${props.status}`}>{glyph}</span>
}

/** Right gutter: the at-a-glance "what did it touch" ledger — the thing audio
 *  can never convey. (SURFACE_PLAN §6 ChangedFilesRail.) */
function ChangedFilesRail(props: { files: ChangedFile[] }): React.JSX.Element {
  return (
    <aside className="rail scroll">
      <div className="rail-title">Changed</div>
      {props.files.length === 0 ? (
        <div className="rail-empty">no files yet</div>
      ) : (
        <>
          {props.files.map((f) => (
            <div className="rail-item" key={f.path}>
              <span className="name">{baseName(f.path)}</span>
              <span className="meta">
                {f.readOnly ? (
                  <span className="read">read</span>
                ) : (
                  <>
                    <span className="add">+{f.adds}</span> <span className="del">−{f.dels}</span>
                  </>
                )}
              </span>
            </div>
          ))}
          <div className="rail-foot">{props.files.length} files</div>
        </>
      )}
    </aside>
  )
}

function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}
