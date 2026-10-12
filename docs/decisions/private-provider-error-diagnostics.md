# Private provider retry/error Work log details

Decision status: Accepted by the user's implementation authorization
Implementation status: Implemented; verification boundary documented below
Created: 2026-10-12 15:11:00 JST (UTC+0900)
Last updated: 2026-10-12 16:35:22 JST (UTC+0900)
Notification replacement partially superseded by:
[Provider errors stay out of chat popups](provider-error-popup-policy.md).
The original witness-based notification decision below is retained as history;
capture, persistence, ownership and inspection decisions remain in force.

## Context and decision

Repeated provider warnings and opaque error banners did not identify the agent
or retain enough received evidence for debugging. Putting complete error JSON
in every activity snapshot would broaden privacy exposure and streaming costs.
Reuse the command inspection disclosure shell, but give diagnostics a separate
typed model and a private, explicit reader rather than pretending they are commands.

The closed public summary contains root/subagent/unknown attribution, a fixed
retry/error label and the original observation time. Unknown never means root.
Native retry counts are unique received observations and may be lower bounds;
they are not upstream attempt numbers, retry limits or deadlines. Current and
hydrated historical Work log headers indicate known provider errors even when
their rows are hidden. No private body appears in collapsed DOM or tooltips.

Capture a bounded error/retry-only diagnostic copy before normal child reduction
and summary truncation. Retain error categories/status, received origin and
operational correlation data when actually reported. Never retain whole
`turn.items`, prompts, tool inputs/outputs, environment or conversation history.
The sanitizer reads inert own data, excludes credential-shaped keys, filters
known credential patterns in prose and field names, and marks unsupported,
redacted, truncated or intentionally omitted data. Limits and the exact closed
schemas live in `packages/shared/src/providerDiagnostic.ts` and
`packages/contracts/src/providerDiagnostic.ts`, not a duplicate table here.
This is a filtered diagnostic copy, not untouched original wire JSON or a claim
that an arbitrary opaque string can be universally identified as a secret.

## Storage, ownership and failure behavior

Migration95 creates a private occurrence table outside ordinary activity,
shell/detail snapshots and optional canonical NDJSON logging. The first copy
and its exact Cafe thread/nullable turn/activity owner are immutable. Persist
before publishing the public recorded marker. A failed capture never publishes
that marker or copies private error prose into a public fallback. Canonical
failure, recovery and direct-send feedback remain intact.

`orchestration.getThreadActivityDiagnostic` requires a currently authenticated
owner over HTTPS or the same machine, independently of ordinary collaboration
read access. Revalidate the exact persisted parent session before private lookup
and before returning its result: the upgrade snapshot alone cannot authorize a
retained socket after revocation or expiry. Missing, changed, or unreadable
session evidence fails closed with a fixed content-free error; the short-lived
WebSocket upgrade credential is not replayed. The final check is the handler's
release admission point, not a claim that later revocation can retract already
admitted or network-buffered bytes. Its indexed query joins the same
exact canonical activity and thread tuple and refuses tombstoned owners. Native IDs and activity IDs alone
are not capabilities. Historic reads do not require a currently live matching
provider; they are diagnostics, not provider authority. Forks do not implicitly
copy private diagnostic bodies to a different thread. Hard deletion purges
private copies and permanently fences later stale writes. Revert prunes only
after retained activities are reinserted, preserving their surviving copies.

The sensitive RPC route requires an actual observed loopback IP, including
the existing local HTTPS sibling boundary, not a missing/empty peer, lexical
prefix, forwarded header or role assertion. This also closes the same empty
peer ambiguity for existing sensitive RPCs without changing the general HTTP
bootstrap allowlist. Renderer connection replacement, ordinary transport loss
and saved-owner revocation discard retained bytes and pending results; recovery
requires an explicit new diagnostic read rather than automatically refetching.

Terminal-only failures get a display-only error row; terminal child rows use
a distinct deterministic activity identity so they cannot overwrite the roster.
Coalesce a terminal echo only with a preceding canonical error whose exact
native thread/turn/runtime and complete copied error body agree. Ambiguous,
omitted, redacted or truncated copies remain distinct. Diagnostics never extend
failed-root clocks or influence retry, native liveness or task controls.

## Renderer and notification replacement

Expansion performs one bounded own-environment read and validates the echoed
thread/turn/activity tuple. Navigation, collapse and superseding reads fence
late results. The body uses escaped plain text and inert JSON, not Markdown,
HTML, auto-links or file actions. Copy JSON/details requires a user gesture.
Failures use fixed inline feedback and a manual reader retry, never a provider
retry or a diagnostic error toast. Dates use native viewer-local Intl semantics,
including seconds/timezone and the user's existing system/12/24-hour preference.

The provider-error banner is replaced only for the latest exact failed root
whose persisted row's content-free account/runtime/message witnesses match
the current canonical failure. Newer unrecorded or uncertain roots cannot borrow
an older row. Do not dismiss or clear errors to hide them. Authentication,
approval, history-recovery, response-limit and unrelated direct-send feedback
retain their existing controls. Existing automatic recovery presentation remains
separate and never derives authority from this diagnostic row.

Schedule refresh/disconnection health and its Refresh action now belong only
in Tasks. Main-chat saved follow-up cards remain visible with honest last-known
state and existing stale-revision action admission.

## Alternatives and qualification

Rejected alternatives: eager raw JSON in subscriptions, per-row provider probes,
reusing command schemas for unrelated error data, global error dismissal, and
guessing root identity or upstream retry deadlines from prose.

Synthetic capture/schema, SQLite retention/ownership, authenticated RPC,
immutable-clock, disclosure/copy/navigation and native-Intl renderer fixtures
qualify these boundaries. Browser cases use the existing native-host focused
subset and Linux full suite without changing workers, deadlines or input/media
policy. Local isolated evidence is not live provider or native desktop evidence.
Repository checks and the forced desktop build precede publication; hosted CI
and release artifacts are separate observed gates. Normal rebuilt backend
adoption is required for the additive migration/reader, not a live-session repair.
