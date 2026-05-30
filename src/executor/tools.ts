// Executor permission policy. We run with `permissionMode: 'acceptEdits'`
// (decision §5 of the scaffold review) inside a scoped workspace, plus a
// conservative bash allowlist enforced by a real shell parser.

import { type ParseEntry, parse as shellParse } from 'shell-quote'

/** Bash commands that auto-approve. The matcher (`isBashCommandAllowed`)
 *  uses `shell-quote`'s real parser and rejects any candidate that yields
 *  a non-string parse entry (operators, redirects, command substitutions,
 *  shell globs, comments). Whatever survives gets argv-prefix matched
 *  against the entries below.
 *
 *  Entries are argv-prefix strings: a bare entry like `ls` matches any
 *  candidate whose argv[0] is `ls`; a two-token entry like `git diff`
 *  requires argv[0]+argv[1] to match exactly. Beyond the prefix, the
 *  candidate's remaining tokens are filtered by `forbiddenFlags`.
 *
 *  Anything not on this list falls through to deny — there's no good
 *  voice-UX for mid-call permission prompts.
 *
 *  Stripped (security-review): `bun run` / `bun install` / `bun test` /
 *  `npm test` / `pnpm test` (all arbitrary-code-exec via package scripts).
 *  The executor can still report it'd LIKE to run tests; a future "run
 *  tests" UX needs a real confirmation surface, not a voice-blind grant.
 *
 *  TODO(security-review): broaden carefully; each addition is a new way
 *  for a hallucinated tool call to run code. */
export const BASH_ALLOWLIST: readonly string[] = [
  // Read-only inspection.
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
  // Git — strictly read-only subcommands.
  'git status',
  'git diff',
  'git log',
  'git show',
  // git-branch is read-only only when invoked with `--list`; the matcher
  // requires the third token to be `--list`.
  'git branch --list',
]

/** Per-allowlist-entry flag/arg filters. Applied AFTER the argv-prefix
 *  match succeeds. The filter receives the candidate's TAIL tokens (those
 *  past the entry's prefix); if any tail token starts with one of the
 *  forbidden prefixes, the whole command is denied.
 *
 *  Why prefix-based and not exact-match: GNU CLI flags accept both `-x val`
 *  and `-x=val`, so we block both forms by matching the leading bytes. */
const FORBIDDEN_TAIL_FLAGS: Record<string, readonly string[]> = {
  // -exec /-execdir / -ok / -okdir let `find` run arbitrary subprocesses;
  // -delete writes; -fprint*/-fls write to attacker-chosen paths.
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls'],
  // `--output` / `-o` write to disk; `--ext-diff` shells out to an external
  // diff program of the model's choice.
  'git log': ['--output', '-o', '--ext-diff'],
  'git diff': ['--output', '-o', '--ext-diff'],
  'git show': ['--output', '-o', '--ext-diff'],
}

export type ExecutorPermissionPolicy = {
  /** Allow file edits without prompting. */
  permissionMode: 'acceptEdits'
  /** Working directory the executor is scoped to. Treated as the path-sandbox
   *  root by the file-tool path-scope check in `canUseTool`. */
  cwd: string
  /** Argv-prefix allowlist for bash. */
  bashAllowlist: readonly string[]
  /** Per-entry forbidden tail flags. */
  forbiddenTailFlags: Readonly<Record<string, readonly string[]>>
}

export function defaultPermissionPolicy(cwd: string): ExecutorPermissionPolicy {
  return {
    permissionMode: 'acceptEdits',
    cwd,
    bashAllowlist: BASH_ALLOWLIST,
    forbiddenTailFlags: FORBIDDEN_TAIL_FLAGS,
  }
}

/** Match a candidate bash command against the policy.
 *
 *  CONTRACT:
 *   1. Parse with `shell-quote`. REJECT if the result contains ANY non-string
 *      entry — operators (`;`, `&&`, `||`, `|`, `<`, `>`, `>>`, …),
 *      command substitutions (`$(…)`, backticks → shell-quote represents
 *      them as ops), variable expansions, redirects, globs that didn't
 *      match (returned as `{op:'glob', pattern}`), or comments.
 *      Anything that isn't a literal argv token disqualifies the command.
 *   2. Argv-prefix match the resulting tokens against each entry in
 *      `bashAllowlist`. A 2-token entry needs both tokens to match.
 *   3. For matched entries with a `forbiddenTailFlags` rule, scan the
 *      tail tokens (those past the entry's prefix length): if any starts
 *      with a forbidden prefix (e.g. `-exec`, `-exec=...`), DENY.
 *
 *  Out-of-scope-by-design: arg-content checks (e.g. `cat /etc/passwd`).
 *  That's handled by the executor's path-scope rule in `canUseTool` for
 *  file tools, and by the prompt-side "no reading secrets" rule for bash.
 *  The bash allowlist is the SHAPE filter; content is checked elsewhere. */
export function isBashCommandAllowed(command: string, policy: ExecutorPermissionPolicy): boolean {
  if (!command) return false

  let parsed: ParseEntry[]
  try {
    parsed = shellParse(command)
  } catch {
    return false
  }
  if (parsed.length === 0) return false

  // Step 1: REJECT any non-string token. Any operator, glob, comment, or
  // substitution disqualifies the command entirely.
  const tokens: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') return false
    tokens.push(entry)
  }

  // Step 2 + 3: argv-prefix match, with tail-flag filter for matched entries.
  for (const entry of policy.bashAllowlist) {
    const entryTokens = entry
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0)
    if (entryTokens.length === 0) continue
    if (entryTokens.length > tokens.length) continue
    let matches = true
    for (let i = 0; i < entryTokens.length; i++) {
      if (entryTokens[i] !== tokens[i]) {
        matches = false
        break
      }
    }
    if (!matches) continue

    const forbidden = policy.forbiddenTailFlags[entry]
    if (forbidden && forbidden.length > 0) {
      const tail = tokens.slice(entryTokens.length)
      for (const arg of tail) {
        for (const bad of forbidden) {
          // `bad` is a literal forbidden prefix. `arg.startsWith(bad)`
          // catches the exact form (`--output`), the `=value` form
          // (`--output=foo`), and the bunched-short-flag form (`-ofoo`).
          // Over-broad in principle (`--outputs` would also match) but for
          // these specific flags there's no benign collision.
          if (arg.startsWith(bad)) return false
        }
      }
    }

    return true
  }

  return false
}
