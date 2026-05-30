// Tests for persona prompt composition (SURFACE_PLAN §B narration modules).
//
// These assert the STRUCTURE/invariants of the composed prompts, not the prose:
// the supervisor prompt carries the supervisor rules, the executor prompt carries
// the safety rules but NOT the voice prefs, and both fold in optional memory.

import { describe, expect, it } from 'vitest'
import { executorSystemPrompt, realtimeInstructions } from './persona.ts'

const empty = { voicePrefs: '', projectFacts: '' }

describe('realtimeInstructions (supervisor prompt)', () => {
  it('is non-empty and includes the base persona + supervisor rules', () => {
    const out = realtimeInstructions(empty)
    expect(out.length).toBeGreaterThan(100)
    // Base persona present.
    expect(out).toContain('Kazoo')
    // The supervisor must carry the anti-fabrication "unbreakable rule" and
    // the delegate-on-unknown discipline (SUPERVISOR_SPEC §5).
    expect(out).toContain('unbreakable rule')
    expect(out).toContain('delegate_to_executor')
    expect(out.toLowerCase()).toContain('never make up a fact')
  })

  it('folds in voice preferences when present', () => {
    const out = realtimeInstructions({ voicePrefs: 'be terse and dry', projectFacts: '' })
    expect(out).toContain('be terse and dry')
    expect(out).toContain('Voice preferences')
  })

  it('folds in project facts when present', () => {
    const out = realtimeInstructions({ voicePrefs: '', projectFacts: 'API lives in src/server' })
    expect(out).toContain('API lives in src/server')
    expect(out).toContain('Project facts')
  })

  it('omits the preference sections when memory is blank', () => {
    const out = realtimeInstructions(empty)
    expect(out).not.toContain('Voice preferences')
    expect(out).not.toContain('Project facts')
  })

  it('ignores whitespace-only preferences', () => {
    const out = realtimeInstructions({ voicePrefs: '   ', projectFacts: '\n\t' })
    expect(out).not.toContain('Voice preferences')
    expect(out).not.toContain('Project facts')
  })
})

describe('executorSystemPrompt', () => {
  it('carries the safety rules (ambient-transcript framing, refusal)', () => {
    const out = executorSystemPrompt(empty)
    expect(out).toContain('SAFETY RULES')
    expect(out.toLowerCase()).toContain('transcript')
    expect(out.toLowerCase()).toContain('workspace')
  })

  it('folds in project facts but NOT voice preferences', () => {
    const out = executorSystemPrompt({
      voicePrefs: 'be terse',
      projectFacts: 'uses Biome not Prettier',
    })
    expect(out).toContain('uses Biome not Prettier')
    // The executor produces no speech, so voice prefs must not leak into it.
    expect(out).not.toContain('be terse')
    expect(out).not.toContain('Voice preferences')
  })
})
