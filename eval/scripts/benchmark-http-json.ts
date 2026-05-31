/**
 * A/B benchmark — does the openai-realtime agent get better at extracting a
 * field from a JSON HTTP response when given a dedicated `http_json` tool?
 *
 * Conditions:
 *   - baseline   : bash-only (VOICE_EVAL_HTTP_JSON unset / "0").
 *   - improved   : also exposes `http_json` (VOICE_EVAL_HTTP_JSON="1") +
 *                  appends a Tools.md note describing when to use it.
 *
 * Per condition we do 1 warmup (discarded) + N measured runs of
 * scenarios/http-json. Per run we record: pass/fail, exactMatch, start/end
 * timestamps, durationMs, raw final text, verifier evidence. Aggregates: pass
 * rate, exact-match rate, median durationMs. Then a verdict line.
 *
 * Usage:
 *   bun run scripts/benchmark-http-json.ts [--runs N]      # N in [5,10], default 6
 *
 * Output:
 *   - Comparison table on stdout (uses src/util/colors.ts).
 *   - Full JSON report at reports/benchmark-http-json-<stamp>.json.
 */
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { runScenario } from "../src/run";
import { c } from "../src/util/colors";

type ConditionId = "baseline" | "improved";

interface RunRecord {
  condition: ConditionId;
  index: number;          // 0 = warmup, 1..N = measured
  warmup: boolean;
  pass: boolean;
  exactMatch: boolean;
  containsTitle: boolean;
  startTs: string;        // ISO
  endTs: string;          // ISO
  startMs: number;        // epoch ms (for raw math)
  endMs: number;
  durationMs: number;
  finalText: string;
  expectedTitle?: string;
  groundTruthSource?: string;
  score: number;
  runId?: string;
  error?: string;
  failureMode?: string;   // tagged classification, see classifyFailure()
}

interface Aggregate {
  condition: ConditionId;
  n: number;
  passes: number;
  passRate: number;       // 0..1
  exactMatches: number;
  exactRate: number;      // 0..1
  durations: number[];
  medianMs: number;
  meanMs: number;
  failureModes: Record<string, number>;
}

const SCENARIO_DIR = resolve("scenarios/http-json");
const AGENT = "openai-realtime";

async function main() {
  const runsArg = parseRunsArg();
  const N = runsArg;
  console.log(c.boldCyan("\n== http-json A/B benchmark =="));
  console.log(
    c.dim(
      `agent=${AGENT} scenario=${SCENARIO_DIR.replace(process.cwd() + "/", "")} ` +
        `runs/condition=${N} (+1 warmup) model=${process.env.VOICE_EVAL_MODEL || "gpt-realtime"}\n`,
    ),
  );

  await preflightHttpbin();

  const records: RunRecord[] = [];
  for (const condition of ["baseline", "improved"] as const) {
    console.log(c.bold(`\n--- condition: ${condition} ---`));
    setConditionEnv(condition);
    // Warmup (counted but flagged warmup:true, excluded from aggregates).
    records.push(await runOne(condition, 0, true));
    for (let i = 1; i <= N; i++) {
      records.push(await runOne(condition, i, false));
    }
  }

  const aggregates: Record<ConditionId, Aggregate> = {
    baseline: aggregate("baseline", records),
    improved: aggregate("improved", records),
  };

  printTable(aggregates);
  const verdict = verdictFor(aggregates);
  printVerdict(verdict);
  printFailureSummary(records);

  // JSON report
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = resolve("reports", `benchmark-http-json-${stamp}.json`);
  mkdirSync(resolve("reports"), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        benchmark: "http-json",
        agent: AGENT,
        scenario: SCENARIO_DIR,
        model: process.env.VOICE_EVAL_MODEL || "gpt-realtime",
        runsPerCondition: N,
        stamp,
        aggregates,
        verdict,
        runs: records,
      },
      null,
      2,
    ),
  );
  console.log(c.dim(`\nfull report: ${outPath.replace(process.cwd() + "/", "")}`));
}

function parseRunsArg(): number {
  const i = process.argv.indexOf("--runs");
  const v = i >= 0 ? Number(process.argv[i + 1]) : 6;
  if (!Number.isFinite(v) || v < 5 || v > 10) {
    console.error(`--runs must be between 5 and 10 (got ${process.argv[i + 1]})`);
    process.exit(1);
  }
  return v;
}

/** Confirm httpbin is reachable so we fail loudly instead of mid-benchmark. */
async function preflightHttpbin() {
  const url = "https://httpbin.org/json";
  let lastErr: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error(`http ${res.status}`);
      const data: any = await res.json();
      const title = data?.slideshow?.title;
      if (typeof title !== "string")
        throw new Error("slideshow.title not a string");
      console.log(c.dim(`preflight: httpbin reachable, title="${title}"`));
      return;
    } catch (e: any) {
      clearTimeout(to);
      lastErr = String(e?.message ?? e);
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  console.error(
    c.red(
      `\nFAIL: httpbin.org/json unreachable after 3 attempts (${lastErr}). ` +
        `Cannot run benchmark — refusing to proceed.`,
    ),
  );
  process.exit(2);
}

