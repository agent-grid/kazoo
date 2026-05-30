<div align="center">

<img src="assets/logo.png" alt="Kazoo" width="420" />

### Talk to a coding agent. Hear it think out loud.

</div>

---

**Kazoo** is a voice-native coding agent wrapped in a terminal-styled Electron surface. You speak; a real coding agent does the work; and a voice **supervisor** narrates that work back to you in first person — semantically, in real time. The hard, error-prone tool-calling stays inside a coding agent that's optimized for it. The voice never touches a file. It watches, narrates, answers, and delegates.

The resonator on the logo — the `···` after the kazoo — is the live speaking indicator. When Kazoo is talking, it hums.

---

## The story: how Kazoo came to be 🪈

### The seed

The idea started as a question about division of labor. Building a TUI coding agent — an executor/harness in the spirit of Claude Code or "PI," the thing that actually edits the code — is one well-understood problem. Layering **voice-to-voice** on top of it is a *different* problem, and the temptation is to make one model do both. That's a trap. A speech-to-speech model asked to also emit complex, correct tool calls is a model doing two jobs badly.

So we split it. The coding agent stays the specialist that makes the complex tool calls. On top of it sits a **voice layer** that consumes the harness's events and narrates them semantically, in first person, so a developer can work entirely over voice **without the voice model ever having to drive the tools itself.** The complexity stays where it belongs.

### Choosing the foundation (and the benchmark)

We weighed the open-weights path — NVIDIA's Nemotron — but decided to **start from the state of the art** in speech-to-speech: OpenAI's Realtime API. Not just as the foundation, but as the *benchmark to beat*. If we were going to claim our narration was faithful, we needed a high bar and a way to measure against it.

That measurement is its own story. Rather than reach for an off-the-shelf eval vendor like Cekura, the team built its **own eval-score library**: a narration-fidelity scorer that asks one question — does the spoken narration faithfully match the coding agent's *real* events? We call it our "beyond vibes" metric. It exists as a real, separately-built teammate component, and it's how we evaluate S2S narration quality instead of trusting our ears.

### The all-TypeScript bet

Everything is TypeScript, end to end. The **Claude Agent SDK** (the Claude Code engine) is the executor "brain." **OpenAI Realtime** is the voice. And rather than re-derive the GA Realtime wire protocol from scratch, we **lifted a battle-tested GA Realtime WebSocket client** and built on top of it — a decision that paid off later in ways we didn't anticipate. The executor runs on a **Claude subscription** (`CLAUDE_CODE_OAUTH_TOKEN`), so day-to-day coding doesn't burn pay-per-token API budget (`ANTHROPIC_API_KEY` is supported too).

### First build: Bun + Ink

The first Kazoo was a **Bun + Ink TUI.** We scaffolded it, got the mic↔Realtime↔speaker audio round-trip working (initially through a subprocess `sox`/ALSA pipeline), wired the end-to-end loop — executor + narration + orchestrator — and ran it.

And then we hit the hard problems.

### The hard problems

The voice **hallucinated the project.** Ask it something and it would improvise an answer instead of narrating what the coding agent had actually done. The relay we thought we'd built wasn't really there. The root cause: Realtime, with server-side VAD, was **auto-responding to the user** — answering on its own initiative, from nothing.

Our first fix was a blunt instrument: **narrator-only mode.** It stopped the hallucinations by stopping the voice from responding at all — but now it couldn't answer questions either. Too blunt. (More on the real fix below.)

Around the same time we built a **coalesce / stay-current narration scheduler** so the voice keeps pace with a busy worker — it never lags behind a flurry of edits and never goes dead-air silent — and we ran a **security-hardening pass** on the executor after finding genuine RCE and exfiltration paths. That pass produced a shell-quote-parsed bash allowlist, file-tool path-scoping, and a secret-scrubbed subprocess environment.

### The pivot realization

Then we stepped back and questioned the TUI itself.

A voice-first agent does not want a keyboard app's surface. Watching real sessions, the terminal UI was mostly **duplicating the voice** — it was a transcript echo — while **failing to show the things voice physically can't convey:** diffs, file trees, results, the current action. The terminal was the wrong medium for the one job a screen should actually do: show you what you can't hear.

### The Electron rewrite

So we rewrote the surface as a **terminal-*styled* Electron app.** We kept the surface-agnostic, security-hardened **core** — realtime, executor, narration, orchestrator — completely intact, and rebuilt only the surface around it.

The move unlocked something the lifted Realtime client had been designed for all along: **audio moved into the renderer's WebAudio.** The hacky subprocess `sox`/ALSA pipeline — and its barge-in bugs — got deleted outright. Capture and playback now live in the browser audio graph, exactly where a GA Realtime client expects them. And the renderer finally makes the coding agent's **actual work the hero** — files, diffs, the current action — instead of echoing a transcript you already heard.

