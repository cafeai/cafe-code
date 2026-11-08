# Decision: separate zero-paid Codex recovery preparation from paid submission

Decision status: Accepted within the user's explicit capacity-retry and cancellation repair request
Implementation status: Implemented in source; rebuilt-runtime adoption remains separate
Verification status: Exact-source qualification is recorded separately; focused results do not replace the required complete gate
Verification scope: Synthetic adapter, authenticated transport, service, reactor and browser fixtures; no live-provider or running-runtime adoption proof
Created: 2026-10-28 18:57:01 JST (UTC+0900)
Last updated: 2026-10-28 22:18:40 JST (UTC+0900)
Decision authority: the user requests repairing capacity recovery which remains
visibly connecting, continuing qualified transient retries until Stop, and making
that recovery cancellable before an approved dev push.
Partially supersedes: [failed-root session restart](codex-failed-root-session-restart.md)
and [proven unsubmitted retry](codex-failed-root-unsubmitted-retry.md), only the
single-call preparation/submission budget and the latter's send-time refusal
handoff for a producer advertising the new phased capability. Exact-history
resume, immutable claims, strict classifiers and unknown-ACK restrictions remain.

## Context and evidence boundary

The previous reactor applies a thirty-second submission timeout to an operation
which also retires the failed native owner, prepares its private resources and
opens a replacement. Native startup separately has a sixty-second allowance;
several preparatory acquisitions precede that inner allowance. A legal opening
can therefore outlive its caller's submission budget before any paid input is
sent. A remote timeout does not cancel a daemon command or establish that no
paid input was accepted. Retrying that combined operation would be unsafe.

The reported screenshot and bounded content-free debug observation show the
visible connecting state, failed root and continuing child work. They do not
identify the historical native opening phase or prove that a particular timeout
caused it. The repair addresses the demonstrated source budget and ownership
gap; new bounded phase observations help distinguish future cases.

Increasing the paid deadline, inferring an idle owner from a spinner, parsing
provider prose, or blindly repeating a timed-out command cannot provide the
missing submission proof. An ordinary manual start also has broader history
fallback behavior than an automatic exact-history continuation may use.

## Private protocol and authority

The authenticated provider boundary exposes four operations for this path:

1. `prepareFailedRootRecovery` admits a complete canonical request, returns
   promptly and owns an asynchronous zero-paid preparation worker.
2. `readFailedRootRecovery` observes the exact existing private reservation. It
   cannot open a session, advance a sequence or reconstruct a consumed permit.
3. `sendTurn` consumes the prepared one-use capability before its first await,
   then submits the exact owned wire copy to the exact prepared native owner.
4. `cancelFailedRootRecovery` revokes only the exact private attempt and joins
   its work. It cannot stop a newer unrelated manual owner.

Admission requires the exact selected Codex account, the complete expected
failed-root/time/history/generation tuple, a qualified original transient failure,
the `codexPhasedFailedRootRecovery` capability and all required methods. Legacy or
partially upgraded peers refuse before retirement instead of falling back to the
old combined operation. Public session schemas do not carry these capabilities.

The existing immutable durable paid claim is consumed once. Preparation retries
retain that claim and advance a separate monotonically increasing safe-integer
private sequence. A request commitment covers the whole schema-canonical send
request, original history and account/root fields, and attempt identity under a
dedicated domain. Tokens use 256 random bits, exact finite lowercase-hex parsing
and constant-time comparison after shape validation. A prepared permit is bound
to the exact replacement generation and opening policy. A caller mutation after
admission cannot change the owned request copy across catalogue, private-home or
other awaited work.

Only the trusted backend and authenticated daemon retain the new request digest
in memory. It is not added to public activities, debug output or durable records.
The daemon ledger separately authenticates the complete wire request and daemon
owner with a process-ephemeral HMAC key. Private calls use opaque UUID command
identities, fixed opaque errors, no automatic transport replay, and redacted
ledger receipts. Neither prepare results nor paid acknowledgments are persisted:
an arbitrary provider resume cursor could otherwise retain a secret. A duplicate
paid command is outcome-unknown and never executes again. Key loss or daemon
restart cannot mint replacement authority from an old digest or receipt.

