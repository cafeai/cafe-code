# Provider compatibility and persistent recovery — October 11, 2026

Created: 2026-10-11 00:19:51 JST (UTC+0900)
Last updated: 2026-10-11 02:38:08 JST (UTC+0900)
Status: implemented; combined source and renderer qualification passed locally

## Scope

The October 3–10 provider review found a concrete Codex recovery classifier gap,
new native protocol fields, additive Claude task identities, Haiku 5.5 capabilities
and pricing changes. This user-authorized combined repair retains exact account,
query, native conversation, runtime generation, turn and immutable control/attempt
ownership. It does not install a provider, interrupt live work, inspect credentials,
edit profiles or replay the original prompt/tool calls. A build or push does not
live-update an already running backend/daemon generation.

## Codex remote-compaction recovery

Codex `rust-v0.162.1`, immutable commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`, uses a finite remote-compaction retry
budget and wraps its exhausted stream failure with
`Error running remote compact task: `. Its underlying generic processing error
still has `codexErrorInfo: other`. Cafe's strict classifier previously rejected
that wrapper, so the definitive failed root did not schedule its next continuation.
The correction admits one exact anchored wrapper around the existing qualified
UUID-bearing processing error. It does not strip arbitrary prefixes, classify
model prose, accept contradictory details or retry permanent auth/quota/policy
errors. [Native compaction source](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/compact_remote_v2.rs).

Definitive native completion already clears tracked automatic-compaction items,
including when no item-completed edge arrives. Manual or uncertain compaction,
pending starts, closed context and history uncertainty remain independent vetoes.
Fresh exact owner inventory must still certify the failed root before Cafe sends
a short continuation in the same native conversation. Native retry warnings
remain native-owned, not nested Cafe submissions. [Official lifecycle](https://learn.chatgpt.com/docs/app-server).

The existing persistent worker has no attempt cutoff: 75–100% jittered exponential
delay caps at 60 seconds and its persisted exponent saturates at 30. The real
SQL-backed regression exercises 36 accepted/failed continuations and then explicit
Stop. Acceptance uncertainty remains reconciliation, never permission to resend.
The compact status now leads with Reconnecting or Agents running, while historical
root failure remains recorded. Independent Stop and manual next-turn input remain
usable. See [the accepted recovery decision](decisions/codex-persistent-transient-recovery.md).

Native reconnect notifications now show deduplicated cumulative observations for
the exact native runtime/target/turn, rather than repeating the provider's internal
`1/5` prose. They have no reported timer; Cafe never invents one. Finite tracking
ceilings display a lower bound, not a retry cutoff. Cafe's own short continuations
carry a separate durable ordinal independent of its saturated delay exponent.
Only an exact accepted receipt permits the next generation; repeated preparation
checks reuse its number. Older saturated chains show an honest lower bound.
Malformed optional count data is omitted without blocking existing recovery.

The compact notice shows the actual scheduled Cafe deadline, for example
`Retry #37 in 45s`; historical work-log waits stay static. One latest exact-owned
current-turn marker survives long child/tool tails and refreshes. Cancellation,
uncertain acknowledgment and an attempted handoff end stale countdowns without
claiming acceptance or a resumed root. A narrow projection-only owner/order index
provides bounded lookup; it does not change retry admission. Typed content-free
native reconnect warnings from surviving children cannot extend the failed
root's completion watermark and invalidate its private failure proof. Qualified
terminal child errors retain their failed task and bounded error detail without a
duplicate unscoped parent warning; missing child identity retains the diagnostic
fallback. Ordinary root work and generic diagnostics keep their existing clocks.
Recovery presentation uses its separate migration 93, following the existing
workflow, recovery-intent and live-work migrations; migration 92 remains LiveWork.

