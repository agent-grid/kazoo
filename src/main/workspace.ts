// Workspace safety — lifted verbatim from the old `cli.tsx` (pure logic, no
// surface coupling). Even with the runtime path-scope check inside
// `canUseTool`, scoping the executor's workspace at `/`, the operator's $HOME,
// or a sensitive system root would defeat the whole sandbox, so we refuse
// those roots before the executor ever starts.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { KazooError } from '../core/lib/errors.ts'

/** Paths the workspace dir must NOT be, post-realpath. Throws a
 *  `config/missing-env` `KazooError` if `workspace` is a forbidden root. */
export function assertWorkspaceSafe(workspace: string): void {
  if (workspace === '/' || workspace === '') {
    throw new KazooError(
      'config/missing-env',
      'KAZOO_WORKSPACE refuses to use the filesystem root.',
    )
  }
  const home = realpathSync(homedir())
  const forbidden = [
    home,
    resolvePath(home, '.ssh'),
    resolvePath(home, '.aws'),
    resolvePath(home, '.kube'),
    resolvePath(home, '.gnupg'),
    resolvePath(home, '.config'),
    '/etc',
    '/var',
    '/usr',
    '/sys',
    '/proc',
    '/dev',
    '/root',
    '/boot',
  ]
  for (const bad of forbidden) {
    if (workspace === bad) {
      throw new KazooError(
        'config/missing-env',
        `KAZOO_WORKSPACE refuses to scope itself to a sensitive root (${bad}). ` +
          'Pick a dedicated directory like ~/kazoo-workspace.',
      )
    }
  }
}
