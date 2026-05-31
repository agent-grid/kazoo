import type { TurnTrace, CanonicalEvent } from "../agents/base";
import type { Scenario, VerifierResult } from "./scenario";

export interface Score {
  total: number; // 0..100
  pass: boolean;
  components: Record<string, number>; // each 0..1
  metrics: Record<string, number | null>;
}

const PASS_THRESHOLD = 50;

/** Equal-weight aggregation into a single 0..100 score (see spec "Scoring Aggregation"). */
export function scoreRun(scenario: Scenario, trace: TurnTrace, verifiers: VerifierResult[]): Score {
  const components: Record<string, number> = {};

  if (verifiers.length) {
    components.task_success = verifiers.reduce((a, v) => a + v.score, 0) / verifiers.length;
  }

  const keys = Object.keys(components);
  const total = keys.length ? Math.round((100 * keys.reduce((a, k) => a + components[k], 0)) / keys.length) : 0;
  return { total, pass: total >= PASS_THRESHOLD, components, metrics: latency(trace.events) };
}

function latency(events: CanonicalEvent[]): Record<string, number | null> {
  const t0 = events.find((e) => e.type === "session.started")?.t ?? events[0]?.t ?? 0;
  const firstResp = events.find((e) => e.type === "response.delta" || e.type === "transcript.partial")?.t;
  const firstAudio = events.find((e) => e.type === "audio.output.chunk")?.t;
  const firstTool = events.find((e) => e.type === "tool.call")?.t;
  const final = [...events].reverse().find((e) => e.type === "response.final")?.t ?? events.at(-1)?.t;
  return {
    ttft_ms: firstResp != null ? Math.round(firstResp - t0) : null,
    time_to_first_audio_ms: firstAudio != null ? Math.round(firstAudio - t0) : null,
    first_tool_ms: firstTool != null ? Math.round(firstTool - t0) : null,
    total_ms: final != null ? Math.round(final - t0) : null,
  };
}
