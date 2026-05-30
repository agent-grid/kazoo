# Voice Coding Agent — Hackathon Plan (8h)

**Thesis:** A voice agent you *call on the phone* that drives a real coding agent and
narrates what it's doing in first person. We measure **narration fidelity** (does the
spoken explanation match what the executor actually did?) and close an **auto-improvement
loop** that drives that score up. The coding domain gives us objective ground truth —
that's our answer to "move beyond vibes."

## Architecture

```
Phone (Twilio)  →  Pipecat  →  [ Riva/Parakeet ASR → narrator LLM (NVIDIA NIM) → Riva TTS ]
                                   ↕  event + control bus
                              Claude Code (Claude Agent SDK)  ←  ground truth (tool_use events + diff)

Cekura simulates voice coding sessions  →  scores narration fidelity  →  failures
   →  optimizer rewrites narrator prompt (safe)  /  LoRA fine-tune narrator (stretch)
   →  re-run suite  →  fidelity ↑  →  logged in narration-fidelity-log.md
```

The narrator runs **concurrently** with execution. Coding is slow and bursty; the voice
turn must NOT block on task completion. Stream narration as events arrive; emit progress
fillers during long tool calls.

## How we hit each judged theme

| Theme | How |
|---|---|
| SOTA open-weights, customized | Narrator LLM + ASR/TTS on NVIDIA NIM (open weights). The loop **customizes** them (prompt-opt baseline, LoRA stretch). |
| Infra / network / latency | Pipecat pipeline + Twilio telephony; show Pipecat latency metrics (TTFB, turn latency). NIM = the acceleration lever. |
| Simulate & evaluate | Cekura runs simulated voice coding calls + scores fidelity. Beyond vibes because code = ground truth. |
| Auto-improve | One full loop iteration live: eval data → prompt/LoRA change → re-eval → measurable gain, logged. |

**Open-weights defense (if a judge asks "but coding is Claude"):** the *executor is a
swappable tool*; the **voice agent** — the thing this hackathon judges — is fully
open-weights, NVIDIA-accelerated, and our loop customizes those weights.

## Concrete tech decisions

- **Language:** Python (forced by Pipecat).
- **Executor relay:** **Claude Agent SDK** (`pip install claude-agent-sdk`) — streams
  structured messages (assistant text, `tool_use`, `tool_result`). Do NOT parse the CLI
  stream-json by hand. The assistant's own natural-language preambles ARE the narration
  source; `tool_use` blocks + resulting diff are the ground truth for scoring.
- **Narrator:** small fast open model on NIM (Nemotron-mini / Llama-8B). It rewrites
  executor events into spoken first-person, applying a salience filter (narrate decisions
  & milestones, batch the `Read`/`Grep` noise). This is also the LoRA target.
- **ASR/TTS:** Riva NIM (Parakeet/Canary ASR) if reachable; else a fast hosted fallback
  for the spine, swap later. Keep at least the narrator on NIM no matter what.
- **Fidelity scorer:** LLM-as-judge. Per agent turn, compare narration text vs. event log.

### Fidelity rubric (0–1, mean over turns)
- **Coverage** — material actions mentioned, nothing significant done silently.
- **Honesty** — no claimed actions that didn't happen (no hallucinated steps).
- **Semantic correctness** — mapping is right (a grep is "searching the code", not "the web").
- **Altitude** — summarizes intent, doesn't read raw commands; doesn't over/under-narrate.

## Hour-by-hour (adjust H-markers to actual start)

- **H0–0.5 — Setup.** Everyone grabs creds in parallel (see checklist). Repo scaffold,
  Python env, `pip install pipecat-ai claude-agent-sdk`. Pick fast transport (Daily/local)
  for the first slice — Twilio comes later.
- **H0.5–2 (Track B) — Executor relay.** Claude Agent SDK streaming events → narrator
  prompt → spoken-style text. Validate **text-only** (no audio yet). Cheap concept proof.
- **H0.5–2 (Track A) — Pipecat pipeline.** transport → ASR → LLM placeholder → TTS. Get
  an audio round-trip echo bot working.
- **H2–3.5 — INTEGRATE → vertical slice.** Wire narration into TTS, ASR into Claude prompts.
  Talk → Claude codes → hear narration. **Protect this milestone above everything.**
- **H3.5–4.5 — Go on-theme.** Swap narrator LLM → NIM (trivial: OpenAI-compatible base_url).
  ASR/TTS → Riva if available. Add Twilio transport (Pipecat has the FastAPI/Media-Streams
  example) → you can now CALL a phone number.
- **H4.5–6.5 — Eval + loop (the money shot).** Fidelity judge. Cekura sim suite (5–10
  scripted voice coding scenarios) — or DIY scripted sim if Cekura is slow. Score baseline,
  log to MD. Run ONE optimizer pass (reflect on failures → rewrite narrator prompt/few-shots)
  → re-score → log before/after.
- **H6.5–7.5 — Stretch + harden.** LoRA showpiece if alive (NeMo on AWS GPU → redeploy NIM).
  Latency metrics on a dashboard/slide. Fallbacks so a flaky component can't kill the demo.
- **H7.5–8 — Demo prep.** Rehearse. Slide: fidelity before/after chart + latency numbers +
  arch diagram. **Record a backup video.**

## Creds / prereqs checklist (HOUR 0 — silent killer)

- [ ] **Anthropic API key** (Claude Agent SDK), billing enabled
- [ ] **Twilio** account + voice number + Media Streams + a public tunnel (ngrok/cloudflared)
- [ ] **NVIDIA** `build.nvidia.com` API key (hosted NIM, OpenAI-compatible)
- [ ] **Cekura** account + API access — skim sim/eval docs NOW
- [ ] **AWS** account (app hosting; GPU only if attempting LoRA)
- [ ] Python 3.11+, `pipecat-ai`, `claude-agent-sdk`, `ngrok`/`cloudflared`

## Risks & cut-lines

- Twilio media-stream debugging eats time → **build the brain on Daily/local first.**
- Cekura unfamiliarity → timebox; **DIY scripted sim + our judge is the fallback.**
- Latency stacking (ASR+LLM+TTS+slow executor) → narrator streams concurrently + progress fillers.
- **Cut order if behind:** Twilio → web audio. Riva → fast hosted (keep narrator on NIM).
  Live Cekura → scripted sim + our judge. LoRA → prompt-opt only.
- **NEVER cut:** talk→code→narrate slice, and ONE fidelity-improvement loop iteration with
  before/after numbers. That's the entire thesis.

## 90-second demo script

1. Call the number. "Hey, in the demo repo, add input validation to the signup endpoint."
2. Audience hears Claude work, narrated in first person ("I'm opening the auth module…").
3. Cut to the dashboard: baseline narration fidelity = X.
4. "We fed the failures back and tuned the narrator." Re-run → fidelity = X+Δ. Show the
   before/after narration snippet from `narration-fidelity-log.md`.
5. One line on the stack: open-weights voice engine on NVIDIA NIM, Pipecat+Twilio infra,
   Cekura-driven auto-improvement.
