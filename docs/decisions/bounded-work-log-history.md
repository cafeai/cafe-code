# Bounded current-turn Work log history

Decision status: Accepted within the authorized Work log repair
Implementation status: Complete; final delivery gates tracked in plan149
Created: 2026-10-11 13:14:45 JST (UTC+0900)
Last updated: 2026-10-18 (UTC)

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

Earlier-range presence, count and page reads also accept the same bounded
`excludeActivityIds` filter for entries already retained inline before the raw
window floor (such as turn configuration and live-work exceptions). These
identities only narrow the authenticated exact chat/turn cursor range. Pages
echo the captured exclusions, and the reader validates both the echo and the
absence of excluded rows. Relevant exclusion changes invalidate cached empty
presence; token/context-only updates do not. Retained settings alone must not
create a disclosure that becomes empty on expansion. Ordinary offset history
remains unchanged.

Earlier-range requests also carry bounded `excludeOperations` identities for
operations already represented inline. Every provider uses an explicit ACP
tool-call identity when present, otherwise its native item identity; public
summaries have a separate identity kind. Presence, count and pages apply the
same exact-turn exclusions before reading rows. Pages echo the captured list,
and the reader rejects a missing/changed echo or an excluded operation. Native
identities are presentation filters, not provider/session/control authority.
No command text, output or label is carried in the exclusion contract.

Exclusions have stable ordering independent of snapshot receipt ids and token
updates. A newly received inline operation invalidates even positive presence
proof, while complete eviction makes its saved work discoverable again.
Removing exclusions widens the range and preserves positive proof and an opened
reader without another presence read. Native item identity also prevents
different OpenCode/Codex tools with identical presentation from collapsing
together. Legacy operations without an admitted
identity retain their older reader entry instead of losing it through an
unproven label/detail match across the history/live boundary. The bounded
reader still folds identified current snapshots before deriving display rows.

Valid same-turn Codex settings also supply `excludeTurnStartAck` on the exact
earlier cursor range. Presence, count and pages omit only that turn's
`codex-turn-start:<turnId>` task-progress receipt, which the renderer already
folds into the accepted settings. Pages echo this filter; the reader rejects a
missing/changed echo or a returned excluded receipt. Absent, malformed,
foreign-turn and non-Codex settings do not request it, preserving legacy ACKs.
Earlier-range positives belong to their exclusion witness. Received settings
that replace a previously counted receipt invalidate that positive without
requiring expansion. A growing earlier range preserves positive proof and its
opened reader; negative/inconclusive reads still expire on newly evicted work.
Context-only updates do not invalidate either. Historical snapshot proof remains
discoverable after eviction.
Presence, count and pages also omit ambient tasks, reserved workflow task rows
and legacy collaboration tool rows that belong to other presentation surfaces.

An unavailable Earlier work presence read is cached as inconclusive for the
current work witness and stays hidden. It does not manufacture positive or
empty evidence, emit a toast, fetch a page or retry in a loop. Relevant new work
or a remounted timeline can check again. Previous-turn fallback behavior is
unchanged. An exhausted empty reader renders no disclosure or empty-state
flash while its scoped negative is published; newly evicted work can reset
only that empty reader without eagerly reading history.

Presence results publish by completed batch. A bounded exact-owner receipt
cache prevents duplicate unresolved batch reads across React effect cleanup.
Negatives are tied to relevant work/new-turn witnesses, not token or context
updates. Remember snapshot-proven historical work so a late received command
does not disappear behind an older empty result after eviction. Reopening or
remounting the timeline resets the focused cache; no implicit provider probe or
unqualified live repair is claimed.

## Consequences and qualification

The later historical-reader repair applies the same exact-owner rule to
previous-turn offset pages, not only the current-turn cursor reader. Cached
rows reset on environment/chat/turn changes and asynchronous page/error/finalizer
publication requires the original mounted reader's current request. This is a
repair within the accepted presentation-only boundary, not a new authorization
or provider control. Saved approval-review starts use the ordinary displayable
work predicate consistently in presence/count/page reads; internal task starts
and structured subagent rows remain excluded.

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