## One lease for preparation, one budget for paid acknowledgment

Phased preparation has one absolute sixty-second lease covering old-owner
retirement, resource acquisition, native startup and publication. Ordinary manual
starts retain their existing startup timeout. Preparation does not get another
relative startup timer which could replace the lease's trusted expiry witness.
After successful preparation the original thirty-second paid-ACK timeout applies
only to paid submission; a lost ACK consumes authority permanently for that
attempt and requires observation/reconciliation, not resend.

Every acquisition has exact scoped cleanup. Runtime construction uses an atomic
acquire/release registration, so a late uninterruptible constructor cannot return
a native runtime into an interruption gap before close ownership is recorded.
Lease/control fences repeat after awaits and immediately before native owner
publication. Retirement revokes authority synchronously; cleanup may still take
time. No timeout claims that an uninterruptible acquisition was preempted.

The preparation record has finite per-chat storage and a process cap of 256
entries. A bounded scan during admission may forget a consumed or retired
tombstone only after the original native owner irreversibly closed, its entire
adapter scope successfully joined and no operation remains pending. It never
evicts a prepared/retryable capability or an uncertain owner. Pruning does not
close an ordinary live replacement; old permits become unavailable and the old
failed-root generation cannot authenticate a fresh preparation. Remaining
exhaustion refuses admission. This state is private and process-local, rather
than a new durable retry journal.

Private preparation workers and their lease timers each publish one actual-exit
completion before admission can await. Their stable completion observers never
unregister while delivery is in progress, and store the actual Exit as a success
value. Controls signal the exact fibers and join those shared completions; the
timer only signals the worker, avoiding a mutual join. New preparation authority
remains unavailable until both the worker has actually exited and that exact
worker/timer launch pair has finished installation. Each prepare response captures
its own sequence result before exposing the next sequence, so an older caller
cannot return a newer caller's capability. Paid completion is kept independent
from cancellation cleanup; a late cancellation cannot restore a stale pending
bit after paid acknowledgment handling has finished.

## What permits another preparation

A retryable result is a new zero-paid witness, never a generic error flag. It
includes a one-use continuation for exactly the next preparation sequence only
after owned cleanup has joined. There are three finite producers:

- A typed exact native refusal before retirement reserved anything. It preserves
  the original owner and children, and may retain that original already-qualified
  transient category. No later phase may borrow this old refusal.
- A newly observed native opening failure which the existing strict transient
  classifier accepts. Permanent/authentication/policy contradictions and unknown
  or malformed metadata refuse. A transport wrapper cannot erase a recognized
  nested permanent native rejection.
- Expiry of this exact owned lease in a by-construction zero-paid operation,
  followed by joined owned cleanup and an interrupts-only outcome. The private
  reason is `startup-timeout`; matching remote prose or a generic timeout tag is
  not that witness.

Native retirement and adapter cleanup have separate proof. Even after native
close succeeds, failure while joining management bindings or the old scope keeps
the attempt uncertain. Exact scope closure is still attempted after earlier
retirement failure, retaining the original and cleanup failures together; a
successful scope close alone cannot manufacture successful native exit.

The entire failure cause must qualify. A transient first error combined with a
cleanup defect, another failure or an interruption does not prove cleanup and
cannot issue a continuation. Private opening also records successful closure of
its owned scope independently: the pinned runtime can replace a startup failure
with a typed cleanup failure, so even one transient-looking final error is not
proof that cleanup succeeded. Pending uninterruptible cleanup and such composite
outcomes remain uncertain with exclusive ownership retained. A permanent
contradictory native outcome wins over an apparent retry signal.

