import { defineConfig } from 'vitest/config'

// Unit tests for the pure core modules (no Electron, no DOM). Per
// SURFACE_PLAN §B the security-critical bash-allowlist matcher, the pcm
// conversions, the narration modules, and the injector queue must be tested
// before P2 exit.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
