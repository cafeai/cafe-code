# Decision: preserve finite session-reconfiguration refusals across the daemon

Decision status: Accepted as the narrow repair within the user's explicit same-account send request
Implementation status: Implemented
Verification status: Isolated transport/lifecycle fixture scope below; unchanged-source repository gates are required for publication, with live adoption and hosted checks separate
Created: 2026-10-15 00:14:51 JST (UTC+0900)
Last updated: 2026-10-15 00:51:10 JST (UTC+0900)
Supplements: [compaction adoption](codex-compaction-request-adoption.md) and
[unchanged-runtime policy continuation](existing-runtime-subagent-policy-continuation.md)

## Context and demonstrated defect

A same-account send can attempt a cold opening to apply pending context or
subagent configuration. Native admission may safely refuse replacement while
work or received events remain active/uncertain. The reactor already permits
only a pure policy-change refusal to retain the unchanged existing owner and
deliver the new explicit input with its current policy; unrelated restart
requirements still fail closed.

The daemon serialized that refusal as the generic ProviderAdapterRequestError
class, dropping its finite semantic code. The remote service reconstructed only
the generic class tag, so the existing reactor exception could not recognize the
same refusal that direct in-process fixtures handled. Operational evidence
shows rejected session openings, not provider capacity or a failed paid turn.
It does not distinguish the original guard's internal subbranch or prove that
every concurrent restart reason was absent.

## Decision and alternatives

Add optional `sessionReconfigurationRefusal` to the existing authenticated error
envelope. Its closed vocabulary contains only `subagent-concurrency-active` and
`codex-context-window-active`. The daemon publishes it only from an actual Codex
ProviderAdapterRequestError for `session/reconfigure`, with an own data-field
code matching that vocabulary. Never infer it from prose, arbitrary native
payloads, another error class/adapter, getters or inherited metadata.

The client retains the outer class for diagnostics and reconstructs the existing
semantic remoteErrorTag only for `startSession`, the exact outer error class and
a valid finite witness. Every other method, unknown/malformed code and legacy
omission preserves the previous generic failure behavior. The existing reactor
retained-policy fallback and all its eligibility restrictions remain unchanged.

Preserve the finite code in bounded command-ledger and recent RPC failure diagnostics, including exact
saved failure receipt replay. Diagnostics are not mutation authority. Do not
add an unguarded mutating transport entrypoint merely to facilitate tests.

Bind every session-start receipt to its complete schema-canonical request in
both directions. A reused command ID cannot lend a failure witness or opening
ACK to a different thread, account, policy or method. Missing/corrupt legacy
request identity is unavailable, not permission to replay a cached result or
execute again. Exact same-request retry still returns one retained outcome.

Parsing the human error message could falsely grant fallback to unrelated
failures. Forwarding arbitrary remote tags would broaden authority and disclose
unneeded provider data. Weakening native idle checks, stopping live work or
automatically replaying input would violate the existing ownership contract.

## Security, compatibility and operations

No new paid submission, retry, cold-opening, permission, process replacement or
session mutation capability is introduced. Existing authenticated transport,
native root/child/ingress checks, account/generation binding and mixed-change
refusals remain intact. A refused policy replacement does not claim application
of the saved value; it stays pending. A later actual idle opening is separate.

The optional field is additive. Old owners omit it; old clients ignore it and
retain their old behavior. Both repaired peers must be adopted normally for
the transport repair. A dev push or renderer reload does not update an adopted
running daemon, and this repair does not restart the user's active chats.

Full operational debug may show the finite field in existing recent failed
command rows. It contains no prompt, output, credential, cursor or filesystem
identity. Do not use missing/truncated historical logs as cause evidence.

## Qualification

Codec tests cover exact current/legacy envelopes and command diagnostics.
An isolated daemon and the real guarded remote start service exercise both
refusal codes and wrong adapter/method/class, absent/unknown/accessor metadata
negatives using in-memory state and synthetic provider implementations only.
Its scoped native facade forwards authenticated control bytes to the real daemon
and terminates only the unrelated event subscription with a finite refusal;
this command qualification does not qualify perpetual stream cancellation.
Reactor regressions use the real remote reconstruction API and preserve exact
Deferred acceptance, one send, unchanged owner/policy, zero retirement and later
idle application. Mixed model replacement and misleading prose remain refusals.
The ledger retains exact failure receipts without replaying their execution.
Changed request coordinates, method collisions and missing legacy identity have
explicit negative controls for both refused and successful opening receipts.

Run the pinned complete repository/browser/copied-bridge gates and forced
desktop build LAST. Local macOS synthetic results are not real provider/user
adoption, physical native idleness, foreign-platform or hosted qualification.
All predecessor decisions and their historical evidence remain intact.
