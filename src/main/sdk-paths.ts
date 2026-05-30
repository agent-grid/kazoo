// Resolve the Claude Agent SDK's native executable.
//
// The SDK ships NO `bin`/`cli.js` — `query()` spawns a ~230 MB native ELF
// (Mach-O / PE on other OSes) that lives in a SIBLING platform package,
// e.g. `@anthropic-ai/claude-agent-sdk-linux-x64/claude`. The SDK's default
// resolution finds it via the node_modules layout, but inside a packaged
// Electron app the binary lives under `app.asar.unpacked`, where the SDK's
// own `require.resolve` walk can't reach it. So we compute the path ourselves
// and pass it as `options.pathToClaudeCodeExecutable` (a real SDK option,
// confirmed at sdk.d.ts:1623).
//
//   - DEV / unpackaged: return `undefined` — let the SDK's default resolution
//     find `node_modules/@anthropic-ai/claude-agent-sdk-<plat>/claude`.
//   - PACKAGED (asar): compute the unpacked path from `process.resourcesPath`.
//     `asarUnpack` in electron-builder.yml mirrors the node_modules tree under
//     `app.asar.unpacked`, so the layout is identical — only the root moves.
//
// Naming follows the sibling-package convention (verified against the
// installed `-linux-x64` package.json): `claude-agent-sdk-<platform>-<arch>`,
// with a `-musl` suffix on musl libc. The binary file is always `claude`
// (`claude.exe` on win32).

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Build the sibling platform-package directory name for the current host.
 *  e.g. `claude-agent-sdk-linux-x64`, `claude-agent-sdk-darwin-arm64`,
 *  `claude-agent-sdk-linux-x64-musl`. */
function platformPackageName(): string {
  const platform = process.platform // 'linux' | 'darwin' | 'win32'
  const arch = process.arch // 'x64' | 'arm64'
  let name = `claude-agent-sdk-${platform}-${arch}`
  if (platform === 'linux' && isMusl()) name += '-musl'
  return name
}

/** Detect a musl libc (Alpine et al). `process.report` exposes the glibc
 *  version string on glibc systems; its absence implies musl. Conservative:
 *  any error → assume glibc (the common case), since the dev host here is
 *  glibc and packaged Linux builds target glibc by default. */
function isMusl(): boolean {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined
    return report?.header?.glibcVersionRuntime === undefined
  } catch {
    return false
  }
}

/** The native binary filename inside the platform package. */
function binaryFileName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

/** Resolve the absolute path to the native `claude` executable for a PACKAGED
 *  app, or `undefined` to defer to the SDK's default resolution (dev).
 *
 *  @param isPackaged  `app.isPackaged` from the caller (main keeps the
 *                     `electron` import; this module stays Electron-free so
 *                     it's unit-testable).
 *  @param resourcesPath  `process.resourcesPath` (the `Resources` dir holding
 *                     `app.asar` / `app.asar.unpacked`). */
export function resolveSdkExecutable(
  isPackaged: boolean,
  resourcesPath: string = process.resourcesPath,
): string | undefined {
  if (!isPackaged) return undefined

  const candidate = join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    platformPackageName(),
    binaryFileName(),
  )
  if (existsSync(candidate)) return candidate

  // The expected unpacked path is missing. Return `undefined` so the SDK's
  // own resolution gets a chance (and throws its descriptive "Native CLI
  // binary not found" error if it also fails) rather than us shadowing that
  // with a worse message.
  return undefined
}
