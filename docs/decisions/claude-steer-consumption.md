# Decision: bind Claude steer presentation to exact native consumption

Decision status: Accepted within the reported stuck-steering repair
Implementation status: Implemented in source; rebuilt runtime adoption pending
Verification status: Synthetic SDK, durable-retention and native browser regressions protect this contract; hosted build and runtime adoption are separately qualified
Created: 2026-11-08 06:06:19 JST (UTC+0900)
Last updated: 2026-11-08 07:30:42 JST (UTC+0900)
Decision authority: The user's request to repair a Claude message left in the
steering shelf while completing the CI repair.

## Context

Cafe can queue another user input into Claude's existing interactive query while
that query is thinking, executing tools or retaining background tasks. Queue
admission is not evidence that the native provider consumed the input. The
adapter already tracks locally minted prompt UUIDs, but previously kept native
consumption observations private. The renderer recognized explicit processing
receipts only for Codex. Its Claude fallback used a later assistant timestamp or
turn completion; that can leave an answered input spinning, or falsely retire a
different input when unrelated output arrives.

A fresh compact Debug observation showed one steering item, an empty unsent
queue and a connected renderer. This confirms presentation state, not whether
that specific message was consumed. Neither screenshot prose nor that count can
mint an acknowledgement.

## Decision and ownership

Project a content-free, message-specific processing receipt from the existing
normalized runtime event stream. Reuse `task.progress` with a reserved Claude
processing identity and explicit account/runtime/message/attempt metadata; do
not add duplicate assistant text or a fabricated user-message echo. The native
UUID is represented by an opaque digest rather than used as UI authority.

Only a locally admitted live steer can be correlated. Bind its receipt to the
exact query, independently initialized primary native session, runtime, current
turn object and admitted message. Native primary started/completed lifecycle or
explicit typed reply/result correlation may witness consumption. Queue ACKs,
queued/cancelled/discarded states, unknown UUIDs, child/task-scoped or foreign frames,
uncorrelated result-count fallbacks and provider prose cannot supply it. Recheck
owners around awaits, retire synchronously before asynchronous cleanup, consume
a receipt at most once and bound its live bookkeeping. Reserve no permanent
publication latch before diagnostic awaits or ignored mixed-schema metadata;
the final exact lease recheck and synchronous publication perform the one-shot
consumption. A native cancellation or discard revokes its exact lease before
a late completion can claim it. The existing finite native-correlation window
limits presentation leases; overflow never rejects, drops or replays an input
and never invents a receipt. Session replacement,
conversation reset, cancellation and turn retirement must not leave transferable
receipt authority. Retained fork/history mappings are not fresh admission proof.

The durable Cafe event sequence identifies each delivery attempt when a saved
message ID is reused. Its optional provider-input field admits only safe
nonnegative integers; the reactor supplies the actual committed event sequence.
It is correlation metadata, never native policy or permission to execute, retry
or redirect a request. Missing legacy observations remain unknown instead of
inventing an attempt number.

The renderer matches exact message and attempt plus account/runtime/turn owner.
An explicit Claude consumption receipt can retire only its matching steering
row while ordinary work continues. Assistant output and root completion do not
stand in for native consumption. Failure/recovery retain their existing
separate paths. Receipt display must not create a phantom provider task or
subagent, complete a turn, cancel callbacks, replay a prompt or change approval,
computer-use, model, quota or provider settings.

## Retention and verification boundary

Consumption must remain identifiable for the pending attempt across ordinary
view changes and event delivery ordering. Final verification must cover the
actual retention/rehydration path; a live-event-only assertion cannot establish
reconnect or background-view correctness. Ambient lifecycle retention already
provides a bounded indexed snapshot and renderer tail exception for these
identities; no separate steer ledger or unbounded message scan is introduced.
An already-durable receipt remains usable when the same runtime subsequently
completes or advances its active turn, while its captured input turn still has
to match. Unknown old observations must never be silently relabelled as
processed. A discarded/cancelled input is not consumption; existing native
warnings, explicit failure and manual Stop/recovery paths keep their policies.
This change introduces no automatic retry for an uncertain discarded input.

Extend the existing native lifecycle/merged-result adapter tests and existing
composer processing owner. Keep exact current-message positives, sibling/stale
attempt/foreign owner/uncorrelated negatives, one-shot emission and unchanged
running/background state. A codec test protects the optional generation field,
and the existing durable reactor boundary checks the actual forwarded sequence.
Preserve native input, fixture ownership, workers, deadlines and all security
checks. Record failing-before and passing-after proof honestly; local targeted
checks do not substitute for the exact hosted Windows CI gate.

Source publication and rebuilt bundle delivery do not prove adoption by the
currently running Debug process. No restart is authorized for this task, and
already-lost native confirmations cannot be reconstructed from chat prose.

## Provider reference

The [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
documents the singular and plural submitted-message UUID echoes, their absence
on child frames and the finite merged-input list. The version-pinned SDK and
Cafe's existing command-lifecycle handling supply the matching native boundary;
provider prose and queue counts supply no equivalent correlation.
