import type {
  AgentAdapter,
  AgentConfig,
  Capabilities,
  CanonicalEvent,
  TurnTrace,
  Usage,
} from "./base";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";

// Google Gemini Live API (BidiGenerateContent), v1beta. API key in query string.
// Docs: https://ai.google.dev/api/live
const ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Default model — "Gemini 3.1 Live Flash" (preview). Pin here, not via the
// harness's cfg.model (that's an OpenAI default). Override with VOICE_EVAL_GEMINI_MODEL.
// Verified in voiceclaw's production Gemini adapter (relay-server/src/adapters/gemini.ts:14).
const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

// ---------------------------------------------------------------------------
// Same pi-like tool pack as agents/openai-realtime.ts — read/write/edit/bash.
// Gemini takes JSON Schema-style parameters under a `functionDeclarations`
// array. No `type: "function"` wrapper (that's OpenAI's shape).
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace the first occurrence of `old` with `new` in a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
      },
      required: ["path", "old", "new"],
    },
  },
  {
    name: "bash",
    description:
      "Run a bash command in the working directory (node and bun are available).",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

const BASE_INSTRUCTIONS =
  "You are an autonomous assistant working inside a project directory. You have these tools: " +
  "read_file, write_file, edit_file, and bash. Use bash for compiling, zipping, hashing, and any " +
  "shell work (node and bun are installed). Call the tools immediately to do the work — do NOT just " +
  "describe what you will do, and do NOT end your turn until the task is fully complete. " +
  "When the user asks for an artifact at a specific path (e.g. `dist/foo.zip`), put every related " +
  "build output under that same directory (e.g. compile to `dist/`, not to the source folder). " +
  "Keep spoken narration to a minimum. When everything is done, briefly report what you did.";

/**
 * Gemini Live adapter. Single-file black-box stub mirroring openai-realtime.ts:
 * brings its own pi-like tools, sandboxes file ops to cfg.workspaceDir, and
 * translates Gemini's BidiGenerateContent envelopes into CanonicalEvents.
 *
 * IMPORTANT QUIRK — Gemini Live is AUDIO-only on every currently-available model
 * (gemini-3.1-flash-live-preview and the 2.5 native-audio family all reject
 * responseModalities: ["TEXT"] with WebSocket close 1007). To service the
 * harness's text layer at all, we run AUDIO output + outputAudioTranscription
 * and surface the transcript as response.delta/final. The audio is also emitted
 * as audio.output.chunk events for the speech layer. This is a model-imposed
 * deviation from the OpenAI adapter's clean TEXT vs AUDIO split — document it
 * in the run report.
 *
 * Wire-level differences from OpenAI Realtime:
 *   - Auth via ?key=API_KEY query string, not Authorization header.
 *   - Frames arrive as binary Blob (not strings) — coerce on receipt.
 *   - Tools declared as { tools: [{ functionDeclarations: [...] }] } at setup.
 *   - Tool calls arrive on msg.toolCall.functionCalls[]; responses sent as
 *     msg.toolResponse.functionResponses[].
 *   - The model field belongs INSIDE the setup envelope (no model in the URL).
 *   - A single user "turn" is one clientContent message with turnComplete: true;
 *     the model auto-generates a reply (no explicit response.create needed).
 */
export default class GeminiLiveAdapter implements AgentAdapter {
  readonly id = "gemini-live";
  private ws!: WebSocket;
  private cfg!: AgentConfig;
  private model = "";
  private events: CanonicalEvent[] = [];
  private finalText = "";
  private usage: Usage = {};
  private done = false;
  private setupComplete = false;
  private setupWaiter: (() => void) | null = null;
  private pendingToolCalls = 0;
  private toolPromises: Promise<void>[] = [];
  private waiter: (() => void) | null = null;
  private t0 = 0;
  onEvent?: (e: CanonicalEvent) => void;

  capabilities(): Capabilities {
    return {
      // text first; speech is a stretch goal but the wire path is present.
      layers: ["text", "speech"],
      architecture: "native_s2s",
      supportsTools: true,
      supportsBargeIn: true,
    };
  }

  private now() {
    return performance.now();
  }
  private emit(e: CanonicalEvent) {
    this.events.push(e);
    this.onEvent?.(e);
  }
  private send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async connect(config: AgentConfig): Promise<void> {
    this.cfg = config;
    // IGNORE config.model — harness defaults to an OpenAI id. Adapter owns this.
    this.model = process.env.VOICE_EVAL_GEMINI_MODEL || DEFAULT_MODEL;
    // IGNORE config.apiKey — the shared harness fills it with OPENAI_API_KEY
    // (see src/run.ts). Each adapter reads its own provider's key from env.
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set (add it to .env)");
    this.t0 = this.now();
    const url = `${ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    this.ws = new WebSocket(url);

    await new Promise<void>((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", (e: any) =>
        rej(new Error("websocket error: " + (e?.message ?? e))),
      );
    });
    this.ws.addEventListener("message", async (ev: any) => {
      let data: string;
      if (typeof ev.data === "string") {
        data = ev.data;
      } else if (ev.data instanceof ArrayBuffer) {
        data = new TextDecoder().decode(ev.data);
      } else if (ev.data && typeof (ev.data as any).text === "function") {
        // Blob (Bun's WS emits Blob for binary frames; Gemini frames JSON as binary).
        data = await (ev.data as Blob).text();
      } else {
        data = String(ev.data);
      }
      if (process.env.VOICE_EVAL_GEMINI_DEBUG) {
        // eslint-disable-next-line no-console
        console.error("[gemini-live] <<", data.slice(0, 500));
      }
      this.onMessage(data);
    });
    this.ws.addEventListener("close", (ev: any) => {
      if (process.env.VOICE_EVAL_GEMINI_DEBUG) {
        // eslint-disable-next-line no-console
        console.error(`[gemini-live] close code=${ev?.code} reason=${ev?.reason}`);
      }
      this.done = true;
      this.wake();
      this.setupWaiter?.();
    });

    const instructions = config.instructions
      ? `${BASE_INSTRUCTIONS}\n\n${config.instructions}`
      : BASE_INSTRUCTIONS;

    // Live API only supports AUDIO output on every current model; the
    // outputAudioTranscription lets us recover text for the text-layer score.
    const setup: any = {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: config.voice ?? "Zephyr" },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: instructions }],
      },
      tools: [{ functionDeclarations: TOOLS }],
      outputAudioTranscription: {},
    };

    this.send({ setup });
    // Wait for setupComplete before allowing runText to send a user turn.
    await new Promise<void>((res) => {
      if (this.setupComplete) return res();
      this.setupWaiter = res;
      setTimeout(res, 15_000);
    });
    this.emit({ type: "session.started", t: this.now() - this.t0 });
  }

  private onMessage(data: string) {
    let m: any;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const t = this.now() - this.t0;

    // Handshake — gates runText().
    if (m.setupComplete !== undefined) {
      this.setupComplete = true;
      const w = this.setupWaiter;
      this.setupWaiter = null;
      w?.();
      return;
    }

    // Per-turn server content: text/audio deltas, optionally turnComplete.
    if (m.serverContent) this.handleServerContent(m.serverContent, t);

    // Function-calling: tool calls arrive on a separate envelope.
    if (m.toolCall) this.handleToolCall(m.toolCall, t);

    // Usage tallies — Gemini sends these intermittently; keep the latest.
    if (m.usageMetadata) {
      const u = m.usageMetadata;
      this.usage = {
        inputTokens: u.promptTokenCount,
        outputTokens: u.responseTokenCount,
      };
      // Only emit when the prompt count is meaningful (mid-stream chunks send
      // tiny output-only deltas — match voiceclaw's filter to avoid noise).
      if ((u.promptTokenCount ?? 0) > 0) {
        this.emit({ type: "usage", t, usage: this.usage });
      }
    }

    // Server-initiated graceful close ("goAway") — surface it but don't act.
    if (m.goAway) {
      this.emit({ type: "error", t, message: "gemini goAway received" });
    }
  }

  private handleServerContent(content: any, t: number) {
    // Audio deltas live in modelTurn.parts[].inlineData.data (base64 PCM).
    // (Live API never sets part.text on the current models — we get text via
    // outputTranscription instead.)
    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.emit({
            type: "audio.output.chunk",
            t,
            bytes: Math.floor((part.inlineData.data.length * 3) / 4),
          });
        }
      }
    }

    // outputAudioTranscription gives us text deltas for what the model is
    // saying. Treat these as the canonical text stream so the text layer has
    // something to score even though the model is AUDIO-only.
    if (content.outputTranscription?.text) {
      const text: string = content.outputTranscription.text;
      this.finalText += text;
      this.emit({ type: "response.delta", t, text });
      this.emit({
        type: "transcript.partial",
        t,
        role: "assistant",
        source: "model",
        text,
      });
    }

    if (content.turnComplete) {
      // Wait for any in-flight tool executions before declaring the turn done —
      // the model will continue generating once the tool responses land and
      // will emit another turnComplete then.
      if (this.pendingToolCalls > 0) return;
      const ps = this.toolPromises;
      this.toolPromises = [];
      Promise.all(ps).then(() => {
        // After flushing any straggling tool promises, finalize the turn.
        if (this.pendingToolCalls === 0) {
          this.done = true;
          this.emit({
            type: "response.final",
            t: this.now() - this.t0,
            text: this.finalText,
          });
          this.wake();
        }
      });
    }
  }

  private handleToolCall(toolCall: any, t: number) {
    const calls: any[] = toolCall.functionCalls ?? [];
    for (const call of calls) {
      this.pendingToolCalls++;
      this.toolPromises.push(this.runOneTool(call, t));
    }
  }

  private async runOneTool(call: any, t: number) {
    const callId = String(call.id ?? `call_${this.events.length}`);
    const name = String(call.name);
    const args = call.args ?? {};
    this.emit({ type: "tool.call", t, id: callId, name, args });

    let result: unknown;
    let error: string | undefined;
    try {
      result = execTool(this.cfg.workspaceDir!, name, args);
    } catch (e: any) {
      error = String(e?.message ?? e);
      result = { error };
    }
    this.emit({
      type: "tool.result",
      t: this.now() - this.t0,
      id: callId,
      result,
      error,
    });

    // Gemini's functionResponse expects an OBJECT, not a stringified payload.
    // Wrap non-object results so the model always receives a structured response.
    const response =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : { result };
    this.send({
      toolResponse: {
        functionResponses: [{ id: callId, name, response }],
      },
    });
    this.pendingToolCalls--;
  }

  async runText(
    text: string,
    onEvent?: (e: CanonicalEvent) => void,
  ): Promise<TurnTrace> {
    if (onEvent) this.onEvent = onEvent;
    // Single user turn. turnComplete: true triggers the model to generate.
    this.send({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    });
    const timeoutMs = this.cfg.layer === "speech" ? 120000 : 90000;
    const start = Date.now();
    while (!this.done && Date.now() - start < timeoutMs) {
      await new Promise<void>((res) => {
        this.waiter = res;
        setTimeout(res, 1000);
      });
    }
    return {
      events: this.events,
      finalText: this.finalText.trim(),
      usage: this.usage,
      model: this.model,
    };
  }

  async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Keep model-supplied paths inside the workspace sandbox. */
function sandbox(ws: string, p: string): string {
  const root = resolve(ws);
  const full = resolve(root, p);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`path escapes workspace: ${p}`);
  return full;
}

function execTool(ws: string, name: string, args: any): unknown {
  switch (name) {
    case "read_file":
      return { content: readFileSync(sandbox(ws, args.path), "utf8") };
    case "write_file": {
      const f = sandbox(ws, args.path);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, args.content ?? "");
      return { ok: true, bytes: (args.content ?? "").length };
    }
    case "edit_file": {
      const f = sandbox(ws, args.path);
      const cur = readFileSync(f, "utf8");
      if (!cur.includes(args.old))
        throw new Error("`old` string not found in file");
      writeFileSync(f, cur.replace(args.old, args.new));
      return { ok: true };
    }
    case "bash": {
      const r = Bun.spawnSync(["bash", "-c", String(args.command)], {
        cwd: ws,
      });
      return {
        stdout: r.stdout.toString().slice(0, 8000),
        stderr: r.stderr.toString().slice(0, 4000),
        exit_code: r.exitCode,
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
