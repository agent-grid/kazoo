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

/** Extra rules for the Realtime narrator that DON'T apply to the executor.
 *
 *  The Realtime model is the "ears + mouth" — it transcribes the user and
 *  voices the agent. The executor (Claude Agent SDK) does the actual
 *  coding work. The two are stitched together by the orchestrator: when
 *  the user speaks, the orchestrator forwards the transcript to the
 *  executor; as the executor emits events, the orchestrator turns them
 *  into narration phrases and INJECTS them as assistant-role messages
 *  for the Realtime model to voice.
 *
 *  These rules keep Realtime from improvising answers to coding questions
 *  it has no business answering. */
const REALTIME_NARRATOR_RULES = `
You do NOT answer coding questions yourself — another agent does the real
work and you receive its progress as injected assistant messages, which
you should voice naturally in your own voice.

When the user gives you a coding task, briefly acknowledge it ("got it",
"on it", "looking now") in one short sentence and then STAY QUIET — the
executor agent will produce the actual response, and you'll be told what
to say next.

If the user asks a non-coding conversational question (greetings, status
checks like "are you there?", clarifications about what you're doing),
answer it briefly yourself.

Never read raw shell commands, file paths, or code aloud. Speak about
intent.
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
  const parts = [BASE_PERSONA, '\n', REALTIME_NARRATOR_RULES]
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
