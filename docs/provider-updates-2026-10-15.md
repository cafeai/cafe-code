# Provider compatibility review: October 8–15, 2026

Reviewed: 2026-10-15 07:58:16 JST (UTC+0900)
Scope: public official releases, immutable source, Cafe's current integration and
explicitly authorized offline Codex artifact/scalar-history investigation.
Native installation, live-account eligibility and hosted CI remain separate.

## Codex catalogue repair

[Stable Codex 0.162.1](https://github.com/openai/codex/releases/tag/rust-v0.162.1)
resolves to `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`, already Cafe's generated
pin. No protocol upgrade is required. Consume its native fixes through the
configured CLI rather than duplicating process/retry policy or installing it here.

The [official model guide](https://learn.chatgpt.com/docs/models) retires GPT-5.5
from ChatGPT Codex on October 14 at 19:00 UTC; API-key use is unaffected. GPT-5.4,
GPT-5.4 mini and GPT-5.3-Codex-Spark had already retired from that sign-in path.
Cafe's conclusive ChatGPT CLI fallback still included these ordinary built-ins.
Generic union/later health replacement could resurrect native omissions too.

The repair labels explicit fallback/native producer provenance. Conclusive
ChatGPT static fallback omits those built-ins; API/unknown fallback and native
results retain their respective policies. Explicit custom models and saved
choices are not silently migrated, banned or substituted. Native rows stay exact
through same-owner, explicitly identified same-account fallback health updates.
Legacy missing provenance is unknown; replacement owners and cache hydration
cannot borrow active native proof. The existing model-only empty discovery policy
stays inconclusive; an explicitly admitted successful empty catalogue is exact.

One private metadata transaction also orders current-view admission, persistence
and publication against maintenance, quota, replacement and removal updates.
Provider operations retain their original concurrency outside that boundary;
startup snapshots must still belong to the exact live owner. An older captured
array cannot publish after a newer quota or removal state merely because its
cache write completed later.
Cleanup obtains fresh inert inventory after awaited health work, while retaining
the early metadata admission check and its original failure-before-probe policy.

This is observed metadata, not current entitlement or fresh account/read proof.
No extra periodic probe, paid default, account switch, permission or retry is
introduced. Existing advertised service-tier controls already accept Ultra fast
where supported; [eligibility/pricing](https://learn.chatgpt.com/docs/agent-configuration/speed)
remain native. See [the decision](decisions/codex-model-catalogue-provenance.md).

## Shared probe cancellation repair

Strict synthetic scope-retirement qualification exposed an existing single-flight
completion defect: provider work was cancelled and its scope closed, but the
captured failure could itself be cancelled before reaching shared waiters. A second
fixture caught a resumed caller borrowing the completed flight before retirement.
The repair masks only bookkeeping, explicitly leaves the provider operation
interruptible, retires the exact flight before waking its Deferred, and retains
the same scope, budgets and concurrency. Closed-scope admission invokes no provider;
caller disconnects still preserve an admitted shared flight for surviving callers.
No paid retry, provider interruption, longer deadline or extra worker is introduced.

Full integration qualification also exercises removal during a held initial probe.
Registry lookup ownership must be revoked before scope teardown can wake readers;
a retiring owner cannot lend capability proof while reconciliation is closing it.
The optional inert snapshot accessor retains the existing live presentation wrapper
so current catalogue reads cannot discard a renamed account's display metadata.
Neither boundary starts a probe or changes close-before-replacement ordering.
Exact shared cleanup receipts also join cancelled unpublished creates and retain
teardown defects as reuse refusals. Closed-scope checks veto late adoption after
parent shutdown; they never substitute for a successful cleanup receipt. These
changes protect bookkeeping/cleanup only, not provider construction or paid work.

## Claude: retain the qualified SDK

All three SDK pins remain 0.3.295. Numeric CLI/SDK releases reached 2.1.300/0.3.300,
while the CLI's named stable channel remains 2.1.292. Complete package sets—not
GitHub release dates—control the existing 24-hour hold. At review, 299 clears
October 15 00:28:40.235 UTC and 300 clears October 15 14:30:39.051 UTC; both are held.

An integrity/source comparison of eligible 0.3.296 found no required change to
Cafe's used query/message/permission/usage/fork surfaces. Its additive version and
agent-window fields do not repair a demonstrated Cafe defect. Cafe does not use
the combined SDK sandbox-option bug. An intermediate bump would not provide later
native fixes; [2.1.299](https://github.com/anthropics/claude-code/releases/tag/v2.1.299)
also fixes a duplicate-execution regression introduced in 296.

[SDK 0.3.300](https://github.com/anthropics/claude-agent-sdk-typescript/blob/fbc529490ca0fb07b486c6f9c8e553d3fb7c690d/CHANGELOG.md)
includes a Node 24 Unicode-separator import fix, but its package set is held and
needs complete supply-chain/integration review. No observed local import failure
warrants a workaround. Retain 295 now; no installation, hold bypass or duplicate
native retry/sandbox/resume machinery. Configured Claude executable versions are unobserved.

## Compaction accounting investigation

Scoped debug found paired actual-opening 800K nominal requests and no pending
policy adoption. A lower retained pre-start API count does not demonstrate a
dropped request or effective 500K limit.

[Pinned native history accounting](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/context_manager/history.rs#L934)
adds estimates for locally appended items and, conditionally, older encrypted
reasoning. Reported reasoning output does not expose that separate estimate and
is already inside output tokens. [Native limits](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/session/context_window.rs#L35)
also depend on scope/model/buffering/post-turn policy. No fixed 300K reserve was
found. Ordinary received events lack the internal active count, resolved scope/
threshold and trigger branch. Keep them unknown rather than changing policy or
presenting a reconstructed possibility as an observed cause. The production debug
trace separates paired requests and same-owner received-order usage from these
unreported native values. See [the context guide](codex-context-window.md).

User-approved REA 6.4.0 was installed in an isolated pinned Node/Yarn tool workspace,
without bypassing the existing package-age hold. Its native Mach-O inspection
identified the installed Codex 0.162.1 artifact; the current process's executable
mapping matches that artifact. This is metadata inspection, not decompilation,
binary/source-equivalence proof or historical execution-trace recovery. No global
MCP setup, provider restart, native engine or provider installation was needed.

The exact session's scalar-only checkpoint/suffix inspection reconstructs two
conditional totals: 468,837 when older reasoning is already included, or 729,028
when adding its 260,191-token encrypted-reasoning estimate. Both include the exact
fitting 10,048-token local tail beside the 458,789 API sample. Previous/current
persisted model and compaction hash match. The second total is consistent with
the nominal ~720K compaction base, not evidence of a fixed 500K window. Native
`server_reasoning_included`, resolved scope/threshold and trigger reason/phase
are unpersisted; the selected account's native log database has no event-window
records. Consequently this is a strong specific accounting lead, not conclusively
observed cause. No raw private text or ciphertext is retained, and no policy is
changed on a guess. A 1M override is nominal capacity subject to model caps, not
a guarantee that the API meter reaches 1M before native compaction.

## Qualification boundary

Finite schema/producer/managed/registry/cache fixtures cover source admission,
native omission, exact owner/account retirement, stale/error/inconclusive paths,
fallback/API/custom compatibility and historical hydration. Required full local
checks and forced desktop build precede publication at lowered child priority,
with original bounds. They do not establish live entitlement, effective native
trigger timing, provider upgrades or hosted CI.
