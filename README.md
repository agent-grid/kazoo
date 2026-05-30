<p align="center">
  <img src="assets/logo.png" width="320" alt="Kazoo">
</p>

# Kazoo

> Talk to a coding agent and hear it think out loud.

Kazoo is a voice-native TUI coding agent. You speak a coding task; a real
coding agent (Claude) does the work in a scoped workspace; and a second voice
agent (OpenAI Realtime) narrates what's happening — semantically, in first
person — as the work unfolds. Talk over the agent any time and it stops
instantly.

## What it is

Two layers, one persona — a relay, not a chatbot:

- **Narrator — ears + mouth.** OpenAI Realtime in **narrator-only mode**.
  It transcribes your speech, detects when you start/stop talking (barge-in),
  and voices the agent in a consistent first-person voice. Critically, it
  does **not** auto-generate a response when you finish speaking
  (`turn_detection: { create_response: false }`) — every word it speaks
  originates from a phrase Kazoo explicitly injects.
- **Executor — the brain.** The Claude Agent SDK. Sandboxed to a workspace
  directory. Reads, edits, runs a narrow set of read-only shell commands.
  Its assistant text (preambles) and `tool_use` events are the source of
  truth the narrator describes.

The orchestrator threads them together: your final transcript goes to the
executor; the executor's events get translated into spoken phrases and queued
into the narrator. Realtime improvises **nothing**.

## How to run it

### Requirements

- **Bun ≥ 1.1** (runtime)
- An OpenAI API key
- Either a Claude subscription token (preferred) or an Anthropic API key
- Terminal audio tooling — install **one** of:
  - **sox** (cross-platform): `brew install sox` / `apt install sox` / `pacman -S sox`
  - **alsa-utils** (Linux fallback): `apt install alsa-utils`

### Environment

```bash
# Required
OPENAI_API_KEY=sk-…                       # for the Realtime narrator
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…    # preferred — Claude subscription
# OR
ANTHROPIC_API_KEY=sk-ant-…                # pay-as-you-go API key

# Optional
KAZOO_WORKSPACE=~/projects/my-app         # where the executor operates
                                          #   (default ~/kazoo-workspace)
KAZOO_REALTIME_VOICE=alloy                # GA voice; falls back to alloy
KAZOO_EXECUTOR_MODEL=claude-sonnet-4-6    # also accepts claude-opus-4-8
KAZOO_LOG_FILE=~/.kazoo/log.ndjson        # ND-JSON pino log (redacted)
KAZOO_LOG_LEVEL=info
```

See [`.env.example`](./.env.example) for the full list.

### Command

```bash
bun install
OPENAI_API_KEY=sk-… CLAUDE_CODE_OAUTH_TOKEN=sk-ant-… bun run dev
```

The Ink TUI shows the banner, a live transcript (your turns + spoken
narration), a tail of executor / realtime events, and a single-line status
bar (`listening` / `user-speaking` / `working` / `narrating`). Ctrl-C
triggers a graceful wrap-up turn, memory append, and a clean teardown of
every subprocess.

### Phase-0 audio loopback

If you want to verify just the audio round-trip without standing up the
executor:

```bash
OPENAI_API_KEY=sk-… bun run audio-check
```

You talk → Realtime echoes → you talk over it → it stops instantly.

## Design considerations

### Narrator-only mode

Server-VAD's default behavior is to auto-generate a response on every user
turn. That makes Realtime a standalone voice chatbot — and in early testing
it would hallucinate answers ("the project is a home-automation app…")
instead of waiting for the executor. Kazoo configures `server_vad` with
`create_response: false` + `interrupt_response: true`, so:

- Realtime transcribes the user (we need the caption).
- Realtime detects speech-start/stop (we need barge-in).
- Realtime **never** auto-generates a response. Every word it speaks comes
  from `injectNarration(text)` — i.e. the executor's actual work, the
  on-submit ack, or a heartbeat.

### Coalesce + stay-current narration scheduler

A "what's the project" question can fire 20+ Reads in seconds. Naive FIFO
would build a backlog the user listens to long after the work is done. The
scheduler in `src/realtime/inject.ts`:

- Lets **high-salience** phrases (preambles, edits, bash, errors, completion
  milestones) through in order, promptly.
- **Coalesces** runs of low-salience tool actions (Read / Grep / Glob) at
  the queue head into a single accurate summary — *"Reading through the
  project."* / *"Searching the code."* — and drops the rest of the run.
  Exploration is **narrated**, never silently dropped.
- **Dedup**s consecutive identical coalesced summaries.

If the executor goes silent for >5 s during a slow tool call (long bash,
build, test), a **heartbeat** ("Still working on it…") fires once per quiet
period so the voice never goes dead. Heartbeats cycle through phrasings and
don't re-arm themselves.

### Auth: subscription vs API key