### The supervisor model — the heart of it

The blunt narrator-only fix became something much better: the **supervisor model.**

The voice is a **supervisor** watching a **worker** (the coding agent). They are *one person* — always first person, never "the agent did X." The supervisor:

- **narrates** the worker's real events semantically as they happen,
- **answers** the user's questions from conversation context when it truthfully can,
- **delegates** new tasks — and any question it *can't* answer truthfully — to the worker through a tool (read-only when it's just fact-finding), and
- **never fabricates.** When it doesn't know, it delegates to find out rather than inventing a code fact.

Critically, the worker runs **decoupled and continuous.** Interrupting the voice — barging in mid-sentence — never stops the worker. You can cut the supervisor off to ask something while the work keeps going.

### Landing it

The whole thing was built through **dynamic multi-agent workflows** — design → build → verify — and it landed **green:** typecheck and electron-vite build pass, **71 tests** pass, and the renderer bundle is verified secret-free. It lives in **draft PR #6** on the `feat/electron` branch.

---

## How it works

Two layers, one persona.

```
                  ┌─────────────────────────────────────────────┐
   you  ◀── 🎙 ──▶│  SUPERVISOR  (OpenAI Realtime, gpt-realtime) │
                  │  • narrates the worker's real events         │
                  │  • answers from conversation context         │
                  │  • delegates / stops via tools               │
                  │  • NEVER fabricates a code fact              │
                  └───────────────┬───────────────▲─────────────┘
                                  │ delegate       │ work-log
                                  │ (read-only     │ awareness
                                  │  for facts)    │ (silent)
                  ┌───────────────▼───────────────┴─────────────┐
                  │  WORKER  (Claude Agent SDK / Claude Code)    │
                  │  • makes the complex tool calls              │
                  │  • runs decoupled & continuous               │
                  │  • bash allowlist · path-scoped · env-scoped │
                  └─────────────────────────────────────────────┘
```

The **supervisor** is the voice. Using `tool_choice: 'auto'`, the Realtime model decides for itself between three moves on every turn: answer, delegate, or stop. Two functions back the decision — `delegate_to_executor` (tagged `reason: 'new_task' | 'unknown_fact'`) and `stop_executor` (with `drop_queue`). The orchestrator stays deliberately *mechanical*: it forwards the call and lets the model voice its own acknowledgement via the tool result.

The **worker** is the coding agent. It runs as a long-lived `query()` over the Claude Agent SDK, fed user turns from an async queue, and it keeps working whether or not the voice is mid-sentence.

The two stay in sync without the voice ever guessing:

- **Anti-fabrication by construction.** When the supervisor delegates an `unknown_fact` — "what does this function return?" — the orchestrator wraps that delegation **read-only** (`wrapReadOnly()`: "do not edit, create, or delete any file… answer in one or two sentences"). The worker finds out; the voice reports the truth. The persona's one unbreakable rule: *never fabricate a code fact — delegate instead.* A reflexive stop-keyword backstop catches the rest.
- **Silent awareness.** A bounded, timestamped, summarize-and-evict `[WORK-LOG]` is built from the worker's raw events (mutating tools, errors, completions) and injected into the voice's context *silently* — as a marked user item, with no `response.create`. The supervisor always knows what the worker just did, without being prompted to speak.
- **Barge-in that doesn't break anything.** You can interrupt the voice at any time. Two gates flush the audio — the main process drops OpenAI's network tail, the renderer synchronously kills scheduled WebAudio buffers — and the worker keeps going the whole time.

---

## Project breakdown

A three-process split: **secrets and all hardened logic live in `main`; the `renderer` is a sandboxed WebAudio device + terminal UI; `preload` is the only bridge.**

