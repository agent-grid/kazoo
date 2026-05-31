/**
 * Kazoo blackbox adapter — drives the real Kazoo orchestrator end-to-end
 * exactly the way a human user does: feed PCM16 audio in via the Realtime
 * voice session, observe the agent reply (audio + transcript + tool work).
 *
 * Headless wiring mirrors src/main/index.ts but skips Electron entirely:
 *   - RealtimeSession (OpenAI Realtime, voice-native)
 *   - createExecutor   (Claude Agent SDK, sandboxed to workspaceDir)
 *   - createQueuedInjector
 *   - createBus
 *   - capturing AudioSink (collects PCM16 frames the model speaks)
 *   - stub Distiller (no memory writes during eval)
 *   - createOrchestrator → start()
 *
 * Kazoo's natural eval layer is SPEECH; runText() is rejected. The harness's
 * runSpeechTurn TTS-synthesizes the user prompt to PCM and calls runAudio()
 * — that's the primary entry point.
 */

import type {
  AgentAdapter,
  AgentConfig,
  Capabilities,
  CanonicalEvent,
  TurnTrace,
  Usage,
} from "./base";

// Reuse Kazoo's brain + voice + persona verbatim. Bun resolves the .ts
// extensions natively; module resolution walks up to ../../node_modules for
// pino/ws/shell-quote/@anthropic-ai/claude-agent-sdk (kazoo's deps).
import { createExecutor } from "../../src/core/executor/runner.ts";
import { defaultPermissionPolicy } from "../../src/core/executor/tools.ts";
import { nullLogger } from "../../src/core/lib/logger.ts";
import {
  executorSystemPrompt,
  realtimeInstructions,
} from "../../src/core/narration/persona.ts";
import { createBus } from "../../src/core/orchestrator/bus.ts";
import {
  type AudioSink,
  createOrchestrator,
  type Orchestrator,
} from "../../src/core/orchestrator/loop.ts";
import { createQueuedInjector } from "../../src/core/realtime/inject.ts";
import { RealtimeSession } from "../../src/core/realtime/session.ts";
import type { ExecutorRunner } from "../../src/core/executor/runner.ts";
import type { Distiller } from "../../src/core/memory/distill.ts";

const REALTIME_MODEL = process.env.KAZOO_EVAL_REALTIME_MODEL || "gpt-realtime";
const EXECUTOR_MODEL =
  process.env.KAZOO_EVAL_EXECUTOR_MODEL || "claude-sonnet-4-5";

// 24 kHz mono PCM16: 48000 bytes/sec. ~100 ms per chunk to mimic mic streaming.
const PCM_BYTES_PER_SEC = 24000 * 2;
const CHUNK_MS = 100;
const CHUNK_BYTES = (PCM_BYTES_PER_SEC * CHUNK_MS) / 1000;

// Trailing silence appended after the user's PCM so server-VAD fires
// `speech-stopped` (silence_duration_ms is 500 in session.ts).
const TRAILING_SILENCE_MS = 900;

// Hard turn budget. Big enough for a multi-tool delegate-and-narrate flow.
const TURN_TIMEOUT_MS = 180_000;

// After audio-done + executor turn-done we wait a short settle window before
// declaring the turn finished — gives the model time to emit the assistant
// transcript.done event that often lands a beat after the last audio frame.
const TURN_SETTLE_MS = 1500;

export default class KazooAdapter implements AgentAdapter {
  readonly id = "kazoo";

  private cfg!: AgentConfig;
  private realtime!: RealtimeSession;
  private executor!: ExecutorRunner;
  private orchestrator!: Orchestrator;
  private sink!: CapturingAudioSink;

  private events: CanonicalEvent[] = [];
  private audioChunks: Uint8Array[] = [];
  private assistantFinal = "";
  private assistantPartial = "";
  private usage: Usage = {};
  private t0 = 0;
  private onEvent?: (e: CanonicalEvent) => void;

  // Turn-completion bookkeeping.
  private executorBusy = false;
  private lastAudioAt = 0;
  private audioDoneAt = 0;
  private sawAnyResponse = false;
  private turnError: string | null = null;
  private closed = false;

  capabilities(): Capabilities {
    return {
      layers: ["speech"],
      architecture: "cascade",
      supportsTools: true,
      supportsBargeIn: true,
    };
  }

