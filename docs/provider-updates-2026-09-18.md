# Provider compatibility and token preservation — September 18, 2026

This audit supersedes the current-version conclusions in the [Codex 0.154](codex-154-compatibility.md) and [Claude 0.3.266](claude-266-compatibility.md) audits. Historical test evidence in those documents remains historical. No live prompts, account credentials, global provider updates or production-session restarts were used for this audit.

## Qualified versions and provenance

- Codex: [0.155.0 release](https://github.com/openai/codex/releases/tag/rust-v0.155.0), published September 17 at 23:14:43 UTC. Protocol generation uses immutable source commit `f0a1b8f0849d90960bc406b848f32e5a129b0457`, not a moving branch or an installed executable. The generated inventory is 105 client RPCs, 10 server requests, 84 server notifications and one client notification. Existing typed-client extensions remain intact.
- Claude: all three exact Agent SDK pins move from `0.3.266` to `0.3.274`, whose packaged CLI is `2.1.274`. Cafe still launches the user's configured CLI, which is independent of the imported SDK version. See the [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [CLI changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), and [immutable version metadata](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.274).
- The Claude wrapper and eight platform siblings (Linux x64/arm64, both musl variants, Darwin x64/arm64, Windows x64/arm64) passed tarball SHA-512 verification and all 17 registry signatures at `2026-09-18T01:22:22.277Z`. The youngest artifact, Windows arm64, was published `2026-09-16T22:43:18.136Z`; the complete set therefore cleared the 24-hour quarantine at `2026-09-17T22:43:18.136Z`. Platform packages add no lifecycle scripts or dependencies; wrapper dependency/export changes are limited to matching platform versions and its CLI version metadata.
- Wrapper SRI: `sha512-kFmWMsh/BEd4jKkOxUeihr0xMkaMdOxONhNNkZ2pGmP0ElHkArvFvuZxqJTPvREnhCsPZByv5f0EzyAb/hkRZw==`. Yarn's lockfile records the installed resolution/checksums. SDK `0.3.275` (published September 17 at 20:23:02 UTC) was still inside quarantine and is deliberately not adopted here.

## Cafe changes

### Codex protocol and privacy boundary

Regeneration adds `thread/attachment/add`, `thread/attachment/list`, `thread/attachment/remove`, `thread/attachment/updated`, and optional feedback `promptHash`. The native attachment store holds arbitrary provider metadata; it is not automatic model-input delivery. Cafe's attachment storage, authenticated retrieval, file pills and on-demand file manifests stay unchanged. No files are automatically migrated or uploaded through these new APIs.

The attachment-update notification is discarded before native runtime observation/emission, with a second adapter guard for injected runtimes or replay. It cannot leak arbitrary identity keys into diagnostics, create phantom work, or keep a child session alive.

### Claude batching and approval contracts

Claude 2.1.274 coalesces internal background completions into one model call while still emitting an empty successful result for each held notification. Cafe previously could treat an uncorrelated result as the oldest pending human input. It now excludes only the proven shape: success, no error, zero model turns, empty result, `origin.kind: "task-notification"`, and no explicit user correlation. Explicit Cafe-owned UUIDs still take precedence, including zero-inference local commands. Older missing-origin fallback, errors and cumulative usage settlement remain unchanged. This retains upstream batching without losing a queued message or prompting again.

New permission hints are carried as typed booleans through the existing authenticated approval lifecycle. `defaultToNo` focuses Decline; `suppressAlwaysAllowRule` hides the reusable-grant affordance. The backend also rejects session-wide approval for these one-time-only asks while leaving the request available for a one-time decision. Sensitive callbacks are not silently approved by historical bypass mode. No arbitrary provider text becomes UI markup or a permission grant.

### Cost controls and metadata helpers

Explicit Fast off now survives into supported Claude model settings, helper settings and session diagnostics instead of inheriting an upstream `fastMode: true`. Absent options still delegate to native configuration; unsupported-model stale settings are still omitted. Codex helper service tiers now use the canonical `priority`/`default` values, including explicit normal mode, instead of the old `fast` alias and implicit inheritance on off.

Claude title/branch/commit/PR helpers receive their bounded source material in the prompt and do not need repository or network tools. They now use default permissions, an empty ordinary-tool allowlist and an MCP-tool deny rule, instead of bypass permissions. The verified 2.1.274 implementation adds its dedicated read-only structured-output tool separately, preserving `--json-schema` output. Ordinary OAuth/settings resolution is retained; `--bare` is intentionally not used because it changes authentication behavior. See the [official CLI flags](https://code.claude.com/docs/en/cli-reference).

Both providers' helper errors now preserve fixed failure classifications/exit codes rather than raw stdout, stderr or schema-error causes containing generated content. Usage is still recorded before validating output. No additional automatic generation retries were introduced.

## Token-preservation mechanisms deliberately retained

1. **Stable native prompts and caches.** Claude uses its bare `claude_code` preset without a dynamic Cafe suffix, native prompt snapshots, native resume and no prompt suggestions. Existing fresh-session title metadata avoids redundant native title generation. Recent provider snapshot/deferred-tool/thinking-resume improvements do not require Cafe to rewrite prompts, strip instructions, or force a cache TTL. Plugin reload is not currently called, so the new cache-impact hold option does not require an invented reload path.
2. **Provider-owned compaction.** Codex 0.155 removes the `remote_compaction_v2` switch and always streams remote compaction on supported providers. Its 64,000-token retained-message budget and default-enabled image budget remain provider-owned. The updated source preserves originating tool-output truncation budgets through resume/fork, intended reasoning effort through recovery, and accepted input after pre-turn compaction failure. Cafe preserves native cursors and omits default compaction overrides; it does not replay its own history or blindly resend the original prompt after an ambiguous acknowledgement. Claude's native compaction and batching likewise remain authoritative.
3. **Read-on-demand attachments.** Cafe sends stable bounded file manifests/pointers, not repeated document bodies. Private originals, bounded document extraction and authenticated retrieval retain their existing controls. New provider attachment metadata is not a reason to duplicate content in the prompt.
4. **Usage accounting.** Claude deduplicates primary message usage and settles monotonic cumulative `modelUsage` across intermediate results, including children and sidechains; reasoning is not charged a second time as output. Cache writes and reads remain distinct subsets of input. A zero/background result cannot erase a cumulative baseline. The [official cost-tracking contract](https://code.claude.com/docs/en/agent-sdk/cost-tracking) still matches these rules; no replacement accounting mechanism was needed.
5. **Durable recovery.** Quiet reasoning is not a failure signal. Ownership-verified recovery, explicit Stop barriers, exact input identities and ambiguous-ACK handling remain intact. No cheaper-looking retry that might duplicate paid work was added.

These are source-verified safeguards, not a claim of a measured account-specific cache-hit improvement or guaranteed dollar saving. Live cache rates and long-duration compaction behavior were not tested with user credentials.

## Concurrency and model re-audit

Codex source at the pinned commit retains `agents.max_concurrent_threads_per_session` (legacy alias `max_threads`), positive `usize`, spawned-child counting and no upstream numeric maximum. V1 defaults to six children; V2 defaults to four total/three children. Explicit V2 total configuration wins; Cafe's public `N` plus total `N+1` translation is still necessary. Astra/Sol/Terra normally use V2; Luna and Bedrock use V1. Cafe's optional 1–64 ceiling is its own safety policy. Omission remains upstream-controlled. See `codex-rs/config/src/config_toml.rs`, `core/src/config/mod.rs`, and model catalogs at the pinned commit.

The exact Claude 2.1.274 native artifact retains `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, positive integer parsing and default 20. Agent-tool admission, manual fork/resume differences and ultracode exemption remain unchanged. Cafe's optional override is still valid; no fabricated SDK concurrency property is added.

Astra's embedded context remains 272,000 normal / 872,000 maximum tokens; live metadata remains authoritative. This release provides no basis to increase Cafe's context limits.

## Verification and limits

Regression coverage includes generated protocol/schema/client contracts; native attachment-notification privacy and liveness; Claude task-notification correlation and explicit Fast off; approval-hint transport, server-side enforcement and browser focus/actions; helper argument construction, output validation and diagnostic sentinels. Tests use in-memory/synthetic providers, not paid inference.

Reproduce with Node 24.19.0 and repository Corepack Yarn 4.17.1: immutable install, `yarn fmt`, `yarn lint`, `yarn typecheck`, `yarn test`, the focused approval browser test, then `yarn build:desktop --force`. The required forced desktop build must follow the tests. A clean archived checkout with the updated three manifests and lockfile also verifies immutable dependency resolution without existing `node_modules`; native build scripts are skipped only for this isolated install replay, not for final desktop verification.

No user provider binary or global setting is changed by this compatibility patch. Native runtime improvements become available when the configured provider CLI is updated through its normal update mechanism. Running Cafe sessions are not restarted by the audit.
