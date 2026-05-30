// BrowserWindow creation + the renderer-side security perimeter.
// (SURFACE_PLAN §7.)
//
// Hardening:
//   - contextIsolation:true, nodeIntegration:false, sandbox:true, webSecurity:true
//     → the renderer has no Node/require/fs/env; only the frozen `window.kazoo`
//       surface the preload exposes.
//   - Mic permission handler in MAIN (must-fix #5): without it, packaged builds
//     silently DENY `media` and capture fails immediately. We allow only
//     `media` from our own renderer; everything else is denied.
//   - Production CSP via response headers (script/connect/worker = 'self').
//     Scoped to PROD only — applying it in dev would block electron-vite's HMR
//     websocket. In dev, electron-vite serves the renderer over its own origin.
//   - Navigation + window-open guards: no in-app navigation away from our
//     content, no popups. Belt-and-suspenders against a renderer compromise.

import { join } from 'node:path'
import { BrowserWindow, session, shell } from 'electron'

/** electron-vite injects the dev-server URL here in `dev`; it's undefined in a
 *  packaged build (we load the built `index.html` from disk instead). */
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL

export type CreateWindowResult = {
  window: BrowserWindow
}

export function createWindow(): CreateWindowResult {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0a0c0b', // matches the renderer --bg so there's no flash
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  installPermissionHandlers(window)
  installCsp()
  installNavigationGuards(window)

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return { window }
}

/** Allow ONLY `media` (mic), and only from our own window's web contents.
 *  Both the request handler (runtime prompt) and the check handler
 *  (synchronous `navigator.permissions` query) must agree, or capture is
 *  silently denied in packaged builds. */
function installPermissionHandlers(window: BrowserWindow): void {
  const ses = window.webContents.session
  const wcId = window.webContents.id

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = permission === 'media' && wc?.id === wcId
    callback(allowed)
  })

  ses.setPermissionCheckHandler((wc, permission) => {
    // wc is null for top-level checks from our own contents; allow `media`.
    return permission === 'media' && (wc === null || wc.id === wcId)
  })
}

/** Attach a strict CSP via response headers in PRODUCTION only. In dev, the
 *  electron-vite HMR websocket + inline dev assets need a looser policy, so we
 *  leave it to the dev server and skip injection. */
function installCsp(): void {
  if (DEV_SERVER_URL) return // dev — do not constrain HMR

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // Vite emits a single inlined style tag; allow inline styles only.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'", // AudioWorklet module fetch (mic worklet)
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

/** Deny all navigation away from our own content and all popups. The renderer
 *  is a fixed app surface — it never navigates and never opens windows. Any
 *  external URL (e.g. a rendered link) opens in the system browser instead. */
function installNavigationGuards(window: BrowserWindow): void {
  const wc = window.webContents

  wc.on('will-navigate', (event, url) => {
    const isDevServer = DEV_SERVER_URL !== undefined && url.startsWith(DEV_SERVER_URL)
    if (!isDevServer && !url.startsWith('file://')) {
      event.preventDefault()
    }
  })

  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // No webviews. (Defense-in-depth — we don't use <webview>, but block it.)
  wc.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
