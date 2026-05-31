import { resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { loadScenario } from "./scenario";
import { seedWorkspace } from "./util/fs";
import { scoreRun } from "./scoring";
import { computeCost, estimateCost, recordCost } from "./cost";
import type { AgentAdapter, CanonicalEvent, TurnTrace } from "../agents/base";
import type { Scenario, VerifierResult } from "./scenario";
import { judge } from "./judge";
import { c } from "./util/colors";
import { pcm16ToWav, wavToPcm16 } from "./util/wav";
import { synthesizePcm16 } from "./tts";
import { transcribe } from "./asr";

const MODEL = process.env.VOICE_EVAL_MODEL || "gpt-realtime";

export async function runScenario(scenarioDir: string, agentId: string) {
  const scenario = loadScenario(scenarioDir);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set (copy .env.example to .env)");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${stamp}_${scenario.id}_${agentId}`;
  const runDir = resolve("artifacts", runId);
  const workspaceDir = resolve(runDir, "workspace");
  mkdirSync(runDir, { recursive: true });
  seedWorkspace(workspaceDir, scenario.workspace_seed ? resolve(scenario.dir, scenario.workspace_seed) : undefined);

  const est = estimateCost(scenario.id, agentId);
  console.log(`\n${c.boldCyan("▶ " + scenario.id)} ${c.dim(`via ${agentId} [${scenario.layer}] model=${MODEL}`)}`);
  console.log(c.dim(`  est. cost: ${est == null ? "n/a (no history yet)" : "$" + est.toFixed(4)}`));

  const adapter = await loadAgent(agentId);
  await adapter.connect({
    apiKey,
    model: MODEL,
    layer: scenario.layer,
    instructions: scenario.system_prompt,
    workspaceDir,
  });

  const live = (e: CanonicalEvent) => {
    if (e.type === "tool.call") console.log(`  ${c.cyan("⚙")} ${c.cyan(e.name)}${c.dim(`(${JSON.stringify(e.args)})`)}`);
    else if (e.type === "tool.result") console.log(c.dim(`  ↳ ${JSON.stringify(e.result).slice(0, 140)}`));
    else if (e.type === "error") console.log(c.red(`  ✖ error: ${e.message}`));
  };

  let trace: TurnTrace;
  let speechArtifacts: SpeechArtifacts | undefined;
  if (scenario.layer === "speech") {
    speechArtifacts = await runSpeechTurn(adapter, scenario, runDir, live);
    trace = speechArtifacts.trace;
  } else {
    trace = await adapter.runText(scenario.user_prompt, live);
  }
  await adapter.close();
  console.log(`  ${c.dim("⤷ final:")} ${trace.finalText.slice(0, 200) || c.dim("(empty)")}`);

  const verifierResults: VerifierResult[] = [];
  for (const v of scenario.verification) {
    if (v.type === "script" && v.path) {
      const mod = await import(resolve(scenario.dir, v.path));
      verifierResults.push(await mod.verify({ scenarioDir: scenario.dir, workspaceDir, trace, expected: scenario.expected_outcome }));
    } else if (v.type === "script") {
      verifierResults.push(builtinContains(trace.finalText, (scenario.expected_outcome as any)?.contains));
    } else if (v.type === "llm_judge") {
      verifierResults.push(
        await judge(
          { scenarioDir: scenario.dir, workspaceDir, trace, expected: scenario.expected_outcome },
          { threshold: v.threshold, samples: v.samples },
        ),
      );
    } else {
      verifierResults.push({ pass: false, score: 0, details: `unknown verifier type: ${(v as any).type}` });
    }
  }

  const score = scoreRun(scenario, trace, verifierResults);
  const cost = computeCost(MODEL, trace.usage);
  recordCost(scenario.id, agentId, cost);

  const report = {
    runId, scenario: scenario.id, agent: agentId, layer: scenario.layer, model: MODEL,
    score: score.total, pass: score.pass, components: score.components, metrics: score.metrics,
    verifiers: verifierResults, usage: trace.usage, cost_usd: cost, finalText: trace.finalText,
    ...(speechArtifacts ? { speech: speechArtifacts.report } : {}),
  };
  writeFileSync(resolve(runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(runDir, "trace.json"), JSON.stringify(trace.events, null, 2));
  mkdirSync(resolve("reports"), { recursive: true });
  writeFileSync(resolve("reports", `${runId}.json`), JSON.stringify(report, null, 2));

  const scoreColor = score.pass ? c.green : c.red;
  console.log(`\n  ${c.bold("SCORE:")} ${scoreColor(`${score.total}/100`)}  ${score.pass ? c.green("✓ PASS") : c.red("✗ FAIL")}`);
  for (const [k, val] of Object.entries(score.components)) {
    const v = Math.round(val * 100);
    const vc = v >= 100 ? c.green : v > 0 ? c.yellow : c.red;
    console.log(`    ${c.dim(`${k}:`)} ${vc(String(v))}`);
  }
  for (const r of verifierResults) {
    console.log(`    ${c.dim("verify:")} ${r.pass ? c.green("pass") : c.red("fail")} ${c.dim(`— ${r.details}`)}`);
  }
  const m = score.metrics;
  console.log(
    c.dim(
      `    latency: ttft=${m.ttft_ms ?? "-"}ms first_audio=${m.time_to_first_audio_ms ?? "-"}ms first_tool=${m.first_tool_ms ?? "-"}ms total=${m.total_ms ?? "-"}ms`,
    ),
  );
  if (speechArtifacts) {
    console.log(
      c.dim(
        `    speech: input=${relativeToCwd(speechArtifacts.report.inputWav)} output=${relativeToCwd(speechArtifacts.report.outputWav ?? "—")} asr=${speechArtifacts.report.asrModel}`,
      ),
    );
  }
  console.log(`  ${c.yellow(`cost: $${cost.toFixed(4)}`)}   ${c.dim(`report: artifacts/${runId}/report.json`)}\n`);
  return report;
}

interface SpeechReport {
  inputWav: string;
  inputSource: "fixture" | "tts";
  outputWav?: string;
  asrModel: string;
  asrTranscript: string;
}
interface SpeechArtifacts {
  trace: TurnTrace;
  report: SpeechReport;
}

/**
 * Speech-layer turn. Resolve the input fixture (PREFER an existing input.wav,
 * else TTS), call adapter.runAudio, write the agent's output.wav into the
 * run's artifacts dir, and transcribe it with the reference ASR. The ASR
 * transcript replaces `finalText` so verifiers + scoring see what the user
 * would actually hear-as-text.
 */
async function runSpeechTurn(
  adapter: AgentAdapter,
  scenario: Scenario,
  runDir: string,
  live: (e: CanonicalEvent) => void,
): Promise<SpeechArtifacts> {
  if (typeof adapter.runAudio !== "function") {
    throw new Error(`agent '${adapter.id}' does not implement runAudio()`);
  }
  const { inputWav, source } = await resolveInputWav(scenario);
  const { pcm } = wavToPcm16(readFileSync(inputWav));
  console.log(
    c.dim(
      `  ◌ speech input: ${source} (${(pcm.length / (24000 * 2)).toFixed(2)}s) — ${relativeToCwd(inputWav)}`,
    ),
  );

  const trace = await adapter.runAudio(pcm, live);

  let outputWavPath: string | undefined;
  if (trace.outputAudio?.length) {
    outputWavPath = resolve(runDir, "output.wav");
    writeFileSync(outputWavPath, pcm16ToWav(trace.outputAudio));
  }

  // Reference ASR: transcribe the agent's output and use THAT as finalText for
  // verifiers/scoring. If no output audio came back, leave trace.finalText
  // alone (the model transcript may still be present).
  let asrText = "";
  let asrModel = process.env.VOICE_EVAL_ASR_MODEL || "whisper-1";
  if (outputWavPath) {
    const wav = readFileSync(outputWavPath);
    const r = await transcribe(wav);
    asrText = r.text;
    asrModel = r.model;
    trace.finalText = asrText;
    console.log(c.dim(`  ◌ asr (${asrModel}): ${asrText}`));
  }

  return {
    trace,
    report: {
      inputWav,
      inputSource: source,
      outputWav: outputWavPath,
      asrModel,
      asrTranscript: asrText,
    },
  };
}

/** Find or synthesize the user's input audio for a speech scenario. */
async function resolveInputWav(
  scenario: Scenario,
): Promise<{ inputWav: string; source: "fixture" | "tts" }> {
  const explicit = scenario.input_audio
    ? resolve(scenario.dir, scenario.input_audio)
    : undefined;
  const fallback = resolve(scenario.dir, "input.wav");
  for (const p of [explicit, fallback]) {
    if (p && existsSync(p)) return { inputWav: p, source: "fixture" };
  }
  // No fixture: synthesize via TTS so the harness still runs end-to-end.
  const text = scenario.input_text ?? scenario.user_prompt;
  console.log(c.dim(`  ◌ no input.wav found — TTS-synthesizing from scenario text`));
  const pcm = await synthesizePcm16(text);
  writeFileSync(fallback, pcm16ToWav(pcm));
  return { inputWav: fallback, source: "tts" };
}

function relativeToCwd(p: string): string {
  const cwd = process.cwd();
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

function builtinContains(text: string, needle?: string): VerifierResult {
  if (!needle) return { pass: false, score: 0, details: "no expected_outcome.contains specified" };
  const pass = text.toLowerCase().includes(String(needle).toLowerCase());
  return { pass, score: pass ? 1 : 0, details: pass ? `output contains "${needle}"` : `output missing "${needle}"`, evidence: { needle } };
}

/** Discover scenario directories (subdirs of scenarios/ that contain scenario.json). */
export function listScenarios(): string[] {
  const root = resolve("scenarios");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => resolve(root, d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory() && existsSync(resolve(d, "scenario.json"));
      } catch {
        return false;
      }
    })
    .sort();
}

const AGENTS_DIR = resolve("agents");

/** Discover agent ids from agents/*.ts (base.ts is shared, not an agent). */
export function listAgentIds(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "base.ts")
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
}

