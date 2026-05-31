import { resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { REPORTS_DIR } from "./paths";
import type { Usage } from "../agents/base";

/**
 * Approximate USD per 1M text tokens. Audio tokens cost more; refine as the
 * speech layer lands. Treat these as estimates — actuals come from usage.
 */
export const PRICING: Record<string, { in: number; out: number }> = {
  "gpt-realtime": { in: 4, out: 16 },
  "gpt-4o-realtime-preview-2024-12-17": { in: 5, out: 20 },
  "gpt-4o-realtime-preview": { in: 5, out: 20 },
  // Gemini 2.5 Flash Native Audio / Live API — input $0.50, output $2 per 1M
  // tokens (text). Audio output is ~$12/1M tokens; we use the blended text
  // figure since the harness only tracks total tokens.
  "gemini-2.5-flash-preview-native-audio-dialog": { in: 0.5, out: 2 },
  "gemini-live-2.5-flash-preview": { in: 0.5, out: 2 },
  // xAI Grok Voice — pricing not publicly listed by xAI for the voice tier;
  // we use Grok 4 text rates as a stand-in ($3 in / $15 out per 1M tokens).
  // Refine when xAI publishes voice-specific pricing.
  "grok-voice-think-fast-1.0": { in: 3, out: 15 },
  // Anthropic Claude Sonnet 4.5 — $3 in / $15 out per 1M tokens. Used for
  // Kazoo's Claude Agent SDK executor pass.
  "claude-sonnet-4-5": { in: 3, out: 15 },
  default: { in: 5, out: 20 },
};

export function computeCost(model: string, u: Usage): number {
  const p = PRICING[model] ?? PRICING.default;
  const tokens = ((u.inputTokens ?? 0) / 1e6) * p.in + ((u.outputTokens ?? 0) / 1e6) * p.out;
  return tokens + (u.extraCostUsd ?? 0);
}

const HIST = resolve(REPORTS_DIR, ".cost-history.json");

function load(): Record<string, number[]> {
  try {
    return JSON.parse(readFileSync(HIST, "utf8"));
  } catch {
    return {};
  }
}

export function recordCost(scenario: string, agent: string, cost: number) {
  const h = load();
  const key = `${scenario}::${agent}`;
  (h[key] ??= []).push(cost);
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(HIST, JSON.stringify(h));
}

/** Pre-run estimate = mean of prior runs for this scenario/agent (null if none). */
export function estimateCost(scenario: string, agent: string): number | null {
  const arr = load()[`${scenario}::${agent}`];
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