function setConditionEnv(cond: ConditionId) {
  if (cond === "improved") process.env.VOICE_EVAL_HTTP_JSON = "1";
  else process.env.VOICE_EVAL_HTTP_JSON = "0";
}

async function runOne(
  condition: ConditionId,
  index: number,
  warmup: boolean,
): Promise<RunRecord> {
  const label = warmup ? "warmup" : `run ${index}/?`;
  console.log(c.dim(`  ${condition} ${label} →`));
  const startMs = Date.now();
  const startTs = new Date(startMs).toISOString();
  try {
    const r: any = await runScenario(SCENARIO_DIR, AGENT);
    const endMs = Date.now();
    const verifier = r.verifiers?.[0] ?? {};
    const ev = (verifier.evidence ?? {}) as Record<string, unknown>;
    const finalText = String(r.finalText ?? "");
    const exact = !!ev.exactMatch;
    const contains = !!ev.containsTitle;
    const expectedTitle = typeof ev.expectedTitle === "string" ? (ev.expectedTitle as string) : undefined;
    const groundTruthSource =
      typeof ev.groundTruthSource === "string" ? (ev.groundTruthSource as string) : undefined;
    const failureMode = r.pass ? undefined : classifyFailure(finalText, expectedTitle);
    return {
      condition,
      index,
      warmup,
      pass: !!r.pass,
      exactMatch: exact,
      containsTitle: contains,
      startTs,
      endTs: new Date(endMs).toISOString(),
      startMs,
      endMs,
      durationMs: endMs - startMs,
      finalText,
      expectedTitle,
      groundTruthSource,
      score: Number(r.score ?? 0),
      runId: r.runId,
      failureMode,
    };
  } catch (e: any) {
    const endMs = Date.now();
    const error = String(e?.message ?? e);
    return {
      condition,
      index,
      warmup,
      pass: false,
      exactMatch: false,
      containsTitle: false,
      startTs,
      endTs: new Date(endMs).toISOString(),
      startMs,
      endMs,
      durationMs: endMs - startMs,
      finalText: "",
      score: 0,
      error,
      failureMode: "harness_error",
    };
  }
}

