import type { VerifierContext, VerifierResult } from "../../src/scenario";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

/**
 * Terminal-Bench verifier (binary, no LLM). Runs the task's OWN pytest suite
 * (vendored under tests/) against the agent's workspace, exactly as the real
 * benchmark does, and maps the result to a {0,1} score: all tests pass -> 1.
 *
 * Faithfulness notes:
 * - The agent is a black box: it used its own tools to do the work. We only
 *   inspect the resulting workspace state, never the agent internals.
 * - Terminal-Bench builds a Docker image and runs the tests inside it. This is
 *   a host-only port: the test reads its target dir from TBENCH_WORKDIR (set to
 *   the run workspace here) instead of the container's hard-coded /app.
 * - Test deps mirror TB's run-tests.sh (uv + pytest). We prefer a system pytest
 *   and fall back to `uv run --with pytest` so nothing is installed globally.
 */
export async function verify(ctx: VerifierContext): Promise<VerifierResult> {
  const testFile = resolve(ctx.scenarioDir, "tests/test_outputs.py");
  if (!existsSync(testFile)) {
    return { pass: false, score: 0, details: `vendored test missing: ${testFile}` };
  }

  const runner = pickRunner();
  if (!runner) {
    return {
      pass: false,
      score: 0,
      details: "no pytest runner found: install pytest (`pip install pytest`) or `uv`",
    };
  }

  const proc = Bun.spawnSync([...runner, testFile, "-rA", "-q"], {
    cwd: ctx.workspaceDir,
    env: { ...process.env, TBENCH_WORKDIR: ctx.workspaceDir },
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const pass = proc.exitCode === 0;

  // Grab pytest's summary line (e.g. "2 passed in 0.01s") for readable details.
  const summary =
    stdout
      .split("\n")
      .reverse()
      .map((l) => l.trim())
      .find((l) => /\b(passed|failed|error|no tests ran)\b/.test(l)) ?? `exit ${proc.exitCode}`;

  return {
    pass,
    score: pass ? 1 : 0,
    details: pass ? `pytest: ${summary}` : `pytest failed: ${summary}`,
    evidence: {
      runner: runner.join(" "),
      exitCode: proc.exitCode,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-1000),
    },
  };
}

/** Prefer a system pytest; else use uv's ephemeral pytest (matches TB run-tests.sh). */
function pickRunner(): string[] | null {
  if (Bun.spawnSync(["python3", "-c", "import pytest"]).exitCode === 0) {
    return ["python3", "-m", "pytest"];
  }
  if (Bun.spawnSync(["bash", "-lc", "command -v uv"]).exitCode === 0) {
    return ["uv", "run", "--no-project", "--with", "pytest", "pytest"];
  }
  return null;
}
