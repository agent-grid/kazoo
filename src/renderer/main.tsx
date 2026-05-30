// Renderer entry — mounts React into #root.
//
// Minimal for the P1 audio spine: it brings up the audio round-trip surface
// (Start/Stop + a live mic/output readout). The rich four-region terminal UI
// (Header / WorkStage / ConversationStrip / StatusBar) lands in P3; this file
// is the mount point it will grow into.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './theme.css'

const rootEl = document.getElementById('root')
if (rootEl === null) {
  throw new Error('renderer: #root not found')
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
