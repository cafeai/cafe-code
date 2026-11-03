# Claude 317 and current Codex compatibility

Created: 2026-11-03 14:26:25 JST (UTC+0900)
Last updated: 2026-11-03 18:38:38 JST (UTC+0900)

This review updates Claude Agent SDK **0.3.314** and managed Claude Code
**2.1.314** to the coordinated **0.3.317 / 2.1.317** pair. Codex stable
**0.166.0** remains current and unchanged. Package admission and repository
dependency installation have passed. Integration results must separately bind
the exact checked source and dependency inputs.
No native provider installation, running-session adoption or publication is
claimed by this record.

## Frozen upstream selection

The reviewed SDK release is commit
[`818b0b3ffa395c6bee213f73c461f16e75f1c441`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/818b0b3ffa395c6bee213f73c461f16e75f1c441/CHANGELOG.md),
and the reviewed CLI release is commit
[`964d69565952a176ac1975ed218362991db71433`](https://github.com/anthropics/claude-code/blob/964d69565952a176ac1975ed218362991db71433/CHANGELOG.md).
At selection, npm `latest` and `next` named SDK 0.3.317 and CLI 2.1.317;
the CLI's separate `stable` tag still named 2.1.311. A non-prerelease on
`latest` does not prove that the `stable` channel advanced. The selected 317
family stays fixed even if mutable tags later change.

Codex's stable release still resolves to the already reviewed
[`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`](https://github.com/openai/codex/tree/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856).
The newer 0.167 alpha 4 is a prerelease and is excluded. Cafe therefore keeps
its 0.166 generated protocol and managed artifacts; this update does not
regenerate the protocol or enable experimental Codex features. The
[October 30 review](provider-updates-2026-10-30.md) remains the compatibility
record for that stable target.

## Exact package-age exception and admission

The user explicitly waived the complete-family 24-hour hold for **SDK 0.3.317
and CLI 2.1.317 only**. Without that exception, the full selected family would
remain held until **2026-11-04 00:04:24.141 UTC**
(09:04:24.141 JST). Early admission does not mean 24 hours elapsed. The normal
rule remains in force for every later selection; the separate
[October 30 exception for 314](provider-updates-2026-10-30.md#coordinated-claude-package-admission)
is preserved as history.

All **18** wrapper/platform archives passed the bounded package review:
publication timestamps, SHA-512/SHA-1 integrity, embedded name/version/platform
identity and **36** registry signatures. The admission receipt's SHA-256 is
`e77dc1dfc1f476bb009f5cbefe0affd450d3f33bfe187568656190c644d6e677`.
The age exception did not waive ownership, finite archive limits, signatures,
platform checks or compatibility review. Registry signatures authenticate
registry metadata; they do not prove native behavior or source-to-binary
reproducibility.

The server, scripts and staged desktop runtime pins now select SDK 0.3.317,
with the corresponding reviewed Yarn lock entries. The managed Windows CLI
wrapper/x64/arm64 entries select 2.1.317. Repository dependency installation
completed, including a normal immutable install without an age override; no
persistent package-age policy was relaxed. A configured external executable
retains its own version, and fresh-install manifest selection does not update
an existing installation.

## Session durability notice

SDK 0.3.317 declares `system/session_writes_lost`. It can arrive as the CLI
exits, after the last result, to report that transcript or global configuration
writes were lost. Results already received still stand, and the notice itself
does not change native exit status. The signed, integrity-checked package
declarations were reviewed alongside the
[official SDK release notes](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.317).

Cafe handles a valid primary notice only under its established, exact current
query/runtime/session owner, rechecking ownership after awaited work. Pre-init,
foreign, child-scoped, malformed and retired notices cannot establish session
identity or emit a warning for another owner. A valid notice produces fixed
guidance: “Some Claude session data could not be saved. Recent conversation or
settings changes may be missing after reconnecting.” Diagnostics retain only
bounded counts and Boolean categories, without native error text, paths or
transcript identities. A listed earlier transcript session is descriptive data,
never authority to adopt that session.

The warning is observational. It does not reverse a result, fail or complete a
turn, replace the resume cursor, change paid usage accounting, settle an
approval/question callback or submit a retry. See
[operation visibility](claude-operation-visibility.md#session-durability-notices)
for the display boundary.

## Public Claude summaries in the primary chat

The user's separate presentation request makes already admitted public Claude
summaries ordinary Markdown prose in distinct primary-chat rows. Exact
turn/block identity, first receipt order, stable live upserts and the latest
4,096 UTF-16-character privacy window remain in force. Retained prior-turn
summaries can appear through the existing bounded snapshot; there is no eager
history fetch or database backfill. Exact duplicate work-log text is suppressed
only when that same summary is already primary. OpenCode thinking and older
unloaded history retain their existing work-log presentation.

These rows do not become canonical assistant messages or grant fork, revert,
attachment, checkpoint or turn-completion authority. Hidden/redacted reasoning
is not promoted, and no prompt or inference is added. The
[successor decision](decisions/claude-primary-public-summaries.md) records the
presentation change and preserved disclosure boundaries.

## Other upstream changes and existing boundaries

SDK 0.3.317 adds hook matcher `onFailure: "block"` support. Cafe configures no
SDK hooks and does not enable it. The public declarations do not provide a
distinct new hook-warning discriminator; existing informational-warning handling
remains, without guessed tags or prose classifiers. The additive
`TaskCreate` description, `Query.readFile()` UTF-8 `lossy` flag and removed
`FileReadOutput.file_unchanged` do not require changes to Cafe's current consumers.
The optional read-exemption setting added in 0.3.316 is not enabled by this update.

Native 2.1.315–2.1.317 changes include permission/egress checks, one-time grant
handling, background-agent message delivery, team incarnation/mode preservation,
resume persistence and process cleanup. Their benefits require the selected
native CLI that contains them. Cafe keeps exact callback authority, native
permission-mode ownership, task generations, historical controls and native
usage accounting. It adds no background-work pause, permission bypass,
compaction scheduler or paid recovery loop. Native model eligibility remains
authoritative, including Fast-mode availability; this update does not switch
models or pricing settings.

## Verification and adoption boundaries

Source implementation includes synthetic adapter, selector and native browser
regressions. Delivery requires format, lint, audit, typechecking, appropriate
complete Node/browser suites and a fresh forced desktop build run last, with
results bound to their actual inputs. Package admission and immutable
installation are not substitutes for those checks. Normal rebuilt backend/app
adoption is separate, as are hosted CI and
any specifically authorized dev push. No app/provider restart, credential or
profile inspection, live inference or native executable update was performed.

Public metadata: [SDK 0.3.317](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/0.3.317),
[CLI 2.1.317](https://registry.npmjs.org/@anthropic-ai%2fclaude-code/2.1.317),
[CLI release](https://github.com/anthropics/claude-code/releases/tag/v2.1.317),
[Codex stable release](https://github.com/openai/codex/releases/tag/rust-v0.166.0).
