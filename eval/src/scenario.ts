import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Layer, TurnTrace } from "../agents/base";

/** Verifier types (see initial-spec.md "Verification"). */
export interface VerifierContext {
  scenarioDir: string;
  workspaceDir: string;
  trace: TurnTrace;
  expected: unknown;
}

export interface VerifierResult {
  pass: boolean;
  /** Binary {0,1} for script verifiers; [0,1] for graded judges. */
  score: number;
  details: string;
  evidence?: Record<string, unknown>;
}

export type Verifier = (ctx: VerifierContext) => Promise<VerifierResult>;

export interface ScenarioVerifier {
  type: "script" | "llm_judge";
  /** For script: path (relative to scenario dir) to a module exporting `verify`. */
  path?: string;
  /** llm_judge: pass threshold in [0,1] (default 0.7). */
  threshold?: number;
  /** llm_judge: n-sample majority to reduce variance (default 1). */
  samples?: number;
}

export interface Scenario {
  id: string;
  description: string;
  layer: Layer;
  system_prompt: string;
  user_prompt: string;
  /** Optional override for the TTS fallback in scripts/gen-input.ts. */
  input_text?: string;
  input_audio?: string;
  expected_outcome?: unknown;
  verification: ScenarioVerifier[];
  /** Seed files copied into the run workspace before the turn. */
  workspace_seed?: string;
  timeout_ms?: number;
  latency_thresholds?: { ttft_ms?: number; total_ms?: number };
  /** Directory the scenario was loaded from (filled in by the loader). */
  dir: string;
}

export function loadScenario(dir: string): Scenario {
  const file = resolve(dir, "scenario.json");
  if (!existsSync(file)) throw new Error(`no scenario.json found in ${dir}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["id", "layer", "user_prompt", "verification"]) {
    if (!(k in raw)) throw new Error(`scenario ${dir} missing required field '${k}'`);
  }
  return { ...raw, dir: resolve(dir) } as Scenario;
}
