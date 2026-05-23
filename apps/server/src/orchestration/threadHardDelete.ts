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

  const checkpointRows = yield* sql<{ readonly checkpointRef: string }>`
    SELECT DISTINCT checkpoint_ref AS "checkpointRef"
    FROM projection_turns
    WHERE thread_id = ${threadId}
      AND checkpoint_ref IS NOT NULL
  `;

  return {
    cwd: threadRow?.worktreePath ?? threadRow?.workspaceRoot ?? null,
    checkpointRefs: checkpointRows.map((row) => CheckpointRef.make(row.checkpointRef)),
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

export const hardDeleteThreadLocalData = Effect.fn("hardDeleteThreadLocalData")(function* (input: {
  readonly threadId: ThreadId;
}) {
  const sql = yield* SqlClient.SqlClient;

  yield* deleteThreadCheckpointRefs(input.threadId);
  yield* deleteThreadAttachments(input.threadId);

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${input.threadId}
      `;
      yield* sql`
        DELETE FROM projection_thread_sessions
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
        DELETE FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${input.threadId}
      `;
      yield* sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${input.threadId}
      `;
    }),
  );

  return { deleted: true };
});
