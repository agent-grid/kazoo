/**
 * Agent adapter contract + canonical event model. Each adapter translates its
 * provider's wire protocol into these types. See ../initial-spec.md.
 */

export type Layer = "text" | "speech";

export type Architecture = "native_s2s" | "cascade" | "unknown";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  inputAudioSec?: number;
  outputAudioSec?: number;
}

/** Provider-agnostic events. Every event carries a monotonic timestamp `t` (ms). */
export type CanonicalEvent =
  | { type: "session.started"; t: number }
  | { type: "transcript.partial"; t: number; role: "user" | "assistant"; source: "asr" | "model"; text: string }
  | { type: "transcript.final"; t: number; role: "user" | "assistant"; source: "asr" | "model"; text: string }
  | { type: "tool.call"; t: number; id: string; name: string; args: unknown }
  | { type: "tool.result"; t: number; id: string; result: unknown; error?: string }
  | { type: "audio.output.chunk"; t: number; bytes: number }
  | { type: "response.delta"; t: number; text: string }
  | { type: "response.final"; t: number; text: string }
  | { type: "usage"; t: number; usage: Usage }
  | { type: "error"; t: number; message: string };

export interface AgentConfig {
  apiKey: string;
  model: string;
  layer: Layer;
  instructions?: string;
  /** Per-run workspace dir the agent's tools operate within (sandbox root). */
  workspaceDir?: string;
  voice?: string;
}

export interface Capabilities {
  layers: Layer[];
  architecture: Architecture;
  supportsTools: boolean;
  supportsBargeIn: boolean;
}

/** One full turn: input + the collected canonical trace. */
export interface TurnTrace {
  events: CanonicalEvent[];
  finalText: string;
  usage: Usage;
  /** Raw PCM16 mono @ 24kHz — present only for `layer: "speech"` turns. */
  outputAudio?: Uint8Array;
}

export interface AgentAdapter {
  readonly id: string;
  capabilities(): Capabilities;
  connect(config: AgentConfig): Promise<void>;
  /** Send one user turn (text) and run it to completion, executing tools internally. */
  runText(text: string, onEvent?: (e: CanonicalEvent) => void): Promise<TurnTrace>;
  /**
   * Speech-layer turn: send raw PCM16 mono @ 24kHz as the user's audio, run to
   * completion, return the trace including the assistant's output audio.
   * Optional on adapters that don't yet support speech.
   */
  runAudio?(
    pcm16: Uint8Array,
    onEvent?: (e: CanonicalEvent) => void,
  ): Promise<TurnTrace>;
  close(): Promise<void>;
}
