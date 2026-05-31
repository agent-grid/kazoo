# Eval Harness Spec

## Overview
Build a headless evaluation harness for a real-time voice agent with two layers: text baseline and speech-to-speech. The baseline validates agent reasoning and tool use without audio variability. The speech layer measures degradation introduced by TTS/ASR.

# Bootstrap (step 0)

Start by creating a project on github and pushing just this file into it.

Then we should have a package json we can use to run this. Something like `npm run eval`.

## Goals
- Deterministic text-layer scoring for task success, tool-call correctness, constraint adherence, latency, and recovery.
- Speech-layer scoring for the same metrics plus ASR stability/intent match and baseline-vs-speech degradation.
- Pluggable agent interface and scenario format.
- CLI for running single scenarios or batches, producing logs and artifacts.

## Non-Goals
- Telephony integration.
- UI.

## Agent Adapter Contract
Each agent under evaluation is one adapter implementing a fixed contract. Adding an
agent never touches scenarios, scoring, or reports — the adapter is the only component
that knows the provider's wire protocol and translates it into the harness's canonical
event model.

Interface:
- connect(config)
- send_input(input_chunk) where input is text (baseline) or audio frames (speech)
- receive_events() yielding canonical events (see below)
- close()
- capabilities() returning { layers: [text|speech], audio_format, architecture: native_s2s|cascade|unknown, supports_tools, supports_barge_in }

Black-box rule:
- The harness treats every agent as a black box: audio/text in, canonical events out. It
  never owns, composes, swaps, or tunes an agent's internal stages.
- `architecture` (native_s2s | cascade | unknown) is self-declared report metadata only. A
  cascade (ASR -> LLM -> TTS) is owned end-to-end by the agent under test and we change
  nothing inside it.
- Degradation is therefore measured at the agent boundary — the same agent's text-layer
  score vs its speech-layer score — not by decomposing the agent into stages.

### Canonical Event Model
Adapters emit only these provider-agnostic events; the scoring engine consumes nothing else:
- session.started
- transcript.partial / transcript.final { role: user|assistant, source: asr|model, text }
- tool.call { id, name, args }
- tool.result { id, result, error? }
- audio.output.chunk (speech)
- response.delta / response.final (text)
- error { ... }
- Every event carries a monotonic timestamp. An adapter MAY surface provider-reported
  internal timing if the API happens to expose it, but the harness never depends on it;
  whole-agent latency and degradation are measured at the boundary.

## Adding an Agent
1. Implement the Agent Adapter Contract in agents/<id>/ (native_s2s or cascade).
2. Register it in agents/registry.ts and optionally add an agents/<id>.yaml profile
   { adapter, model, voice, audio_format, params, temperature/seed }.
3. Run `eval run <scenario> --agent <id>`. The adapter must pass the adapter conformance
   suite (a generalized smoke check: connect, one tool-using turn, clean close, well-formed
   canonical events) before it can be scored.

Agent selection is a CLI concern, not part of a scenario, so the same scenario runs
against any agent. Pass `--agent a,b,c` to run a comparison matrix in one batch.

## Integrating Kazoo (planned)
Kazoo is a voice-native coding agent: a Narrator (OpenAI Realtime, voice I/O) over an
Executor (Claude Agent SDK, the brain that reads/edits/runs tools). It's a black box that
owns its own tools — a natural fit for this harness. Not yet buildable: its executor and
orchestrator are stubs (`createExecutor`/`createOrchestrator` throw "not implemented"), so
we design now and build once they land.

Plan — text layer first (the Executor):
- Add `agents/kazoo.ts` driving the Executor only, skipping the voice path. It maps almost
  1:1 onto the adapter contract:
  - `ExecutorRunner.submit(text)` ↔ `runText(text)`
  - `assistant-text` → response.delta/final; `tool-use` → tool.call; `tool-result` →
    tool.result; `turn-done(finalForTask)` → end of turn; `executor-error` → error
- Point the Executor's `cwd` at the per-run `workspaceDir`; tools stay Kazoo's (black box).
- This runs the existing scenarios (smoke, ts-to-zip) and gives a head-to-head: Kazoo's
  Claude executor vs. openai-realtime, text layer.
- Speech layer comes later (Narrator + orchestrator + audio — also currently stubs).

To make Kazoo testable, ask its development to:
- Land a runnable `createExecutor()` that streams the existing `ExecutorEvent` contract.
- Expose the Executor headlessly (no TUI) and accept a working directory (`cwd`).
- Keep `ExecutorEvent` provider-agnostic and stable; surface a turn-complete signal.

## Tool Contract (adapter-owned)
Tools are defined and executed inside each adapter, so each provider wires tools the way
that fits its runtime (function-calling for native_s2s, the LLM stage for cascade). To
keep cross-agent scores comparable despite separate implementations:
- A shared tool spec lists each tool's name, args JSON schema, and expected semantics.
  Scenarios' tools_allowed reference these names.
- Golden I/O fixtures define expected outputs for canonical inputs.
- A tool conformance test runs every adapter's tools against the fixtures and asserts
  matching outputs, so an adapter that drifts from the spec fails before it is scored.

Trade-off (noted): adapter-owned tools maximize per-provider flexibility but risk
behavioral drift between agents; the shared spec + conformance fixtures are the guardrail
that preserves apples-to-apples comparison.

The initial "pi-like" pack is a small set of simple assistant tools, implemented first
inside the OpenAI Realtime adapter and mirrored by each new adapter.

