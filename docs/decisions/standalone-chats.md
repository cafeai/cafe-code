# Standalone chats: optional project association, independent Desk views

Decision status: Accepted by the user's explicit approval of the proposed design.
Implementation status: Implemented.
Verification status: The initial implementation passed pinned repository checks
and 75 focused browser tests on macOS. The latest pending-editor/sidebar follow-up has
updated regression fixtures; test execution is deferred at the user’s request.
Native Windows/Linux and live-provider qualification remain separate.
Created: 2026-10-03 13:39:38 JST (UTC+0900).
Last updated: 2026-10-06 (pending-editor/sidebar follow-up).
Supersedes: No prior decision in full. Supplements the project-only creation
scope of [Desk tab groups](desk-tab-groups.md); all its navigation, queue,
subscription, composer and per-group rail ownership rules remain in force.

## Context and alternatives

Desk previously organized existing project chats but did not make projectless
conversations possible. Creation, drafts, first-send admission and persistence
required a project even though tab routes themselves did not. A New chat button
alone would therefore create a draft that could not send. A hidden synthetic
project would conceal repository-context inheritance and misrepresent ownership.

## Decision

A thread belongs to its execution environment and may have an explicit null
project association. A project provides optional repository/folder execution
context; Desk is a client-local open-view arrangement, never the owner of chat
history. Project IDs remain genuine IDs, with no sentinel or synthetic project.

The New chat icon in Projects' Chats heading and the existing global shortcut
share one pending-editor action. Desk has no heading creation button. There
is no full-width New chat button and creation never switches the sidebar mode.
Capture the primary environment and active group before asynchronous navigation.
Reuse the current or most recent unpromoted standalone draft in that environment,
preserving input, attachments and explicit settings. Exclude a canonical server
identity and any draft owned by the existing first-send gate. The sidebar lives
outside the chat layout's React context, so it observes that gate through a
read-only registry lookup rather than creating a competing gate. Existing project
New chat actions stay project-scoped; standalone drafts do not use the logical
project index.

Pending editors live in ephemeral, environment-bound Desk view ownership outside
saved tabs, target preferences, counts, sidebar rows and reopen history. Draft
content and routing metadata remain in the existing persisted composer store.
A draft route renders its editor in the captured group without opening a chat.
When the exact first-send server identity is ready, register one canonical tab
in that group before retiring the draft. Background promotion preserves the
current group, selected saved tab, newer editor and route. Keep in-flight editors
mounted as hidden dispatch owners; idle recovered drafts do not mount controllers.
An unavailable tab slot keeps its pending ownership until a slot becomes free.
Legacy standalone draft-tab preferences are retired as views, preserving draft
content; project draft-tab behavior is unchanged.

Projects view presents a separate Chats catalog for canonical projectless
thread shells only, matching project rows. New chats remain local drafts until
first send atomically bootstraps the server thread; New chat does not dispatch
thread creation or add an unsent draft to the saved catalog. Draft text and
attachments remain recoverable through the pending editor and composer storage.
Desk remains only open views. Closing a tab does not archive, delete, stop,
clear input or clear its queue. The catalog reuses the existing inline
rename/archive conventions and shell summaries, without eager detail
subscriptions or subscriptions to local draft content. Archive is the row action;
Move to Recycle Bin remains in the context menu and uses the shared confirmed
flow. Archive/deleted/search/Atrium must include standalone identities even
when the environment has no projects.

Repository-only actions are unavailable for standalone chats: project scripts,
worktree/branch setup, project file browsing, Git operations and checkpoints.
The server enforces the same boundary rather than trusting a hidden button.
All ordinary chat controls, provider account/model selection, attachments,
approvals, streaming, durable delivery, usage and task/context/quota rails remain
the existing implementation.

## Execution context and security

Agent CLIs still require a working directory. Resolve it centrally from private
server-owned durable standalone workspace ownership; do not accept a renderer
path, omit cwd, inherit backend/home cwd, or reuse a formerly associated project's
additional roots. Explicitly pass an empty additional-directories array for a
standalone session. Validate directory identity and link/ownership admission;
use host-native paths and server-minted opaque names. Archive and soft deletion
retain resumable workspace state. Destructive cleanup must follow exact provider
retirement and authenticated workspace ownership, not arbitrary thread text.

