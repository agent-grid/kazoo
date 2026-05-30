// Resolve the Anthropic credential the SDK child will authenticate with.
//
// The native `claude` binary reads exactly one of (in the SDK's own order):
//   CLAUDE_CODE_OAUTH_TOKEN  (Claude subscription — preferred here)
//   ANTHROPIC_API_KEY        (pay-as-you-go)
// `runner.ts` already builds the child env from an ALLOWLIST and forwards
// whichever of `oauthToken` / `apiKey` is set (never both). This module is the
// single place that decides WHICH to pass, and the place the composition root
// calls to fail fast — with an operator-readable message — when neither is
// present, instead of letting the SDK fail opaquely deep inside `query()`.
//
// Secrets never leave main. This returns the resolved value to hand straight
// into `createExecutor`; it is never logged (the logger redacts these paths)
// and never crosses an IPC channel.

import type { Config } from '../core/config.ts'
import { KazooError } from '../core/lib/errors.ts'

export type ExecutorAuth =
  | { kind: 'oauth'; oauthToken: string; apiKey: undefined }
  | { kind: 'api-key'; oauthToken: undefined; apiKey: string }

/** Pick the executor credential from config, preferring the OAuth token.
 *  Throws `config/missing-env` if neither is set. */
export function resolveExecutorAuth(config: Config): ExecutorAuth {
  const oauthToken = config.anthropic.oauthToken
  if (oauthToken) {
    return { kind: 'oauth', oauthToken, apiKey: undefined }
  }
  const apiKey = config.anthropic.apiKey
  if (apiKey) {
    return { kind: 'api-key', oauthToken: undefined, apiKey }
  }
  throw new KazooError(
    'config/missing-env',
    'set CLAUDE_CODE_OAUTH_TOKEN (preferred — Claude subscription) ' +
      'OR ANTHROPIC_API_KEY (API key) so the executor can authenticate. ' +
      'See .env.example.',
  )
}
