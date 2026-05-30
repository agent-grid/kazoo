// Tests for the renderer's PCM16 conversions (SURFACE_PLAN §B).
//
// "renderer/audio/pcm.ts — Int16↔Float32 round-trip, clipping bounds
// (-0x8000 / 0x7FFF)." These run in the `node` vitest environment — the module
// is pure typed-array math with no DOM/Buffer dependency (that's the whole point
// of splitting it out of the deleted audio/format.ts).

import { describe, expect, it } from 'vitest'
import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  durationMs,
  float32ToInt16,
  int16ToFloat32,
  SAMPLE_RATE_HZ,
} from './pcm.ts'

describe('pcm wire constants', () => {
  it('match the OpenAI Realtime wire format (PCM16 mono 24kHz)', () => {
    expect(SAMPLE_RATE_HZ).toBe(24000)
    expect(BYTES_PER_SAMPLE).toBe(2)
    expect(CHANNELS).toBe(1)
  })
})

describe('float32ToInt16 — clipping bounds', () => {
  it('maps +1.0 to the top of the Int16 range (0x7FFF), not overflow', () => {
    const out = float32ToInt16(new Float32Array([1]))
    expect(out[0]).toBe(0x7fff)
  })

  it('maps -1.0 to the bottom of the Int16 range (-0x8000)', () => {
    const out = float32ToInt16(new Float32Array([-1]))
    expect(out[0]).toBe(-0x8000)
  })

  it('maps 0 to 0', () => {
    const out = float32ToInt16(new Float32Array([0]))
    expect(out[0]).toBe(0)
  })

  it('clamps out-of-range values rather than wrapping', () => {
    const out = float32ToInt16(new Float32Array([5, -5, 2.5, -100]))
    expect(out[0]).toBe(0x7fff)
    expect(out[1]).toBe(-0x8000)
    expect(out[2]).toBe(0x7fff)
    expect(out[3]).toBe(-0x8000)
  })

  it('never exceeds Int16 limits across a swept range', () => {
    const n = 2001
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = -1.5 + (3 * i) / (n - 1) // -1.5 .. +1.5
    const out = float32ToInt16(input)
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-0x8000)
      expect(v).toBeLessThanOrEqual(0x7fff)
    }
  })

  it('treats undefined slots as 0 (defensive ?? 0)', () => {
    // A sparse-ish array still yields a full Int16Array of the same length.
    const out = float32ToInt16(new Float32Array(3))
    expect(out.length).toBe(3)
    expect([...out]).toEqual([0, 0, 0])
  })
})

describe('int16ToFloat32', () => {
  it('maps the Int16 extremes back into [-1, 1)', () => {
    const out = int16ToFloat32(new Int16Array([0x7fff, -0x8000, 0]))
    expect(out[0]).toBeCloseTo(0x7fff / 0x8000, 6)
    expect(out[1]).toBe(-1)
    expect(out[2]).toBe(0)
  })

  it('keeps every output sample within [-1, 1]', () => {
    const input = new Int16Array([-0x8000, -1234, 0, 4567, 0x7fff])
    const out = int16ToFloat32(input)
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('round-trip Float32 → Int16 → Float32', () => {
  it('recovers values within ~one quantization step', () => {
    const input = new Float32Array([0, 0.25, -0.5, 0.999, -0.75])
    const round = int16ToFloat32(float32ToInt16(input))
    // float32ToInt16 truncates (no rounding) and uses an ASYMMETRIC scale
    // (·0x7fff for +, ·0x8000 for −), so worst-case error for a positive value
    // is just over one 1/0x8000 step. Bound at two steps — tight, but honest
    // about the truncation + asymmetry. (See B2 in the round-trip below.)
    const eps = 2 / 0x8000
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs((round[i] ?? 0) - (input[i] ?? 0))).toBeLessThan(eps)
    }
  })

  it('preserves length', () => {
    const input = new Float32Array(480) // one Realtime frame
    expect(int16ToFloat32(float32ToInt16(input)).length).toBe(480)
  })
})

describe('durationMs', () => {
  it('computes ms from sample count at the wire rate', () => {
    // 24000 samples @ 24kHz = 1000 ms.
    expect(durationMs(new Int16Array(24000))).toBe(1000)
    // 480 samples (one 20ms frame) = 20 ms.
    expect(durationMs(new Int16Array(480))).toBeCloseTo(20, 6)
    expect(durationMs(new Int16Array(0))).toBe(0)
  })

  it('respects an explicit sample rate override', () => {
    expect(durationMs(new Int16Array(48000), 48000)).toBe(1000)
  })
})
