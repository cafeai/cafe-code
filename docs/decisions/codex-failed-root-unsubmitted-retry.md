# Decision: retry a proven unsubmitted failed-root continuation

Decision status: Accepted within the user's explicit retry repair request
Implementation status: Implemented in source
Verification status: Exact-source qualification is recorded separately; no live-provider or running-runtime adoption claim
Created: 2026-10-19 12:16:05 JST (UTC+0900)
Last updated: 2026-10-28 20:21:41 JST (UTC+0900)
Decision authority: the user requests repairing failed-root recovery and continuing
with backed-off retries until explicitly stopped, without weakening submission safety.
Partially supersedes: [persistent transient recovery](codex-persistent-transient-recovery.md)
and [failed-root session restart](codex-failed-root-session-restart.md), only their
treatment of a consumed attempt whose exact new native result proves that neither
retirement nor submission began. Unknown acknowledgment remains reconciliation,
not permission to resend.
Partially superseded by: [phased failed-root recovery](codex-phased-failed-root-recovery.md)
for the send-time refusal handoff and combined preparation/submission budget
under the exact owner's phased capability. The successor retains immutable
paid claims and uses a separate private one-use preparation continuation only
after qualified zero-paid outcome and cleanup proof. Unknown paid acknowledgment
remains non-resendable. Its source implementation and separate exact-source
qualification do not replace the historical verification status below.

## Context and alternatives

A failed-root continuation consumes immutable authority before provider I/O. That
is necessary when a timeout, lost acknowledgment or interrupted transport leaves
acceptance unknown. However, the native retirement guard can also conclusively
refuse before closing the old session, opening a replacement or submitting input.
Treating that result as unknown permanently parks an otherwise retryable recovery.

Blindly wrapping `sendTurn` in retries would replay uncertain requests. Deleting
or reusing the first attempt would erase competing-worker and acceptance ownership.
Parsing an error message would let arbitrary provider prose claim zero submission.
Increasing deadlines or bypassing a busy native guard would not establish safety.
The chosen design preserves every old claim and requires an exact typed refusal
receipt before reserving a separate next attempt.

## Decision

### Native witness and typed transport

Only the guarded failed-root retirement operation may originate
`ProviderDaemonFailedRootRetirementRefusal`, defined in the
[daemon contract](../../packages/contracts/src/providerDaemon.ts). The finite
reason identifies a refused condition; it is not a generic retryable-error flag.

The [native boundary](../../apps/server/src/provider/Layers/CodexSessionRuntime.ts)
retains its existing lifecycle permit, awaited availability/history/compaction
observations, exact current account/runtime/root/history/time comparisons and
final synchronous received-notification fence. It reports refusal while the
attempt has not reserved retirement. A queued but unprocessed native lifecycle
notification still vetoes admission even if projected state appears idle.
Successful reservation instead owns completion of the old teardown before
returning success; a later teardown, reopening or paid-input failure cannot
borrow the earlier refusal classification.

The [adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) accepts only
the finite own-data native result and emits the typed field on its exact cold
`turn/start` refusal. Legacy booleans, malformed results, accessors, proxies,
inherited fields and arbitrary messages stay unknown. It does not attach this
field to failures after successful retirement.

The [daemon producer](../../apps/server/src/providerDaemon/ProviderDaemonServer.ts),
[command ledger](../../apps/server/src/providerDaemon/CommandLedger.ts) and
[remote consumer](../../apps/server/src/providerDaemon/RemoteProviderService.ts)
retain the field only for the exact admitted cold `sendTurn` request and its
typed Codex adapter error. Completed-command lookup must match both directions
of the canonical command/request identity, including the private native history
and expected failed-root tuple. An unrelated method, request, account, runtime or
generic remote tag cannot lend a refusal witness to another submission.

### Immutable authority and a distinct claim per retry

The [retry helper](../../apps/server/src/orchestration/codexFailedRootRetry.ts)
and [reactor](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts)
bind the recovery intent and source event, Cafe chat and failed turn, selected
account, exact native runtime generation and immutable session/completion time.
The exact schema-canonical provider request and native conversation have separate
domain-separated SHA-256 commitments. Neither a digest nor a diagnostic grants
authority by itself: server-authored durable records, exact request binding and
fresh lifecycle admission are also required. Public retry records do not copy
the native history identifier, prompt, attachments or provider error body.

The first winning `attemptOwnerId` remains unchanged. Existing accepted-chain
and replacement-generation association continue to use that stable owner. Each
individual provider call nevertheless requires its own immutable winning
`claimOwnerId` and command identity. A definite refusal appends a separate
`codex-transient-continuation-unsubmitted` receipt referencing the precise
consumed claim, owner, request commitment and recovery tuple. Only that receipt
permits reservation of one new claim, with a fresh claimant identity, before a
later call. The old claim and receipt are never erased, mutated or reused.

