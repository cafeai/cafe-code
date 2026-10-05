# Decision: exact selected-message Claude forks

Decision status: Accepted within the authorized provider parity implementation.
Created: 2026-10-05 10:51:29 JST (UTC+0900)
Last updated: 2026-10-05 11:16:52 JST (UTC+0900)
Implementation status: Implemented; focused synthetic qualification is recorded separately from integrated release verification.
Supplements [prepared conversation rewinds](claude-conversation-rewind.md),
[restored usage baselines](claude-resumed-usage-baseline.md), and
[runtime observation](subagent-runtime-observation.md).

## Identity and inclusion

The selected-message action sends only a Cafe message ID. The authenticated
transport binds it to the exact source thread, configured Claude account,
persisted turn and checkpoint ordinal. Clients cannot supply native UUIDs.
The adapter retains at most 4,096 private message correspondences in the durable
resume cursor. User messages bind to the UUID Cafe submitted. An assistant block
binds only after the existing SDK snapshot correlator matches one exact text
block and verifies its streamed UTF-16 prefix commitment. SDK wrapper UUIDs,
not API message IDs, distinguish multiple blocks in one Cafe turn. Ambiguous
snapshots, split renderer segments, invalid identities and evicted/legacy
correspondences do not gain guessed native boundaries.
Each correspondence also binds the exact Cafe turn ID and ordinal. Repeated
partial branches can resolve their interrupted endpoint without a filesystem
checkpoint only when that ordinal still equals the private native binding.

Agent SDK 0.3.288 documents `forkSession`'s `upToMessageId` as inclusive. Its
qualified implementation loads the supplied SessionStore, resolves the current
chain, slices through that wrapper UUID, rewrites parent relationships and UUIDs,
and publishes new entries with exact `forkedFrom` provenance. Cafe additionally
requires the selected message in the SDK's public `getSessionMessages` view;
compacted-away or unbound choices fail instead of forking the latest history.
The SDK owns graph interpretation, including compaction and progress removal.
The [official session guide](https://code.claude.com/docs/en/agent-sdk/sessions)
distinguishes conversation persistence from filesystem checkpointing.

Every currently projected candidate must have an exact private correspondence.
An indexed count capped at 2,001 proves that the bounded 2,000-message detail
contains the complete source projection before any native fork. A longer source
is explicitly unavailable: neither a retained display tail nor the larger private
mapping bound authorizes silently dropping its earlier Cafe history.
The SDK's resulting lineage determines retained Cafe message IDs. Timestamps
and random display IDs never decide native inclusion: equal-time messages can
sort differently from native order. The server returns a bounded, content-free
retained-ID set for the SQL, engine and renderer projections. A source identity
or account change is rejected at commit. Retrying the same command reuses its
dormant binding, exact cutoff, source event authority and retained set; a changed
source cannot rebind an earlier unknown-outcome candidate to a fresh commit.
The server samples the source thread and its current project's latest durable
event sequence on both sides of the initial detail read. Commit reserves the
SQLite writer and compares that exact authority before deciding or appending
events. Source metadata, model, permission policy, messages, lifecycle or project
root changes invalidate preparation; unrelated conversations remain independent.
The writer-held authority check uses two indexed latest-event seeks, not a scan
of growing transcript history.

## Immutable snapshot and unchanged source

Both full and selected Claude forks use the rewind reader's bounded, no-follow,
private-file checks and domain-separated content/filesystem commitment. The SDK
receives a frozen in-memory SessionStore, so its asynchronous graph processing
cannot reload a moving source transcript. A known idle whole tree is required:
pending prompts, approvals, input callbacks, foreground/detached tools,
background/unknown tasks, in-flight frames and uncertain shutdown all refuse.
An ingress revision detects received events even if they settle during the fork.
The exact runtime/session and original commitment are checked again immediately
before publication and after SDK completion. A waking/appending source invalidates
the operation. This is a consistent copied snapshot, not an assertion that
portable filesystem calls freeze all external processes.

Selected-message forking never cold-starts, closes or interrupts the source query,
never changes its native cursor and never rewinds repository files. Resume the
source explicitly when its runtime is unavailable. Publication exclusively
creates a fresh private transcript through the existing held-descriptor helper.
Uncertain publication preserves the candidate for recovery; errors are fixed
and contain no transcript, paths or native identifiers. Compensation requires
the exact command, account, stopped binding, cursor, cwd, original configuration
directory and candidate publication commitment. Cleanup refuses a live target,
changed profile, replacement leaf or changed directory namespace. It rereads the
candidate and synchronously rechecks namespace/leaf identity immediately before
unlinking only that transcript; the SDK disk fork creates no neighboring subagent
directory which would authorize recursive directory deletion. This closes Cafe's
asynchronous check/delete gap, not an impossible portable guarantee against an
external same-user writer changing a pathname between native filesystem calls.
Only an explicit pre-commit domain rejection authorizes compensation. Losing an
RPC waiter, a defect or an uncertain persistence acknowledgment retains the native
candidate and shared-workspace ownership: the independent engine queue may still
commit after the caller disconnects.

## Branch projection, continuation and accounting

The new chat keeps the selected account/model, title, permission mode,
materialized concurrency policy and exact workspace/worktree. Standalone chats
retain the existing shared directory ownership transaction. Only SDK-proven
messages enter its visible history. A selected branch endpoint is dormant and
projected as interrupted; it does not claim successful execution of a partial
turn. Historical filesystem checkpoint references are retained only for complete
turns; an intermediate selected turn has no checkpoint, plan or work-log rows
from its later execution. Live callbacks, approval/input request handles and
pending authority tables are never copied; historical completed task rows cannot
control a task in the new runtime generation.
The server resolves the current source workspace using its ordinary project/
worktree or standalone ownership rules. Before native I/O, the provider service
checks that the live runtime still owns that workspace; it also checks returned
and idempotently recovered fork paths. Equivalent lexical spellings or proven
same-directory filesystem identities are accepted without changing launch paths.
A pre-existing association move cannot attach an old native cwd to new metadata.

SDK lineage remaps the private correspondence to the target's copied Cafe IDs,
including full-fork then selected-fork and repeated selected forks after restart.
Prepared rewinds retain only still-proven correspondences. The next ordinary
target send resumes its new native session without `resumeSessionAt` or replay
of the selected message. Source continuation remains independent.

The public SDK fork omits native `cost-state`. Existing query-owned accounting
therefore uses its conservative missing-baseline policy when appropriate, never
charges inherited history again and never fabricates a complete historical total.
Forking itself invokes no model and copies no usage ledger rows or active tasks.

## Qualification

Credential-free tests use the real pinned SDK with scoped synthetic transcripts
for first, intermediate and latest cutoffs, multiple native blocks per Cafe turn,
UUID remapping, restart and full/selected successive forks. Adapter fixtures
verify durable streaming correlation, unknown/compacted/wrong-turn identities,
source append/task races, no source close/interrupt and unchanged source bytes.
Projection fixtures include equal timestamps with reversed lexical/native order,
partial checkpoint removal and idempotent replay. Service fixtures protect
fork idempotency and reject forged compensation cursors. Browser qualification
covers the selected-message action and truthful limitations. These checks do not
claim live paid inference or native foreign-platform execution; the full required
repository checks and final forced desktop build remain release gates.

User-facing behavior and limitations are described in
[Claude conversation actions](../claude-conversation-actions.md).
