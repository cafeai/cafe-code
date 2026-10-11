# Bounded current-turn Work log history

Decision status: Accepted within the authorized Work log repair
Implementation status: Complete; final delivery gates tracked in plan149
Created: 2026-10-11 13:14:45 JST (UTC+0900)
Last updated: 2026-10-11 13:25:45 JST (UTC+0900)

## Context

The live thread-detail/store window retains500 ordinary activities plus
separate bounded lifecycle/configuration exceptions. Messages can outlive that
window. Historical disclosure excluded the latest turn, so its saved commands
became inaccessible when evicted even though their messages remained visible.
Eagerly expanding snapshots would increase ingestion, reconnect and rendering
cost for mature chats without fixing the history boundary.

## Decision

Keep the shared500 limit. Derive one presence-proven Earlier work disclosure
for a full latest-turn window, alongside existing previous-turn Work logs.
Anchor to exact turn identity, never provider prose or a timestamp guess. Keep
known message turns discoverable if latest-turn metadata is missing. Preserve
the existing indexed displayability predicate for presence/count/page queries.
An explicit local summary flag carries that uncertainty through snapshot and
hydrated child presentation; missing latest identity cannot infer that a legacy
Started child completed. Real structured terminal edges remain authoritative.

The additive `before` tuple contains nullable sequence, receipt time and opaque
activity id. It is an immutable read filter, not an authorization capability.
Authenticated queries still bind exact chat/turn and reject nonzero offsets in
this mode. Count/list share a short read transaction. Indexed reads select the
nearest bounded descending page then return chronological rows. The response
echoes the consumed bound so an older server cannot silently ignore it. Legacy
offset callers are unchanged. Strings compare in SQLite BINARY/codepoint order,
not viewer-local collation. Cursor fields reject unsafe numbers and controls.

Expand explicitly to read six rows, then24 per Show older. Capture the upper
bound once; live tokens do not drift it. Keep at most1000 reader rows while
advancing older, with a lower-bound count after truncation and explicit Recent
reset. Fence requests by environment/chat/turn/generation and validate scope,
echo, count, ordering and range before displaying. Retry is local and manual.
No transient history error emits a toast or exposes arbitrary error content.

Fold current raw snapshots over saved rows before deriving operations, and
omit already-inline operation identities. Never mark a current turn terminal
to format its paged rows. No history response enters the live store or grants
native liveness, task control, Stop/restart or retry authority. Subagents remain
in their separate authoritative roster.

Presence results publish by completed batch. A bounded exact-owner receipt
cache prevents duplicate unresolved batch reads across React effect cleanup.
Negatives are tied to relevant work/new-turn witnesses, not token or context
updates. Remember snapshot-proven historical work so a late received command
does not disappear behind an older empty result after eviction. Reopening or
remounting the timeline resets the focused cache; no implicit provider probe or
unqualified live repair is claimed.

## Consequences and qualification

Memory/network work stays bounded and history reads remain independent from
provider recovery. Legacy cursor-less servers fail the new reader visibly;
normal rebuilt backend adoption is required. A deleted/changed row cannot move
the captured tuple, although immutable filtering is not a lifetime snapshot.

Credential-free real SQLite, schema, reducer and browser fixtures cover modern
and legacy ordering, scope isolation, live appends/moving summaries,500-row
eviction, explicit paging/retry, owner/revision races,1000-row retention and
narrow light/dark/scale/reduced-motion layout. Shared browser coverage belongs
in the existing native-host subset and Linux full suite with unchanged checks,
workers and deadlines. Local Chromium evidence is not live provider/native
desktop qualification. Final required repository checks and forced desktop
build precede a separately confirmed dev push and exact-run CI verification.
