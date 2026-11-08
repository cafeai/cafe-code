# Volatile Claude provider metadata advisories

Created: 2026-11-04 11:20:36 JST (UTC+0900)
Last updated: 2026-11-04 12:05:37 JST (UTC+0900)
Status: Accepted design with implementation included in the Claude 318 integration.
Design acceptance does not establish repository, native-host or delivery qualification.

## Context

SDK 318 exposes a reported claude.ai sign-in end date and a typed invalid-config
startup reason. Neither value establishes a new authenticated account, proves
remote credential acceptance, authorizes a retry, or proves successful work.
An old query, child frame or cached status must not publish either as current
evidence for a replacement owner.

## Decision

Treat sign-in expiry as optional, bounded, volatile native-result metadata.
Admit an own-data expiry slot only from the exact current independently
initialized primary query/runtime/session, with a valid nonnegative safe result
sequence. A result must not establish that owner by updating a resume cursor.
Recheck the owner around awaited processing. Duplicate/older results cannot
restore an earlier observation; valid numbered absence clears that lease's
unknown date. Malformed data cannot publish or refresh a date.

The owning driver gives each admitted native runtime an opaque in-process
lease. Retirement invalidates the owner synchronously before asynchronous
cleanup. Projection rechecks the live predicate, so a delayed notification or
retirement cannot revive another runtime's advisory. Bound retained live
observations; select the earliest reported deadline among valid active owners
as a conservative warning for their work. It is not a verified account-wide
identity or a promise that every thread has the same credential.

Expose only canonical expiry/receipt instants and the finite native-result
source. Keep native IDs, paths, credentials and raw result bodies private to
their existing boundaries. Content-free snapshot invalidations read the current
inert snapshot; they must not trigger health probes, inference or provider
refreshes. Status-cache persistence, hydration and conclusive-auth retention
strip the advisory. Instance replacement cannot reconstruct it from disk.

Show a localized nonblocking warning in Settings and the selected provider's
chat banner during the ten days before the reported date, or when the date has
passed. Explain that an active session reported an estimate, that the actual
end can be three days earlier, and that remote acceptance/revocation is not
established by local metadata. Keep `auth.status`, account selection, native
send policy, permissions and quota unchanged. A dismissed chat warning stays
dismissed for that exact instance/source/deadline, not merely until the next
status refresh. Settings retains the factual detail.

For `config_file_invalid`, use a closed reason and fixed diagnostic guidance
only on an exact held primary unscoped zero-turn startup failure. Such a failure
can precede init and name a different failed native session; preserve the prior
durable cursor. Do not infer the category from error prose or use that startup
result as expiry-owner proof. Preserve canonical lifecycle errors and existing
failure/Stop/recovery behavior. No automatic configuration repair or broad
native-log rewrite is part of this decision.

## Alternatives and consequences

Persisting an account-level expiry or deriving authentication failure from a
deadline would overstate the native evidence. Polling another native status
command would add account-selection, subprocess and timeout behavior solely
for presentation; this integration instead uses existing result delivery.
Unowned or legacy metadata remains unknown even when that means no warning.

The SDK's date may be a server value or an estimate. UI wording must preserve
that uncertainty; it cannot guarantee a future login duration or replace a
real request's authentication result. The lease/decorator is Claude-specific
and introduces no history/database migration or provider-execution authority.

## Verification requirements

Qualify genuine success/error result admission, pre-init/foreign/child/retired
refusals, malformed accessors, monotone result ordering, late-await replacement,
scope teardown and bounded live-owner resources. Protect existing result,
cursor, Stop, auth and accounting behavior. Contract/cache/retention tests must
prove that unknown metadata stays unknown and old state cannot mint live proof.

Pure presenter tests own threshold/date/legacy cases. Native scoped browser
wiring owns Settings display, selected-instance warning/dismissal and retirement
without another provider call. Keep native input, assertions, deadlines and
worker/context ownership. Run the new wiring in the existing macOS/Windows
subset and Linux's complete coverage. Complete verification and fresh forced
desktop build remain required before delivery.

See [the provider update record](../provider-updates-2026-11-04.md) and
[Claude authentication selection](../claude-authentication.md).