  async connect(config: AgentConfig): Promise<void> {
    this.cfg = config;
    this.t0 = now();

    const openaiKey = process.env.OPENAI_API_KEY || config.apiKey;
    if (!openaiKey)
      throw new Error("kazoo: OPENAI_API_KEY required for Realtime voice");
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
    const anthropicKey = process.env.ANTHROPIC_API_KEY || undefined;
    if (!oauthToken && !anthropicKey)
      throw new Error(
        "kazoo: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY required for the executor",
      );
    if (!config.workspaceDir)
      throw new Error("kazoo: workspaceDir required");

    const logger = nullLogger();
    const bus = createBus();
    this.sink = new CapturingAudioSink((bytes) => {
      this.audioChunks.push(bytes);
      this.lastAudioAt = now();
      this.emit({
        type: "audio.output.chunk",
        t: now() - this.t0,
        bytes: bytes.length,
      });
    });

    // Empty persona prefs — the eval has no carry-over memory.
    const personaPrefs = { voicePrefs: "", projectFacts: "" };
    const rtInstructions = config.instructions
      ? `${realtimeInstructions(personaPrefs)}\n\n${config.instructions}`
      : realtimeInstructions(personaPrefs);
    const execPrompt = executorSystemPrompt(personaPrefs);

    // Deferred handler proxies (same pattern as src/main/index.ts).
    let realtimeHandler: (ev: any) => void = () => {};
    let executorHandler: (ev: any) => void = () => {};

    this.realtime = new RealtimeSession({
      apiKey: openaiKey,
      model: REALTIME_MODEL,
      instructions: rtInstructions,
      logger,
      // Suppress the opening response — the user "speaks first" in eval mode.
      suppressOpeningResponse: true,
      onEvent: (ev) => {
        this.observeRealtime(ev);
        realtimeHandler(ev);
      },
    });

    const injector = createQueuedInjector(this.realtime, logger);

    const policy = defaultPermissionPolicy(config.workspaceDir);
    this.executor = createExecutor({
      oauthToken,
      apiKey: anthropicKey,
      model: EXECUTOR_MODEL,
      systemPrompt: execPrompt,
      policy,
      logger,
      onEvent: (ev) => {
        this.observeExecutor(ev);
        executorHandler(ev);
      },
    });

    const distiller: Distiller = {
      // Eval doesn't persist memory.
      async appendFromWrapUp() {
        /* no-op */
      },
    };

    this.orchestrator = createOrchestrator({
      realtime: this.realtime,
      executor: this.executor,
      injector,
      audioSink: this.sink,
      distiller,
      bus,
      logger,
    });
    realtimeHandler = this.orchestrator.onRealtimeEvent;
    executorHandler = this.orchestrator.onExecutorEvent;

    await this.orchestrator.start();
    this.emit({ type: "session.started", t: now() - this.t0 });
  }

  async runText(_text: string): Promise<TurnTrace> {
    throw new Error(
      "kazoo is a speech-native agent; use a layer:'speech' scenario " +
        "(harness will TTS-synthesize the prompt and call runAudio).",
    );
  }