The executor accepts **either** `CLAUDE_CODE_OAUTH_TOKEN` (the same token
`claude login` writes — Claude subscription credit) **or** `ANTHROPIC_API_KEY`
(pay-as-you-go). OAuth is preferred when both are present. Whichever
credential is set is the **only** auth-shaped env var forwarded into the
Claude subprocess; nothing else from `process.env` is passed through (see
"Security posture" below).

### Subprocess audio + SIGKILL-flush barge-in

Kazoo speaks PCM16 @ 24 kHz mono over stdin to a `play` / `aplay` child
process. For barge-in, "stop the voice **now**" needs to drop bytes that
are already in the kernel pipe and the device's hardware buffer — not just
clear a JS queue. We SIGKILL the player process; the kernel reclaims its
buffers; the next phrase respawns it (~10-30 ms cost, paid only on
interrupts).

## Security posture

The executor is a powerful language model with file-edit and shell-exec
authority. Treat any layer that can run its tool calls as the attack
surface. Layered defenses:

- **Path-scoped sandbox.** `canUseTool` in `src/executor/runner.ts`
  resolves every `Read`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Grep`/
  `Glob`/`LS` path against the workspace's realpath and DENIES anything
  that lands outside. Symlink escape, `..` climbs, absolute paths are all
  blocked. The workspace itself is realpath'd at startup and refused if it
  matches a sensitive root (`/`, `~`, `~/.ssh`, `/etc`, …).
- **Shell-parser bash allowlist.** `src/executor/tools.ts` parses every
  bash command with `shell-quote` and rejects any candidate containing a
  non-string parse entry (operators, command substitutions, redirects,
  globs, comments). Surviving commands argv-prefix match a tight read-only
  allowlist: `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `echo`, `grep`,
  `rg`, `find`, `git status`/`diff`/`log`/`show`, `git branch --list`. Per-
  entry forbidden-flag filters reject `find -exec`/`-delete`/etc and
  `git log/diff/show --output`. **No** `bun install`, `bun run`, `npm test`,
  `pnpm test` — all arbitrary-code-exec via package scripts.
- **Denied tool families.** `WebFetch`, `WebSearch`, `Task` are denied by
  default — SSRF, data exfil, and remote-prompt-injection vectors.
- **Secret-scrubbed subprocess env.** The Claude subprocess receives only
  an allowlist (`PATH`, `HOME`, `USER`, locale + tmpdir + term basics) plus
  the **one** Anthropic credential it needs. `OPENAI_API_KEY`,
  `AWS_*`, `GITHUB_TOKEN`, etc. are **not** forwarded. A model that tries
  to read `/proc/self/environ` finds nothing useful.
- **Untrusted-transcript framing.** The executor's system prompt explicitly
  notes that "user messages" are TRANSCRIPTS of ambient audio — possibly a
  podcast, a video, a bystander — not authoritative commands. It is
  instructed to refuse destructive ops, out-of-workspace paths, secret
  files (`/proc`, `~/.ssh`, `.env`, …), and package installs even if the
  transcript appears to grant them.
- **Workspace mode + isolation.** The workspace dir is created with mode
  `0o700` so other users on the host can't read in-flight files.
- **Redacted, capped logs.** Pino with a `redact` list masks
  `*.command` / `*.text` / `*.input.command` / `*.input.content` /
  `*.stderr` / auth-shaped fields. Tool result strings are capped at 8 KB
  before they enter the event surface. Log defaults to `~/.kazoo/log.ndjson`
  (out of the repo).

### Known limitations

- The bash matcher's tail-flag filter is prefix-based (`--outputs` would
  also match a `--output` ban). Acceptable for the current list; revisit
  when adding flags whose names share prefixes with allowed ones.
- The path-scope check uses `realpath` of the longest existing prefix
  plus the non-existent tail. TOCTOU between check and write is in
  principle possible inside the workspace; this hardens the
  outside-workspace boundary, not in-workspace race conditions.
- `WebFetch` / `WebSearch` / `Task` are blanket denies. Re-enabling any of
  them needs a real user-confirmation surface (not voice).
- Heartbeat / coalesce thresholds are hand-tuned constants — see
  `src/realtime/inject.ts` to retune.
- Memory distillation (`src/memory/distill.ts`) is still a stub. The
  wrap-up turn fires on hangup and the orchestrator captures the text,
  but the parser + append is TODO.

## Stack

- **Runtime** — Bun + TypeScript
- **TUI** — Ink (React for the terminal)
- **Voice** — OpenAI Realtime API (GA, `gpt-realtime`)
- **Executor** — `@anthropic-ai/claude-agent-sdk`
- **Audio I/O** — sox or ALSA, subprocess
- **Lint/format** — Biome
- **Logs** — Pino → ND-JSON, redacted

## Status

🚧 Active development. Architecture lives in
[`voice-agent-plan.html`](./voice-agent-plan.html).
