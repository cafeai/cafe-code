# Claude operation visibility

Last updated: 2026-11-03 18:38:38 JST (UTC+0900)

## What the chat can show

Already admitted public Claude summaries appear directly in the primary chat
as ordinary Markdown prose, in distinct rows at their received chronological
position. Live text replaces the same row without moving it past interleaved
commands. Each row shows its full retained text (the latest 4,096 UTF-16
characters), with updating, partial and truncation notices when applicable.
There is no separate disclosure or thinking header. Ordinary assistant text
keeps its existing message path; a summary is not a final answer or proof that
a tool succeeded.

Summary rows retain their operation identity rather than becoming canonical
assistant messages. They supply no fork, revert, attachment, checkpoint or
turn-completion authority. The normal `ChatMarkdown` renderer owns sanitization
and link handling. This presentation is the narrow successor to the original
work-log placement; see [the primary-summary decision](decisions/claude-primary-public-summaries.md).

Anthropic can return readable summaries or brief progress notes, while omitted
blocks contain no readable text. Which kind arrives depends on the selected
model and native runtime policy; the shared public-summary path does not guess
which kind arrived. Cafe does not decrypt signatures, reconstruct hidden reasoning, force a
beta mode or request another model to manufacture updates. Some operations can
still have no summary. See [Anthropic's thinking display and progress contract](https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates-between-tool-calls).

## Inspect command work

An admitted Claude Bash command can expose its description, command text,
received output preview and status in an expandable row. Timing is based on
Cafe's observed start/completion edges, not an independently measured provider
execution duration. Missing timing or output stays visibly unavailable; empty
received output is different from missing output. A failed operation stays
failed even if another operation later succeeds.

Background commands retain that same expandable row. Native task starts,
progress and terminal notifications keep their exact spawning tool identity
through ingestion, so a generic command lifecycle edge or a task-result echo
does not create another row beside an admitted command in the same turn.
Interleaved commands keep their own rows even when their descriptions match.
The row keeps its original position and open disclosure, and late progress
cannot revive a completed command. Task summaries are never treated as command
stdout; missing command output stays unavailable.

Only explicitly projected command fields are inspected. The view never
stringifies arbitrary tool JSON or uses omitted file contents, patches, private
resource capabilities, MCP results, child traffic or encrypted thinking as a
fallback. Command/output text is inert, escaped and selectable, not an execution
or approval control. Existing path actions and permission callbacks remain
separate.

## Bounds, privacy and history

Public summaries retain the latest 4,096 UTF-16 characters per block, with one
boundary completion and one final snapshot repair whose entire streamed prefix
is proved, including text that has rolled out of the retained window. Live
publication continues for the lifetime of the native block: neither filling
the preview nor reaching a fixed number of updates can freeze it. The adapter
admits at most 64 blocks per response segment and 16 active blocks. Source
retirement/correlation witnesses are bounded and never evicted into fallback
authority; exhausting them can suppress further summary admission for that
canonical turn. Command inspection has its own exact native response witness;
ordinary answer text, tools and provider work continue unchanged. Live updates
coalesce over one second into the same activity instead of creating a new
row for every token. Text size, active block count and refresh frequency remain
bounded; there is no lifetime live-publication cutoff. Exact native message/block identity
and streamed-prefix commitments prevent a snapshot from supplying a guessed
suffix or replacing divergent received text. Replayed wrappers cannot duplicate
a summary. Tool and terminal boundaries flush received partial summaries without
declaring an answer or successful tool outcome.

Command/description/output previews retain their 4,096/2,048/2,048-character
bounds; a truncation label identifies partial retained content. Common
credential patterns, terminal
and bidirectional controls are removed from new display details. This is
conservative minimization, not proof that arbitrary user-chosen strings contain
no sensitive information. The authenticated owning chat remains the disclosure
boundary. Child transcript disclosure retains its narrower existing policy in
[the child activity decision](decisions/subagent-activity-details.md).

Operational diagnostic copies omit opaque thinking signatures and redacted
blocks; nested or malformed-parent thinking text is not promoted. The filter is
forward-only and does not rewrite old logs. It changes Cafe's diagnostic copy,
not provider-owned conversation data or round-trip context.

New summary and command inspection payloads require their exact version-1
admission markers and trusted provider provenance from ingestion. OpenCode
primary-session reasoning parts use the same summary contract and bounds,
shown as secondary **OpenCode thinking** work-log rows; see the OpenCode section
of `AGENTS.md`.
Unmarked legacy rows, other providers and future versions never become an
arbitrary inspection fallback. Older work logs can lack these admitted fields
and cannot be reconstructed by a push. Primary Claude rows can use admitted
current and prior-turn summaries already present in the bounded retained
snapshot. There is no eager history query or backfill. Exact secondary duplicates
are suppressed only for the same Claude turn/block already shown as primary;
older unloaded summaries remain in the explicit paged work-log reader. Bounded
detail snapshots and historical expansion retain their existing paging limits.
The operation view makes no provider call, reads no credential store and never
replays a command or prompt.

The earlier-work reader uses the same explicit task/tool operation identity as
the inline list and its indexed presence/count/page filters. An older generic
tool edge can fold into a retained admitted command through its exact item id;
an older task result without an explicit task/tool link remains visible. A
matching description or native task id does not supply the missing correlation.
All native lifecycle events remain persisted and retain their original task
control and liveness semantics.

## Session durability notices

SDK 0.3.317 can report `session_writes_lost` as its native process exits, even
after a successful result. A valid notice from the exact established current
primary query/session produces fixed guidance that recent conversation or
settings changes may be missing after reconnecting. Pre-init, foreign, child,
malformed or retired notices cannot adopt session identity or warn for another
owner. Only bounded counts and Boolean categories reach diagnostics; native
error text, paths and transcript session identities are omitted.

This notice does not retract a received result, change the resume cursor,
complete/fail a turn, alter paid usage accounting, resolve callbacks or trigger
a retry. Native exit status remains independently authoritative. See the
[November 3 compatibility review](provider-updates-2026-11-03.md).

## Qualification and adoption

Native workflow roots and received phase/agent telemetry have a separate bounded
Tasks/rail presentation. Their inert counters never become primary context or
billing usage, and their numeric rows never authorize history or controls. See
[native workflow details](claude-runtime-options.md) for compatibility, privacy
and unavailable-data rules.

The November 3 source changes have synthetic regressions; complete integration
qualification must bind the exact checked source. Adapter/ingestion fixtures must exercise
exact query/turn/block ownership, live updates and snapshot fallback, duplicate/divergent/foreign
frames, partial terminal flushes, command output/status retention and privacy
bounds. Renderer tests cover chronological coalescing, expanded detail,
keyboard use, themes, interface scaling and narrow layouts. Native hosted browser
coverage is separate from local macOS evidence; no live Claude account is used.

Run the repository-pinned Node/Corepack Yarn checks, default and browser suites,
and the final forced desktop build. New behavior requires normal rebuilt
backend/app adoption; existing running sessions are not live-repaired. See the
[original visibility decision](decisions/claude-operation-visibility.md), its
[primary-summary successor](decisions/claude-primary-public-summaries.md) and
[response-limit handling](claude-response-limits.md).
