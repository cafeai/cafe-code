# Subagent concurrency and activity

Use **More composer controls → Subagent limit…** to set a chat's maximum
concurrent subagents, or Reset to remove its override. Cafe accepts whole numbers
from 1 through 64. Codex and Claude have separate saved values: changing one does
not erase the other. Model effort, including Ultra, does not select this limit.

Provider settings also offer a **Default subagent limit**. New and existing chats
without a saved override inherit this setting from their selected account. Editing
the account default updates their saved-limit display immediately; native changes
wait for the next safe idle send, never an account restart on save. An explicit
per-chat override takes precedence. A numeric override or inherited account
default requires the configured runtime to advertise support; unsupported or
unknown runtimes reject it explicitly.
Reset remains available if a provider is downgraded or its version becomes
unknown. Sends preserve the prompt and refuse an unsupported selected-driver
numeric policy, including queued sends; they never silently discard it on an
older server. Another driver's remembered value does not block the current one.

## Saved limit and session configuration

The context popover, pinned rail and limit editor use one compact label. Matching
current and saved numbers show **Subagent limit: N**. When a known recorded
process policy differs from the saved chat/account setting, the label shows both,
for example **Subagent limit: 5 → 15 when idle**. Active work keeps its current
configuration until the native idle boundary permits the saved change; the
immediately next turn may still be a steer rather than an idle turn.

The saved choice updates immediately with acknowledged settings. A known null
process policy means provider inheritance, not a guessed numeric default; unknown
process evidence is not treated as null or an applied number. A saved number with
unknown materialization is marked saved. Clearing/resetting a saved number still
shows any known current number while the return to inheritance is pending. If
neither numeric policy is known, the label and section are omitted. The editor
remains available. These labels describe recorded settings, not independently
verified capacity or a universal hard cap.

No separate selected/current-session or pending rows are added. The labelled
**About subagent limits** info tooltip and editor explain source, recorded process
evidence, the safe application boundary and enforcement caveat. All three surfaces
share this presentation; it adds no provider calls or runtime changes on render.

Saving during work changes durable chat metadata
only. Cafe applies a changed process limit at the next safe idle send boundary;
it does not stop running children or replay a prompt to apply a preference.
Unknown child liveness or incomplete event processing prevents replacement.
The guard covers the owned bindings and frames observed by the current runtime;
it does not prove physical idleness in unread native/OS buffers or historical
children absent from that runtime's bounded metadata.

Resolution is the selected driver's chat override, then the exact selected
account's Default subagent limit, then its existing legacy runtime override,
then native configuration/environment. New chats do not copy the default into an
override, so later account edits remain inherited. Older releases copied defaults
into numeric per-chat values without recording their origin. Those values remain
overrides because Cafe cannot distinguish a copied default from a manual choice;
use Reset on such a chat to opt into live account inheritance. Reset does not edit
global provider files.
An inherited provider default is not a known numeric limit. Internally, a null
session policy records the absence of a Cafe override, while an omitted policy
records unknown process evidence; neither is a numeric default. Old snapshots
with no recorded process policy remain unknown. Requested
values survive restart, fork, and duplicate without restoring a cleared override.
Configured process evidence survives restart and native fork; a duplicate is
intentionally session-unbound until its first send.

## Native semantics

Cafe qualifies Codex CLI 0.159.0+ and Claude Code 2.1.217+ from the configured
runtime's existing health result, not model names or SDK package versions.
Unknown and prerelease versions do not qualify automatically.

- Codex receives the existing structured native agent overrides: N spawned
  threads and N+1 total resident threads including the root. Completed history is
  not a concurrent-agent count; native admission and idle unloading remain owned
  by Codex.
- Claude receives `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` in that query's copied
  environment. Cafe never mutates the global process environment. Native manual,
  resume, and Ultracode/team exceptions remain native behavior; this preference
  is not a universal spending cap.

See the [live inheritance decision](decisions/live-account-subagent-default.md),
the [original implementation decision](decisions/per-chat-subagent-concurrency.md),
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
and [Claude concurrency documentation](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit).

## Activity surfaces

Tasks and the pinned session rail show only active/waiting workers across turns.
That claim requires matching current native-runtime evidence. Saved nonterminal
rows from an older runtime, legacy rows without evidence, and stopped/error
sessions instead show **Status unavailable** in history/Atrium, without a running
clock. They are not labelled completed and remain available for authorized detail
inspection. A fresh native observation can confirm a worker again. Reconnecting
to the same surviving daemon preserves its confirmed workers; a new native
runtime cannot inherit the previous runtime's Working claims. See
[runtime-bound observation](decisions/subagent-runtime-observation.md).
Closed, completed, failed, and stopped workers leave those active rosters.
Atrium cards start on **Active (N)**, showing confirmed active/waiting workers.
Choose **History (N)** to inspect completed, failed, stopped, or unverified workers.
Both views show at most five rows per page, adding **Previous** / **Next** controls
and a visible range/page count when more than one page is needed. History is newest
first. A card with only historical work says **No active subagents** instead of
expanding that history automatically.
Switching views returns to the first page, and live roster changes keep the
selected page within the available range.

This is presentation-only pagination of the retained roster: history and aggregate
counts are unchanged, and switching pages makes no provider request. Click a worker
to open its authorized public transcript and latest durable summary. An open detail
view stays bound to that exact worker even if it finishes or moves off the visible
page. Names can update after completion without reopening a worker or advancing
its completion clock. Cards share the Atrium's main scroll pane rather than adding
individual scrollbars.

New and reused workers follow durable event order, including when an old status
refresh and a fresh start have identical timestamps. The compact roster retains
lifecycle authority across parent turns; ordinary Work Log volume is not evidence
that a quiet worker finished. See the [ordered retention decision](decisions/subagent-lifecycle-retention.md)
for the bounded history-repair and reconnect behavior.

Elapsed time alone never proves completion. Native terminal events and bounded
authoritative child-state reconciliation update the durable lifecycle. Late tool
completion/progress notifications cannot resurrect a finished child. Transcript
selection binds the exact environment, parent, turn, child and history identity;
changing that identity clears old text before a replacement read. No new paid
model calls are used to produce these displays.

On Codex resume, one bounded latest-turn metadata read discovers referenced
children and refreshes their exact native status. It repairs those rows without
replaying old starts, scanning all history, or interpreting elapsed time as
completion. Older unreferenced rows retain their historical outcome rather than
being guessed closed, but without current-runtime confirmation they no longer
appear as actively working. Pending, unavailable, or superseded-generation discovery keeps limit
replacement fenced; a fresh explicit resume/restart is required to establish
new evidence after an inconclusive discovery.
