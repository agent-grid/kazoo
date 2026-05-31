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

const ENDPOINT = "wss://api.openai.com/v1/realtime";

// ---------------------------------------------------------------------------
// Pi-like tools the AGENT owns (read / write / edit / bash). The eval harness
// does not define or control these — they belong to the agent under test. This
// is just our first black-box stub; real agents would bring their own tools.
// ---------------------------------------------------------------------------
const BASE_TOOLS = [
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

// http_json: opt-in tool gated by VOICE_EVAL_HTTP_JSON=1. Fetches a URL, parses
// JSON, and (optionally) returns a single field via a dot-path. Exists so the
// agent can avoid brittle bash curl|grep|sed parsing for JSON APIs. See the
// http-json benchmark scenario + scripts/benchmark-http-json.ts.
const HTTP_JSON_TOOL = {
  type: "function",
  name: "http_json",
  description:
    "GET a URL that returns JSON and return the parsed value. Use this instead of bash+curl whenever you need a field from a JSON HTTP response — it removes the need to text-parse. If `json_path` is given (dot path, e.g. \"slideshow.title\"), return only that value; otherwise return the whole parsed object.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
      json_path: {
        type: "string",
        description: "Optional dot-path into the response, e.g. \"slideshow.title\".",
      },
    },
    required: ["url"],
  },
};

const BASE_INSTRUCTIONS =
  "You are an autonomous assistant working inside a project directory. You have these tools: " +
  "read_file, write_file, edit_file, and bash. Use bash for compiling, zipping, hashing, and any " +
  "shell work (node and bun are installed). Call the tools immediately to do the work — do NOT just " +
  "describe what you will do, and do NOT end your turn until the task is fully complete. Keep spoken " +
  "narration to a minimum. When everything is done, briefly report what you did.";

// Tools.md-style entry appended to instructions when http_json is enabled.
// Tells the model exactly when to reach for it instead of bash, the required
// inputs, and a one-line example — same shape as a real project's Tools.md.
const HTTP_JSON_INSTRUCTIONS =
  "\n\nExtra tool available — http_json:\n" +
  "- When to use: any time the task requires a value from a JSON HTTP response. Prefer this over bash+curl+grep/sed/jq; it removes brittle text parsing.\n" +
  "- Required inputs: `url` (absolute http(s) URL). Optional `json_path` (dot path into the response, e.g. \"slideshow.title\") returns just that value verbatim.\n" +
  "- Example: http_json({ url: \"https://httpbin.org/json\", json_path: \"slideshow.title\" }) → returns the title string. Use it directly in your reply.";

/** Tools enabled for this process. Recomputed each connect() so the env flag
 *  can change between runs (the A/B benchmark relies on this). */
function activeTools(): unknown[] {
  return httpJsonEnabled() ? [...BASE_TOOLS, HTTP_JSON_TOOL] : [...BASE_TOOLS];
}

function httpJsonEnabled(): boolean {
  return process.env.VOICE_EVAL_HTTP_JSON === "1";
}

/**
 * OpenAI Realtime adapter (GA "2.0" API). A thin, single-file black-box stub: it
 * brings its own pi-like tools and the harness only sends a prompt and reads the
 * canonical event stream back. Tool calls are executed internally.
 */
export default class OpenAIRealtimeAdapter implements AgentAdapter {
  readonly id = "openai-realtime";
  private ws!: WebSocket;
  private cfg!: AgentConfig;
  private events: CanonicalEvent[] = [];
  private finalText = "";
  private usage: Usage = {};
  private done = false;
  private toolPromises: Promise<void>[] = [];
  private waiter: (() => void) | null = null;
  private t0 = 0;
  /** Output audio (raw PCM16 chunks, in arrival order) for a speech turn. */
  private audioChunks: Uint8Array[] = [];
  onEvent?: (e: CanonicalEvent) => void;

  capabilities(): Capabilities {
    return {
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
    this.t0 = this.now();
    const url = `${ENDPOINT}?model=${encodeURIComponent(config.model)}`;
    // GA Realtime API: Authorization only (no OpenAI-Beta header).
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    } as any);

