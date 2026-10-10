# Claude operation visibility

Last updated: 2026-10-09 13:03:52 JST (UTC+0900)

## What the chat can show

Claude's received public updates belong in the operation history, not only its
final answer. Ordinary assistant text keeps the existing message path. Readable
thinking/progress blocks appear separately as **Claude summary** rows in the
work log, in their received chronological position. Expand a row to read its
retained text. A summary is not a final answer or proof that a tool succeeded.

Anthropic can return readable summaries or brief progress notes, while omitted
blocks contain no readable text. Which kind arrives depends on the selected
model and native runtime policy; a generic summary label avoids guessing the
kind. Cafe does not decrypt signatures, reconstruct hidden reasoning, force a
beta mode or request another model to manufacture updates. Some operations can
still have no summary. See [Anthropic's thinking display and progress contract](https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates-between-tool-calls).

## Inspect command work

An admitted Claude Bash command can expose its description, command text,
received output preview and status in an expandable row. Timing is based on
Cafe's observed start/completion edges, not an independently measured provider
execution duration. Missing timing or output stays visibly unavailable; empty
received output is different from missing output. A failed operation stays
failed even if another operation later succeeds.

Only explicitly projected command fields are inspected. The view never
stringifies arbitrary tool JSON or uses omitted file contents, patches, private
resource capabilities, MCP results, child traffic or encrypted thinking as a
fallback. Command/output text is inert, escaped and selectable, not an execution
or approval control. Existing path actions and permission callbacks remain
separate.

## Bounds, privacy and history

Public summaries retain at most 4,096 UTF-16 characters per block, with at most
16 intermediate publications, one boundary completion and one final snapshot
repair whose streamed prefix is proved. The adapter
admits at most 64 blocks per response segment and 16 active blocks. Source
retirement/correlation witnesses are bounded and never evicted into fallback
authority; exhausting them can suppress further summary admission for that
canonical turn. Command inspection has its own exact native response witness;
ordinary answer text, tools and provider work continue unchanged. Live updates
coalesce over one second instead of appending a durable activity for every
token. Exact native message/block identity
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
admission markers and trusted Claude provider provenance from ingestion.
Unmarked legacy rows, other providers and future versions never become an
arbitrary inspection fallback. Older work logs can lack these admitted fields
and cannot be reconstructed by a push. Bounded detail snapshots and historical expansion retain their existing
paging limits. The operation view makes no provider call, reads no credential
store and never replays a command or prompt.

## Qualification and adoption

Native workflow roots and received phase/agent telemetry have a separate bounded
Tasks/rail presentation. Their inert counters never become primary context or
billing usage, and their numeric rows never authorize history or controls. See
[native workflow details](claude-runtime-options.md) for compatibility, privacy
and unavailable-data rules.

Synthetic adapter/ingestion fixtures must exercise exact query/turn/block
ownership, live updates and snapshot fallback, duplicate/divergent/foreign
frames, partial terminal flushes, command output/status retention and privacy
bounds. Renderer tests cover chronological coalescing, expanded detail,
keyboard use, themes, interface scaling and narrow layouts. Native hosted browser
coverage is separate from local macOS evidence; no live Claude account is used.

Run the repository-pinned Node/Corepack Yarn checks, default and browser suites,
and the final forced desktop build. New behavior requires normal rebuilt
backend/app adoption; existing running sessions are not live-repaired. See the
[operation visibility decision](decisions/claude-operation-visibility.md) and
[response-limit handling](claude-response-limits.md).
