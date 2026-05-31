// Tests for the executor-event → spoken-phrase translator (SURFACE_PLAN §B:
// "Pure narration modules — translator, salience, persona").
//
// The translator is the harvest-preambles layer: assistant text becomes the
// narration verbatim; tool-use becomes a one-line semantic; only ERROR
// tool-results speak; final turn-done is a milestone.
//
// Hard invariant tested here: bash is NEVER voiced as a raw command — no
// backticks, no flags, no paths in the spoken text. Description if present,
// otherwise a semantic phrase derived from the leading verb.

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
  it('reads narrate by basename, low salience, kind=read', () => {
    const out = t.ingest(toolUse('Read', { file_path: '/work/src/auth/login.ts' }))
    expect(out[0]?.text).toBe('Opening login.ts.')
    expect(out[0]?.source).toBe('tool-summary')
    expect(out[0]?.salience).toBeCloseTo(0.35, 6)
    expect(out[0]?.kind).toBe('read')
  })

  it('edits/writes get high salience and kind=edit', () => {
    const edit = t.ingest(toolUse('Edit', { file_path: 'a/b/c.ts' }))[0]
    expect(edit?.salience).toBeCloseTo(0.8, 6)
    expect(edit?.kind).toBe('edit')
    const write = t.ingest(toolUse('Write', { file_path: 'x.ts' }))[0]
    expect(write?.text).toBe('Writing x.ts.')
    expect(write?.kind).toBe('edit')
  })

  describe('bash — semantic phrasing, never raw commands', () => {
    it('prefers the model description when provided', () => {
      const out = t.ingest(
        toolUse('Bash', { description: 'run the linter', command: 'biome check' }),
      )
      expect(out[0]?.text).toBe('Run the linter.')
      expect(out[0]?.kind).toBe('shell')
    })

    it('never includes a backtick or the raw command string', () => {
      const cases: Array<{ command: string }> = [
        { command: 'ls -la' },
        { command: 'find . -type f -name "*.ts"' },
        { command: 'grep -R "TODO" src/' },
        { command: 'cat /etc/hosts' },
        { command: 'git status' },
        { command: 'bun test --watch' },
        { command: 'rm -rf node_modules' },
        { command: 'sudo FOO=bar mkdir -p /tmp/x' },
      ]
      for (const c of cases) {
        const out = t.ingest(toolUse('Bash', { command: c.command }))[0]
        expect(out, `phrase for ${c.command}`).toBeTruthy()
        expect(out?.text).not.toContain('`')
        expect(out?.text.toLowerCase()).not.toContain(c.command.toLowerCase())
        expect(out?.kind).toBe('shell')
      }
    })

    it('maps representative verbs to semantic phrases', () => {
      const cases: Array<[string, string]> = [
        ['ls -la', 'Looking through the project files.'],
        ['find . -type f', 'Looking through the project files.'],
        ['tree -L 2', 'Looking through the project files.'],
        ['grep -R TODO src/', 'Searching the code.'],
        ['rg --files', 'Searching the code.'],
        ['cat README.md', 'Taking a look at a file.'],
        ['head -n 20 foo.ts', 'Taking a look at a file.'],
        ['git status', "Checking what's changed."],
        ['git log --oneline', "Checking what's changed."],
        ['git diff HEAD', "Checking what's changed."],
        ['git commit -m "wip"', 'Saving the work in git.'],
        ['bun test', 'Running the tests.'],
        ['npm test', 'Running the tests.'],
        ['vitest run', 'Running the tests.'],
        ['pytest -q', 'Running the tests.'],
        ['go test ./...', 'Running the tests.'],
        ['tsc -b', 'Building the project.'],
        ['npm run build', 'Building the project.'],
        ['pwd', 'Getting my bearings.'],
        ['which node', 'Getting my bearings.'],
        ['mkdir -p foo/bar', 'Setting up some files.'],
        ['touch foo.ts', 'Setting up some files.'],
        ['cp a b', 'Setting up some files.'],
        ['rm -rf dist', 'Cleaning up some files.'],
        ['chmod +x run.sh', 'Adjusting file permissions.'],
      ]
      for (const [command, expected] of cases) {
        const out = t.ingest(toolUse('Bash', { command }))[0]
        expect(out?.text, `phrase for ${command}`).toBe(expected)
      }
    })

    it('read-only bash → low salience, mutating bash → high salience', () => {
      // Exploration / read-only verbs
      const explore = ['ls', 'find .', 'grep TODO', 'cat foo.ts', 'pwd', 'git status', 'git log']
      for (const c of explore) {
        const out = t.ingest(toolUse('Bash', { command: c }))[0]
        expect(out?.salience, `salience for ${c}`).toBeCloseTo(0.35, 6)
      }
      // Side-effectful verbs
      const mutate = [
        'rm -rf dist',
        'mkdir foo',
        'touch x',
        'mv a b',
        'chmod +x run.sh',
        'bun test',
        'npm run build',
        'git commit -m wip',
        'git push',
      ]
      for (const c of mutate) {
        const out = t.ingest(toolUse('Bash', { command: c }))[0]
        expect(out?.salience, `salience for ${c}`).toBeCloseTo(0.7, 6)
      }
    })

    it('description-only bash without a command still narrates semantically', () => {
      const out = t.ingest(toolUse('Bash', { description: 'run a quick check' }))[0]
      expect(out?.text).toBe('Run a quick check.')
      expect(out?.text).not.toContain('`')
    })

    it('empty command and no description produces no phrase', () => {
      expect(t.ingest(toolUse('Bash', {}))).toEqual([])
    })
  })

  it('grep / glob narrate the pattern, with kind tags', () => {
    const grep = t.ingest(toolUse('Grep', { pattern: 'TODO' }))[0]
    expect(grep?.text).toBe('Searching the code for "TODO".')
    expect(grep?.kind).toBe('search')
    const glob = t.ingest(toolUse('Glob', { pattern: '**/*.ts' }))[0]
    expect(glob?.text).toBe('Looking for files matching "**/*.ts".')
    expect(glob?.kind).toBe('list')
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
