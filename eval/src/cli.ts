/**
 * voice-eval CLI. See ../initial-spec.md for the full design.
 * Minimal surface: `run` (all scenarios × all agents by default) and `report`.
 */
import { runAll, listScenarios, listAgentIds } from "./run";
import { report } from "./report";

const USAGE = `voice-eval - headless evaluation harness for real-time voice agents

Usage:
  bun run eval run [scenarioDir] [--agent <id>]   # no args = all scenarios x all agents
  bun run eval report [runId]

Examples:
  bun run eval run                          # run everything
  bun run eval run scenarios/smoke          # one scenario, all agents
  bun run eval run --agent openai-realtime  # all scenarios, one agent
  bun run eval report

Env:
  OPENAI_API_KEY     required (loaded from .env)
  VOICE_EVAL_MODEL   override model (default: gpt-realtime)
`;

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

switch (command) {
  case "run": {
    const scenarioArg = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    const agentFlag = flag("agent");
    const agents = agentFlag ? [agentFlag] : listAgentIds();
    const scenarios = scenarioArg ? [scenarioArg] : listScenarios();
    if (!scenarios.length) {
      console.error("no scenarios found under scenarios/");
      process.exit(1);
    }
    await runAll(scenarios, agents);
    break;
  }
  case "report":
    report(rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exitCode = 1;
}
