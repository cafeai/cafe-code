# Decision: preserve Codex children and recover definitive transient root failures

Decision status: Accepted within the current user-authorized repair
Implementation status: Implemented; normal rebuilt-runtime adoption required
Verification status: Combined source/renderer qualification passed locally; forced build remains the final release gate; no live provider qualification
Created: 2026-10-10 21:31:04 JST (UTC+0900)
Last updated: 2026-10-11 02:38:08 JST (UTC+0900)
Decision authority: the user's request for persistent backed-off recovery until
explicit Stop, correct surviving-child presentation, and compact Stop/restart UI.
Partially supersedes: the failed-root availability assumption in
[runtime-bound observation](subagent-runtime-observation.md), not its exact
generation or conservative unknown/closed-runtime rules.
Supplements: [verified runtime recovery](verified-runtime-recovery.md) with a
distinct definitive-transient-root path; its Stop and at-most-once rules remain.

## Context

A native root response can fail while the same app-server context and its children
continue running. Cafe previously projected the root failure as an unavailable
session, hiding those children. Atrium could also age or dismiss the failed parent
before considering its live workers. Provider retry warnings are not final
failures, and a final root failure is not proof of native process death.

The [official app-server protocol](https://learn.chatgpt.com/docs/app-server)
provides start, steer and interrupt, not a command to retry a failed turn in place.
Persistent recovery therefore needs a new short continuation in the same native
conversation after the native retry loop definitively fails. It must not resend
the original prompt, attachments or tool commands. This is a new inference turn;
it cannot guarantee that a model will never choose to repeat an action.

## Decision

Keeping every failed parent unavailable was rejected because it hides independently
live children. Blindly replaying the original request or replacing the process was
rejected because acceptance and side effects may be uncertain. Changing native
retry configuration alone was rejected because it does not reconcile Cafe's root,
child and session lifecycles. The chosen path separates those lifetimes and starts
only a freshly authorized continuation after definitive transient failure.

Separate root outcome from native context availability. The native owner may
report availability only for the newest definitively failed root in its current
conversation/generation, with a running primary process, no pending root start,
compaction, protocol termination or uncertain history. Fresh private inventory
repeats that proof; persisted fields alone are not authority.

Ingestion first commits the normal error transition, closing the root as failed.
Only then does an exact generation/account/turn/timestamp compare-and-set publish
ready context state while retaining the root error. Directly publishing ready in
the terminal transition would incorrectly complete the failed root. An exact
replayed partial fanout may finish this second phase without reopening the root.
Missing legacy proof, a stopped/closed context, newer input or a changed owner
retains the conservative unavailable state. Permanent root failures may preserve
child visibility but do not authorize automatic continuation.
Ready-state replay does not rewrite the session tuple or clear concurrently
admitted input. Delayed root diagnostics cannot invalidate the indexed terminal
outcome. Diagnostic and exact server recovery bookkeeping do not extend terminal
root execution time; schema-valid child lifecycle events preserve their own
timestamps without extending an already failed parent's clock. Genuine root
late-tool activity and completed-parent history retain their existing behavior.
Qualified terminal child errors retain failed status and bounded error detail in
the child task, without a duplicate unscoped warning that would re-date its parent.
Missing child identity retains the diagnostic fallback, not guessed child scope.

Automatic continuation requires an allowlisted definitive transient category:
transport, server failure or temporary rate limiting. Bounded structured errors
are preferred; the provider's exact generic processing-error form with a valid
request UUID is separately recognized. Arbitrary prose, inherited/accessor fields,
auth, billing/quota, policy, history and unknown errors do not gain retry authority.
Provider-native retry warnings remain native-owned; Cafe never nests another
submission inside that loop or changes native retry configuration.

Codex 0.162.1 remote compaction retains the underlying `other` error variant and
uses one exact `Error running remote compact task: ` wrapper after its finite
native retry budget. Recognize only that anchored wrapper around the same
UUID-bearing processing-error form, not arbitrary prefix stripping. This fixes
a classifier omission under the accepted decision, not a new retry category or
permission to bypass pending/uncertain compaction. Definitive native completion
clears tracked automatic-compaction items; manual reservations remain separate.

The server-authored durable marker binds the failed turn, account, exact runtime
generation and session timestamp. Its hashed command is a server decision minted
after fresh private proof, not provider-authored authority. A schema-only
append-time sidecar indexes both failure markers and continuation intents and joins
the retry chain to immutable attempt ownership and accepted receipts, without
backfilling history or scanning full transcripts. Unknown acceptance parks the
chain for reconciliation; it is not a fresh retry grant. A matching acknowledgment
can settle a terminal-before-ACK outcome without resurrecting a failed root.

A continuation can fail before any native started notification. While that exact
indexed transient request is pending, its unbound failure/diagnostic must not
discard the saved input. After a definitive acknowledgment, an internal atomic
association requires the immutable server intent/message, winning attempt nonce,
matching accepted receipt, fresh same-conversation owner proof, and serialized
control/lifecycle fences. It records the new turn directly as failed and consumes
only that input; it never invents a running transition or start timestamp. Already
observed execution timestamps remain unchanged. This association is not exposed
as client authority. Missing or contradictory acceptance remains uncertain, not
permission to associate a different turn or resend the request.

Each definitively accepted continuation that fails transiently may schedule the
next one. There is no attempt cutoff. Exponential delays have bounded 75–100% jitter
and a 60-second cap; bookkeeping saturates rather than overflowing. Waits run
outside the shared serial worker. Successful acceptance alone does not reset the
failure chain, preventing fast repeated failures from producing a retry storm.
The [OpenAI rate-limit guidance](https://developers.openai.com/api/docs/guides/rate-limits)
supports backoff and jitter; it does not guarantee available capacity.

Before paid I/O, recheck durable Stop/newer-input/archive/delete/configuration
barriers, exact native failed-root proof and a one-use immutable owner claim.
Never steer another active root, replace a missing runtime to continue this path,
or replay an ambiguous submission. Stop cancels queued recovery; a terminal-root
Stop closes the owned session so surviving children are actually stopped. An
intentional new user turn supersedes unattended recovery through normal admission.
This does not weaken approvals or native whole-tree idle admission for settings.

## Presentation and operational consequences

- Keep the root failed while exact-generation active children remain visible and
  ticking. Atrium age/dismissal cannot hide such children; terminal and unavailable
  histories retain their existing behavior.
- Lead the compact notice with Reconnecting or Agents running while retaining the
  root failure in its explanation and work log, not a stopped claim while workers
  continue. Stop remains usable even when the root itself is terminal;
  manual new-turn input remains available.
- Suppress only the matching current provider-error banner while exact account,
  generation, immutable completion time and pending automatic-recovery metadata
  agree. The error remains in history; cancellation, uncertainty, unavailable
  environments and unrelated manual failures retain notifications. Surviving
  children alone do not imply unattended recovery. Keep a compact ongoing footer
  with the historical root duration and the normal red Stop for an empty recovery
  composer. The Stop callback rechecks canonical state; a typed draft retains
  ordinary new-turn submission, not an invented running-turn queue.
- Show a countdown only from bounded received server timing metadata. Display
  markers describe work, never confer recovery permission.
- Separate native reconnect observations from Cafe continuation generations.
  Typed native warning envelopes increment a runtime-local deduplicated counter
  for the exact native target/turn; 1,024 observations becomes a lower bound, not
  a retry cutoff. Native timing is unknown, so never guess its next deadline.
  Cafe's durable continuation ordinal advances only after the preceding exact
  accepted receipt, independently of the capped delay exponent. Older saturated
  chains show a lower bound, and malformed optional count metadata is omitted.
  Preparation waits reuse the ordinal. Live countdowns use the actual recorded
  sleep deadline; saved work-log rows stay static. Snapshot and renderer retain
  one latest exact-current-turn/account/runtime/session-time display marker beyond
  the ordinary tail, including cancellation/uncertain/attempted dominance. This
  narrow projection index and display exception cannot grant retry authority.
- Keep private native conversation identities, resume cursors, prompts, provider
  error text and credentials out of new public operational payloads/diagnostics.
- Unknown ACK, genuinely missing ownership and permanent errors require
  reconciliation or deliberate user action. “Persistent” is not blind resend or
  permission to restart every provider error forever.
- Existing desktop/backend/daemon processes need normal rebuilt-code adoption.
  Synthetic verification does not repair or prove the user's live provider task,
  establish upstream capacity, or authorize an automatic restart.
- The shared protocol, persistence and renderer behavior is cross-platform; no
  platform-specific process, permission or credential policy is introduced.

## Verification

### Implementation ordering correction

The native thread-watch `systemError` and root-scoped `error` can precede the
definitive failed completion. They retain the tracked root identity until that
completion, rather than closing it early and invalidating its exact-time
availability transition. A later thread-watch diagnostic preserves readiness only
with fresh same-owner failed-root proof; it cannot create readiness. Native
unscoped watch diagnostics cannot consume newer pending input: preserve its
observed manual-starting or recovery-ready tuple without any lifecycle write,
using a fresh pending-input read after awaited inventory. This is not availability
publication and does not authorize continuation. A server-only no-pending guard
repeats that refusal in serialized command admission, covering recovery input
which commits after ingestion's read without changing the lifecycle tuple.
The guard is neither a client command field nor persisted event data.
Native closure, pending root admission/compaction and sticky history uncertainty veto
availability. The existing strict public terminal-time fence remains unchanged,
and fresh native proof must attest that same definitive time. Old failed/null
tuples are not repaired through timestamp relaxation or retrospective backfill.

Synthetic regressions exercise both event orders, diagnostic-before-terminal
state, idempotent replay, permanent errors, missing/foreign proof, Stop, newer
input/root and awaited-observation races. This is an implementation correction
under the accepted decision, not expanded retry or historical-repair authority.

### Qualification

Use the repository-pinned Node/Corepack Yarn toolchain. Qualify native terminal
and pre-I/O guards, structured error admission, terminal-before-ACK, Stop/new-input,
competing ownership, unknown acceptance, chain backoff and partial-fanout replay
with isolated synthetic peers/SQL only. Browser fixtures cover both themes,
compact active-child/recovery presentation and real Stop dispatch. Legacy error,
closed and replacement-generation negatives remain mandatory.

The real SQL-backed worker regression advances 36 consecutively accepted/failed
continuations, beyond the persisted exponent's saturation at 30, and explicitly
stops the next wait. It asserts no original input/attachment replay, runtime
replacement or steer, no changed original terminal time, and no later submission
after Stop. The counter cap is a delay bound, never a fixed retry cutoff.

The no-start association fixtures must drain native failure events before the
acknowledgment, then qualify exact receipt/nonce/message association and the next
failure-chain retry. Refuse foreign accounts, actors, receipts, messages, missing
pending bindings, Stop and newer input; preserve actual start/completion timestamps
and idempotent replay. These checks use synthetic protocol/inventory/SQL only.

Run `yarn fmt`, `yarn fmt:check`, `yarn lint`, `yarn typecheck`, `yarn test`, full
browser tests, then `yarn build:desktop --force` LAST on unchanged source. Live
provider interruption, paid retry probes and profile mutation are not part of
default verification. Record exact build/push evidence before marking the release
complete.

Earlier local qualification used Node 24.21.0 and Corepack Yarn 4.17.1: formatting/check,
lint and typecheck passed; all ten uncached default test tasks passed with 7,700
ordinary passing tests and the existing expected failure/skips unchanged. All
1,406 browser tests passed with the original two-worker bound and deadlines.
Independent frozen-source recovery qualification passed 601 tests, including the
real ingestion/engine/SQL association and ownership/cancellation boundaries.
Those earlier passes are not proof of the expanded source. Combined qualification
at `2026-10-11 02:38:08 JST (UTC+0900)` passes formatting/check, lint and all ten
uncached typecheck tasks; default tests pass 7,875 ordinary tests with the existing
expected failure/eight skips unchanged, and all 1,408 browser tests in 95 files
pass. Independent final notification/footer/Stop review closes exact-owner,
cancellation, uncertainty, current live-work and manual draft boundaries. See
[the provider compatibility report](../provider-updates-2026-10-11.md) for commands
and qualification scope. The forced build follows final documentation formatting;
record its exact source and outcome with the release checkpoint.

The full browser run exposed an existing tooltip fixture that hovered during its
dialog's opening transform. Its narrow test-only correction waits for actual
dialog animations before the same real hover, retaining every original assertion
and deadline; production tooltip behavior is unchanged. Preserve the original
failure and screenshot evidence. The forced desktop build remains the final
release gate after these checks, never evidence of a live provider repair or
native Windows/Linux execution on this macOS host.
