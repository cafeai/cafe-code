# Codex 0.166 and coordinated Claude 314 update

Last updated: 2026-10-30 15:07:14 JST (UTC+0900)

This audit compares Cafe's Codex 0.164 protocol and managed runtime with
**0.166.0**, and Claude Agent SDK **0.3.311** / managed Code **2.1.311** with
the coordinated **0.3.314 / 2.1.314** target. Source integration, package
admission, synthetic compatibility checks and live provider adoption are separate
observations. A configured external executable can remain on another version;
changing Cafe's SDK or fresh-install Windows bundle never updates that executable.

## Codex compatibility and security

The protocol generator now targets immutable release commit
`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. The stable request/notification
method sets remain unchanged; additive fields do not enable experimental
attached forks, workspace switching, memory controls, MCP sharing or GCP setup.
The native `gcp` account variant receives an inert “Google Cloud” label without
borrowing ChatGPT email, entitlement or quota identity.

The wrapper and all six platform archives passed bounded serial SHA-512/SHA-1
and embedded-manifest/platform checks, with 14 npm metadata signatures verified.
The managed Windows manifest selects the exact wrapper/x64/arm64 bytes.
This manual Codex stable-artifact review does not assert 24 hours have elapsed,
prove source-to-native reproducibility or install/launch a provider. It is
separate from Yarn dependency admission. It does not itself authorize a Claude
package-age exception; the separate user-approved exception for this exact update
is recorded below.

Codex 0.166 adds structured `ModelProviderError` variants for saved/current
provider mismatch, an unavailable configured provider and managed-policy
conflicts. Cafe treats those tags as a refusal to create a different conversation,
even when an interpolated provider name resembles a missing-thread error.
Malformed known variants remain refusals. Ordinary genuine legacy missing-thread
recovery retains its existing behavior; automatic failed-root recovery still
requires exact history and never creates a blank replacement. This does not
authorize switching accounts, providers or policies.

New `imageGeneration.generationId` metadata is an opaque native correlation
identifier. Cafe does not use it, and removes it alongside `fileId` and
`inputImages` from raw observations, activity, retained history and diagnostics.
The bounded own-data projection does not invoke accessors or mutate native
decoding/control. Existing saved-image delivery remains the authenticated Cafe
transport; none of these identifiers becomes a URL, file lookup or download grant.

Native 0.165/0.166 changes also address plugin marketplace URL parsing,
app-server listener lifecycle, completed-runtime cleanup and preservation of
acknowledged permissions across resume/fork. These fixes belong to the selected
native runtime, rather than a second Cafe permission or process-control policy.

An upstream reasoning-accounting fix records whether reported usage already
includes retained reasoning, and restores that fact on resume/fork. Counting the
same reasoning again could previously cause early compaction. Older records
without that field retain the native legacy accounting behavior. This is a
specific upstream explanation, not proof of the cause of an older Cafe screenshot.
Cafe preserves native usage and compaction authority; it does not subtract guessed
thinking overhead, reconstruct historical counts or change context limits.

The 164-to-166 source comparison retains the public spawned-child key
`agents.max_concurrent_threads_per_session`, legacy `max_threads` alias,
positive-`usize` admission and Cafe's separate 1–64 safety bound. V1 defaults
to six children; V2 defaults to four resident threads including root. Explicit
V2 feature configuration takes precedence, then the public child limit is
translated to a root-inclusive total, then native defaults apply. Cafe's explicit
child limit still supplies both public `N` and V2 total `N + 1`; omission
delegates to the native model/backend and user configuration.

The current Bedrock catalog preserves the bundled model's backend, including V2
for Astra/Sol/Terra, and custom catalogs retain their chosen backend. Earlier
Cafe guidance that Bedrock always selected V1 was stale, including for the
previous 164 target. Correcting that documentation does not change native
defaults or Cafe's translation. V2 may unload idle residents; historical child
count is not simultaneous resident count or permission to cancel active work.

Sources: [0.166 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0),
[0.165 release](https://github.com/openai/codex/releases/tag/rust-v0.165.0),
[frozen provider-error contract](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/src/protocol/v2/model_provider_error.rs),
[frozen image contract](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/ext/items/src/image_generation.rs),
[marketplace URL fix](https://github.com/openai/codex/commit/61a991990fa4fd0c511ccaaab3875371796be956),
[reasoning-accounting fix](https://github.com/openai/codex/commit/c62e9df39f3bc2e1eae124a79075e9bc5555fe1a),
[frozen configuration](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/config/mod.rs),
[frozen Bedrock catalog](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/model-provider/src/amazon_bedrock/catalog.rs).

## Claude question interactions

Native 2.1.312 adds optional unanswered-question annotations. Cafe's explicit
Skip and Dismiss controls require `ask_user_question_unanswered_v1` from the
actual current query's initialization response. A saved setting, SDK version or
renderer capability flag cannot establish native support. Older strict hosts
must continue receiving the exact answers-only shape.

Skip replaces only the selected question's local answer with an explicit skipped
disposition. Dismiss retains valid answers and prior skips, marking only the
remaining questions dismissed. Neither action stops the query, invents answer
text, submits a follow-up message or clears the main composer draft. Native
`replied_in_chat` annotations are not inferred from unrelated chat messages.
Explanations intended for the model belong in ordinary answers; native unanswered
metadata is not model-visible. See [the interaction decision](decisions/claude-unanswered-questions.md)
for validation, ownership and compatibility boundaries.

Canonical operational logging for these exact input-request/resolution events
retains bounded routing metadata, counts and Boolean facts instead of question
text, answers, full-text disposition keys or raw copies. This log-only projection
preserves authenticated events/activities and native callbacks. The separate
optional protected native protocol transcript log retains its existing behavior;
this change does not scrub historical logs or every content-bearing event type.

## Coordinated Claude package admission

At the October 30 audit, SDK `latest`/`next` were 0.3.314 and Code
`latest`/`next` were 2.1.314, while Code's separate `stable` tag remained
2.1.308. A non-prerelease on `latest` is not proof of a `stable` channel change.
The 314 target remains frozen even if mutable tags later advance.

The complete SDK wrapper/eight-platform family reaches 24 hours at
2026-10-31 00:17:55.347 UTC; the complete CLI family reaches 24 hours at
2026-10-31 00:24:18.389 UTC (09:24:18.389 JST). The user explicitly approved a
**one-time package-age exception for SDK 0.3.314 and CLI 2.1.314** in this update.
At this document's update those chronological ages have not elapsed. The
exception permits early admission of this exact coordinated pair; it does not
claim the packages have aged 24 hours or change the normal age rule for future
updates.

Fresh admission completed at **2026-10-30 14:58:00.679 JST (UTC+0900)**. All **18** exact
wrapper/platform archives passed timestamp validation, SHA-512/SHA-1 integrity,
embedded manifest/platform checks and **36** npm metadata signatures. The bounded
serial audit read 2,128,960,251 compressed bytes without installing or executing
a provider. The three SDK pins and Yarn lock now select **0.3.314**; the managed
Windows CLI wrapper, x64 and arm64 entries select **2.1.314** with their reviewed
archive identities. Existing selected external CLI generations remain unchanged.

The repository-only dependency install used transient preapproval for the nine
exact SDK 0.3.314 descriptors covered by the age exception. A subsequent normal
immutable install passed without that override; no persistent age-policy change
was made. Wrapper-only checks remain insufficient. The exception does not relax
finite download/decompression limits, private file ownership, package-script
exclusions or compatibility verification. Registry signatures authenticate npm
metadata under the published registry keys; they do not prove native behavior or
source-to-binary reproducibility. Managed packaging does not execute the CLI's
lifecycle scripts. Required final integration verification remains separate;
this admission record does not claim it passed or attest live provider adoption.

Code 2.1.314 reports a sandbox/worktree repair for headless resume/continue,
relevant to Cafe's resumed SDK queries. Other native changes concern required
remote policy refresh, hooks, startup failure reporting, prompt acknowledgements
and subagent result memory. Cafe retains native sandbox refusals and permission
settings; no unsandboxed fallback is appropriate. Normal queries still read
user/project/local settings. The account-quota helper remains a control-only
process with empty setting sources, disabled hooks/tools/MCP and no inference
or initialize/user frame; its isolation must be qualified separately.

The optional native `blockWritesOutsideWorkingDirectories` setting is not a
general shell/MCP/hook sandbox and is not globally enabled by this update.
Prewarming remains deferred. Native editor idle-compaction behavior does not
justify a Cafe timer. Existing cache-write duration accounting already handles
311's optional partial lifetime buckets; it needs no second implementation.
The separate direct Anthropic API SDK's major release is not an Agent SDK
migration requirement.

The October 30 official concurrency contract still specifies
`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` as a positive plain-digit integer,
ignoring invalid values and defaulting to 20. It applies to Agent-tool admission,
not historical spawns or all running work. Manual/subtask forks occupy slots
without being blocked by the limit; resuming a finished agent takes a new slot
without that admission check. Ultracode is exempt, and workflows/teams retain
separate limits. Cafe preserves the configured-CLI version gate, its own 1–64
safety bound, per-query environment copy and idle reconfiguration policy.
This rechecks the published contract and existing SDK declaration, not the closed
2.1.314 native implementation or actual running-provider adoption. No new
concurrency setting or default change is warranted.

Sources: [SDK 0.3.314](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.314),
[SDK 0.3.312](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.312),
[Code 2.1.314](https://github.com/anthropics/claude-code/releases/tag/v2.1.314),
[Code 2.1.312](https://github.com/anthropics/claude-code/releases/tag/v2.1.312),
[SDK registry](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk),
[CLI registry](https://registry.npmjs.org/@anthropic-ai%2fclaude-code),
[npm signing keys](https://registry.npmjs.org/-/npm/v1/keys),
[official environment contract](https://code.claude.com/docs/en/env-vars),
[official concurrency semantics](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit).