/** Load an agent by id from agents/<id>.ts (default export = AgentAdapter class). */
async function loadAgent(id: string): Promise<AgentAdapter> {
  const file = resolve(AGENTS_DIR, `${id}.ts`);
  if (!existsSync(file)) throw new Error(`unknown agent '${id}' (no agents/${id}.ts)`);
  const mod = await import(file);
  const Adapter = mod.default;
  if (typeof Adapter !== "function") {
    throw new Error(`agents/${id}.ts must default-export an AgentAdapter class`);
  }
  return new Adapter();
}

/** Run every (scenario × agent) combination, then print a summary. */
export async function runAll(scenarioDirs: string[], agentIds: string[]) {
  const results: { scenario: string; agent: string; score: number; pass: boolean; error?: string }[] = [];
  for (const dir of scenarioDirs) {
    for (const agent of agentIds) {
      try {
        const r = await runScenario(dir, agent);
        results.push({ scenario: r.scenario, agent, score: r.score, pass: r.pass });
      } catch (e: any) {
        const error = String(e?.message ?? e);
        console.log(c.red(`  ✖ ${dir} × ${agent}: ${error}`));
        results.push({ scenario: dir, agent, score: 0, pass: false, error });
      }
    }
  }
  console.log(c.bold("===== SUMMARY ====="));
  for (const r of results) {
    const mark = r.pass ? c.green("✓") : c.red("✗");
    const sc = (r.pass ? c.green : c.red)(`${r.score}/100`);
    console.log(`  ${mark} ${r.scenario} ${c.dim("×")} ${r.agent}: ${sc}${r.error ? c.red(` (${r.error})`) : ""}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const allPass = passed === results.length;
  console.log(`  ${(allPass ? c.green : c.yellow)(`${passed}/${results.length} passed`)}\n`);
  return results;
}
