# Subagent concurrency and activity

Use **More composer controls → Subagent limit…** to set a chat's maximum
concurrent subagents, or Reset to remove its override. Cafe accepts whole numbers
from 1 through 64. Codex and Claude have separate saved values: changing one does
not erase the other. Model effort, including Ultra, does not select this limit.

Provider settings also offer a **New-chat subagent limit**. This is copied into
new chats once; editing it does not reconfigure existing chats or restart an
account. It is a future preference, not evidence that an older CLI supports the
feature. A numeric chat override requires the configured runtime to advertise
support; unsupported or unknown runtimes reject it explicitly.
Reset remains available if a provider is downgraded or its version becomes
unknown. Sends preserve the prompt and refuse an unsupported selected-driver
numeric policy, including queued sends; they never silently discard it on an
older server. Another driver's remembered value does not block the current one.

## Requested versus configured

The context popover, pinned rail and limit editor show **Selected for this chat**
(or an inherited **Account setting**) separately from **Current session**. Both
numeric labels describe Cafe's settings, not an independently verified hard cap.
**Provider-managed** means Cafe has not set a numeric override for that session;
**Not recorded** means there is no known process-policy evidence. Neither means
a known numeric provider default. A mismatched known setting shows **Waiting to
apply**, conditional on a new turn and a safe session restart. The enforcement
caveat is available through the labelled **About subagent limits** info tooltip,
not a permanent extra line. These labels use the same shared presentation in all
three surfaces and do not add provider calls or change runtime policy.

Saving during work changes durable chat metadata
only. Cafe applies a changed process limit at the next safe idle send boundary;
it does not stop running children or replay a prompt to apply a preference.
Unknown child liveness or incomplete event processing prevents replacement.
The guard covers the owned bindings and frames observed by the current runtime;
it does not prove physical idleness in unread native/OS buffers or historical
children absent from that runtime's bounded metadata.

Resolution is chat override, then an existing explicit account runtime override,
then native configuration/environment. Reset does not edit global provider files.
An inherited limit is not a claim that Cafe knows the provider's effective
number. Old snapshots with no recorded process policy remain unknown. Requested
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

See the [implementation decision](decisions/per-chat-subagent-concurrency.md),
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
and [Claude concurrency documentation](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit).

## Activity surfaces

Tasks and the pinned session rail show only active/waiting workers across turns.
Closed, completed, failed, and stopped workers leave those active rosters.
Atrium retains finished work, supports expanded history, and opens a worker's
authorized public transcript and latest durable summary. Names can update after
completion without reopening a worker or advancing its completion clock.

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
completion. Older unreferenced rows remain unchanged rather than being guessed
closed. Pending, unavailable, or superseded-generation discovery keeps limit
replacement fenced; a fresh explicit resume/restart is required to establish
new evidence after an inconclusive discovery.
