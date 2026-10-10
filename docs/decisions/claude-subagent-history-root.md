# Decision: stable Claude subagent history roots

Decision status: Accepted within the user-authorized transcript bug repair
Implementation status: Implemented; qualification is described below
Created: 2026-10-11 03:53:42 JST (UTC+0900)
Last updated: 2026-10-11 04:14:36 JST (UTC+0900)
Decision authority: implementation choice within the user's request to fix unavailable Claude subagent transcripts and push dev
Partially supersedes: [public subagent history](subagent-public-history.md), only Claude's use of the mutable resume checkpoint as immutable native-root identity

## Context and rationale

The Agent SDK provides `listSubagents()` and `getSubagentMessages()` for active as
well as completed children. Its [0.3.285 change](https://github.com/anthropics/claude-agent-sdk-typescript/blob/da321bbe62ed45d10a1ff0e77a948253d9eee3e0/CHANGELOG.md)
includes messages received mid-run; Cafe's qualified 0.3.295 pin already includes
it. These APIs read persisted history, not every unwritten in-memory update.

Cafe previously froze a history root before a fresh Claude query published its
durable resume checkpoint. A missing native conversation UUID then prevented
active detail reads. Conversely, a completed root's changing turn count and
rewind/fork checkpoint maps could conflict with its unchanged native history
root and prevent late child history-ID upgrades.

Relaxing a missing root into a live-session wildcard would cross a trust
boundary: a Cafe chat can switch accounts or native conversations. Publishing
the ordinary resume cursor early would also change first-turn resume/recovery
semantics. Both alternatives are rejected.

## Decision

Claude's owner exposes optional private `subagentHistoryResumeCursor` coordinates
in authenticated daemon session snapshots, with an exact `{ resume: UUID }`
wire schema. They contain only the validated
native conversation UUID, independently of the completion-gated resume cursor.
SDK adoption updates them; malformed native roots remove them. They do not
authorize inference, resume, fork or rewind.

Each task incarnation retains the native root first observed with its exact
task/tool binding. A delayed task event carries that root in the task-only
optional `claudeSubagentHistorySessionId` UUID field, never the query's
subsequently adopted root. It survives authenticated daemon and event-journal
schema transport but is excluded from public task projections. Query runtime
generation and native conversation identity are distinct discriminators.

Before persisting child history, the service verifies the exact emitting
provider, configured account, query runtime and native root against the bound
adapter's current inventory. It reconstructs a root-only cursor from own inert
data properties, rather than serializing arbitrary adapter fields. Missing
native coordinates defer history binding; they never create an incomplete
Claude root or authorize a fallback to the live slot.

The retained per-turn root still binds account, original cwd and native UUID
immutably. Valid older full Claude cursors can compare equal only when their
native UUIDs match exactly; mutable count/checkpoint fields are irrelevant to
history identity. The original retained cursor remains unchanged. Other
providers retain their full-cursor comparison and routing behavior.

## Security, privacy and compatibility

Incomplete older roots are not rebound from current inventory. Their original
native identity cannot be established by guessing; unavailable history remains
unavailable. Replaced runtimes, account changes and same-query conversation
resets cannot lend their native root to a delayed old child.

The optional fields are server-owned and confined to authenticated internal
session results and task lifecycle transport. Explicit renderer projections,
user inputs, public runtime payloads and compact debug metadata do not acquire
them. Native history coordinates are not transcript display data. Existing exact task/history membership, parent-tool
metadata correlation, hidden-task suppression, public-only text extraction,
filesystem admission, retention limits and request deadlines remain intact.

No dependency update, database migration, credential access, provider process,
live prompt replay or platform-specific launch/permission change is introduced.
Older daemons omit the optional field and fail closed instead of inferring it.
Normal rebuilt-backend/session adoption is required; this does not repair a
running older owner or missing legacy provenance in place.

## Qualification

The real SDK reads an isolated configured-home transcript during an unfinished
first root turn; the durable resume cursor remains absent. Fixtures also cover
incomplete-root refusal, same-query reset with delayed old-child progress,
original-root reads after reset, service generation/account/native-root fences,
late history-ID upgrades, valid legacy-root equivalence and differing-root
conflicts. First authoritative start preserves the original turn and clock
during assistant-first identity promotion; genuine reuse clears the earlier
binding. Schema/journal roundtrips cover older and new authenticated daemon
results and task-only root stamps, including malformed UUID refusal.

Replay with the pinned Node/Corepack Yarn toolchain: provider adapter/service,
session-directory and `claudeSubagentHistoryRoot` tests, contracts provider and
daemon tests, then repository `fmt`, `lint`, `typecheck`, `test`, and final
`build:desktop --force`. Synthetic SDK/filesystem evidence is not a claim of
live native provider qualification or adoption by a running daemon.