Read/prepare/send/cancel transitions consume private authority before awaiting.
Same-sequence concurrent preparation coalesces to its existing reservation;
continuation replay, a foreign request/account/history/attempt, or a future
sequence cannot start another worker. Backoff remains capped and jittered outside
the shared orchestration worker, without an attempt-count cutoff for qualified
transient preparation failures. Unknown prepare ACKs use read-only lookup of the
existing attempt. Missing state stays unknown; it is never permission to prepare
or submit a replacement operation.

## Controls, native notifications and cancellation

The reactor repeats durable Stop, new-input, account/configuration, archive/delete
and original failed-root checks before each private operation and paid admission.
The adapter repeats its current context and synchronous control-epoch guards after
its last admission await, including when no reservation existed at Stop time.
The final native paid guard authenticates the exact prepared replacement and
repeats availability/history checks plus the synchronous received-notification
fence. A root, compaction or history envelope already received but not projected
vetoes admission while projected state might still look idle.

Automatic cleanup uses the exact private cancel CAS. It revokes prepared permits
and continuation authority before joining the worker, fences late acquisition,
and closes only its captured unchanged idle prepared context. It does not call a
generic thread Stop which could kill newer work. Once paid submission has begun,
that private cleanup cannot assume the new native root belongs to it.

Private preparation and its capped polling run in an exact-intent scoped
coordinator outside the shared serial worker. Its one-use prepared handoff is
private, queued once, and rechecks the durable intent and current native owner
on the worker immediately before paid admission. Stop and new input synchronously
revoke that coordinator. A per-thread cleanup barrier retains their order until
the exact preparation and paid child close, while unrelated chats remain free
to use the worker. A queued stale handoff cannot send.

The paid child installs one stable observer of its actual Exit before scope
shutdown can add another observer. The worker and coordinator await a shared
success-valued completion; the subscriber only signals the exact owned children.
A synthetic pinned-runtime control exposed a lost wakeup when `Fiber.join` and
`Fiber.interrupt` observed the same exiting child together. Held-finalizer and
shutdown regressions check actual cleanup ordering rather than treating an
interruption or an accepted Stop as proof of native closure.

If the prepared attestation no longer matches fresh native inventory, the reactor
reports uncertainty and revokes only the exact private reservation. It does not
submit or reuse the permit and cannot stop a replacement owner. Concurrent durable
controls retain their separate retirement path.

The visible Cancel start action instead invokes an explicit human whole-chat
`thread.session.stop`. It is an ordered human control, not a native-generation
CAS or automatic retry witness. The UI rechecks the current canonical thread and
observed recovery state at click time, shares a per-thread in-flight Stop fence,
and keeps cancellation available when a draft Send remains usable. The service
must reach the adapter even in the gap where no native session is listed but
private preparation still owns resources. Hard deletion revokes that owner too.

## Observational diagnostics and qualification

The server projects only fixed `codex-transient-preparation` phases
`preparing`, `uncertain`, `retryable` and `retired`, bounded wait counters, safe
intent/source/preparation sequences and the original failed-turn association.
The latest terminal marker supersedes a prior pending marker. These activities
contain no private token, digest, native identifier, account address, prompt,
payload or raw cause. They explain waiting and make human Stop discoverable;
they do not grant native retirement or resend authority. They cannot establish
the cause of an older event which was not observed.

Synthetic qualification covers legal opening beyond thirty seconds without paid
input, a held native opening at the absolute lease boundary, late uninterruptible
home/runtime acquisitions, exact Stop and newer-owner races, whole-cause cleanup
negatives, strict permanent/transient classification, exact owned paid bytes,
malformed/foreign/replayed permits, transport privacy and lost ACK behavior.
Service tests cover Stop/delete with private preparation but no listed runtime;
reactor tests retain actual durable SQL controls and immutable-claim assertions.
Browser tests use original native input and deadlines. No test may replace an
unknown result with a retry grant or weaken workers, deadlines, history, ownership,
privacy or sandbox checks. Required repository verification and the final forced
desktop build remain necessary before approved publication. A source push cannot
retroactively change an already running daemon's capability or prove live adoption.