```
src/
├── core/                  surface-agnostic, security-hardened modules (no Electron, no audio I/O)
│   ├── realtime/          OpenAI Realtime GA client
│   │   ├── session.ts     ws client · SUPERVISOR_TOOLS · injectNarration / injectAwareness / sendToolResult / requestWrapUp
│   │   ├── inject.ts       pacing + heartbeat scheduler · coalesces low-salience runs · flush() for barge-in
│   │   ├── events.ts · transcripts.ts
│   ├── executor/          the Claude Agent SDK worker
│   │   ├── runner.ts       long-lived query() · AsyncQueue of turns · canUseTool enforcement · env-allowlist · cancelTurn
│   │   ├── tools.ts        bash allowlist matcher (isBashCommandAllowed)   + tools.test.ts
│   │   ├── events.ts
│   ├── narration/
│   │   ├── translator.ts · salience.ts · modes.ts (flow | high-level)
│   │   ├── persona.ts      BASE_PERSONA + REALTIME_SUPERVISOR_RULES + EXECUTOR_SAFETY_RULES
│   │   └── *.test.ts       translator · persona · salience
│   ├── orchestrator/
│   │   ├── loop.ts         the single onEvent seam (surface-free) · wrapReadOnly() · barge-in
│   │   ├── bus.ts          typed pub/sub · 6-variant BusEvent
│   │   ├── state.ts        FSM
│   │   └── awareness.ts    the [WORK-LOG] builder
│   ├── memory/            store.ts (recall) · distill.ts
│   ├── lib/               errors.ts (KazooError) · async.ts (AsyncQueue) · logger.ts (pino + redaction)
│   └── config.ts          typed env loader
│
├── main/                  composition root + Electron seams (secrets live here only)
│   ├── index.ts           bootstrap(): dotenv → loadConfig → resolveExecutorAuth → workspace guard → bus → executor → orchestrator → window → IPC
│   ├── window.ts          BrowserWindow (contextIsolation · no nodeIntegration · sandbox · webSecurity) · mic-only perms · prod CSP · nav guards
│   ├── ipc.ts             MIC_FRAME → realtime.sendAudio · CONTROL → start/stop/setMode · bus → renderer
│   ├── audio-sink.ts      decodes base64 → ArrayBuffer in main, webContents.send on dedicated channels
│   ├── lifecycle.ts       before-quit graceful teardown (orchestrator.stop + executor.close)
│   ├── sdk-paths.ts       resolves native claude from app.asar.unpacked (musl detection · claude.exe)
│   ├── executor-auth.ts   OAuth-preferred auth picker · fail-fast KazooError
│   └── workspace.ts       assertWorkspaceSafe() — refuses /, $HOME, .ssh/.aws/.kube/..., /etc /var /usr ...
│
├── preload/index.ts       contextBridge.exposeInMainWorld('kazoo', api) — functions only · mic via postMessage (no base64 in renderer)
│
├── renderer/              WebAudio device + terminal UI
│   ├── audio/             capture.ts (getUserMedia + AEC/NS/AGC → AudioWorklet) · mic-worklet.ts (480-sample/20 ms framing)
│   │                      playback.ts (gapless scheduled queue · flush() gate) · pcm.ts (Int16↔Float32) + pcm.test.ts · useAudioIO.ts
│   ├── App.tsx            single onBus reducer + useAudioIO
│   ├── store/reducer.ts
│   ├── components/        Header · WorkStage (executor work = the hero) · ConversationStrip · StatusBar
│   └── theme.css          near-black #0a0c0b / mint-teal accent · monospace
│
└── shared/ipc-types.ts    single source of truth: `as const` CH channel map · ControlMsg · SessionInfo {cwd, model} · KazooBridge (type-only)
```

---

## Getting started

### Prerequisites

- **Node** — `@types/node` is pinned to `20.x` to match the Node bundled inside Electron 33.
- An **OpenAI** key (for the Realtime voice).
- A **Claude** credential — a subscription OAuth token (preferred) **or** an Anthropic API key (for the worker).

### Configure

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | ✅ | `loadConfig` throws without it. |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of these | Preferred — runs the worker on your Claude subscription. |
| `ANTHROPIC_API_KEY` | one of these | Pay-as-you-go alternative. `resolveExecutorAuth` fail-fasts if neither is set. |
| `KAZOO_WORKSPACE` | optional | The dir the executor is scoped to. Default `~/kazoo-workspace` (created on first run, `~` expanded). **Point it at a project to work on it.** |
| `KAZOO_EXECUTOR_MODEL` | optional | Default `claude-sonnet-4-6`. |
| `KAZOO_REALTIME_MODEL` / `KAZOO_REALTIME_VOICE` / `KAZOO_REALTIME_SPEED` | optional | Voice tuning. |
| `KAZOO_PROJECT_MEMORY_PATH` | optional | Default `./KAZOO.md`. |
| `KAZOO_USER_MEMORY_PATH`, `KAZOO_LOG_FILE` / `KAZOO_LOG_LEVEL` | optional | |

> Note: `.env.example` still mentions Bun's native dotenv ("no dotenv package required") — that's historical. Main now does `import 'dotenv/config'` before `loadConfig()`.

### Run

```bash
npm install

npm run dev          # electron-vite dev — renderer HMR, auto-restart on main/preload change
npm test             # vitest run — 71 tests
npm run typecheck    # tsc -b
npm run lint         # biome check .

npm run build        # electron-vite build → out/
npm run package      # build + electron-builder
npm run package:dir  # unpacked build (--dir)
```

---

## Technical decisions & considerations

**All TypeScript, end to end.** Electron `^33.4.11` + electron-vite `^2.3.0` bundling three targets (main / preload / renderer) from one config; TypeScript `^6.0.3` with solution-style project references; React `^19` in the renderer; vitest for tests; Biome for lint/format. One language, one toolchain, three processes.

