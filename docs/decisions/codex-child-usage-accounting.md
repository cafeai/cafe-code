# Decision: prospective, bounded Codex child usage accounting

Decision status: Accepted within the authorized provider-parity implementation
Implementation status: Implemented and released; integrated local and exact-head platform CI gates verified on 36c64874.
Created: 2026-10-05 06:28:00 JST (UTC+0900)
Last updated: 2026-10-05 16:58:09 JST (UTC+0900)
Authority: the user's request to implement all medium-priority provider-parity items.
Supersedes: primary-only Codex throughput coverage, not primary context occupancy.

## Released qualification

The integrated release at `36c64874fce05cb037d69737b4833ccf7c37f52d` passed
formatting, lint, typecheck, 6,599 default tests, 934 browser tests, two isolated
native fixtures and the final forced desktop build. [Exact-head CI](https://github.com/cafeai/cafe-code/actions/runs/37258417302)
passed all seven applicable quality/artifact jobs and produced four nonempty
platform artifacts. This is source-bound fixture/build evidence, not a live paid
provider claim; later changes require fresh release verification.

## Native evidence

The qualified source is [Codex 0.160.0](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc).
`app-server/src/bespoke_event_handling.rs::handle_token_count` publishes one
thread's `TokenUsageInfo`. `core/src/session/mod.rs::record_token_usage_info`
updates that session's history from its own model response, not a subtree sum.
`protocol/src/protocol.rs::TokenUsageInfo::append_last_usage` accumulates those
responses. Child completion does not add a child's counters to its parent's
history. Thus independently owned child increments are disjoint from the existing
parent accounting stream. Context estimates are different: `recompute_token_usage`
changes last occupancy, and `fill_to_context_window` can replace total counters
with an estimated window and zero categories. Neither authorizes billed tokens.
`core/src/agent/control/spawn.rs` strips inherited `TokenUsageRecord` and paginated
TokenCount events from child forks. Older/history-loaded shapes can nevertheless
contain a preexisting cumulative baseline. Do not assume a received child-start
notification proves a newly zeroed counter.

## Decision

Keep root context and root throughput behavior unchanged. Add only child
increments observed between validated cumulative snapshots in one native runtime.
The first snapshot is a subtract-only baseline, never historical backfill. This
deliberately misses the first response if no zero baseline was observed. State and
coverage remain partial; we do not label these numbers a complete billing record.

Use the existing exact root/account/runtime routing plus a bounded native parent
ancestry attestation before admitting a child. Metadata may come from already
received thread-start notifications or existing bounded liveness reads; accounting
adds no provider request, transcript read, inference, or startup scan. Retain at
most 4,096 child entries and follow at most 32 ancestry hops. Unknown ancestry,
cycles, changed owner or overflow cannot become another root's accounting.

Each observed child receives a fresh random Cafe UUID accounting epoch. Each
accepted numeric delta increments that epoch's cumulative per-model checkpoint.
The existing ordered journal and transactional usage ledger deduplicate epoch
revisions across backend reconnect/restart. A replacement native runtime starts
new epochs and new subtract-only baselines, so a resumed/forked/reused native id
does not charge inherited totals again. Unjournalled observations lost to a hard
crash cannot be recovered honestly and remain missing.

Validate safe integer input/cache-write/cache-read/output/reasoning counters and
their disjoint fresh/cache and generated/reasoning categories before subtraction.
Never use totalTokens or last-context estimates as additive spend. Duplicate
snapshots add zero. Regression is ambiguous reset/reordering: freeze that child's
epoch for the runtime rather than lowering its watermark and later recounting.
Invalid or overflowing counters fail closed, including cumulative processed totals
across models and child publications within this runtime. Bound model cardinality
to 64. Counter observation uses the same exact admission/route permit as lifecycle
state, so concurrent reconnect discovery cannot change its attribution boundary.

Only native child model metadata or reroute/settings observations may name a model;
never borrow the parent's selection. Missing/invalid identity is `unknown` and
unpriced. A model transition anchors the next counter observation without charging
an interval whose attribution may straddle the change. Earlier credited rows stay
under their original model and observation day.

## Privacy and operational consequences

Native root/child/account/turn identifiers remain in bounded runtime memory only;
new accounting payloads contain solely Cafe-minted UUIDs, revisions, safe numeric
counts and bounded canonical model labels. No prompts, transcript text, filesystem
paths or provider errors enter the ledger. This creates no task liveness authority,
does not affect approvals or stop/restart behavior, and does not alter Claude,
Grok, model pricing or user overrides. Existing processes adopt it through normal
runtime restart/resume, not live session mutation. All hosts share this pure path.

## Verification gate

Exercise exact parent/root ownership, missing/nested/cyclic ancestry, duplicate and
out-of-order snapshots, reset/fork/resume baselines, child reuse across parent
turns, model changes, category regression, arithmetic overflow and cardinality
bounds. Prove child tokens cannot replace primary context or double count parent
usage, and replay the exact accounting epoch through real SQLite after service
recreation. Usage UI must explicitly describe prospective partial child coverage.
Independent accounting/security review, all required repository checks, browser
qualification, final forced desktop build and exact-head CI are required before
claiming completion. Synthetic tests do not establish paid provider billing parity.

Focused qualification passed 359 collector, runtime, adapter and SQLite-ledger
tests, plus 32 usage browser tests. The shared accounting contract also rejects
overflow of the combined input/output total, not only individual columns; its
11 contract tests passed. Independent review found and corrected cumulative
processed-token overflow and aligned observation with lifecycle admission. No
historical backfill or price-table change was introduced to obtain these results.
