# voice-eval

Headless evaluation harness for real-time voice agents — a **text baseline** layer and a
**speech-to-speech** layer. The baseline validates agent reasoning and tool use without audio
variability; the speech layer measures degradation introduced by the agent's own TTS/ASR.

See [initial-spec.md](./initial-spec.md) for the full design.

## Quickstart

```bash
bun install
cp .env.example .env   # add your OPENAI_API_KEY
bun run eval run scenarios/smoke
bun run eval run scenarios/ts-to-zip
bun run eval report
```

## Layout

- `agents/` — one adapter per agent (currently `openai-realtime`)
- `scenarios/` — eval scenarios (`smoke`, `ts-to-zip`); each has `scenario.json` (+ optional `verify.ts`)
- `src/` — runner, scenario loader, scoring, cost, CLI
- `artifacts/`, `reports/` — per-run traces and JSON score reports (gitignored)

## Status

Text layer runs end-to-end against the OpenAI Realtime API (GA `gpt-realtime`). The speech
layer and `llm_judge` verifiers are scaffolded per the spec but not yet wired.