**Claude subscription for the worker.** The executor runs through the Claude Agent SDK on `CLAUDE_CODE_OAUTH_TOKEN` so the bulk of token spend — the actual coding — rides your subscription rather than per-token API billing. `ANTHROPIC_API_KEY` works too; OAuth is just preferred and chosen first. (The SDK ships no `bin` — `query()` spawns a ~230 MB native `claude` binary from a per-platform `optionalDependencies` package; all 8 OS/arch variants are declared, and `sdk-paths.ts` resolves the right one out of `app.asar.unpacked` in packaged builds.)

**Model & eval: start from SOTA, measure beyond vibes.** We weighed NVIDIA Nemotron's open-weights path but chose OpenAI Realtime GA (`gpt-realtime` + `gpt-4o-mini-transcribe` input transcription) as both foundation *and* benchmark — base64 PCM16 LE, 24 kHz mono over `wss://api.openai.com/v1/realtime`, on a **lifted, battle-tested GA WebSocket client** (`ws`) rather than a hand-rolled protocol. And instead of an off-the-shelf eval vendor (Cekura), we built our **own narration-fidelity eval library** — the "beyond vibes" scorer that checks whether the spoken narration actually matches the worker's real events.

**Audio: renderer WebAudio, with real barge-in.** Capture and playback live in the Chromium audio graph: `getUserMedia` with AEC/NS/AGC → an `AudioContext` at 24 kHz → an `AudioWorklet` that frames Float32→Int16 at 480 samples / 20 ms; playback is a gapless scheduled `AudioBufferSource` queue with 20 ms lookahead. No hand-rolled resampler — Chromium handles it. Barge-in is two-gated: the main process drops OpenAI's network tail and the renderer synchronously kills scheduled buffers, while the worker keeps running.

**Security posture.** The executor was hardened after finding real RCE/exfil paths:

- **Bash allowlist** (`isBashCommandAllowed`) — a *real* `shell-quote` parse, not a regex. Any non-string token (operators, redirects, command substitution, globs) is rejected; matching is argv-prefix against read-only commands plus `git status/diff/log/show` and `git branch --list`, with per-entry forbidden tail flags.
- **Path-scoping** (`isInsideWorkspace`) — symlink-aware realpath walk; file tools can't escape the workspace.
- **`DENY_TOOLS`** = `WebFetch` / `WebSearch` / `Task`.
- **Subprocess env allowlist** — an explicit `ENV_ALLOWLIST` plus the single Claude credential; never a `process.env` spread, so secrets don't leak into spawned processes.
- **Renderer isolation** — `sandbox: true`, a functions-only preload, secrets confined to main, and `verbatimModuleSyntax` keeping core runtime code out of the renderer bundle entirely (verified secret-free).

**Anti-fabrication by design.** The supervisor can never invent a code fact. Anything it can't answer truthfully from context becomes a *read-only* delegation to the worker, and the worker's real activity flows back as a silent, bounded `[WORK-LOG]`. The voice reports what is, not what it guesses.

---

## Status

**Green.** ✅

```
typecheck (tsc -b)              pass
build (electron-vite build)     pass
tests (vitest run)              71 passed (6 files)
renderer bundle                 verified secret-free
```

Test breakdown: `executor/tools.test.ts` (23 — bash matcher metachar / argv-prefix / flag edges), `renderer/audio/pcm.test.ts` (13 — Int16↔Float32 round-trip & clipping), `narration/translator.test.ts` (13), `realtime/inject.test.ts` (10 — queue / flush / heartbeat), `narration/persona.test.ts` (7), `narration/salience.test.ts` (5). Ships as **draft PR #6** on `feat/electron`.

### Deferred — P4 packaging

The packaging config is written and committed, but P4 is the deferred phase and hasn't been executed or validated yet:

- **Per-OS builds on native runners.** Because the native `claude` binary resolves per-host via `optionalDependencies`, cross-compiling won't ship the right binary — each OS needs its own runner. `electron-builder.yml` declares `mac:dmg`, `win:nsis`, `linux:AppImage` with `asarUnpack` of both the SDK glue and the platform packages.
- **macOS signing / notarization.** `hardenedRuntime`, `notarize`, and an entitlements plist (allow-jit, unsigned-executable-memory, disable-library-validation, dyld-env, inherit, audio-input) are all present — but unsigned and unnotarized so far.
- **App icon** from `assets/logo.png` — build resources are set; icon wiring is pending.
- **Packaged smoke test** — env loading, mic prompt, native SDK spawn from the unpacked asar, and an offline voice session — not yet run.

---

<div align="center">

*Built in TypeScript. Powered by Claude Code + OpenAI Realtime. Narrated by a kazoo.* 🪈

</div>
