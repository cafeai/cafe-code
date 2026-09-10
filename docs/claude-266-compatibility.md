# Claude SDK 0.3.266 compatibility

Last updated: 2026-09-10 12:08:00 JST (UTC+0900)

## Release and package boundary

Cafe pins `@anthropic-ai/claude-agent-sdk` to **0.3.266** in the server, scripts and staged desktop runtime. The policy test requires all three to use one exact version. The audited SDK release is [commit 246f936602d5344f7efe560d9563acebab00a358](https://github.com/anthropics/claude-agent-sdk-typescript/tree/246f936602d5344f7efe560d9563acebab00a358), with bundled Claude Code 2.1.266. An explicitly configured system CLI remains authoritative; installing this wrapper does not upgrade or downgrade that executable.

The latest publication among the wrapper and eight platform packages was `2026-09-08T23:40:55.523Z`; all cleared the repository's 24-hour quarantine at `2026-09-09T23:40:55.523Z`. All nine tarballs matched npm SHA-512 integrity, and all 16 registry signatures verified against npm's public keys. These checks establish consistency with signed registry metadata, not proof of arbitrary code safety. The wrapper's platform/dependency/export and lifecycle-script shapes did not change from 0.3.260. The lockfile retains exact package resolutions and Yarn checksums.

0.3.267 is not included. The registry had no published 0.3.262 or 0.3.264 packages at audit time despite changelog headings for them.

## Relevant behavior

The [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/246f936602d5344f7efe560d9563acebab00a358/CHANGELOG.md) changes response correlation for synthetic and automatically started turns, including messages consumed midway through a response. Local commands can return a correlated success without inference. Cafe already consumes these edges through its exact owned-UUID state machine. New regressions exercise repeated assistant/stream correlation, foreign IDs, stale deferred results, duplicate results and zero-inference completion. No new retry loop or private control message is necessary.

The SDK/CLI update also preserves an agent's changed shell working directory between streamed user messages. Cafe keeps its own project/session identity stable rather than pretending that every native shell `cd` changed the Cafe project.

The [Claude Code release notes](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) describe provider-owned resume, subagent cache-prefix, token-refresh and forked-skill streaming fixes in 2.1.265, followed by a gateway-auth regression fix in 2.1.266. These ship through the corresponding provider binary; Cafe does not emulate them by rewriting prompts, changing credentials or adding another retry scheduler.

## Concurrent subagent setting

Settings → Providers → Claude now exposes **Agent-tool concurrency limit**. Enter 1–64, or clear it to retain inherited configuration and otherwise use Claude's current default of 20. This supported control predates this release but was missed in Cafe's earlier audit. It requires Claude Code 2.1.217+ and is not a hard limit on all work: resumes/manual forks may exceed it, ultracode is exempt, and workflows/teams have separate rules. See the [official concurrency contract](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit).

Cafe validates the optional integer in settings and again when constructing a new provider environment, then writes only `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` on that copied environment. It does not mutate existing process environments, write provider configuration files, or add inference. Saving provider settings still uses Cafe's existing instance-reconciliation lifecycle, which reloads the changed instance and can end its current sessions; change this setting between sessions. The form includes that warning. The 64 ceiling is Cafe's resource-safety policy. Clearing the control removes Cafe's override, not a user-owned inherited environment variable.

## Kept unchanged

- Existing live model metadata, effort/context reporting, cumulative billed usage and separate subagent usage remain authoritative; the audited public account/model/retry shapes require no replacement.
- Preserve the bare `claude_code` system-prompt preset, host approval callbacks and managed/user/project settings. No new per-turn prompt text, quota probes, credential handling or permission bypass is added.
- Cafe does not provide SDK `plugins`, so the optional `pluginDelivery: "initialize"` brings no current benefit. Do not send its newer CLI flag unconditionally to older configured executables. Any future SDK plugin delivery must version-check the actual CLI.
- Output-style reload without an editor, experimental quota controls, private MCP handshake cache plumbing and quarantined browser transport changes are not exposed. The SDK owns its handshake. Any future context inspector should request `detail: "summary"` rather than introduce token-count API calls into the hot path.

The [stream integrity corrections](provider-stream-reconciliation.md) and [Codex capability update](codex-154-compatibility.md) are included in the same delivery. No additional architecture boundary is introduced by this patch-level SDK update.

## Verification and applying the build

Use the pinned Node runtime and Corepack-managed Yarn 4.17.1. A fresh checkout uses `yarn install --immutable`; isolated dependency replay may use `--mode=skip-build` to avoid executing native install hooks, but that is not a substitute for native desktop verification.

Focused coverage lives in Claude adapter/environment tests, contracts settings tests, the schema-driven provider form tests and `scripts/toolchain-policy.test.ts`. Run root `yarn fmt`, `yarn lint`, `yarn typecheck` and `yarn test`, plus the inline-question browser suite; run `yarn build:desktop --force` last. These offline regressions do not prove account-specific live inference. The build does not replace running desktop/daemon processes; apply it through Cafe's normal restart lifecycle when ready.