/** Tag the loss mode so the report's "Notes" section is actionable. */
function classifyFailure(out: string, expected?: string): string {
  const o = (out ?? "").trim();
  if (!o) return "empty_output";
  if (!expected) return "no_expected_title";
  const lo = o.toLowerCase();
  const lx = expected.toLowerCase();
  if (lo === lx) return "case_or_whitespace_only"; // shouldn't happen — exact would have passed
  if (lo.includes(lx)) {
    // Contains the right value but wrapped in prose / quotes / punctuation.
    if (/^['"]|['"]$/.test(o)) return "wrapped_in_quotes";
    return "wrapped_in_prose";
  }
  // Common bash-parsing misses: "Sample" only, "Slideshow" (no space), etc.
  if (expected.split(" ").some((w) => lo.includes(w.toLowerCase())))
    return "partial_title_brittle_parse";
  return "wrong_value";
}

function aggregate(condition: ConditionId, records: RunRecord[]): Aggregate {
  const rs = records.filter((r) => r.condition === condition && !r.warmup);
  const passes = rs.filter((r) => r.pass).length;
  const exactMatches = rs.filter((r) => r.exactMatch).length;
  const durations = rs.map((r) => r.durationMs);
  const failureModes: Record<string, number> = {};
  for (const r of rs) {
    if (!r.pass && r.failureMode) {
      failureModes[r.failureMode] = (failureModes[r.failureMode] ?? 0) + 1;
    }
  }
  return {
    condition,
    n: rs.length,
    passes,
    passRate: rs.length ? passes / rs.length : 0,
    exactMatches,
    exactRate: rs.length ? exactMatches / rs.length : 0,
    durations,
    medianMs: median(durations),
    meanMs: rs.length ? Math.round(durations.reduce((a, b) => a + b, 0) / rs.length) : 0,
    failureModes,
  };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function pad(s: string, n: number): string {
  // ANSI-codes confuse padding; strip before measuring width.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, n - visible.length));
}

function printTable(agg: Record<ConditionId, Aggregate>) {
  const cols = [
    { h: "condition", w: 12 },
    { h: "n", w: 4 },
    { h: "pass rate", w: 12 },
    { h: "exact rate", w: 12 },
    { h: "median ms", w: 12 },
    { h: "mean ms", w: 10 },
  ];
  console.log("\n" + c.bold("== A/B comparison =="));
  const header = cols.map((col) => pad(c.dim(col.h), col.w)).join(" ");
  console.log(header);
  console.log(c.dim("-".repeat(cols.reduce((a, x) => a + x.w + 1, 0))));
  for (const cond of ["baseline", "improved"] as const) {
    const a = agg[cond];
    const passColor = pickRateColor(a.passRate);
    const exactColor = pickRateColor(a.exactRate);
    const row = [
      pad(cond === "improved" ? c.boldCyan(cond) : c.cyan(cond), cols[0].w),
      pad(String(a.n), cols[1].w),
      pad(passColor(`${a.passes}/${a.n} (${pct(a.passRate)})`), cols[2].w),
      pad(exactColor(`${a.exactMatches}/${a.n} (${pct(a.exactRate)})`), cols[3].w),
      pad(String(a.medianMs), cols[4].w),
      pad(String(a.meanMs), cols[5].w),
    ].join(" ");
    console.log(row);
  }
}

function pickRateColor(r: number) {
  return r >= 0.8 ? c.green : r >= 0.5 ? c.yellow : c.red;
}
function pct(r: number) {
  return `${Math.round(r * 100)}%`;
}

interface Verdict {
  improvedHigherPassRate: boolean;
  improvedReturnsExactTitle: boolean;
  improvedAvoidsBrittleParsing: boolean; // heuristic — see below
  allMet: boolean;
  notes: string[];
}

/**
 * Map the spec's three success criteria to numbers we have:
 *  - improved.passRate > baseline.passRate
 *  - improved.exactRate == 1.0 (every measured run returned the exact title)
 *  - "avoids brittle text parsing" — proxy: no improved run failed with a
 *    bash-parsing-shaped failureMode (partial_title_brittle_parse,
 *    wrapped_in_quotes, wrapped_in_prose). True iff no such failure occurred.
 */
function verdictFor(agg: Record<ConditionId, Aggregate>): Verdict {
  const higher = agg.improved.passRate > agg.baseline.passRate;
  const exact = agg.improved.exactRate >= 1.0 && agg.improved.n > 0;
  const brittleModes = new Set([
    "partial_title_brittle_parse",
    "wrapped_in_quotes",
    "wrapped_in_prose",
  ]);
  const avoids = !Object.keys(agg.improved.failureModes).some((m) => brittleModes.has(m));
  const notes: string[] = [];
  if (!higher)
    notes.push(
      `improved passRate (${pct(agg.improved.passRate)}) NOT greater than baseline (${pct(agg.baseline.passRate)})`,
    );
  if (!exact)
    notes.push(`improved exactRate (${pct(agg.improved.exactRate)}) < 100%`);
  if (!avoids)
    notes.push(
      `improved still showed brittle-parsing failure modes: ${Object.keys(agg.improved.failureModes)
        .filter((m) => brittleModes.has(m))
        .join(", ")}`,
    );
  return {
    improvedHigherPassRate: higher,
    improvedReturnsExactTitle: exact,
    improvedAvoidsBrittleParsing: avoids,
    allMet: higher && exact && avoids,
    notes,
  };
}

function printVerdict(v: Verdict) {
  const line = v.allMet
    ? c.green("VERDICT: success criteria met ✓")
    : c.red("VERDICT: success criteria NOT met ✗");
  console.log("\n" + c.bold(line));
  const mark = (b: boolean) => (b ? c.green("✓") : c.red("✗"));
  console.log(`  ${mark(v.improvedHigherPassRate)} improved pass rate > baseline`);
  console.log(`  ${mark(v.improvedReturnsExactTitle)} improved returns exact title (100%)`);
  console.log(`  ${mark(v.improvedAvoidsBrittleParsing)} improved avoids brittle text parsing`);
  for (const n of v.notes) console.log(c.dim(`    - ${n}`));
}

function printFailureSummary(records: RunRecord[]) {
  const measured = records.filter((r) => !r.warmup);
  const fails = measured.filter((r) => !r.pass);
  if (!fails.length) {
    console.log(c.dim("\nfailure modes: none observed"));
    return;
  }
  console.log("\n" + c.bold("failure modes (measured runs):"));
  for (const cond of ["baseline", "improved"] as const) {
    const f = fails.filter((r) => r.condition === cond);
    if (!f.length) {
      console.log(c.dim(`  ${cond}: none`));
      continue;
    }
    const counts: Record<string, number> = {};
    for (const r of f) counts[r.failureMode ?? "unknown"] = (counts[r.failureMode ?? "unknown"] ?? 0) + 1;
    const summary = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`  ${c.cyan(cond)}: ${summary}`);
    // Show one example per mode so the human reader sees the actual text.
    const seen = new Set<string>();
    for (const r of f) {
      const m = r.failureMode ?? "unknown";
      if (seen.has(m)) continue;
      seen.add(m);
      console.log(c.dim(`    e.g. [${m}] → ${JSON.stringify(r.finalText.slice(0, 120))}`));
    }
  }
}

await main();
