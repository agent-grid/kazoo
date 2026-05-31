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

const ENDPOINT = "wss://api.x.ai/v1/realtime";
// Default model = xAI's flagship voice model ("Grok Voice Think Fast 1.0", the
// thinking-augmented voice model the user asked for). Override via env if needed.
// See: https://docs.x.ai/docs/guides/voice/agent
const DEFAULT_MODEL =
  process.env.VOICE_EVAL_GROK_MODEL || "grok-voice-think-fast-1.0";
const DEFAULT_VOICE = "eve";

// ---------------------------------------------------------------------------
// Pi-like tools the AGENT owns — identical to the openai-realtime adapter so
// scenarios that target either provider run the same task. The eval harness
// does NOT inject tools; the adapter is a black box.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    type: "function",
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
    type: "function",
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
  "describe what you will do, and do NOT end your turn until the task is fully complete. Keep spoken " +
  "narration to a minimum. When everything is done, briefly report what you did.";

/**
 * xAI Grok Voice Realtime adapter. Speaks the xAI dialect of the OpenAI-
 * compatible Realtime protocol (beta-shape session config — top-level voice /
 * turn_detection / audio.{input,output} — no `output_modalities` field). The
 * model is native speech-to-speech; the "text layer" in the eval is satisfied
 * by reading the assistant's audio-transcript stream as the response text.
 *
 * Self-contained: it reads XAI_API_KEY directly from process.env and IGNORES
 * the harness-supplied `cfg.apiKey` and `cfg.model` (which default to OpenAI's
 * config). Same pi-like tools as openai-realtime.ts; executed internally in
 * the workspace sandbox; results fed back via function_call_output.
 */
export default class GrokVoiceAdapter implements AgentAdapter {
  readonly id = "grok-voice";
  private ws!: WebSocket;
  private cfg!: AgentConfig;
  private model = DEFAULT_MODEL;
  private events: CanonicalEvent[] = [];
  private finalText = "";
  private transcriptBuf = "";
  private usage: Usage = {};
  private done = false;
  private toolPromises: Promise<void>[] = [];
  private waiter: (() => void) | null = null;
  private t0 = 0;
  onEvent?: (e: CanonicalEvent) => void;

