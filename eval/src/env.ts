import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PKG_ROOT } from "./paths";

/**
 * Load eval/.env into process.env, anchored to the package root so the keys
 * load whether the CLI runs from the repo root (`bun eval ...`) or eval/.
 *
 * Bun auto-loads a `.env` from process.cwd() only — from the repo root that's
 * the repo's .env (missing GEMINI_API_KEY / XAI_API_KEY), so the provider
 * adapters failed with "<KEY> not set". We explicitly read eval/.env here.
 *
 * Precedence: existing process.env wins (real shell env / Bun's cwd .env),
 * so we only fill in keys that aren't already set.
 */
export function loadEnv(): void {
  const file = resolve(PKG_ROOT, ".env");
  if (!existsSync(file)) return;

  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env && process.env[key] !== undefined && process.env[key] !== "") continue;
    let val = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
