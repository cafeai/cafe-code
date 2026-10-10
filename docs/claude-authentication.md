# Claude authentication selection

On macOS, Claude Code can select different Keychain entries depending on whether `CLAUDE_CONFIG_DIR` is explicitly set, even when its value equals the default `~/.claude` directory. Cafe previously always set that variable, so an ordinary terminal login could work while Cafe reported "Not logged in". The discrepancy was reproduced locally with Claude Code 2.1.291 and is also reported in [upstream issue 92252](https://github.com/anthropics/claude-code/issues/92252). See [Claude's credential management](https://code.claude.com/docs/en/authentication#credential-management).

For an enabled default macOS Claude account with no explicit authentication overrides, Cafe uses the configured Claude executable's structured `auth status` command to select its environment:

1. Check Cafe's previous environment, with `CLAUDE_CONFIG_DIR` set to the default directory. A confirmed login keeps that environment, including when both stores have logins belonging to different accounts.
2. Only if Cafe's environment conclusively reports no login, check the ordinary terminal environment with `CLAUDE_CONFIG_DIR` unset. Use it when that check confirms a login.
3. If neither store has a login, or either required check is inconclusive, preserve Cafe's previous environment.

Each check has a four-second deadline and retains at most 16 KiB of stdout. Selection requires an exact `loggedIn` Boolean and the matching documented exit code: zero for logged in, one for logged out. Missing executables, unsupported commands, malformed or oversized output, mismatched exit codes and timeouts are inconclusive. Probe children are scoped and receive bounded termination cleanup. The check sends no model prompt, and Cafe never logs or persists raw status output, reads or copies Keychain credentials, or changes provider credential files.

Selection is shared by the account's health checks, newly created SDK queries and one-shot metadata helpers. The first confirmed login is pinned for the configured instance's lifetime so later refreshes cannot silently switch accounts. Unresolved results are coalesced and cached for five seconds; a later status refresh or new launch can observe a subsequent login without reloading the instance. Existing queries retain their captured environments. Reload the configured instance to choose a different store after a selection has been pinned.

Explicit account homes, `CLAUDE_CONFIG_DIR`, secure-storage overrides (including an explicit empty value), API keys, bearer/OAuth tokens, cloud-provider selectors and Anthropic profile/federation selectors bypass automatic selection. Non-macOS launches retain the existing environment policy. This resolver is instance-local and never mutates global environment variables.

Local `auth status` establishes that login material is available; it does not prove that a remote service will accept an expired or revoked credential. A real turn's authentication failure retains Cafe's existing error/session-retirement behavior. Cafe does not replay the prompt or automatically switch to another account after a model request fails.

The selected configuration scope also determines whether Claude reads `~/.claude/.claude.json` or `~/.claude.json`. Cafe's MCP installer retains both default targets. It does not merge unrelated user configuration between those files.

## Passive quota diagnostics

Claude quota presentation does not add an authentication probe or choose a new
credential store. It displays bounded structured reports received from an
existing query after a user-requested native `/usage`, when supported by that
runtime. Source-session/configuration binding is not a stable authenticated
principal: the UI explicitly calls this a session-reported observation and shows
receipt/freshness information. No independent Refresh, experimental usage getter,
inspection query, credential read or billing change is introduced. See the
[quota report decision](decisions/claude-account-quota-report.md) for privacy,
ownership, compatibility and integration-policy limits.

Default tests use synthetic status output and in-memory child handles. Focused qualification:

```sh
corepack yarn workspace @cafeai/cafe-code test src/provider/Drivers/ClaudeAuthenticationEnvironment.test.ts src/provider/Drivers/ClaudeHome.test.ts src/provider/Layers/ClaudeAdapter.test.ts src/textGeneration/ClaudeTextGeneration.test.ts src/provider/Layers/ProviderRegistry.test.ts
```

Actual installed-CLI checks are separate, read-only local diagnostics. They do not belong on the default test path and require no paid inference.
