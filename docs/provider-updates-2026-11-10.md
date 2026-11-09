# Claude 321 and Fable 5.2

Created: 2026-11-10 08:19:06 JST (UTC+0900)
Last updated: 2026-11-10 08:19:06 JST (UTC+0900)

This update selects Agent SDK **0.3.321** and the managed Windows Claude Code
**2.1.321** installation manifest together. All three SDK pins and the lockfile
must agree. The SDK continues to launch the configured native executable;
updating these repository dependencies does not replace an external Claude
installation or restart a running session.

## Reviewed upstream changes

The comparison starts at SDK 0.3.318. The selected SDK tag resolves to
[`1f565ec639edf56fafd0c12b745f082b10d2a452`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/1f565ec639edf56fafd0c12b745f082b10d2a452),
and the CLI tag to
[`a4fcccc70a89df6607e66cc30682d551269d0680`](https://github.com/anthropics/claude-code/tree/a4fcccc70a89df6607e66cc30682d551269d0680).
At selection, npm `latest` named this pair while CLI `stable` still named
2.1.311; these channels are distinct.

The [SDK release notes](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.321)
describe corrected hook decisions, resumed-query startup, worktree skill
discovery, transcript-read failures and batched background-agent reports.
Intermediary empty, successful zero-turn task-notification results still must
not acknowledge Cafe input. Cafe already guards that case, including explicit
message-correlation precedence, so this update preserves the existing ownership
and accounting logic rather than adding another completion path.

[SDK 319](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.319) also supports opt-in streaming MCP background tasks. An observed
`mcp_task` start is already backgrounded even when it omits `is_backgrounded`;
Cafe must not offer to background it again. Its ordinary task identity, progress
and Stop controls remain separate from the subagent roster. Cafe does not enable
new MCP streaming settings or adopt undocumented control requests automatically.

The [CLI release](https://github.com/anthropics/claude-code/releases/tag/v2.1.321)
includes native fixes for cross-host OAuth redirect leakage, sandbox and file
permission checks, headless resume failures, TLS stalls and Fast-mode recovery.
Those security and lifecycle fixes require a selected executable containing
them. Cafe retains its own permission callbacks, native ownership checks and
provider-controlled retry policy.

## Fable 5.2 selection

The model option is the explicit `claude-fable-5-2`, with a native CLI minimum of
**2.1.321**. Older, unknown and prerelease CLI versions do not receive the
fallback row. Live account/deployment metadata can further restrict its
availability; a source catalogue is not proof of account eligibility.

[Claude Code's model configuration](https://code.claude.com/docs/en/model-config)
specifies **Medium** as its default effort, with Low, Medium, High, Extra High
and Max available. That differs from the direct API's High default. The model
has a fixed 1M context window and always-on adaptive thinking; Cafe adds neither
a thinking-off option nor a legacy Ultrathink prompt prefix.

[Fast mode supports Fable 5.2](https://code.claude.com/docs/en/fast-mode).
The new option defaults Off and ordinary composer selection sends explicit
`fastMode: false`. An explicit On selection sends the SDK setting without
claiming native adoption: native eligibility, account policy and serving
availability remain authoritative.

Explicit 5.2 aliases are recognized. Existing saved Fable 5 and 5.1 models,
Cafe's historical bare `fable` normalization, and the default Opus selection
remain unchanged. Cafe does not reproduce the native CLI's account-specific
saved-setting migration.

The [official model specification](https://platform.claude.com/docs/en/models/fable-5-2/overview)
provides the separate standard-rate estimate: $8/M input, $40/M output,
$0.20/M cache reads, $10/M five-minute cache writes and $16/M one-hour cache
writes. Historical Fable rates and user-entered overrides remain independent.
Only reported cache-duration evidence receives the corresponding duration rate;
unknown duration remains visibly unknown. These estimates are not subscription
quota, Fast-mode billing or promotional eligibility evidence.

## Package admission and verification boundary

The user explicitly waived only the elapsed 24-hour age hold for this exact
321 pair. All **18** wrapper/platform archives passed publication-time,
SHA-512/SHA-1, embedded identity/platform and **36** registry-signature checks.
The normal complete-family hold would end at **2026-11-10T19:12:02.471Z**.
The admission receipt SHA-256 is
`3742d152e2b5c80389f56ddb59e64cb58cf4c3c0e13238aa1f175f08e97ee353`.
Registry signatures do not establish native behavior or source-to-binary
reproducibility. No permanent package-age or installer policy is relaxed.

Repository dependency setup uses transient preapproval for only the nine exact
SDK 321 descriptors, with package scripts disabled, followed by a normal
immutable install without the exception. Both repository setup stages passed. They do not run the CLI installer.

Replay uses the pinned Node/Yarn workflow in [test performance](test-performance.md).
Qualify the complete no-emit programs, affected model/pricing/quota and Claude
adapter/control tests, packaging policy checks, formatting and lint. Run the
forced desktop build fresh and last. Keep targeted checks distinct from a full
local test suite, and require a new push's own CI before claiming hosted
qualification. Neither package admission nor a built bundle proves that an
existing native provider process adopted the update.
