import { resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { Usage } from "../agents/base";

/**
 * Approximate USD per 1M text tokens. Audio tokens cost more; refine as the
 * speech layer lands. Treat these as estimates — actuals come from usage.
 */
export const PRICING: Record<string, { in: number; out: number }> = {
  "gpt-realtime": { in: 4, out: 16 },
  "gpt-4o-realtime-preview-2024-12-17": { in: 5, out: 20 },
  "gpt-4o-realtime-preview": { in: 5, out: 20 },
  default: { in: 5, out: 20 },
};

export function computeCost(model: string, u: Usage): number {
  const p = PRICING[model] ?? PRICING.default;
  return ((u.inputTokens ?? 0) / 1e6) * p.in + ((u.outputTokens ?? 0) / 1e6) * p.out;
}

const HIST = resolve("reports", ".cost-history.json");

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
  mkdirSync(resolve("reports"), { recursive: true });
  writeFileSync(HIST, JSON.stringify(h));
}

/** Pre-run estimate = mean of prior runs for this scenario/agent (null if none). */
export function estimateCost(scenario: string, agent: string): number | null {
  const arr = load()[`${scenario}::${agent}`];
  if (!arr?.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
