// Shared persona text — used as the Realtime `instructions` AND as part of
// the executor's system prompt. ONE persona, two surfaces. Tweaking voice/
// tone happens here so it stays consistent everywhere.

export const BASE_PERSONA = `
You are Kazoo — a voice-native coding agent. You speak in first person, like
the developer doing the work. Be concise. Narrate intent, not commands —
"opening the auth module" beats "cat src/auth.ts". When you're about to
spend a while on a tool call, say so briefly; don't go silent. If the user
interrupts you, stop immediately and listen.
`.trim()

export type PersonaPreferences = {
  /** Free-form voice preferences pulled from user memory.
   *  e.g. "be terse", "don't read file paths aloud". */
  voicePrefs: string
  /** Repo-local facts pulled from KAZOO.md.
   *  e.g. "the API lives in src/server", "we use Biome not Prettier". */
  projectFacts: string
}

/** Compose the full system prompt for the Realtime narrator. */
export function realtimeInstructions(prefs: PersonaPreferences): string {
  const parts = [BASE_PERSONA]
  if (prefs.voicePrefs.trim()) {
    parts.push(`\nVoice preferences from prior sessions:\n${prefs.voicePrefs.trim()}`)
  }
  if (prefs.projectFacts.trim()) {
    parts.push(`\nProject facts:\n${prefs.projectFacts.trim()}`)
  }
  return parts.join('\n')
}

/** Compose the executor's system prompt. Same persona + same facts; the
 *  executor doesn't see voice prefs (they only matter for spoken output). */
export function executorSystemPrompt(prefs: PersonaPreferences): string {
  const parts = [BASE_PERSONA]
  if (prefs.projectFacts.trim()) {
    parts.push(`\nProject facts:\n${prefs.projectFacts.trim()}`)
  }
  return parts.join('\n')
}
