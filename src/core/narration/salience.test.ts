// Tests for the salience filter (SURFACE_PLAN §B narration modules).
//
// The filter drops phrases below a mode-dependent threshold: 'flow' speaks
// ≥0.4, 'high-level' speaks ≥0.7.

import { describe, expect, it } from 'vitest'
import { createSalienceFilter } from './salience.ts'
import type { NarrationPhrase } from './translator.ts'

function phrase(salience: number): NarrationPhrase {
  return { text: `p${salience}`, source: 'tool-summary', salience }
}

describe('createSalienceFilter', () => {
  it('flow mode keeps phrases >= 0.4', () => {
    const f = createSalienceFilter('flow')
    const out = f.filter([phrase(0.3), phrase(0.4), phrase(0.9)])
    expect(out.map((p) => p.salience)).toEqual([0.4, 0.9])
  })

  it('high-level mode keeps only phrases >= 0.7', () => {
    const f = createSalienceFilter('high-level')
    const out = f.filter([phrase(0.35), phrase(0.5), phrase(0.7), phrase(0.95)])
    expect(out.map((p) => p.salience)).toEqual([0.7, 0.95])
  })

  it('defaults to flow when no mode is given', () => {
    const f = createSalienceFilter()
    expect(f.filter([phrase(0.4)])).toHaveLength(1)
    expect(f.filter([phrase(0.39)])).toHaveLength(0)
  })

  it('setMode switches the threshold at runtime', () => {
    const f = createSalienceFilter('flow')
    expect(f.filter([phrase(0.5)])).toHaveLength(1)
    f.setMode('high-level')
    expect(f.filter([phrase(0.5)])).toHaveLength(0)
    f.setMode('flow')
    expect(f.filter([phrase(0.5)])).toHaveLength(1)
  })

  it('returns an empty array for empty input', () => {
    expect(createSalienceFilter('flow').filter([])).toEqual([])
  })
})
