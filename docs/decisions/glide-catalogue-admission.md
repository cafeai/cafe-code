# Separate Glide catalogue admission from desktop execution

Decision status: Accepted implementation choice within the user's bug-fix authorization
Implementation status: Implemented
Verification status: Regression baseline reproduced; focused owner checks passed; repository and hosted qualification pending
Created: 2026-11-06 12:43:31 JST (UTC+0900)
Last updated: 2026-11-06 13:12:49 JST (UTC+0900)

## Context

Glide attaches an inert, per-provider-session MCP catalogue before desktop
permission is enabled. This lets the user click Computer use later without
restarting that provider. Its original shared limit counted retained catalogues
and pending file publications together. Thirty-two idle sessions therefore
refused the next ordinary chat before the provider started, even while desktop
control was off. A synthetic owner fixture reproduces that exact admission
failure using real private capability files and no live provider or native input.

The reported chat retained four fixed Glide attachment failures. Current native
observations found thirty-two distinct live Glide capability-file groups. That
is current corroboration, not a historical snapshot of the broker map at the
failure instant. Generic attachment diagnostics did not retain its inner cause.

## Decision

Keep automatic inert catalogue registration and explicit, per-chat desktop opt-in.
Do not omit tools from a disabled chat or infer permission from catalogue presence.
Do not evict another provider owner to admit a new chat.

Bound catalogue resources separately: at most 128 retained allocations, 128 MiB
of actual copied bridge and serialized connection bytes, and 32 simultaneous
publications. Publication ownership is reserved synchronously before the trusted
bridge read; byte/count charges are reserved before the private directory is
allocated. Charges survive uncertain cleanup and release only after exact owned
file and directory removal. Reserved token replacement cannot exceed its charged
connection extent. Existing unreserved management-MCP rotation retains its path.
Token renewals are admitted in order before asynchronous writes. Removal fences
new renewals and joins every admitted native write before retiring files, so a
late replacement cannot recreate an uncharged directory. Trusted bundled bridge
reads retain Electron ASAR and root-owned installation semantics while rejecting
a known oversized source before allocation and checking the resulting payload.

The retained count is an explicit increase selected for this fix. It is not a
claim that more relay processes consume no memory: providers launch persistent
stdio relays and subagents may create additional clients. The copied-file budget
retains the former worst-case allowance of thirty-two four-MiB bridge payloads;
it is not an aggregate process/RAM guarantee. Keep all four execution kernels,
their heap bounds, native queues, preview-owner limits, sandboxing, permission
checks and cancellation deadlines unchanged.

When capacity still refuses, retain a finite local capacity category. Failed-start
activities may publish only a closed display category for attach, activation or
capacity failure. The renderer chooses fixed translated wording from that
category, never received error prose, paths, stacks or credentials. Exact
unstarted-message ownership and old-turn guards still apply. This presentation
does not change retry, submission or permission authority; unknown and legacy
categories retain generic public wording.

## Alternatives

Skipping disabled catalogues at saturation would let ordinary startup continue,
but removes later enablement from that provider's fixed MCP configuration.
Blindly increasing the count without independent byte/publication accounting
would enlarge allocation bounds without measuring retained cost. Unbounded
catalogues and silent owner eviction are rejected. Shared native HTTP transport
could reduce stdio relay processes, but requires separate protocol, credential
transport and native-provider qualification and is outside this repair.

## Qualification

One runtime regression opens more than thirty-two inert sessions, verifies that
desktop execution is denied with zero kernels before the explicit button action,
and then enables the same catalogue through the normal control operation.
Independent budget tests protect byte/count bounds and idempotent release; native
private-file tests protect reservation timing, confirmed cleanup and growth
refusal. Existing grant, Stop all, owner-replacement and four-kernel tests remain.
Presentation tests protect finite guidance and arbitrary-error privacy. Local
repository checks, final forced build and the exact published CI qualify the
result; source changes alone do not repair or restart an already-running owner.

The focused qualification passed the complete Glide/session-file/management
connection owners, the existing local/daemon startup-failure matrix and the
complete session-display policy owner. The original thirty-two-catalogue guard
failed the new ordinary-chat admission regression before the repair. The native
file owner also holds an actual token write through racing removal and checks
that cleanup drains admitted renewals before releasing capacity. These results
are scoped owner evidence, not a whole local Node/browser-suite claim or live
provider adoption.
