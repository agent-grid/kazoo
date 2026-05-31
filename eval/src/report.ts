import { resolve } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { REPORTS_DIR } from "./paths";
import { c } from "./util/colors";

interface RunReport {
  runId?: string;
  scenario: string;
  agent: string;
  layer?: string;
  mode?: string;
  model?: string;
  score: number;
  pass: boolean;
  components?: Record<string, number>;
  metrics?: Record<string, number | null>;
  cost_usd?: number;
  finalText?: string;
  speech?: { inputWav: string; outputWav?: string; asrModel: string };
}

/** CLI entrypoint: with a runId → show that single run; without → cross-agent summary. */
export function report(runId?: string) {
  if (runId) {
    printRun(runId);
    return;
  }
  const reports = loadLatestReports();
  if (!reports.length) {
    console.log("no reports yet — run a scenario first");
    return;
  }
  printAgentSummary(reports);
}

/** Most recent persisted report per (scenario, agent). */
function loadLatestReports(): RunReport[] {
  const dir = REPORTS_DIR;
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort(); // ISO timestamp prefix → ascending
  const latest = new Map<string, RunReport>();
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as RunReport;
      latest.set(`${r.scenario}::${r.agent}`, r);
    } catch {
      // skip malformed
    }
  }
  return [...latest.values()];
}

function printRun(runId: string) {
  const dir = REPORTS_DIR;
  const file = resolve(dir, runId.endsWith(".json") ? runId : `${runId}.json`);
  if (!existsSync(file)) {
    console.error(`no report found: ${file}`);
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(file, "utf8")) as RunReport;
  console.log(`\n${c.boldCyan(r.scenario)} ${c.dim(`via ${r.agent} [${r.layer}${r.mode && r.mode !== r.layer ? `→${r.mode}` : ""}] model=${r.model}`)}`);
  console.log(`  ${c.bold("SCORE:")} ${(r.pass ? c.green : c.red)(`${r.score}/100`)}  ${r.pass ? c.green("✓ PASS") : c.red("✗ FAIL")}`);
  for (const [k, v] of Object.entries(r.components ?? {})) {
    const val = Math.round((v as number) * 100);
    const vc = val >= 100 ? c.green : val > 0 ? c.yellow : c.red;
    console.log(`    ${c.dim(`${k}:`)} ${vc(String(val))}`);
  }
  const m = r.metrics ?? {};
  console.log(
    c.dim(
      `  latency: ttft=${m.ttft_ms ?? "-"}ms first_audio=${m.time_to_first_audio_ms ?? "-"}ms first_tool=${m.first_tool_ms ?? "-"}ms total=${m.total_ms ?? "-"}ms`,
    ),
  );
  if (r.speech) {
    console.log(
      c.dim(
        `  speech: input=${r.speech.inputWav} output=${r.speech.outputWav ?? "—"} asr=${r.speech.asrModel}`,
      ),
    );
  }
  console.log(`  ${c.yellow(`cost: $${(r.cost_usd ?? 0).toFixed(4)}`)}`);
  console.log(`  ${c.dim("final:")} ${String(r.finalText ?? "").slice(0, 200)}\n`);
}

export interface RunOutcome {
  scenario: string;
  agent: string;
  score: number;
  pass: boolean;
  error?: string;
  metrics?: Record<string, number | null>;
  cost_usd?: number;
}

interface AgentStats {
  agent: string;
  runs: number;
  passed: number;
  failed: number;
  errored: number;
  avgScore: number | null;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  avgCost: number | null;
  totalCost: number;
}

/**
 * Aggregate run outcomes by agent and render an aligned table.
 * Errored runs are counted (not dropped) and listed individually below the table.
 */