  capabilities(): Capabilities {
    return {
      // Even though native-S2S, the "text" layer is supported via transcript
      // capture (input_text in, audio_transcript out). Speech layer works in
      // principle (PCM16 in/out) but the eval harness does not drive audio
      // I/O in this adapter version.
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
    // Self-contained: ignore harness-provided OpenAI key + model; use xAI key
    // and our own model. Harness still gets a single connect() callback shape.
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey)
      throw new Error(
        "XAI_API_KEY not set (add it to .env). See .env.example.",
      );
    this.t0 = this.now();
    const url = `${ENDPOINT}?model=${encodeURIComponent(this.model)}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    } as any);

    await new Promise<void>((res, rej) => {
      let settled = false;
      this.ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        res();
      });
      this.ws.addEventListener("error", async (e: any) => {
        if (settled) return;
        settled = true;
        // Bun's WebSocket only surfaces "Expected 101 status code" — the
        // actual HTTP upgrade status and body are hidden, which makes it
        // impossible to tell auth (401), entitlement (403/429), wrong
        // path (404), or bad-upgrade (400/426) apart from a real protocol
        // bug. Replay the upgrade as an HTTPS fetch to extract the real
        // status and body and bake them into the rejection message.
        const wsMsg = e?.message ?? String(e);
        const detail = await probeUpgrade(url, apiKey).catch(() => null);
        const suffix = detail
          ? ` (HTTP ${detail.status}${detail.body ? `: ${detail.body}` : ""})`
          : "";
        rej(new Error("websocket upgrade failed: " + wsMsg + suffix));
      });
    });
    this.ws.addEventListener("message", (ev: any) =>
      this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data)),
    );
    this.ws.addEventListener("close", () => {
      this.done = true;
      this.wake();
    });

    const instructions = config.instructions
      ? `${BASE_INSTRUCTIONS}\n\n${config.instructions}`
      : BASE_INSTRUCTIONS;

    // xAI beta-shape session: voice + turn_detection at top level, audio.{input,output}
    // with a PCM16 24kHz format, no `type: "realtime"`, no `output_modalities`.
    // turn_detection is disabled — we never stream user audio, just text turns.
    const session: any = {
      instructions,
      voice: config.voice ?? DEFAULT_VOICE,
      turn_detection: null,
      tools: TOOLS,
      tool_choice: "auto",
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 } },
        output: { format: { type: "audio/pcm", rate: 24000 } },
      },
    };
    this.send({ type: "session.update", session });
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
    switch (m.type) {
      // Direct text-mode streaming (rare for a voice model but accept it).
      case "response.text.delta":
      case "response.output_text.delta":
        this.finalText += m.delta ?? "";
        this.emit({ type: "response.delta", t, text: m.delta ?? "" });
        break;
      // Voice-model "text" channel: the spoken transcript. We treat each
      // delta as a response.delta so the harness sees a unified text stream.
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (m.delta) {
          this.transcriptBuf += m.delta;
          this.emit({ type: "response.delta", t, text: m.delta });
          this.emit({
            type: "transcript.partial",
            t,
            role: "assistant",
            source: "model",
            text: m.delta,
          });
        }
        break;
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const text = m.transcript ?? this.transcriptBuf;
        if (text) {
          this.emit({
            type: "transcript.final",
            t,
            role: "assistant",
            source: "model",
            text,
          });
          // Prefer the explicit transcript.done payload over the delta buffer.
          if (m.transcript && !this.finalText) this.finalText = m.transcript;
        }
        this.transcriptBuf = "";
        break;
      }
      case "response.audio.delta":
      case "response.output_audio.delta":
        if (m.delta)
          this.emit({
            type: "audio.output.chunk",
            t,
            bytes: Math.floor((m.delta.length * 3) / 4),
          });
        break;
      case "response.function_call_arguments.done":
        this.toolPromises.push(
          this.handleToolCall(m.call_id, m.name, m.arguments, t),
        );
        break;
      case "response.done": {
        const u = m.response?.usage;
        if (u) {
          this.usage = {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
          };
          this.emit({ type: "usage", t, usage: this.usage });
        }
        const out: any[] = m.response?.output ?? [];
        // Fish a final text out of the response body if we don't already have one.
        for (const it of out) {
          if (it.type === "message") {
            for (const c of it.content ?? []) {
              if (c.type === "text" && c.text && !this.finalText)
                this.finalText = c.text;
              if (
                (c.type === "audio" || c.type === "output_audio") &&
                c.transcript &&
                !this.finalText
              ) {
                this.finalText = c.transcript;
              }
            }
          }
        }
        // Fall back to whatever we streamed in the transcript channel.
        if (!this.finalText && this.transcriptBuf) {
          this.finalText = this.transcriptBuf;
          this.transcriptBuf = "";
        }
        if (out.some((it) => it.type === "function_call")) {
          const ps = this.toolPromises;
          this.toolPromises = [];
          Promise.all(ps).then(() => this.requestResponse());
        } else {
          this.done = true;
          this.emit({ type: "response.final", t, text: this.finalText });
          this.wake();
        }
        break;
      }
      case "error":
        this.emit({
          type: "error",
          t,
          message: m.error?.message ?? JSON.stringify(m.error ?? m),
        });
        this.done = true;
        this.wake();
        break;
    }
  }

  private async handleToolCall(
    callId: string,
    name: string,
    argsJson: string,
    t: number,
  ) {
    let args: any = {};
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      /* leave empty */
    }
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
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
  }

  private requestResponse() {
    // xAI's beta dialect ignores response.output_modalities — let it default
    // (audio + transcript). The transcript channel is what feeds finalText.
    this.send({ type: "response.create" });
  }

  async runText(
    text: string,
    onEvent?: (e: CanonicalEvent) => void,
  ): Promise<TurnTrace> {
    if (onEvent) this.onEvent = onEvent;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.requestResponse();
    // Voice synthesis can be slow on multi-tool runs; same budget as the
    // OpenAI Realtime adapter for parity in matrix evals.
    const timeoutMs = this.cfg.layer === "speech" ? 180000 : 120000;
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

/**
 * Replay a failed WebSocket upgrade as an HTTPS GET with the upgrade headers,
 * so we can see the real HTTP status + body that the WS API hides. Used only
 * on the error path; the key is never logged — only the response is returned.
 */
async function probeUpgrade(
  wsUrl: string,
  apiKey: string,
): Promise<{ status: number; body: string } | null> {
  try {
    const httpsUrl = wsUrl.replace(/^wss:/, "https:");
    const r = await fetch(httpsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        // Static nonce is fine: we only care about the status the server
        // returns BEFORE accepting the upgrade — a real upgrade would echo
        // back a derived Sec-WebSocket-Accept, but on error we never get
        // that far.
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    const body = (await r.text()).slice(0, 500);
    return { status: r.status, body };
  } catch {
    return null;
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