The later claim names its preceding refusal receipt. Concurrent or restarted
workers race through the existing idempotent command admission; only the stored
winning claimant proceeds. Before any provider I/O the reactor repeats current
durable controls and exact thread/session checks. The adapter/native path then
repeats its full private ownership, history and received-notification guards.
A refusal therefore permits another guarded attempt, not bypass of the condition
that refused it.

### Bounded durable reconstruction

Retry reconstruction must not scan a chat's event stream or recursively walk an
unbounded retry chain. The helper uses the existing `command_id` B-tree for exact
claims and the latest bounded refusal-prefix endpoint, followed by a fixed number
of exact identity lookups and one immediate predecessor check. Refusal command
identities order the referenced positive safe-integer claim sequence using its
fixed-width padded decimal representation. Ordering by that claim sequence,
rather than a receipt's append time, prevents a delayed older refusal from
overtaking a newer consumed claim.

The reader bounds individual payload decoding and rejects duplicate, malformed,
foreign, missing or contradictory evidence. It never falls back to an older
receipt when the latest endpoint is invalid. An already consumed next claim is
not another retry grant. These are bounded server-journal lookups, not native
history queries, transcript replay or authority backfill.

### Backoff, Stop and unknown outcomes

Definite unsubmitted refusals use the existing
[capped jittered recovery delay](../../apps/server/src/orchestration/providerRuntimeRecovery.ts).
Preparation bookkeeping saturates to keep arithmetic and delays bounded; it is
not an attempt limit. Repeated eligible refusals can continue until Stop or a
superseding control. Sleeps remain scoped and cancellable outside the shared
serial worker; the worker revalidates after a wait rather than sleeping while
blocking other commands. Accepted continuations retain the predecessor's
non-resetting failure-chain accounting.

Stop, newer user input, account/configuration changes, archive/delete and changed
or uncertain ownership retain priority. A terminal-root Stop closes its owned
session and surviving children through the existing lifecycle path. No retry
can invent a blank conversation, replay the original prompt or attachments,
steer a different active root, loosen permissions or extend native budgets.

Timeouts, interruption, lost/unknown acknowledgments, mixed causes and legacy or
untyped errors do not mint an unsubmitted receipt. Their consumed claim stays
consumed and requires reconciliation or deliberate user action. A successful ACK
remains acceptance, not running-state proof; terminal-before-ACK and failed-before-
started association retain their exact receipt/owner/control checks and original
timestamps. Persistence does not promise upstream capacity or exactly-once
external effects by the model.

## Diagnostics, compatibility and adoption

Compact debug may expose
`providerDaemon.lastHealth.rpc.latestFailedRootRetirementRefusal`: one finite
reason, the fixed `sendTurn` method, canonical failure time and finite duration.
The [debug projector](../../apps/desktop/src/debug/DesktopDebugServer.ts) inspects
only a bounded newest-received failure window, omits unknown/legacy/accessor/proxy
metadata and copies no native IDs, private paths, prompts or raw errors into the
new summary. This observation cannot authorize recovery, select a claimant or
retroactively explain an older failure that lacked the typed witness.

Existing consumed records without the new exact commitments and refusal receipt
remain consumed. Do not adopt old diagnostic prose, reinterpret a historical
generic error as zero submission, repair old ownership records in place or replay
them on upgrade. This additive contract needs rebuilt-code adoption in each
owning backend/daemon/native adapter. A build does not restart or repair a user's
running app, prove live provider recovery or authorize a provider/profile change.
The shared protocol and persistence logic retain existing native host policies.

## Implementation and verification

The source changes are implemented; qualification belongs to exact-source test
records. Decision acceptance and this description are not passing-test or delivery
evidence.

Required synthetic qualification covers native refusal before any destructive
boundary, queued-notification races after awaited checks, typed transport and
canonical request mismatch, unknown/legacy/post-retirement errors, competing
claimants, restart/replay reconstruction, delayed older receipts, bounded indexed
lookup, repeated refusals followed by acceptance, Stop and unchanged accepted-chain
association. The helper, native runtime, adapter, transport/ledger, reactor and
compact-debug tests own those boundaries without live providers or private profiles.

Use the repository-pinned Node/Corepack Yarn toolchain and preserve existing worker
limits and deadlines. The integrated change still requires formatting, lint,
typechecking, default and applicable browser/copied-bridge qualification followed
by the final `yarn build:desktop --force` on unchanged source. Record exact-source
results before upgrading verification status; no release, push or live adoption
is implied by this decision.

## Supersession and preserved decisions

This successor changes only the prior consumed-attempt handling for a newly
authenticated, definite pre-retirement/pre-submission refusal. Each attempt
remains one-use; unknown ACK remains non-resendable. The predecessors' definitive
transient classifiers, same-history cold reopening, launch-policy preservation,
native guards, Stop/control ordering, terminal-time truth, privacy and presentation
requirements remain in force. [Runtime-loss recovery](verified-runtime-recovery.md)
and [invalid-history recovery](codex-invalid-history-recovery.md) remain separate;
this decision grants neither transcript repair nor general watchdog restart.
