import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CheckpointRef, ThreadId } from "@cafecode/contracts";

import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { purgeProviderDaemonThreadPersistence } from "../providerDaemon/ProviderDaemonThreadPurge.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { makeStandaloneWorkspaceStore } from "./standaloneWorkspace.ts";
import {
  checkpointRefForThreadTurn,
  isThreadOwnedHiddenCheckpointRef,
} from "../checkpointing/Utils.ts";

export const deleteThreadAttachments = Effect.fn("deleteThreadAttachments")(function* (
  threadId: ThreadId,
) {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    yield* Effect.logWarning("skipping hard-delete attachment cleanup for unsafe thread id", {
      threadId,
    });
    return;
  }

  const entries = yield* fileSystem
    .readDirectory(config.attachmentsDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
        if (relativePath.length === 0 || relativePath.includes("/")) {
          return;
        }
        const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
        if (!attachmentId) {
          return;
        }
        const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
        if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
          return;
        }
        yield* fileSystem.remove(path.join(config.attachmentsDir, relativePath), {
          force: true,
        });
      }),
    { concurrency: 1 },
  );
});

const loadThreadHardDeleteMetadata = Effect.fn("loadThreadHardDeleteMetadata")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [threadRow] = yield* sql<{
    readonly worktreePath: string | null;
    readonly workspaceRoot: string | null;
  }>`
    SELECT
      thread.worktree_path AS "worktreePath",
      project.workspace_root AS "workspaceRoot"
    FROM projection_threads AS thread
    LEFT JOIN projection_projects AS project
      ON project.project_id = thread.project_id
    WHERE thread.thread_id = ${threadId}
    LIMIT 1
  `;

  const checkpointRows = yield* sql<{
    readonly checkpointRef: string;
    readonly turnCount: number;
    readonly associationSequence: number | null;
  }>`
    SELECT DISTINCT turn.checkpoint_ref AS "checkpointRef",
      turn.checkpoint_turn_count AS "turnCount", fence.association_sequence AS "associationSequence"
    FROM projection_turns AS turn
    LEFT JOIN thread_checkpoint_workspace_fences AS fence ON fence.thread_id = turn.thread_id
    WHERE turn.thread_id = ${threadId}
      AND turn.checkpoint_ref IS NOT NULL
      -- Historical associations retain transcript metadata, not filesystem
      -- authority in the current repository. Never clean their refs through a
      -- destination cwd after a detach/move/reattach.
      AND turn.checkpoint_turn_count > COALESCE(fence.invalid_through_turn_count, -1)
  `;

  return {
    // A worktree is meaningful only while its canonical project exists.
    cwd: threadRow?.workspaceRoot ? (threadRow.worktreePath ?? threadRow.workspaceRoot) : null,
    checkpointRefs: checkpointRows
      .filter(
        (row) =>
          isThreadOwnedHiddenCheckpointRef(threadId, row.checkpointRef) &&
          (row.associationSequence === null ||
            row.checkpointRef ===
              checkpointRefForThreadTurn(threadId, row.turnCount, row.associationSequence)),
      )
      .map((row) => CheckpointRef.make(row.checkpointRef)),
  };
});

const deleteThreadCheckpointRefs = Effect.fn("deleteThreadCheckpointRefs")(function* (
  threadId: ThreadId,
) {
  const checkpointStore = yield* CheckpointStore;
  const metadata = yield* loadThreadHardDeleteMetadata(threadId);
  if (!metadata.cwd || metadata.checkpointRefs.length === 0) {
    return;
  }
  yield* checkpointStore
    .deleteCheckpointRefs({
      cwd: metadata.cwd,
      checkpointRefs: metadata.checkpointRefs,
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to delete thread checkpoint refs during hard delete", {
          threadId,
          cwd: metadata.cwd,
          cause,
        }),
      ),
    );
});

/**
 * Delete every durable row owned by a thread while deliberately retaining its
 * `hard_deleted_threads` tombstone. This effect is exported for the
 * OrchestrationEngine worker; production callers must use
 * `hardDeleteThreadLocalData` so the deletion stays serialized with commands.
 */
export const purgeHardDeletedThreadPersistence = Effect.fn("purgeHardDeletedThreadPersistence")(
  function* (input: { readonly threadId: ThreadId }) {
    const sql = yield* SqlClient.SqlClient;

    // Desktop and daemon usually share a database, but remote/supervisor
    // deployments may not. The authenticated daemon RPC purges its own store;
    // this second idempotent pass covers daemon rows in the orchestration DB
    // without assuming both processes were configured with the same file.
    yield* purgeProviderDaemonThreadPersistence(input);

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        DELETE FROM provider_subagent_history_bindings
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM provider_subagent_history_roots
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM provider_supervisor_sessions
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM projection_thread_goals
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM projection_pending_approvals
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        UPDATE projection_thread_proposed_plans
        SET implementation_thread_id = NULL
        WHERE implementation_thread_id = ${input.threadId}
          AND thread_id <> ${input.threadId}
      `;
        yield* sql`
        DELETE FROM projection_thread_proposed_plans
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        UPDATE projection_turns
        SET
          source_proposed_plan_thread_id = NULL,
          source_proposed_plan_id = NULL
        WHERE source_proposed_plan_thread_id = ${input.threadId}
          AND thread_id <> ${input.threadId}
      `;
        yield* sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM checkpoint_diff_blobs
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread'
          AND aggregate_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM orchestration_message_identity_hydration
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM orchestration_message_identities
        WHERE thread_id = ${input.threadId}
      `;
        // The compact steer ledgers contain no prompt text, but their thread
        // identities and recovery authority must still be erased explicitly.
        // Candidate/barrier rows would also cascade from event deletion while
        // foreign keys are enabled; explicit cleanup keeps hard delete correct
        // for databases that were opened with FK enforcement disabled.
        yield* sql`
        DELETE FROM orchestration_unsettled_codex_steer_hydration
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM orchestration_unsettled_codex_steer_intents
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM orchestration_codex_steer_recovery_barriers
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM orchestration_codex_steer_control_barriers
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM orchestration_pending_codex_steer_acceptances
        WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM thread_checkpoint_retired_turns WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM thread_checkpoint_request_epochs WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM thread_checkpoint_workspace_fences WHERE thread_id = ${input.threadId}
      `;
        yield* sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${input.threadId}
      `;
      }),
    );

    return { deleted: true as const };
  },
);

/**
 * Permanently delete one Cafe thread using a two-phase engine barrier.
 *
 * The first engine envelope installs the durable identity tombstone and drops
 * the thread from the command read model. File cleanup then runs without
 * blocking unrelated command processing. The second engine envelope purges
 * rows in FIFO order. Any command or stale provider writer arriving between
 * the two phases is rejected by the read model or migration-65 SQL guards.
 */
export const hardDeleteThreadLocalData = Effect.fn("hardDeleteThreadLocalData")(function* (input: {
  readonly threadId: ThreadId;
}) {
  const orchestrationEngine = yield* OrchestrationEngineService;

  yield* orchestrationEngine.retireThreadForHardDelete(input);
  yield* deleteThreadCheckpointRefs(input.threadId);
  yield* deleteThreadAttachments(input.threadId);
  const standaloneWorkspaces = yield* makeStandaloneWorkspaceStore;
  yield* standaloneWorkspaces.remove(input.threadId);
  return yield* orchestrationEngine.purgeHardDeletedThread(input);
});