Ordinary new chats and transcript duplicates own distinct neutral directories.
Explicit provider-native forks intentionally share the original execution
directory with durable reference-counted ownership. Deleting the source cannot
erase a surviving fork's files; only the final retired owner admits cleanup.
Root and leaf identities are durable device/inode pairs. Last-owner deletion
reserves an exact private quarantine before rename; interrupted or inconclusive
cleanup keeps ownership evidence and cannot delete a replacement directory.
Provisional native fork ownership is bound to the exact command identity, so
failure compensation cannot release a different concurrent attempt's reference.
Confirmed provider compensation releases that reference through the same durable
last-owner quarantine as deletion. A failed or inconclusive provider fork/cleanup
retains ownership evidence rather than assuming its execution directory is unused.
Compensation diagnostics contain operation metadata, never raw provider errors.

The macOS device-number durability assumption above is superseded by
[stable workspace volume identity](standalone-workspace-volume-identity.md),
which preserves the remaining ownership and cleanup rules.

New standalone chats share the Full access default used by project chats.
Creation honors the selected runtime mode, including explicit Supervised and
Auto-accept edits choices. Saved chats and drafts retain their selected mode,
and plan implementation in a new chat inherits the current composer selection.
This is not an OS sandbox, tool-free policy, credential isolation from
an explicitly full-access agent, or separate ChatGPT service. User/provider-level
instructions, tools, MCP and existing permission behavior still apply. Do not
claim a scratch directory removes every globally configured tool or hook.

Association changes must be explicit and idle-only, retaining conversation,
account/model and permission choices while clearing stale branch/worktree
context. Reconfiguration belongs to the next explicit user turn, never paid
prompt replay. Existing provider-native cwd-change/fork semantics must be handled
deliberately; an unsupported transition must not silently lose context or reuse
unowned workspace state. Cross-environment moves are not an implicit transfer.

An atomic projection fence records the highest historical checkpoint count and
association event sequence on each actual project change. Historical checkpoint
summaries remain readable, but cannot capture, restore or clean files through the
destination cwd. Fresh baselines use an event-bound ref namespace, even on a
return to the original project. Forks/duplicates copy this provenance boundary.
Exact retired turn identities and an explicit user-request epoch ledger reject
late or newly discovered native history without trusting provider/server clock
ordering. Capture rechecks association authority after external Git I/O, and
restore/cleanup check the current ref epoch. Fresh baselines are restorable;
copied source refs are readable history, never a fork's cleanup authority.

## Persistence and wire compatibility

Canonical creates and snapshots encode `projectId: null` explicitly. Existing
linked records and events replay without rewriting. Metadata update omission
means unchanged; null means detach. The schema migration removes the SQL NOT NULL
restriction while retaining accumulated columns, indexes, deletion triggers and
foreign-key attachment/subagent provenance in one transaction.

`ExecutionEnvironmentDescriptor.capabilities.standaloneChats === true` is required
before new clients create standalone conversations; absence means unsupported.
Nullable-aware catalog/detail RPCs opt in with `includeStandaloneChats: true`.
Legacy catalogs remain project-only, detached rows receive a view-only shell
removal, and legacy direct standalone detail requests fail with upgrade guidance.
Legacy replay excludes standalone segments rather than manufacturing project
IDs or durable deletions. Upgraded clients receive canonical history; this is
read-side compatibility, not a claim that old clients understand standalone chats.

## Verification and operational consequences

Contract fixtures must distinguish null from omission and preserve legacy event
defaults. Migration tests retain private child rows, indexes and tombstone
triggers. Mock-backed backend tests verify neutral cwd, empty roots, permission
defaults, no-project capabilities, attachment admission, restart and lifecycle.
Browser tests exercise zero-project creation, multiple independent drafts,
captured group/environment identity, sending/promotion and catalog recovery.

Use the existing pinned Node/Corepack Yarn workflow and required fmt, lint,
typecheck, full test, browser checks and final forced desktop build. Synthetic
platform tests and local macOS results do not establish live provider behavior
or native Windows/Linux qualification. No provider calls, credentials or paid
inference are required for default tests. See [the user guide](../standalone-chats.md).

The implemented verification includes contract null/omission and legacy-read
fixtures, migration child/tombstone preservation, real temporary filesystem and
Git provenance tests, mocked first-send/provider context, and browser creation,
draft promotion, archive recovery and linked/detached controls. The full default
test graph passes all ten workspaces (5,633 tests passed); its existing skips and
expected-failure fixture remain unchanged. Independent review regressions cover
root replacement before permission mutation and source deletion during native
fork compensation, including deliberate retention on uncertain provider outcomes.
