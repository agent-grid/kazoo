// Config-loader smoke tests — covers the two new knobs landed with the
// `gpt-realtime-2` upgrade: the model default flip, and the `reasoning_effort`
// parse/validate path (we want a typo to fail-fast in `loadConfig`, not later
// at the OpenAI session.update wire boundary).

import { describe, expect, it } from 'vitest'
import { loadConfig, REALTIME_REASONING_EFFORTS } from './config.ts'
import { isKazooError } from './lib/errors.ts'

const BASE_ENV: NodeJS.ProcessEnv = {
  OPENAI_API_KEY: 'sk-test',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
  // Pin memory paths into /tmp so the test never touches the operator's
  // ~/.kazoo files.
  KAZOO_USER_MEMORY_PATH: '/tmp/kazoo-test-user.md',
  KAZOO_PROJECT_MEMORY_PATH: '/tmp/kazoo-test-project.md',
  KAZOO_WORKSPACE: '/tmp/kazoo-test-workspace',
  KAZOO_LOG_FILE: '/tmp/kazoo-test.log',
}

describe('loadConfig — realtime model + reasoning_effort', () => {
  it('defaults the realtime model to gpt-realtime-2', () => {
    const cfg = loadConfig({ ...BASE_ENV })
    expect(cfg.realtime.model).toBe('gpt-realtime-2')
  })

  it('lets KAZOO_REALTIME_MODEL pin an older model', () => {
    const cfg = loadConfig({ ...BASE_ENV, KAZOO_REALTIME_MODEL: 'gpt-realtime' })
    expect(cfg.realtime.model).toBe('gpt-realtime')
  })

  it('defaults reasoning_effort to `low`', () => {
    const cfg = loadConfig({ ...BASE_ENV })
    expect(cfg.realtime.reasoningEffort).toBe('low')
  })

  it('accepts every documented effort level', () => {
    for (const effort of REALTIME_REASONING_EFFORTS) {
      const cfg = loadConfig({
        ...BASE_ENV,
        KAZOO_REALTIME_REASONING_EFFORT: effort,
      })
      expect(cfg.realtime.reasoningEffort).toBe(effort)
    }
  })

  it('uses `xhigh` (not `very-high`) as the documented top tier', () => {
    // Guard against accidental drift back to the old wrong on-wire value.
    expect(REALTIME_REASONING_EFFORTS).toContain('xhigh')
    expect((REALTIME_REASONING_EFFORTS as readonly string[])).not.toContain('very-high')
  })

  it('normalizes case (HIGH → high)', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      KAZOO_REALTIME_REASONING_EFFORT: 'HIGH',
    })
    expect(cfg.realtime.reasoningEffort).toBe('high')
  })

  it('aliases `very-high` → `xhigh` (the documented on-wire token)', () => {
    for (const alias of ['very-high', 'VERY-HIGH', 'veryhigh', 'very_high']) {
      const cfg = loadConfig({
        ...BASE_ENV,
        KAZOO_REALTIME_REASONING_EFFORT: alias,
      })
      expect(cfg.realtime.reasoningEffort).toBe('xhigh')
    }
  })

  it('rejects an unknown effort value with a KazooError', () => {
    let captured: unknown
    try {
      loadConfig({
        ...BASE_ENV,
        KAZOO_REALTIME_REASONING_EFFORT: 'turbo',
      })
    } catch (err) {
      captured = err
    }
    expect(isKazooError(captured)).toBe(true)
    if (isKazooError(captured)) {
      expect(captured.tag).toBe('config/missing-env')
      expect(captured.message).toContain('KAZOO_REALTIME_REASONING_EFFORT')
    }
  })
})
