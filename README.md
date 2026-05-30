<p align="center">
  <img src="assets/logo.png" width="320" alt="Kazoo">
</p>

# Kazoo

> Talk to a coding agent and hear it think out loud.

Kazoo is a voice-native TUI coding agent. You hold a voice conversation with a real
coding agent: you speak a task, it does the work, and it narrates what it's doing —
semantically, in first person — instead of reading raw commands aloud.

## How it works

Two layers, one persona:

- **Narrator — ears + mouth.** OpenAI Realtime. Listens, handles barge-in, and voices
  the agent in a consistent first-person voice.
- **Executor — the brain.** The Claude Agent SDK. Reads, edits, and runs tools. Its
  streamed events are the source of truth the narrator describes.

The narrator never answers coding questions itself. It routes your spoken request to the
executor, then turns the executor's events ("opening the auth module," not
"cat src/auth.ts") into speech as the work happens.

## Stack

- **Runtime** — Bun + TypeScript
- **TUI** — Ink
- **Voice** — OpenAI Realtime API
- **Executor** — `@anthropic-ai/claude-agent-sdk`
- **Memory** — a markdown file recalled across sessions

## Status

🚧 Early scaffolding. The design lives in
[`voice-agent-plan.html`](./voice-agent-plan.html).
