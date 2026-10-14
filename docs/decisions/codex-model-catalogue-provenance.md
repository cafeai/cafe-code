# Keep native Codex catalogues separate from fallback guesses

Decision status: Accepted
Created: 2026-10-15 05:53:19 JST (UTC+0900)
Last updated: 2026-10-15 07:58:16 JST (UTC+0900)
Decision authority: Current weekly provider-compatibility implementation request.
Implementation status: Source and synthetic fixtures; publication qualification is recorded in the current ignored plan.
Supersedes: None; supplements native discovery and advertised model settings.
Superseded by: None

## Context and decision

Static fallback does not prove current account availability. Generic union or
later static health replacement must not resurrect rows omitted by native model
discovery. Equality, model spelling, a refresh invocation and cached rows do not
establish native discovery or ordering.

Add optional finite `codexModelCatalogSource: "fallback" | "native"` to snapshots.
Trusted producers label their source; omission remains legacy unknown. Stamp
native only on admitted successful results, before equality comparison. Failed,
undefined, timed-out, cancelled or stale work stamps nothing. Preserve the Codex
model-only producer's existing empty-discovery-as-inconclusive policy. Where a
producer explicitly admits an empty native result, keep its exact empty array.

Native rows remain exact, not unioned with omitted fallback. Managed status and
registry projection retain native rows through fallback health only under the
exact in-memory owner and explicit authenticated type plus nonempty comparable
email. Missing type/email is not same-account proof. API/unknown authentication
keeps its existing discovery behavior without manufacturing that comparison.
Explicit custom and saved choices retain their own metadata. The changed static
fallback path keeps an explicitly configured retired row's original controls;
it never assigns that row another fallback model's capabilities. Native custom
supplementation retains its existing policy and is not a new entitlement proof.

Shared refresh ownership also requires cancellation-safe completion. Provider
operations remain explicitly interruptible in the original scope, while narrow
bookkeeping captures their Exit, retires the exact flight and then settles every
waiter. This order prevents both cancelled Deferred delivery and borrowing a
finished flight for a new request. It introduces no new worker, budget or retry.

Registry synchronization captures the actual instance and reads its inert
current snapshot, when supported, before publication. Recheck exact instance
identity at final mutation. This optional accessor starts no settings read,
probe, enrichment or provider call. A private volatile owner map retires previous
provenance on replacement even when the routing id/account label is unchanged.
The public flag is not an owner id, clock or ordering token.

Exact identity alone cannot order two deliveries from the same live owner. One
private metadata permit covers current-view admission, final owner validation,
mutation, cache persistence and publication. Maintenance patches read the latest
row only after admission; quota updates, replacement proof retirement and removal
publish under that same ordering boundary. Background startup snapshots retain
their exact owner and reread its inert current view before admission. Health/model
work, startup snapshot acquisition, admission barriers and subscription setup stay
outside this permit with their existing concurrency and deadlines. This prevents
both stale catalogue resurrection and older captured arrays reaching subscribers
after newer quota or removal state.

Final cleanup rereads the inert owner/unavailable inventories after awaited health
work instead of pruning from an old pass's captured list. The early unavailable
inventory check still qualifies admission before any probe; its failure cannot
wake pending capability readers with success. That early observation is not
reused as the later cleanup view.

Retirement must revoke exact lookup visibility before scope teardown can wake
admission waiters. Keep teardown joined before creating a replacement; lookup
revocation is not proof that native cleanup has finished. The inert accessor uses
the same live presentation decorator as ordinary snapshots, without a probe.
Shared captured cleanup outcomes prevent a repeated close from mistaking an
in-flight or defective finalizer for successful teardown. Interrupted unpublished
creation batches join their cleanup before releasing reconciliation ownership;
failed receipts remain refusal evidence. Creation stays interruptible. Final local
publication and routing additionally veto closed parent/child scopes, without
treating Closed as a successful cleanup witness.

Cache storage may preserve exact native-source historical arrays, but live
hydration drops active provenance. A new owner must establish its own successful
result. Foreign drivers and unqualified legacy paths preserve existing behavior
without gaining Codex native provenance.

## Security, alternatives and qualification

This narrows stale metadata borrowing, not provider/account entitlement. Existing
model/list uses health authentication observations, not a fresh account/read;
native authorization remains decisive. No extra periodic request, paid retry,
settings/profile mutation, permission or active interruption is introduced.
Preserve settings/replacement fences after awaits, probe budgets and native input.
Only finite source data is public, never an owner UUID, path or native object.

A helper-only retirement filter fails because later unions/health can resurrect
rows. Slug/equality inference fails for custom and identical native results.
Timestamps/probe diagnostics do not order model-only updates that share them.
Public owner UUID/revision metadata is unnecessary for exact local ownership.

Synthetic tests cover pending-to-ready, native-to-health, admitted empty results,
undefined/error/timeouts, same-email owner replacement, absent identity, stale
direct/stream results and cache hydration, alongside unchanged foreign/API/custom
paths. Full required local checks and forced desktop build remain publication
gates, not live-account or hosted qualification. No protocol/dependency pin moves.

Related: [service tiers](codex-model-service-tiers.md),
[picker guide](../codex-model-and-skill-picker.md),
[weekly review](../provider-updates-2026-10-15.md).