  async runAudio(
    pcm16: Uint8Array,
    onEvent?: (e: CanonicalEvent) => void,
  ): Promise<TurnTrace> {
    if (onEvent) this.onEvent = onEvent;
    this.resetTurnState();

    // Stream the user PCM in mic-sized chunks, then append trailing silence
    // so the server-VAD's silence_duration_ms threshold fires speech-stopped
    // and Realtime generates the single supervisor response.
    await this.streamPcm(pcm16);
    await this.streamPcm(new Uint8Array((PCM_BYTES_PER_SEC * TRAILING_SILENCE_MS) / 1000));

    await this.awaitTurnComplete();

    // Prefer the model-emitted assistant final caption; fall back to any
    // streamed partials.
    const finalText = (this.assistantFinal || this.assistantPartial).trim();
    this.emit({
      type: "response.final",
      t: now() - this.t0,
      text: finalText,
    });

    const outputAudio = this.audioChunks.length
      ? concatBytes(this.audioChunks)
      : undefined;

    return {
      events: this.events,
      finalText,
      usage: this.usage,
      ...(outputAudio ? { outputAudio } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Skip orchestrator.stop() — it does an 8s wrap-up turn we don't need
    // in an eval. Tear down the pieces directly.
    try {
      await this.executor.close();
    } catch {
      /* ignore */
    }
    try {
      this.realtime.close();
    } catch {
      /* ignore */
    }
  }

  // -- internals -----------------------------------------------------------

  private emit(e: CanonicalEvent): void {
    this.events.push(e);
    this.onEvent?.(e);
  }

  private resetTurnState(): void {
    this.executorBusy = false;
    this.lastAudioAt = 0;
    this.audioDoneAt = 0;
    this.sawAnyResponse = false;
    this.turnError = null;
    this.assistantFinal = "";
    this.assistantPartial = "";
    this.audioChunks = [];
  }

  private async streamPcm(pcm: Uint8Array): Promise<void> {
    for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
      const slice = pcm.subarray(off, Math.min(off + CHUNK_BYTES, pcm.length));
      const b64 = Buffer.from(slice).toString("base64");
      this.realtime.sendAudio(b64);
      // Pace roughly to wall-clock so the server VAD sees a realistic stream.
      await sleep(CHUNK_MS / 4);
    }
  }

  private async awaitTurnComplete(): Promise<void> {
    const start = Date.now();
    while (!this.closed && Date.now() - start < TURN_TIMEOUT_MS) {
      if (this.turnError) return;
      if (
        this.sawAnyResponse &&
        !this.executorBusy &&
        this.audioDoneAt > 0 &&
        Date.now() - Math.max(this.audioDoneAt, this.lastAudioAt) > TURN_SETTLE_MS
      ) {
        return;
      }
      await sleep(150);
    }
  }

  /** Map RealtimeEvent → CanonicalEvent and update turn-completion state. */
  private observeRealtime(ev: any): void {
    const t = now() - this.t0;
    switch (ev.type) {
      case "caption":
        if (ev.role === "assistant") {
          if (ev.final) {
            this.assistantFinal = ev.text;
            this.emit({
              type: "transcript.final",
              t,
              role: "assistant",
              source: "model",
              text: ev.text,
            });
            // The audio-transcript stream carries the spoken text. Treat each
            // final as a response.delta-equivalent for downstream scorers.
            this.emit({ type: "response.delta", t, text: ev.text });
          } else {
            this.assistantPartial += ev.text;
            this.emit({
              type: "transcript.partial",
              t,
              role: "assistant",
              source: "model",
              text: ev.text,
            });
          }
        } else {
          // user-side transcript (ASR by the server) — surface as-is.
          this.emit({
            type: ev.final ? "transcript.final" : "transcript.partial",
            t,
            role: "user",
            source: "asr",
            text: ev.text,
          });
        }
        return;
      case "response-created":
        this.sawAnyResponse = true;
        return;
      case "audio-chunk":
        // Audio bytes are captured inside the sink; nothing to do here.
        return;
      case "audio-done":
        this.audioDoneAt = now();
        return;
      case "response-done":
        // Mark audio-done if it hasn't already (some responses are tool-only
        // and never produced audio).
        if (this.audioDoneAt === 0) this.audioDoneAt = now();
        return;
      case "error":
        this.turnError = ev.message;
        this.emit({ type: "error", t, message: ev.message });
        return;
    }
  }

  /** Map ExecutorEvent → CanonicalEvent and track executor liveness. */
  private observeExecutor(ev: any): void {
    const t = now() - this.t0;
    switch (ev.type) {
      case "tool-use":
        this.executorBusy = true;
        this.emit({
          type: "tool.call",
          t,
          id: ev.toolUseId,
          name: ev.toolName,
          args: ev.input,
        });
        return;
      case "tool-result":
        this.emit({
          type: "tool.result",
          t,
          id: ev.toolUseId,
          result: ev.content,
          ...(ev.isError ? { error: "tool reported error" } : {}),
        });
        return;
      case "assistant-text":
        // The worker's narration preamble. Useful context, not the spoken
        // final — that comes via the Realtime caption stream.
        this.emit({ type: "response.delta", t, text: ev.text });
        return;
      case "turn-done":
        this.executorBusy = false;
        // Usage isn't surfaced on ExecutorEvent today. Leave usage empty —
        // cost.ts treats missing fields as 0, which is the honest default
        // (claude-agent-sdk doesn't currently expose per-turn token counts
        // through its high-level streaming surface).
        return;
      case "executor-error":
        this.turnError = ev.message;
        this.emit({ type: "error", t, message: ev.message });
        return;
    }
  }
}

// Minimal AudioSink: decodes base64 PCM16, appends to a buffer, and supports
// the barge-in flush/done semantics the orchestrator expects.
class CapturingAudioSink implements AudioSink {
  constructor(private readonly onPcm: (bytes: Uint8Array) => void) {}
  play(b64: string): void {
    if (!b64) return;
    const bytes = Buffer.from(b64, "base64");
    this.onPcm(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
  flush(): void {
    /* barge-in — eval doesn't need to discard captured bytes */
  }
  responseStarted(): void {
    /* no-op */
  }
  done(): void {
    /* no-op — turn completion is tracked from RealtimeEvents */
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function now(): number {
  return performance.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