While an exact-owned automatic wait or pre-I/O continuation is pending, the
matching provider error stays in the work log without a separate error banner.
This does not clear the saved error: uncertain acknowledgment, cancellation,
unprepared recovery, unavailable environments and unrelated/manual command
failures keep their notifications. Surviving children alone cannot suppress a
banner. The transcript footer shows a compact ongoing context label with the
historical root duration, rather than implying the session finished. An empty
recovery composer keeps the normal red Stop button and uses current canonical
session-stop admission. A deliberate draft retains ordinary new-turn submission;
the failed root's phase is never changed merely to choose a button or label.

## Codex protocol qualification

The generated app-server surface advances from immutable 0.159.0 source to
0.162.1 using the repository's inert JSON-schema/method generator, not an
executed provider or hand-edited generated types. New `partial_answer` messages
previously failed the closed phase decoder; live and bounded history mapping now
retain their public text as commentary, not final or successful-turn authority.
Open-ended native error strings/objects survive typed terminal envelopes, while
unknown errors remain excluded from the transient recovery allowlist. Independent
review reproduced closed tagged decoding silently stripping contradictory policy
keys and nested permanent metadata before classification. Preserve the entire
open error object and reject unknown outer error fields; typed decoding must not
convert an unclassified raw failure into retry authority. Classification uses the
complete in-memory error; separate bounded diagnostic copies omit unconsumed
unknown values from native/debug logs and canonical raw/detail journals, including
startup snapshots of prior failed turns. Malformed unused attachment and prediction
frames retain only fixed diagnostic categories, not schema causes quoting their
private values. The JSON
schema keeps nullable `rootTurnId` optional, so older native omissions remain valid;
that field does not replace Cafe's owner/turn guards.

Native goal set/clear now distinguishes explicit user and automatic origin.
Cafe supplies `origin: user` only for its existing authenticated explicit goal
controls and user Stop pause. Read-only operations and unrelated turn parameters
remain unchanged. Missing provenance is not user authorization. Newly generated
methods and metadata stay inert unless an existing authorized adapter consumes
them. In particular, new `thread/prediction/updated` data is dropped before raw
native logging, canonical activity and child-liveness accounting: unused predicted
text must not become durable private data or phantom activity.
[Immutable protocol source](https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol).

The concurrency re-audit retains public key/legacy alias/minimum, V1 six spawned,
V2 four total/three spawned, explicit V2 precedence, public N→N+1 translation and
inherited omission. Native resident membership/teardown implementation changed,
but capacity still counts residents plus pending starts. Cafe does not copy native
eviction policy or introduce another capacity queue. No cache/compaction budget,
experimental flag, prompt or credential-default change is made.

## Claude SDK release and supply chain

