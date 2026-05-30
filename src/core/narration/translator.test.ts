// Tests for the executor-event → spoken-phrase translator (SURFACE_PLAN §B:
// "Pure narration modules — translator, salience, persona").
//
// The translator is the harvest-preambles layer: assistant text becomes the
// narration verbatim; tool-use becomes a one-line semantic; only ERROR
// tool-results speak; final turn-done is a milestone.

import { describe, expect, it } from 'vitest'
import type { ExecutorEvent } from '../executor/events.ts'
import { createTranslator } from './translator.ts'

const t = createTranslator()

describe('assistant-text → preamble (verbatim, high salience)', () => {
  it('speaks the trimmed assistant text as a preamble', () => {
    const out = t.ingest({
      type: 'assistant-text',
      text: '  Let me check the config.  ',
      messageId: 'm1',
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.text).toBe('Let me check the config.')
    expect(out[0]?.source).toBe('preamble')
    expect(out[0]?.salience).toBeGreaterThanOrEqual(0.9)
  })

  it('drops empty assistant text', () => {
    expect(t.ingest({ type: 'assistant-text', text: '   ', messageId: 'm2' })).toEqual([])
  })

  it('truncates very long preambles with an ellipsis', () => {
    const long = 'x'.repeat(1000)
    const out = t.ingest({ type: 'assistant-text', text: long, messageId: 'm3' })
    expect(out[0]?.text.length).toBeLessThanOrEqual(400)
    expect(out[0]?.text.endsWith('…')).toBe(true)
  })
})

function toolUse(toolName: string, input: unknown): ExecutorEvent {
  return { type: 'tool-use', toolUseId: 'tu1', toolName, input }
}

describe('tool-use → one-line semantic + per-tool salience', () => {
  it('reads narrate by basename, low salience', () => {
    const out = t.ingest(toolUse('Read', { file_path: '/work/src/auth/login.ts' }))
    expect(out[0]?.text).toBe('Opening login.ts.')
    expect(out[0]?.source).toBe('tool-summary')
    expect(out[0]?.salience).toBeCloseTo(0.35, 6)
  })

  it('edits/writes get high salience', () => {
    expect(t.ingest(toolUse('Edit', { file_path: 'a/b/c.ts' }))[0]?.salience).toBeCloseTo(0.8, 6)
    expect(t.ingest(toolUse('Write', { file_path: 'x.ts' }))[0]?.text).toBe('Writing x.ts.')
  })

  it('bash prefers a description, else the command', () => {
    expect(
      t.ingest(toolUse('Bash', { description: 'run the linter', command: 'biome check' }))[0]?.text,
    ).toBe('Run the linter.')
    expect(t.ingest(toolUse('Bash', { command: 'ls -la' }))[0]?.text).toBe('Running `ls -la`.')
    expect(t.ingest(toolUse('Bash', { command: 'ls' }))[0]?.salience).toBeCloseTo(0.7, 6)
  })

  it('grep / glob narrate the pattern', () => {
    expect(t.ingest(toolUse('Grep', { pattern: 'TODO' }))[0]?.text).toBe(
      'Searching the code for "TODO".',
    )
    expect(t.ingest(toolUse('Glob', { pattern: '**/*.ts' }))[0]?.text).toBe(
      'Looking for files matching "**/*.ts".',
    )
  })

  it('falls back to a generic line for unknown tools', () => {
    expect(t.ingest(toolUse('SomeMcpTool', {}))[0]?.text).toBe('Using SomeMcpTool.')
    expect(t.ingest(toolUse('SomeMcpTool', {}))[0]?.salience).toBeCloseTo(0.5, 6)
  })
})

describe('tool-result → only errors speak', () => {
  it('emits nothing for a successful result', () => {
    expect(
      t.ingest({ type: 'tool-result', toolUseId: 'tu1', isError: false, content: 'ok' }),
    ).toEqual([])
  })

  it('emits a high-salience error phrase for a failed result', () => {
    const out = t.ingest({
      type: 'tool-result',
      toolUseId: 'tu1',
      isError: true,
      content: 'permission denied',
    })
    expect(out[0]?.source).toBe('error')
    expect(out[0]?.salience).toBeGreaterThanOrEqual(0.9)
    expect(out[0]?.text).toContain('permission denied')
  })
})

describe('turn-done → milestone only when final', () => {
  it('says "Done." on a final turn', () => {
    const out = t.ingest({ type: 'turn-done', finalForTask: true })
    expect(out[0]?.text).toBe('Done.')
    expect(out[0]?.salience).toBe(1.0)
  })

  it('stays silent on a non-final turn-done (e.g. synthesized cancel)', () => {
    expect(t.ingest({ type: 'turn-done', finalForTask: false })).toEqual([])
  })
})

describe('executor-error → spoken error', () => {
  it('voices the executor failure at top salience', () => {
    const out = t.ingest({ type: 'executor-error', message: 'consumer loop ended' })
    expect(out[0]?.source).toBe('error')
    expect(out[0]?.salience).toBe(1.0)
    expect(out[0]?.text).toContain('consumer loop ended')
  })
})
