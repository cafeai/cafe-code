# Decision: Viewport-positioned automatic visualization history

Decision status: Accepted; implemented
Verification status: Exact-source qualification is recorded separately; no live application adoption claim
Created: 2026-10-19 12:42:24 JST (UTC+0900)
Last updated: 2026-10-19 12:47:21 JST (UTC+0900)
Decision authority: the user requests removal of the manual older-visualization
control and automatic restoration at the proper conversation positions while
scrolling. The bounded indexed read strategy is an implementation decision within
that request, not permission to broaden chart execution or provider access.
Supersedes: the manual-only compact-reference pagination policy; supplements
[the viewport pool](agent-visualization-viewport-pool.md), whose frame/source and
ownership limits remain unchanged.

## Context and alternatives

The compact visualization reader previously fetched the newest page and required
a separate button for every older page. Ordinary message scrolling therefore
could reach old messages without loading their associated visualization rows.
Automatically walking every intervening cursor would turn a far-old jump into
an eager history scan. Loading source or mounting hidden frames would also cross
the independent execution and resource boundaries.

Use a bounded indexed time seek for compact references, followed only by an exact
visible-page continuation when needed. Retain cursor authentication rather than
turning a timestamp or a client-provided offset into row ownership.

## Decision and data flow

The actual LegendList reports visible rows after its exact initial-load boundary.
That received viewport determines the oldest visible timestamp and the next
chronological row's timestamp as an inclusive upper read position. A message is
dated at its start; a chart published later during a long visible message must
not disappear merely because the next message is still offscreen. At the final
row the finite maximum timestamp supplies the upper position.

The list contract accepts an optional canonical finite UTC `atOrBefore`. The
server uses the existing thread/time/id index and unchanged page limit. Seek and
cursor inputs are mutually exclusive at the service boundary; cursor continuation
still binds the exact stored row and chat, including timestamp ties. No migration,
offset scan or client-selectable page size is added.

An owner-scoped controller keeps one request, one coalesced latest invalidation,
and the current viewport demand. It retains at most 1,000 compact references and
20 page coverage records. Far-old navigation seeks directly; it never fills an
intervening gap. Only actual visibility of a page's last chart admits its cursor.
Live invalidation retires stale absence coverage but keeps stable entry objects;
only newest/current viewport boundaries are refreshed. Alternating latest versus
viewport work and alternating the viewport's two edges prevent sustained new
publication from starving historical review.

Reference eviction protects current visible entries. Stable overlapping objects
and deterministic timestamp/identity presentation order preserve visible chart
identity; equal timestamps do not invent causal order from LRU touches. Reaching
evicted history re-seeks it. The conversation's native anchoring, review/follow
state and scroll owner remain authoritative; the reader never scrolls the list.

## Security, privacy and failure behavior

Viewport positions grant only bounded compact-metadata reads. They never carry
source, private JSON, account/session ownership, access policy or execution grants.
The same thread tombstones, exact cursor lookup and authenticated API owner fences
remain in force. Chart source reads, Full-access checks, frame pool, offscreen
retirement and App-operation consent remain separate and unchanged.

The reader rejects invalid positions, non-descending/out-of-window pages, repeated
invocations within a page and stalled cursors. A bounded demand ledger refuses
cycles or repeated failed coverage in the same visible read generation; explicit
retry or a changed current viewport/revision does not create an unbounded queue.
Errors retain admitted metadata and expose only the existing quiet refresh action.
Unabortable requests retain their sole permit until settlement; retired owner
responses cannot publish or dispatch trailing work. No automatic provider launch,
timer, permission relaxation or hidden source prefetch is introduced.

## Implementation and evidence

The list contract/store, pure history controller, owner hook and native list
visibility wiring implement this policy. Direct tests cover finite/canonical
positions, same-thread indexed seeking/tie cursors, far-old navigation, bounded
retention, stable visible identity, cycles/stalls, held-owner retirement and
publication fairness. Native browser wiring exercises actual wheel scrolling and
a chart published after a long message's starting timestamp, without a manual
history button or source execution.

Run the affected contract/server/renderer tests, required repository checks and
the final forced desktop build on the same source. Local synthetic evidence does
not establish live application adoption or native hosted release qualification.
No current verification pass is claimed by this decision record.