export function printAgentSummary(results: Array<RunReport | RunOutcome>) {
  const byAgent = new Map<string, RunOutcome[]>();
  for (const r of results) {
    const o: RunOutcome = {
      scenario: r.scenario,
      agent: r.agent,
      score: r.score,
      pass: r.pass,
      error: (r as RunOutcome).error,
      metrics: r.metrics,
      cost_usd: r.cost_usd,
    };
    const arr = byAgent.get(o.agent) ?? [];
    arr.push(o);
    byAgent.set(o.agent, arr);
  }

  const stats: AgentStats[] = [...byAgent.entries()].map(([agent, rows]) => {
    const errored = rows.filter((r) => r.error).length;
    const ok = rows.filter((r) => !r.error);
    const passed = ok.filter((r) => r.pass).length;
    const failed = ok.length - passed;
    const scores = ok.map((r) => r.score);
    const lats = ok
      .map((r) => r.metrics?.total_ms)
      .filter((v): v is number => typeof v === "number");
    const costs = ok
      .map((r) => r.cost_usd)
      .filter((v): v is number => typeof v === "number");
    return {
      agent,
      runs: rows.length,
      passed,
      failed,
      errored,
      avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      avgLatencyMs: lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : null,
      p50LatencyMs: percentile(lats, 0.5),
      p95LatencyMs: percentile(lats, 0.95),
      avgCost: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      totalCost: costs.reduce((a, b) => a + b, 0),
    };
  });
  stats.sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));

  const totalScenarios = new Set(results.map((r) => r.scenario)).size;
  console.log(
    `\n${c.bold("═══ AGENT SUMMARY")} ${c.dim(`(${stats.length} agents × ${totalScenarios} scenarios)`)}\n`,
  );

  const cols: { h: string; w: number; right?: boolean }[] = [
    { h: "AGENT", w: Math.max(5, ...stats.map((s) => s.agent.length)) },
    { h: "SCORE", w: 7, right: true },
    { h: "PASS", w: 4, right: true },
    { h: "FAIL", w: 4, right: true },
    { h: "ERR", w: 3, right: true },
    { h: "AVG LAT", w: 8, right: true },
    { h: "P50", w: 7, right: true },
    { h: "P95", w: 7, right: true },
    { h: "AVG COST", w: 9, right: true },
    { h: "TOTAL", w: 9, right: true },
  ];
  const pad = (s: string, w: number, right = false) => (right ? s.padStart(w) : s.padEnd(w));

  const header = cols.map((col) => pad(col.h, col.w, col.right)).join("  ");
  console.log(c.dim(header));
  console.log(c.dim("─".repeat(header.length)));

  for (const s of stats) {
    const scoreStr = s.avgScore != null ? `${Math.round(s.avgScore)}/100` : "—";
    const scoreC =
      s.avgScore == null ? c.dim : s.avgScore >= 50 ? c.green : s.avgScore > 0 ? c.yellow : c.red;
    const cells = [
      pad(s.agent, cols[0].w),
      scoreC(pad(scoreStr, cols[1].w, true)),
      c.green(pad(String(s.passed), cols[2].w, true)),
      (s.failed > 0 ? c.red : c.dim)(pad(String(s.failed), cols[3].w, true)),
      (s.errored > 0 ? c.red : c.dim)(pad(String(s.errored), cols[4].w, true)),
      pad(fmtMs(s.avgLatencyMs), cols[5].w, true),
      pad(fmtMs(s.p50LatencyMs), cols[6].w, true),
      pad(fmtMs(s.p95LatencyMs), cols[7].w, true),
      pad(fmtCost(s.avgCost), cols[8].w, true),
      pad(fmtCost(s.totalCost), cols[9].w, true),
    ];
    console.log(cells.join("  "));
  }

  // Surface every errored (scenario, agent) — never silently drop.
  const erroredRows = [...byAgent.values()].flat().filter((r) => r.error);
  if (erroredRows.length) {
    console.log();
    for (const r of erroredRows) {
      console.log(c.red(`  ✖ ${r.agent} × ${r.scenario}: ${r.error}`));
    }
  }
  console.log();
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const arr = [...values].sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.floor(p * arr.length));
  return arr[idx];
}

function fmtMs(v: number | null): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

function fmtCost(v: number | null): string {
  if (v == null) return "—";
  return `$${v.toFixed(4)}`;
}
