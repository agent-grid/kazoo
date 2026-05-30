// Executor permission policy. We run with `permissionMode: 'acceptEdits'`
// (decision §5 of the scaffold review) inside a scoped workspace, plus a
// conservative bash allowlist. Security-review will harden this later.

/** Bash command prefixes that auto-approve in `acceptEdits` mode. Anything
 *  not on this list falls through to the SDK's prompt machinery (and in a
 *  voice TUI, that means we deny — there's no good UX for mid-call prompts).
 *
 *  TODO(security-review): broaden carefully. Each entry is a literal prefix
 *  match against the full command string. */
export const BASH_ALLOWLIST: readonly string[] = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'grep',
  'rg',
  'find',
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'bun run',
  'bun test',
  'bun install',
  'npm test',
  'pnpm test',
]

export type ExecutorPermissionPolicy = {
  /** Allow file edits without prompting. */
  permissionMode: 'acceptEdits'
  /** Working directory the executor is scoped to. */
  cwd: string
  /** Bash command allowlist (see above). */
  bashAllowlist: readonly string[]
}

export function defaultPermissionPolicy(cwd: string): ExecutorPermissionPolicy {
  return {
    permissionMode: 'acceptEdits',
    cwd,
    bashAllowlist: BASH_ALLOWLIST,
  }
}
