# Per-chat subagent concurrency

Status: Accepted design; implemented with synthetic regression coverage
Last updated: 2026-10-10 17:30:23 JST (UTC+0900)
Partially superseded by: [Live account subagent-default inheritance](live-account-subagent-default.md)
for new-chat-only seeding, account fallback resolution and saved-only label presentation. The accepted history
below is retained; requested/materialized evidence and safety rules remain in force.

## Context and authority

The user approved a per-chat override and per-account new-chat defaults, with
durability, current worker status, and clear pending-change presentation. A model
or effort label does not determine native concurrency; an inherited provider
configuration can also be unknown. Cafe must not stop a long-running tree just
to apply a saved preference.

## Alternatives and rationale

- An account-only runtime setting cannot express different limits for two chats
  on the same account. Reusing it as a new-chat default would also restart live
  work when the preference changes.
- Editing global native configuration would affect unrelated sessions and lose
  the immutable session evidence needed for safe recovery.
- Reconfiguring on every metadata save would interrupt workers and could start
  a competing query after an inconclusive teardown.

Separate requested policy, new-chat seeding, and observed materialized policy
instead. Native admission remains authoritative and changes wait for a safe
session boundary.

## Decision

Keep requested chat policy separate from materialized provider process evidence.
`subagentLimits` is an optional driver-keyed map with validated integer values
1–64. Omission is unchanged; explicit `{}` is reset. The account's typed
`defaultMaxConcurrentSubagents` is outside runtime configuration and is copied
only during new-chat creation, so editing it never retires a running adapter.

Session `maxConcurrentSubagents` is optional and nullable. Absence is legacy
unknown evidence, null is no explicit Cafe numeric process override, and a number
is configured process policy. Migration 81 stores a known bit separately from
the nullable materialized value. Projections, bootstrap, recovery and fork retain
these distinctions. Existing account runtime overrides remain compatible fallback.

Runtime capability derives from the already observed configured CLI version.
Unsupported/unknown versions reject explicit numeric requests. Codex uses its
existing N spawned/N+1 resident structured overrides; Claude uses a private copied
query environment. Neither changes permissions, global files, model effort,
native cache policy, or platform-specific process ownership.

## Safety and reconciliation

Saving metadata is provider-lifecycle-neutral. A concurrency-driven replacement
requires native idle authority for the owned root/child bindings observed by
the current runtime. Count
notifications through ingress, processing and finalization, rather than assuming
an empty consumer queue means no pending start event. Hold the native lifecycle
permit across final admission and retirement. Unknown liveness or uncertain
native retirement is not authority to launch a competing query.
This is an observed-runtime admission guard, not proof of physical idleness in
unread native/OS buffers or universal historical worker enumeration.

A child waking between orchestration's advisory check and native retirement keeps
the previous process and the new desired policy pending. Only the fixed typed
active-concurrency refusal for a pure limit replacement may preserve that process;
unrelated account/model/cwd changes and arbitrary errors retain their existing
error handling. Never retry/replay a prompt to diagnose or materialize a limit.

Child-state reads reconcile against the same unchanged native child generation.
Canonical terminal edges reach persistence and every renderer. Late tool
completion/request-resolution frames do not create new active authority; only a
real explicit child restart can reopen a terminal row. Late renames update
presentation without changing history binding or frozen duration.

Resume adds one bounded latest-turn metadata read, seeds only previously unbound
exact child references as unknown, and publishes terminal truth only after an
authoritative generation-fenced native read. It preserves known routes and never
replays starts or binds a stale root generation to newer history. Unavailable or
superseded discovery remains conservative until a fresh explicit resume/restart;
older unreferenced history is not inferred completed.

## Presentation and security

The editor, context popover and pinned rail display one saved numeric
**Subagent limit: N**, including while native application is pending. They omit
the limit status when no numeric chat/account setting is known, rather than
showing a provider-managed or unrecorded placeholder. A reset follows the current
inherited setting instead of retaining the previous session's numeric label.
Saved choices and materialized process policy remain separate internally; the
display is not an applied-state or enforcement claim. The editor and accessible
info tooltip explain the safe application boundary without extra pending rows.

The saved-policy editor uses the exact environment/thread/account identity and
the acknowledged command sequence, not arrival order. Canonical policy authority
is committed atomically with the map in the shared store for both shell and detail
streams. Older or unsequenced cross-channel writes cannot replace newer policy;
omission-only metadata and unrelated thread cursors cannot certify it. A temporary
ACK-owned overlay bridges only projection lag and retires at exact-thread policy
authority at or after that ACK, including equal-policy snapshots. Owner changes,
unmounts and reloads release the overlay. Numeric turn entry points require exact
runtime capability; control-only compaction/goal commands remain unaffected.

Tasks/rail are active-only; Atrium keeps historical rows. Both consume the same
canonical derived lifecycle. Authorized detail reads bind the exact immutable
parent/turn/child/history tuple and return bounded public text only. Identity
changes clear the old snapshot synchronously. Historical child formatting uses
the server-verified provider, not the parent's current account. Existing shared
detail subscriptions, refresh coalescing and retention bounds remain in force.

Validation is shared and transport-safe. Diagnostics contain fixed categories,
not prompts, transcripts, credentials or provider exceptions. The implementation
does not add native Windows/macOS/Linux ownership differences. Synthetic contract,
SQLite, recovery, fork, adapter race, environment isolation, and real-browser
fixtures exercise these boundaries; native multi-OS/live-provider qualification
is separate from the local macOS test run.

## Verification and replay

Use the repository-pinned Node/Corepack Yarn toolchain and lockfile. Required
repository checks are `corepack yarn fmt`, `corepack yarn lint`,
`corepack yarn typecheck`, and `corepack yarn test`; run
`corepack yarn build:desktop --force` after tests as the final software check.
Resource-constrained hosts may serialize Turbo test tasks with
`corepack yarn test --concurrency=1` without reducing suite coverage.

Relevant browser regressions run with
`corepack yarn workspace @cafecode/web test:browser --fileParallelism=false`
followed by the affected chat, Atrium, and provider-card browser files. Contract,
projection/migration, provider admission/lifecycle, whitespace, and exact policy
sequence tests run on the ordinary synthetic test path. No paid calls, live
credentials, global provider edits, or native multi-OS qualification are required
or implied by these local regression commands.
