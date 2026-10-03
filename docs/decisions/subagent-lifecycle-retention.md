# Decision: ordered, bounded subagent lifecycle retention across turns

Decision status: Accepted within the authorized subagent tracking repair
Implementation status: Implemented; release qualification follows the gate below
Created: 2026-10-04 00:28:48 JST (UTC+0900)
Last updated: 2026-10-04 01:25:23 JST (UTC+0900)
Decision authority: implementation choice within the user's request to fix new, reused, and closed subagent tracking.
Supersedes: the latest-turn-only activity retention rule; preserves the ownership and admission rules in [native root liveness](codex-native-root-liveness.md).

## Context

A native root may finish while its children keep working. A subsequent user turn
does not end those children. Keeping compact lifecycle edges only for the latest
turn loses older workers after the ordinary activity tail fills or reconnects.
Conversely, losing a completion while retaining later progress can manufacture
an active worker. Neither age nor the parent's terminal state establishes a
structured child's status.

An independent ordering defect allowed old terminal metadata and a new child
start in the same millisecond to sort by UUID. The enclosing orchestration append
sequence exists, but was not consistently projected onto activity rows. A
provider-local counter is not a substitute: it can reset across native sessions.

## Decision

Every new activity projection uses its enclosing orchestration append sequence,
consistently in SQLite, in-memory replay, and the renderer. Legacy retained task
rows can recover that sequence only from a uniquely qualified exact indexed
provider command witness. Verify the event's actor, thread, activity, turn and
kind before using its sequence; never infer order from a model name, label,
timestamp proximity or current composer selection.

The qualification join must start from the bounded unique witnesses and fetch
each event by its sequence primary key. An indexed command probe alone does not
make the complete statement bounded: mature SQLite statistics can reorder a
later join into a walk of the entire thread stream. Explicit loop-order fences
and query-plan regressions protect both small and full witness batches without
relaxing actor, identity, timestamp, ambiguity, or payload checks.
The final detail activity lookup likewise starts from the retained identity set
and fetches base activities by primary key; a planner-selected activity-table
scan is not an acceptable alternative merely because its result is capped.

Keep the newest start, progress and completion edge separately for each exact
`(visible turn, child identity)`, across turns. The global compact-detail identity
ceiling remains 4,096; the ordinary activity tail, latest plan and current-turn
configuration exceptions remain independent. Ambient visibility tombstones must
survive with the same authority as their corresponding visible lifecycle edges.

Use a normalized lifecycle-source sidecar plus a latest-edge pointer table.
Exact-key indexes support pointer repair on activity update/delete. An indexed
read of at most three times the identity ceiling plus sentinel identifies the
most recently active identities; rank complete ordering tuples rather than
combining unrelated maximum columns. Hydrate no more than three lifecycle
activities per admitted identity. The source activity remains authoritative;
these tables do not contain another copy of prompts, transcripts or summaries.

The migration creates empty schema and maintenance triggers only. Existing data
hydrates after readiness, for the requested thread, in bounded indexed pages
through fixed cutoffs with real event-loop yields. Deduplicate and bound
background work. Until hydration is complete, keep the existing latest-turn
fallback; do not expose a partially reconstructed older lifecycle as authoritative
state. Global legacy coverage becomes available on a subsequent detail refresh,
reopen or reconnect after hydration. Selected legacy task ordering is repaired
independently, so the same-millisecond restart fix does not wait for full history.

## Alternatives and rationale

- Removing the current-turn SQL predicate would parse unbounded history on each
  reconnect and can starve WebSocket heartbeats.
- A JSON expression index alone cannot bound both recent distinct-identity
  discovery and per-kind latest-edge lookup when one child has unlimited progress.
  Building that index or backfilling globally during startup also violates the
  repository's readiness requirements.
- Keeping only the last three events per child loses lifecycle authority when
  those events are all progress. Retain one of each kind instead.
- Timestamp heuristics or marking every historical child complete hide symptoms
  without provider evidence and are rejected.

## Security, failure, and compatibility

Provider identities are exact opaque keys, not display text. Bound them and
reject unsafe controls without trimming or normalizing distinct identities.
Hydration transactions obey permanent hard-delete tombstones; a racing repair
must not recreate deleted activity. SQL parameters remain bound. Only narrowly
classified lock contention is eligible for bounded retry, never malformed state
or integrity failures. Missing legacy provenance stays unknown rather than
borrowing another thread's event or credentials.

The change adds no provider inference, transcript scan, permission change,
credential access, process restart, or platform-specific launch behavior. Native
child-turn completion and runtime-owner checks remain separate from UI retention.
Already-running old processes do not gain new behavior from a successful build.

The immutable owner map is scoped to one native runtime/root/account. Resume
retains the existing bounded newest-turn discovery policy, not a global original-
owner reconstruction. Preexisting duplicate rows for one native child under
different visible turns are therefore not automatically merged or completed.
Repairing those requires qualified original root/account/owner evidence; neither
this compact projection nor a label match supplies that authority.

## Evidence and release gate

Required regressions cover equal timestamps with conflicting UUID/provider-local
ordering, repeated replay/reconnect, quiet older-turn workers, terminal progress
replay, explicit reuse, exact identity separation, bounded candidate selection,
legacy hydration cutoffs, and update/delete/tombstone behavior. Native routing
tests cover reused children and stale terminal events. Browser tests verify both
Tasks and the docked rail.

Query-plan coverage must include analyzed, long-thread fixtures and partial
batches, not only empty in-memory schemas. A synchronous SQLite history scan
prevents heartbeat handling; the desktop watchdog can then restart the backend,
which repeats the same load and leaves the renderer reconnecting. Increasing
heartbeat or watchdog deadlines does not correct that failure. Keep legacy
fallback extraction/identity validation materialized once per indexed current-
turn candidate set rather than duplicating scans through flattened CTEs.

Use the pinned Node/Yarn toolchain, run the repository checks and full tests, then
the forced desktop build as the final local gate. Native Windows/macOS/Linux CI
quality and artifact jobs qualify the pushed revision separately. Implementation
and verification status above must be updated after that evidence is available.