All three imported/staged Agent SDK pins move from 0.3.288 to **0.3.295** together.
At the initial observation (`2026-10-10T15:08:31.364Z`) 0.3.296 was newer but its
complete nine-package set remained age-held until `2026-10-10T17:17:17.488Z`
(October 11, 02:17:17.488 JST). The 0.3.295 set cleared on
`2026-10-09T18:24:32.504Z`; its youngest sibling was Windows x64, not the wrapper.
No package-age bypass is used. The native CLI's named stable channel is separate
from numeric non-prerelease availability and does not authorize installation.
[SDK registry](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk),
[CLI registry](https://registry.npmjs.org/@anthropic-ai/claude-code).

The wrapper and eight native siblings cover macOS arm64/x64, Linux arm64/x64
glibc/musl, and Windows arm64/x64. Every inert archive passed registry SHA-512
integrity and embedded manifest identity/constraints/entrypoint comparison. All
18 supplied registry ECDSA signature entries verified; shared-key signatures
are not independent publisher attestations. Wrapper SRI:
`sha512-GaLZbMAqyT4ZCtDQYq2p26bjpqqRfoobVxCK+Ao283I12sGyw2ttMvjdCXclS9VKhs+/IIu8/AtjqyrX73FZ/g==`.
Wrapper archive SHA-256:
`704b1228401f951e1cdb3a1782b97893d3caee64afe162a4f7fbda8106273c7b`.

AST-normalized Options, Query, top-level message discriminants, permission/effort
and usage-report contracts are unchanged. Every direct Cafe SDK import remains
declared, and every runtime import is present in the actual public export table.
The directly imported user-message declaration adds agent metadata; task-related
declarations add run/parent identities. The wrapper's `sdk.mjs` SHA-256 is
`86ba133f4d52e80d03f04cb47f1022d5c8010a7971c7ed937a45a629c0bf2cf0`.

The additive task contract uses `agent_id` for an emitting subagent's stable task
id, not its transcript/history id. Resolve agent-only child frames only through
an already admitted same-query task/spawning-tool association. Unknown, stale,
foreign or contradictory nested frames cannot become primary text or gain
history access. Optional lexically ordered `run_id` distinguishes resumed task
incarnations. A newer complete level or a legacy task's first run-aware non-start
edge invalidates older task-control receipts; only a qualified explicit start
creates the new control generation. Exact pending-run progress and terminal data
still settle liveness without renewing controls. Empty and
legacy complete membership levels also require the current established native
session/query. Known same-query parent metadata remains private and confers no
history authority. Run-free legacy tasks retain their existing behavior without
borrowing a newer run's identity. [SDK release notes](https://github.com/anthropics/claude-agent-sdk-typescript/blob/85d8f8e0772199ec7965a0c2e874ac88343f2a01/CHANGELOG.md).

Native Claude 2.1.289–2.1.295 includes partial-stream/resume, background workflow,
permission and MCP recovery hardening. Those fixes require the configured native
executable. Cafe still supplies `pathToClaudeCodeExecutable`; upgrading its SDK
wrapper neither replaces that executable nor proves those native fixes active.
No duplicate MCP retry loop, new watchdog environment override, automatic status
prompt or unconditional output-budget increase is introduced.
[Native release notes](https://github.com/anthropics/claude-code/blob/2301018b1f61073c501a8e7a4813ef48c239163b/CHANGELOG.md).

## Models, service tiers and estimates

Haiku 5.5 fallback metadata requires native Claude Code 2.1.293, exposes five
concrete efforts with Medium default, and does not invent a context selector,
legacy thinking toggle or global bare-alias migration. Its native 1M context and
API 128K output ceiling do not authorize silently changing the user's response
budget. Explicit 5.5 shorthand aliases coexist with the saved bare Haiku 4.5
mapping and unchanged Sonnet 5 new-chat default. Existing live discovery may
narrow these controls. Gated fallback rows
now require bounded canonical stable native-version evidence: unknown or malformed
versions previously qualified through generic lexical sorting, and are rejected.
[Claude model configuration](https://code.claude.com/docs/en/model-config),
[Haiku capabilities](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5).

Standard USD/M-token estimates add Haiku 5.5 input 0.10, output 0.50, cache read
0.01 and five-minute cache write 0.125. Sonnet 5.5 cache reads use 0.10 while
historical Sonnet 5 remains 0.20. Longest-prefix selection and user overrides
remain authoritative. Haiku's per-request >100K premium cannot be reconstructed
from cumulative ledger totals; neither service tier nor one-hour cache TTL can
be inferred. These are standard-rate API-equivalent estimates, not invoices or
subscription usage. [Published pricing](https://www.anthropic.com/claude-haiku-5-5),
[pricing reference](https://platform.claude.com/docs/en/about-claude/pricing).

OpenAI's Ultrafast service tier already uses Cafe's generic exact advertised-tier
path; no paid default or hard-coded new switch is needed. Native per-account model
inventory remains authoritative. GPT-5.5's announced October 14 retirement applies
to ChatGPT-authenticated Codex, not API availability. Tests preserve native
ChatGPT omission, API-listed availability and explicit custom selection. No
guessed retirement hour or global model ban is added.
[Speed configuration](https://learn.chatgpt.com/docs/agent-configuration/speed),
[model lifecycle](https://learn.chatgpt.com/docs/models).

## Verification boundary

Use Node 24.21.0 and Corepack Yarn 4.17.1 with the checked-in lockfile. Dependency
replay must use a fresh isolated source archive, immutable installation and the
same focused synthetic tests. Source/event and renderer qualification is not
live provider eligibility, upstream capacity, native foreign-platform behavior or
proof that the user's existing process has adopted the repair. Integrated fmt,
lint, typecheck, full default/browser tests and a forced desktop build last on
unchanged source remain required before release completion. Normal rebuilt-runtime
adoption is required; these checks do not change a running provider session.

Combined source and renderer qualification completed locally at
`2026-10-11 02:38:08 JST (UTC+0900)` after preserving the concurrent native-control,
Daybreak and live-work integration:

- `yarn fmt`, `yarn fmt:check`, `yarn lint` and `yarn typecheck` pass. Existing
  lint warnings remain; all ten typecheck tasks execute uncached in 14.84s.
- `yarn test --force`: ten uncached tasks pass in 4m44.938s, with 7,875 passing
  tests, one existing expected failure and eight existing skipped tests.
- `yarn workspace @cafecode/web test:browser --maxWorkers=2`: all 1,408 tests in
  95 files pass in 237.11s, retaining original deadlines and worker bounds.
- Independent final lifecycle/security reviews close the matching-error banner,
  fixed-root ongoing footer and canonical red Stop boundaries. Focused merged
  Codex 410/410 and Claude 307/307 pass; final notification 161 focused tests,
  footer-adjacent 34 tests and actual composer/footer 104 browser tests pass.

The forced desktop build is the final release gate after documentation formatting;
its exact tested tree, outcome and dev push identity are recorded in the release
checkpoint. Native preparation may reuse only its verified reviewed-source bytes;
this local build does not qualify native desktop interaction or enable it.

Prior local macOS qualification on Node 24.21.0 / Corepack Yarn 4.17.1 completed at
`2026-10-11 01:17:11 JST (UTC+0900)`, before the additional cumulative-retry display
request. This historical evidence is not substituted for the combined results above:

- `yarn fmt`, `yarn fmt:check`, `yarn lint` and `yarn typecheck` pass; lint retains
  existing warnings. All ten typecheck tasks execute without cached results.
- `yarn test`: all ten tasks pass in 6m50.86s, with 7,776 passing tests, one existing
  expected failure and six existing skipped tests.
- `yarn workspace @cafecode/web test:browser --maxWorkers=2`: all 1,406 tests in
  93 files pass in 223.14s on the unchanged renderer source.
- Independent lifecycle/privacy review closes the error-decoding, diagnostic-copy
  and task-incarnation findings. Focused Codex server 405/405 and protocol127/127,
  Claude306/306, SDK/process/rewind9/9 and toolchain12/12 pass. The Claude306/306
  suite also passes in a fresh script-disabled immutable dependency replay.

The release must run `yarn build:desktop --force` after these tests and final
documentation formatting, without further source edits. Native Windows/Linux
execution and upstream service capacity remain separate qualification boundaries.

For the dependency replay, bind the exact reviewed **committed** candidate SHA,
not moving `dev` or an older HEAD that omits uncommitted repairs. Use a fresh
isolated temporary directory and the pinned Node binary on PATH:

```sh
candidate_commit=REPLACE_WITH_REVIEWED_COMMIT_SHA
provider_replay_dir="$(mktemp -d "${TMPDIR:-/tmp}/cafe-provider-replay.XXXXXX")"
git archive "$candidate_commit" | tar -x -C "$provider_replay_dir"
cd "$provider_replay_dir"
node --version
corepack yarn --version
YARN_ENABLE_SCRIPTS=false corepack yarn install --immutable --mode=skip-build
corepack yarn workspace @cafecode/scripts test toolchain-policy.test.ts
corepack yarn workspace @cafeai/cafe-code test src/provider/Layers/ClaudeAdapter.test.ts src/provider/claudeQueryProcess.test.ts src/provider/claudeConversationRewind.test.ts
corepack yarn workspace @cafeai/cafe-code typecheck
```

The isolated archive contains no provider profile or live Cafe database. This
script-disabled dependency/import replay is separate from repository-wide final
gates and native packaging qualification; it never invokes a configured provider.
