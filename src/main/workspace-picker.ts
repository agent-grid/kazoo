// Workspace picker — the dialog seam.
//
// The renderer's "change workspace" control invokes this through the preload
// bridge; everything that touches the filesystem stays in MAIN. The picked
// dir is canonicalized (realpath) and then run through `assertWorkspaceSafe`
// — the SAME guard that protects the boot-time `KAZOO_WORKSPACE`. So an
// operator clicking through to `/` or `~/.ssh` from the picker gets the
// same rejection a hostile env var would. (SURFACE_PLAN §7 — secrets and
// privileged surfaces stay in main; the renderer only sees the outcome.)
//
// We never throw across the IPC boundary. The handler returns a discriminated
// result the renderer can display verbatim, so a dialog cancellation, a
// realpath failure, and an unsafe-root rejection are all flat data.

import { realpathSync } from 'node:fs'
import { type BrowserWindow, dialog } from 'electron'
import { isKazooError } from '../core/lib/errors.ts'
import type { Logger } from '../core/lib/logger.ts'
import type { WorkspacePickResult } from '../shared/ipc-types.ts'
import { assertWorkspaceSafe } from './workspace.ts'

export type WorkspacePickerDeps = {
  window: BrowserWindow
  logger: Logger
}

/** Show the native `openDirectory` dialog, canonicalize the chosen path, and
 *  validate it against `assertWorkspaceSafe`. Returns a discriminated result
 *  the renderer can render directly — never throws. */
export async function pickWorkspace(deps: WorkspacePickerDeps): Promise<WorkspacePickResult> {
  const log = deps.logger.child({ mod: 'workspace-picker' })

  let dialogResult: Electron.OpenDialogReturnValue
  try {
    dialogResult = await dialog.showOpenDialog(deps.window, {
      title: 'Choose Kazoo workspace',
      // `openDirectory` is the macOS/Linux flag; `createDirectory` lets the
      // operator make a fresh dedicated dir from inside the picker on macOS.
      // Both are no-ops on platforms that don't support them, so this is the
      // standard cross-platform spelling.
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      buttonLabel: 'Use as workspace',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ err: message }, 'workspace-picker: showOpenDialog threw')
    return { ok: false, reason: 'error', message }
  }

  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return { ok: false, reason: 'cancelled' }
  }

  const picked = dialogResult.filePaths[0]
  if (!picked) {
    return { ok: false, reason: 'cancelled' }
  }

  // Canonicalize before the safety check — otherwise a symlink could be used
  // to dodge `assertWorkspaceSafe`'s blacklist (`~/safe-link → /`).
  let canonical: string
  try {
    canonical = realpathSync(picked)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ picked, err: message }, 'workspace-picker: realpath failed')
    return {
      ok: false,
      reason: 'invalid',
      message: `Couldn't resolve ${picked}: ${message}`,
    }
  }

  try {
    assertWorkspaceSafe(canonical)
  } catch (err) {
    const message = isKazooError(err)
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err)
    log.warn({ canonical, err: message }, 'workspace-picker: rejected unsafe root')
    return { ok: false, reason: 'unsafe', message }
  }

  return { ok: true, cwd: canonical }
}
