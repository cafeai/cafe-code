# Admit late ordinary Claude input on the retained query

Decision authority: The user requested delivery of ordinary steering messages after the foreground response ends while Claude background tasks remain.
Created: 2026-11-19 06:48:59 JST (UTC+0900)
Last updated: 2026-11-19 06:48:59 JST (UTC+0900)

The backend can receive a persisted steer while its projection still names the
preceding foreground turn. Claude may have completed that turn and retained
the same streaming query for background work. The ready query can accept a
new foreground input. A generic no-active-turn error does not establish that
the adapter owns this boundary.

The Claude adapter retains one in-memory completion witness for a successful
primary result tied to the current user turn or one of its exact admitted
prompt UUIDs. The already initialized native conversation, current query and
runtime must match at observation and completion. Binding the prior root is
separate from proving that the new input was consumed.

An ordinary steer naming that root can start one foreground turn inside the
same adapter call. The adapter rechecks the witness beside input admission,
including after asynchronous attachment preparation. It requires the same
live query to be ready with no newer root, pending input or pending terminal
frame. The new turn uses the retained native model, permissions and background
tasks. Explicit priority, Stop, replacement and stream closure carry their
existing authority. Background task counts, archived history and error prose
grant none.

The request has one native queue offer. This introduces no second daemon
request, startup replay, or attempt to recover after an unknown response. The
new root carries the original message and committed sequence through the
[initial-input consumption lease](claude-initial-input-consumption.md). Only
its exact native consumption can settle the Steering presentation. The
preceding turn stays terminal.
