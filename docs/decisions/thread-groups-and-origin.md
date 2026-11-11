# Agent-created thread groups and thread origin metadata

Status: implemented (source). Supersedes the earlier generic user-created
folder idea, which is not implemented.

## Problem

Swarms are a coordinator chat that uses Cafe's management tools to create and
check worker chats. Every worker was a top-level chat, so repeated
`[MANAGED …]` titles filled the sidebar, and nobody could tell who created a
chat or why.

## Decision

- **Groups belong to a parent thread.** A group is sidebar containment owned by
  exactly one thread and is shown as an indented folder row directly beneath
  it. Members are rendered only inside their group. Members can own groups of
  their own: thread → group → member → group …
- **Only the management tool creates groups.** The renderer has no "New group"
  or "Add to group" entry point and `thread.group.create` is absent from the
  client command unions. This is product routing, not proof that a caller is
  an AI: manual owner clients may call the tool. No human/agent security or
  ownership gate exists.
- **A thread may own several named groups** (recommended default). Titles are
  unique among an owner's live groups. A thread belongs to at most one group,
  fixed at creation (`thread.create.groupId`); a brand-new thread has no
  descendants, so no cycle can form. There is no move-into-group command.
- **People browse and delete.** Groups start collapsed (expansion is a bounded
  client-local preference) and the path to the open chat is always shown.
  Delete group moves the whole subtree to the Recycle Bin and keeps the parent.
- **No swarm policy.** There is no scheduler and no worker or concurrency cap.
  The only new bounds are data-structure bounds: nesting depth 16 (traversal),
  128 live groups per owner (owner shell frame size), 200-character titles and
  2,000-character descriptions. Group membership is unlimited.

## Origin, provenance and description

- `provenance` is recorded once by the server at creation and never accepted
  from a caller. The client dispatch normalizer always overwrites it with
  `cafe-ui`; first-send bootstrap records `cafe-ui`; startup bootstrap records
  `server`; fork/duplicate record their source thread.
- A management call with a verified signed launch claim records `mcp-launch`
  with the claim's Cafe chat as `originThreadId`. The claim identifies a Cafe
  chat, never a native provider subagent: an inherited child using the same
  connection is attributed to that chat. A manual/external owner bearer records
  `mcp-owner-client` and is deliberately neither human nor agent.
- `origin.classification` (Human / Agent / Unknown) is an editable label. Its
  recorded default comes from provenance; a person's correction sets
  `source: "user"` and never rewrites provenance. Missing provenance (all
  historical chats) is Unknown.
- `description` is optional untrusted text, multi-line, without other control
  or bidi characters. It appears in authenticated UI and management discovery,
  never in logs or compact diagnostics, and is not carried on shell frames.
- Group membership, origin and provenance grant no permission, native
  ownership, retry authority or isolation.

## Persistence

Migration 108 is schema-only: sidecar `projection_thread_metadata` (keyed by
thread, so the hot `projection_threads` upsert path is unchanged) and
`projection_thread_groups`, each with hard-delete tombstone triggers. The
existing `projection.threads` projector applies the new events, so no new
projector replays history at startup. Group events are filed on the owner's
event stream. The engine command read model carries every retained group
(including soft-deleted ones) so restore works after a restart; client
snapshots carry live summaries on the owner shell and deleted summaries only in
the Recycle Bin snapshot.

## Deletion, restore and parent operations

- `thread.group.delete` emits one batch: `thread.group-deleted` for the group
  and every live nested group, and the ordinary `thread.deleted` for every live
  member, all tagged with one deletion ID (the command ID). The parent is not
  included. Deleting a parent cascades through its groups in the same way.
- Each `thread.deleted` keeps the existing `ThreadDeletionReactor` stop
  request. That is a requested native stop, not finished cleanup; tool results
  say `recorded` and count `stopRequested`.
- Commands are serialized by the engine: a create decided before a delete is in
  that delete's closure, one decided after is refused. Turn starts and steers
  on a chat in the Recycle Bin are refused on every path.
- Pending approvals/questions are not answered by deletion; stopping retires
  native callbacks and restore does not revive them. Drafts and queued input
  stay local. Worktrees are kept.
- `thread.group.restore` is bounded twice: only rows reachable downward from
  that group, and only rows still carrying its exact deletion ID. A sibling
  group deleted by the same parent cascade is not restored; a member restored
  and deleted again later has a newer ID and stays deleted. The parent must be
  live. Restoring a thread restores its own subtree under the same rule.
- Restoring a single member restores its group shell when the parent is live,
  otherwise returns the member to top level.
- Permanent delete of an owner purges its groups and returns surviving members
  to top level. Recycle Bin "Delete forever" for a group runs the existing
  per-chat permanent delete in order, stops at the first failure and never
  retries.
- Archiving a parent archives its group members with a cascade ID; unarchiving
  the parent reverses only that cascade. Moving a parent changes no member's
  project (execution context). Fork/duplicate copy neither groups nor
  membership.

## Management tools

`create_thread_group`, `list_thread_groups`, `delete_thread_group`,
`restore_thread_group`; `create_thread` accepts `groupId` and `description`;
`update_thread` accepts `description`; `list_threads` filters by `groupId` /
`topLevelOnly`; `get_cafe_context` returns a bounded first page of
`ownedGroups` with `hasMore`/`nextCursor`/`totalMatches`.

A tracked create derives its target ID from the bearer scope, request ID and
tool, so `get_operation.plannedTargets` can name it and the engine refuses a
second creation of that ID. This is a reconciliation aid only: finding the
target confirms the action, but **not finding it is not proof** that the
originally admitted, possibly delayed action cannot still create it. Absent,
unconfirmed, failed or expired receipts and scope rotation never authorize
automatic replay or a replacement request.

## Limits

- Desk tabs and the Desk chat list do not show groups.
- Group rename is supported by the server command but has no UI yet.
- Collapsed project status summaries count only that project's top-level
  chats; group members are summarized on their group row.
- An older renderer connected to a newer server ignores group fields and shows
  members flat.
