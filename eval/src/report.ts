import { resolve } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { c } from "./util/colors";

/** Print a saved run report (latest if no runId given). */
export function report(runId?: string) {
  const dir = resolve("reports");
  if (!existsSync(dir)) {
    console.log("no reports yet — run a scenario first");
    return;
  }
  let file: string;
  if (runId) {
    file = resolve(dir, runId.endsWith(".json") ? runId : `${runId}.json`);
  } else {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    if (!files.length) {
      console.log("no reports yet — run a scenario first");
      return;
    }
    files.sort();
    file = resolve(dir, files[files.length - 1]);
  }
  if (!existsSync(file)) {
    console.error(`no report found: ${file}`);
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(file, "utf8"));
  console.log(`\n${c.boldCyan(r.scenario)} ${c.dim(`via ${r.agent} [${r.layer}] model=${r.model}`)}`);
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
