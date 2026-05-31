import { resolve } from "node:path";

/**
 * All harness paths anchor to the eval package root (this file lives in
 * eval/src/), NOT process.cwd() — so the CLI works identically whether it's
 * invoked from the repo root (`bun eval ...`) or from inside eval/.
 */
export const PKG_ROOT = resolve(import.meta.dir, "..");

export const SCENARIOS_DIR = resolve(PKG_ROOT, "scenarios");
export const AGENTS_DIR = resolve(PKG_ROOT, "agents");
export const ARTIFACTS_DIR = resolve(PKG_ROOT, "artifacts");
export const REPORTS_DIR = resolve(PKG_ROOT, "reports");

/**
 * Resolve a user-supplied scenario dir. Absolute paths pass through;
 * relative ones (e.g. `scenarios/smoke`) resolve against the package root
 * so they work from any cwd.
 */
export function resolveScenarioDir(dir: string): string {
  return resolve(PKG_ROOT, dir);
}
