import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Three targets from one config. electron-vite applies correct per-target
// defaults: main/preload are Node (CJS-friendly, deps externalized); renderer
// is ESM + DOM with React HMR. Output lands in `out/` for electron-builder.
//
// `externalizeDepsPlugin` keeps node_modules OUT of the main/preload bundles
// so the native Claude SDK ELF (resolved at runtime from the unpacked asar)
// and `ws`/`pino` load as real Node modules instead of being bundled.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // `package.json` has `"type":"module"`, which makes Vite default the
        // preload to ESM (`index.mjs`). But a SANDBOXED preload (sandbox:true)
        // MUST be CommonJS — Electron can't load an ESM preload under the
        // sandbox, and `window.ts` references `../preload/index.js`. Force CJS
        // + a `.js` extension so the reference resolves and the script loads.
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // The mic AudioWorklet is a SEPARATE entry so Rollup transpiles its
          // TS to JS and emits a stable `mic-worklet.js` next to the renderer
          // bundle. `capture.ts` then loads it with
          // `new URL('./mic-worklet.js', import.meta.url)` — a same-origin
          // fetch that passes the production CSP (`worker-src 'self'`). It must
          // NOT be inlined into the renderer bundle: `audioWorklet.addModule`
          // needs a real URL, and the worklet runs in its own global scope.
          'mic-worklet': resolve('src/renderer/audio/mic-worklet.ts'),
        },
        output: {
          // Keep entry filenames stable (no hash) so the `import.meta.url`
          // reference in capture.ts resolves to a predictable `mic-worklet.js`.
          entryFileNames: '[name].js',
        },
      },
    },
  },
})
