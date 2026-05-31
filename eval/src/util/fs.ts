import { mkdirSync, cpSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

/**
 * Resolve a model-supplied path inside the workspace sandbox. Throws if it
 * escapes the workspace (constraint adherence — see initial-spec.md).
 */
export function safeResolve(workspaceDir: string, p: string): string {
  const root = resolve(workspaceDir);
  const full = resolve(root, p);
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return full;
}

export function seedWorkspace(workspaceDir: string, seedDir?: string) {
  ensureDir(workspaceDir);
  if (seedDir && existsSync(seedDir)) {
    cpSync(seedDir, workspaceDir, { recursive: true });
  }
}
