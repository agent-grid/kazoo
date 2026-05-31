import type { VerifierContext, VerifierResult } from "../../src/scenario";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { sha256 } from "../../src/util/zip";

/**
 * Script verifier (binary, no LLM). The agent is a black box and may use any
 * toolchain, so we do NOT assert an exact hash. Instead we check the real
 * artifacts: dist/index.js exists, dist/build.zip exists and unzips to a .js
 * file containing the compiled program ("Hello," from the seed's greet()).
 */
export async function verify(ctx: VerifierContext): Promise<VerifierResult> {
  const ws = ctx.workspaceDir;
  const compiled = resolve(ws, "dist/index.js");
  const zipPath = resolve(ws, "dist/build.zip");

  const checks: Record<string, boolean> = {
    compiledExists: existsSync(compiled),
    zipExists: existsSync(zipPath),
    zipHasCompiledJs: false,
  };

  let zipSha = "";
  if (checks.zipExists) {
    const zipBytes = readFileSync(zipPath);
    zipSha = sha256(zipBytes);
    try {
      const entries = unzipSync(new Uint8Array(zipBytes));
      const jsEntry = Object.entries(entries).find(([name]) => name.endsWith(".js"));
      const text = jsEntry ? new TextDecoder().decode(jsEntry[1]) : "";
      checks.zipHasCompiledJs = !!jsEntry && text.length > 0 && text.includes("Hello");
    } catch {
      checks.zipHasCompiledJs = false;
    }
  }

  const pass = checks.compiledExists && checks.zipExists && checks.zipHasCompiledJs;
  return {
    pass,
    score: pass ? 1 : 0,
    details: pass
      ? "dist/index.js present; build.zip contains the compiled program"
      : `failed: ${JSON.stringify(checks)}`,
    evidence: { zipSha, ...checks },
  };
}