    await new Promise<void>((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", (e: any) =>
        rej(new Error("websocket error: " + (e?.message ?? e))),
      );
    });
    this.ws.addEventListener("message", (ev: any) =>
      this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data)),
    );
    this.ws.addEventListener("close", () => {
      this.done = true;
      this.wake();
    });

    const baseInstr = httpJsonEnabled()
      ? `${BASE_INSTRUCTIONS}${HTTP_JSON_INSTRUCTIONS}`
      : BASE_INSTRUCTIONS;
    const instructions = config.instructions
      ? `${baseInstr}\n\n${config.instructions}`
      : baseInstr;
    const session: any = {
      type: "realtime",
      output_modalities: config.layer === "speech" ? ["audio"] : ["text"],
      instructions,
      tools: activeTools(),
      tool_choice: "auto",
    };
    if (config.layer === "speech") {
      // single committed user turn — disable server VAD (see spec "Speech I/O").
      // GA Realtime expects audio.input.format / audio.output.format as objects
      // (type/rate), not the legacy "pcm16" string.
      const pcmFmt = { type: "audio/pcm", rate: 24000 };
      session.audio = {
        input: { format: pcmFmt, turn_detection: null },
        output: { format: pcmFmt, voice: config.voice ?? "marin" },
      };
    }
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
      case "response.text.delta":
      case "response.output_text.delta":
        this.finalText += m.delta ?? "";
        this.emit({ type: "response.delta", t, text: m.delta ?? "" });
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        this.emit({
          type: "transcript.partial",
          t,
          role: "assistant",
          source: "model",
          text: m.delta ?? "",
        });
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (m.delta) {
          // Decode base64 PCM16 and keep the raw bytes so the runner can write
          // a WAV file for ASR scoring. The chunk event still surfaces byte
          // counts for latency/scoring; the raw bytes are stashed separately.
          const pcm = Uint8Array.from(Buffer.from(m.delta, "base64"));
          this.audioChunks.push(pcm);
          this.emit({ type: "audio.output.chunk", t, bytes: pcm.length });
        }
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
      result = await execTool(this.cfg.workspaceDir!, name, args);
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
    this.send({
      type: "response.create",
      response: {
        output_modalities: this.cfg.layer === "speech" ? ["audio"] : ["text"],
      },
    });
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
    return this.awaitTurn();
  }

  /**
   * Speech-layer turn: send a recorded user buffer (PCM16 mono @ 24kHz) as one
   * committed input, then ask for a response. The harness records the agent's
   * raw output audio and the assistant transcript (model-emitted) for scoring.
   */
  async runAudio(
    pcm16: Uint8Array,
    onEvent?: (e: CanonicalEvent) => void,
  ): Promise<TurnTrace> {
    if (onEvent) this.onEvent = onEvent;
    // Append the whole buffer as a single base64 chunk, then commit + create.
    // The Realtime input is configured pcm16 @ 24kHz (see connect()), so no
    // conversion is needed here. Large buffers could be sliced, but a short
    // user turn (a few seconds) fits comfortably in one append.
    const b64 = Buffer.from(pcm16).toString("base64");
    this.send({ type: "input_audio_buffer.append", audio: b64 });
    this.send({ type: "input_audio_buffer.commit" });
    this.requestResponse();
    return this.awaitTurn();
  }

  /** Block until the agent finishes the current turn (or we time out). */
  private async awaitTurn(): Promise<TurnTrace> {
    const timeoutMs = this.cfg.layer === "speech" ? 120000 : 90000;
    const start = Date.now();
    while (!this.done && Date.now() - start < timeoutMs) {
      await new Promise<void>((res) => {
        this.waiter = res;
        setTimeout(res, 1000);
      });
    }
    const outputAudio =
      this.cfg.layer === "speech" && this.audioChunks.length
        ? concatBytes(this.audioChunks)
        : undefined;
    return {
      events: this.events,
      finalText: this.finalText.trim(),
      usage: this.usage,
      model: this.cfg.model,
      ...(outputAudio ? { outputAudio } : {}),
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

/** Keep model-supplied paths inside the workspace sandbox. */
function sandbox(ws: string, p: string): string {
  const root = resolve(ws);
  const full = resolve(root, p);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`path escapes workspace: ${p}`);
  return full;
}

async function execTool(ws: string, name: string, args: any): Promise<unknown> {
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
    case "http_json": {
      // Opt-in tool; only registered when VOICE_EVAL_HTTP_JSON=1. Guarded
      // here as well so a stale tool call can't slip past the flag.
      if (!httpJsonEnabled()) throw new Error("http_json disabled");
      return await httpJson(args);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Fetch a URL, parse JSON, optionally dot-path into it. Real network call. */
async function httpJson(args: any): Promise<unknown> {
  const url = String(args?.url ?? "");
  if (!/^https?:\/\//i.test(url)) throw new Error("url must be http(s)");
  const ctrl = new AbortController();
  const timeoutMs = 15000;
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  let data: unknown;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const txt = await res.text();
    try {
      data = JSON.parse(txt);
    } catch {
      throw new Error(`response was not valid JSON (first 80 chars: ${txt.slice(0, 80)})`);
    }
  } finally {
    clearTimeout(to);
  }
  const path = typeof args?.json_path === "string" ? args.json_path.trim() : "";
  if (!path) return { url, value: data };
  // Simple dot path — supports `a.b.c` and numeric indices (`a.0.b`).
  let cur: any = data;
  for (const seg of path.split(".")) {
    if (cur == null) break;
    cur = cur[seg];
  }
  if (cur === undefined) throw new Error(`json_path not found: ${path}`);
  return { url, json_path: path, value: cur };
}
