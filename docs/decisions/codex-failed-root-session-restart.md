# Decision: reopen the session before a failed-root continuation

Decision status: Accepted within the user's explicit implementation request
Implementation status: Guarded lifecycle and receipt transfer implemented; normal rebuilt-runtime adoption required
Verification scope: Isolated synthetic peers/SQL and complete release checks; no live provider proof
Created: 2026-10-14 15:46:27 JST (UTC+0900)
Last updated: 2026-10-19 12:16:05 JST (UTC+0900)
Decision authority: the user explicitly requests ending a failed root's session and
starting a completely new turn with the automatic continuation.
Partially supersedes: [persistent transient recovery](codex-persistent-transient-recovery.md),
only its retention of the failed native context during automatic continuation.
Partially superseded by: [proven unsubmitted retry](codex-failed-root-unsubmitted-retry.md)
only when a new exact typed refusal proves that retirement and submission did not
begin. The same-history cold restart, individual one-use claims, unknown-ACK
reconciliation and all native/control guards below remain governing.

## Context and alternatives

The previous policy already submitted a new `turn/start`, not a steer, after a
definitive allowlisted transient failure. It nevertheless reused the failed
native session and preserved independently running children. Repeated visible
continuations therefore did not establish that the failed process generation was
replaced. The user now explicitly prefers ending that session before continuing.

Starting a blank conversation would discard native history, and replaying Cafe's
original request or tool calls could duplicate external actions. Neither is the
requested recovery. An unguarded inventory-read followed by a thread-only Stop
could terminate newer work that won between those operations. Retirement must be
an exact native admission operation, not inferred from projected status or prose.

The [official app-server lifecycle](https://learn.chatgpt.com/docs/app-server)
separates resuming stored history with `thread/resume`, beginning a new turn with
`turn/start`, and appending to active work with `turn/steer`. Reopening history does
not guarantee that upstream capacity becomes available or that an agent will never
choose to repeat an action.

## Decision

For the existing definitive, allowlisted transient root recovery path, retire the
exact failed native session before reopening the same stored native conversation
and sending one short automated continuation as a fresh turn. Retirement also
ends the old session's surviving child work. The old failed root remains failed;
its completion timestamp, error, message history and diagnostics are preserved.

The continuation asks the agent to inspect existing work before repeating an
action. It carries no original attachments, transcript copy, hidden reasoning,
tool command replay or replacement of the user's chosen model/effort/permissions.
Preserve the owning account and recorded launch policies rather than materializing
new saved defaults during recovery.

Atomic native retirement must authenticate the exact account/generation/native
conversation/failed turn and its definitive transient evidence, with no pending
new root, compaction, closed context or uncertain history. Commit a one-use durable
attempt before destructive provider I/O. A replacement session must establish its
own generation; it cannot inherit the old generation identity or manufacture
failed-root proof from saved fields. A private exact-resume opening policy refuses
missing history or recoverable resume errors before a native blank-thread fallback;
ordinary manual session opening retains its existing fallback policy. Received
but unprocessed native lifecycle envelopes veto new-owner admission as well as
old-owner retirement, even while projected state still appears idle.
Acceptance and subsequent failure-chain
association must bind that replacement explicitly to the original winning intent.
Public attempt/receipt activities carry a domain-separated SHA-256 conversation
commitment, not the private native conversation identifier or resume cursor.
Running and failed-before-started adoption both reauthenticate the immutable
intent/attempt/receipt and later controls inside the engine's serial worker. Exact
observed replacement policy fields replace old-generation materialization proof;
absence stays unknown and an observed null stays known omission. Delayed inventory
heartbeats and old retirement bridges cannot overwrite or remove a new generation.

Stop, newer input, account/configuration changes, archive/delete and uncertain
ownership retain priority before retirement, reopening and paid submission. An
unknown submission acknowledgment is parked for reconciliation, never resent.
The existing capped jittered backoff and accepted-chain bookkeeping remain;
changing generations does not reset repeated failure delays into a retry storm.

Native retry warnings are not definitive failures. Permanent authentication,
quota/billing, policy, invalid history and unknown errors do not acquire automatic
retry authority. Existing failed-root observation may still display children until
the guarded retirement actually succeeds. An old daemon lacking the new guarded
capability must refuse this path instead of silently using retained-session retry.
The fixed unsupported-owner notice ends the recovery countdown without pretending
that a provider request was submitted or that the running app adopted new code.

## Security and operational consequences

This is new, explicitly authorized session-retirement authority within one exact
failed recovery, not a general watchdog, silence timeout or force restart. It
cannot authorize killing an unverified/new owner, switching accounts, probing
credentials, discarding history or changing permissions. Session reopening may
incur setup delay and cannot repair persistent provider-side history errors or
model capacity. Real external side effects remain the provider's responsibility;
the short continuation is a new inference request, not an exactly-once action proof.

Tests use isolated synthetic protocol peers and SQL. They must prove retirement,
history/policy preservation, new-generation admission, no-start/terminal-before-ACK
truth, repeated-failure backoff and stale-owner/control/uncertainty negatives.
Default tests do not stop real sessions or access accounts/profiles. All required
repository checks and the final forced desktop build precede normal approved dev
publication. Local fixtures or a build do not prove adoption by running user sessions.

## Preserved decisions

The predecessor's classifiers, durable authority, at-most-once attempts, Stop
ordering, exact owner observations and history/presentation invariants remain in
force. [Verified runtime-loss recovery](verified-runtime-recovery.md) remains a
separate path. [Invalid-history recovery](codex-invalid-history-recovery.md) remains
explicit and never becomes an unattended cold restart or transcript repair.