## Scenario Format
YAML/JSON with:
- id, description
- layer: text or speech
- system_prompt, user_prompt
- input_audio (speech layer): path to a recorded audio fixture (the user's voice)
- tools_allowed, constraints
- expected_plan (optional), expected_outcome
- verification: one or more verifiers — type: script | llm_judge (see Verification)
- scoring rubric weights
- timeouts and latency thresholds

## Scoring & Metrics
- Task success: decided by the scenario's verifiers (see Verification), not a single fixed comparison.
- Tool-call correctness: tool name and call order must match; argument matching is fuzzy
  (semantic/partial, not exact string equality). For the first eval tasks (zip creation), the
  compile -> zip -> hash sequence and the tool names are what's scored.
- Constraint adherence: no disallowed tools/files.
- Latency: time to first token (text), time to first audio (speech), total completion, and
  tool latency (time to first tool call + per-tool execution duration). Barge-in/interruption
  latency is defined but not exercised by the current single-turn scenarios.
- Recovery: penalize unrecovered errors, reward self-correction.
- Speech layer: ASR transcript vs expected intent; compute degradation vs text baseline.

### Verification
Task success is decided by one or more pluggable verifiers declared per scenario. A verifier
receives the run context (final output, tool-call trace, files produced, transcripts,
timings) plus the scenario's expected fields, and returns { pass, score, details, evidence }.

Verifier types:
- script: a deterministic, code-based check co-located with the scenario
  (e.g. scenarios/<id>/verify.ts exporting verify(ctx)). Returns a binary result — pass/fail,
  score in {0, 1}, no partial credit. Preferred whenever correctness is mechanically
  checkable. Fully reproducible.
- llm_judge: an LLM grades output against expected_outcome with a rubric and returns a graded
  score in [0, 1] (pass at a threshold), for qualitative/semantic correctness code can't
  check. Judge model, prompt, and temperature (0) are pinned and recorded in the trace for
  reproducibility; supports n-sample majority to reduce variance. Implemented in a later phase.

A scenario may use either or both; per-verifier scores combine via the rubric weights into the
task-success score. The initial build ships script verification only (binary); judge-based
scoring comes later. Prefer script verification where correctness is mechanically checkable.

### Speech I/O
- Input audio: supplied as a pre-recorded fixture referenced by the scenario
  (e.g. scenarios/<id>/input.wav) — the user's own voice, not TTS-synthesized. It is sent as
  a single committed user turn (append buffer, commit, request a response) rather than
  chunk-streamed with server VAD, for determinism. TTS synthesis of user_prompt is a possible
  future alternative, not used now.
- Output scoring: the harness transcribes the agent's output audio with its own reference ASR
  (a measurement instrument, separate from any ASR inside the agent) and scores that
  transcript against expected intent. The reference ASR is pinned to Whisper large-v3
  (vendor-neutral vs the OpenAI agent, run locally) and the model id is recorded in the trace
  for reproducibility.
- Degradation: the same scenario carries both user_prompt (text, baseline layer) and
  input_audio (speech layer) for the same intent, so a given agent's text vs speech scores are
  directly comparable.

### Scoring Aggregation
- The final score is a single number from 0 to 100.
- Components are equally weighted for now: the per-scenario rubric weights field exists but
  defaults to equal weighting until we tune it.
- A binary script verifier maps to 0 (fail) or 100 (pass); graded judge scores scale into the
  same 0-100 range (later phase).
- A batch score is the unweighted mean of its scenario scores.
- A pass threshold is configurable per scenario/batch; the report always shows the raw 0-100 score.

## Logging & Artifacts
- Structured logs for events and timings.
- Store transcripts, tool-call traces, audio in/out (speech), ASR output, and a final JSON score report.
- Every artifact and report is keyed by (scenario_id, agent_id, layer, run_id) so runs are
  comparable across agents and baseline-vs-speech degradation is computed per agent.

## Secrets & Cost
- Secrets: provider API keys live in a gitignored .env (OPENAI_API_KEY, etc.), loaded at startup.
- Cost tracking: every run records its actual cost (model tokens, audio in/out minutes,
  reference-ASR usage) into the run report.
- Live display: the CLI shows the accumulating cost on screen during and after a run.
- Pre-run estimate: before a run, the CLI shows an estimated cost based on the historical
  average of previous runs for that scenario/agent, falling back to a rough default when no
  history exists.
- Guards: requests use retry with backoff; a per-run cost ceiling can abort a run that exceeds budget.

## CLI
- eval run <scenario> --agent <id>
- eval batch <dir> --agent <id>[,<id>...]   (agent comparison matrix)
- eval report <run>
- eval conformance --agent <id>   (adapter + tool conformance)

## Implementation Plan
- Implement agent adapter and event model.
- Implement scenario loader and validator.
- Implement scoring engine and metrics.
- Implement runners for text and speech layers.
- Add example scenario and baseline tests.

## Folder Layout
- agents/            (one subfolder per adapter; agents/registry.ts; agents/<id>.yaml profiles)
- tools/             (shared tool spec + golden I/O fixtures for conformance)
- scenarios/
- runners/           (native_s2s and cascade runners)
- scoring/
- logs/
- artifacts/         (keyed by scenario/agent/layer/run)
- reports/

## Example Scenario
- First scored run: a TypeScript-to-zip harness test. The agent compiles a small TypeScript file to JavaScript, packages the output into a zip under dist, and runs a verify mode that checks the compiled output exists, the zip exists, and the zip hash matches the expected value. The run records timings and hashes in the trace. Verification is a script verifier in code (scenarios/ts-to-zip/verify.ts) — no LLM judge.
- Minimal direct real-time API smoke check: call the OpenAI real-time API directly with a simple prompt to confirm connectivity and basic response handling, then record the trace and outcome as the initial baseline.
