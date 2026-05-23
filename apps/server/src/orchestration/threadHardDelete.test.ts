import { CheckpointRef, ProjectId, ThreadId } from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CheckpointStore,
  type DeleteCheckpointRefsInput,
} from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { hardDeleteThreadLocalData } from "./threadHardDelete.ts";

const checkpointDeleteCalls: Array<DeleteCheckpointRefsInput> = [];

const checkpointStoreLayer = Layer.succeed(CheckpointStore, {
  isGitRepository: () => Effect.succeed(true),
  captureCheckpoint: () => Effect.void,
  hasCheckpointRef: () => Effect.succeed(true),
  restoreCheckpoint: () => Effect.succeed(true),
  diffCheckpoints: () => Effect.succeed(""),
  deleteCheckpointRefs: (input) =>
    Effect.sync(() => {
      checkpointDeleteCalls.push(input);
    }),
});

const repositoryIdentityResolverLayer = Layer.succeed(RepositoryIdentityResolver, {
  resolve: () => Effect.succeed(null),
});

const testLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(repositoryIdentityResolverLayer),
  Layer.provideMerge(checkpointStoreLayer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cafe-hard-delete-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

it.layer(Layer.fresh(testLayer))("hardDeleteThreadLocalData", (it) => {
  it.effect("removes local thread data and preserves unrelated rows", () =>
    Effect.gen(function* () {
      checkpointDeleteCalls.length = 0;

      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const targetThreadId = ThreadId.make("hard-delete-thread");
      const survivorThreadId = ThreadId.make("survivor-thread");
      const projectId = ProjectId.make("project-hard-delete");
      const now = "2026-05-22T00:00:00.000Z";
      const deletedAt = "2026-05-22T00:01:00.000Z";
      const modelSelectionJson = '{"instanceId":"codex","model":"gpt-5-codex"}';
      const attachmentId = "hard-delete-thread-00000000-0000-4000-8000-000000000001";
      const survivorAttachmentId = "survivor-thread-00000000-0000-4000-8000-000000000002";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      const survivorAttachmentPath = path.join(
        config.attachmentsDir,
        `${survivorAttachmentId}.png`,
      );

      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "delete me");
      yield* fileSystem.writeFileString(survivorAttachmentPath, "keep me");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${projectId},
          'Project Hard Delete',
          '/tmp/project-hard-delete',
          ${modelSelectionJson},
          '[]',
          ${now},
          ${now},
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            ${targetThreadId},
            ${projectId},
            'Target Deleted Thread',
            ${modelSelectionJson},
            'full-access',
            'default',
            NULL,
            '/tmp/project-hard-delete/worktree',
            'turn-hard-delete',
            ${now},
            1,
            0,
            0,
            ${now},
            ${now},
            ${deletedAt}
          ),
          (
            ${survivorThreadId},
            ${projectId},
            'Survivor Thread',
            ${modelSelectionJson},
            'full-access',
            'default',
            NULL,
            NULL,
            'turn-survivor',
            ${now},
            0,
            0,
            0,
            ${now},
            ${now},
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-hard-delete',
            ${targetThreadId},
            'turn-hard-delete',
            'assistant',
            'erase this',
            '[{"type":"image","id":"hard-delete-thread-00000000-0000-4000-8000-000000000001","name":"delete.png","mimeType":"image/png","sizeBytes":9}]',
            0,
            ${now},
            ${now}
          ),
          (
            'message-survivor',
            ${survivorThreadId},
            'turn-survivor',
            'assistant',
            'keep this',
            '[]',
            0,
            ${now},
            ${now}
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES
          (
            'activity-hard-delete',
            ${targetThreadId},
            'turn-hard-delete',
            'info',
            'runtime.note',
            'erase this activity',
            '{"secret":"remove"}',
            ${now}
          ),
          (
            'activity-survivor',
            ${survivorThreadId},
            'turn-survivor',
            'info',
            'runtime.note',
            'keep this activity',
            '{}',
            ${now}
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES
          (
            ${targetThreadId},
            'idle',
            'codex',
            'codex',
            'provider-session-hard-delete',
            'provider-thread-hard-delete',
            'full-access',
            NULL,
            NULL,
            ${now}
          ),
          (
            ${survivorThreadId},
            'idle',
            'codex',
            'codex',
            'provider-session-survivor',
            'provider-thread-survivor',
            'full-access',
            NULL,
            NULL,
            ${now}
          )
      `;

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES
          (
            ${targetThreadId},
            'codex',
            'codex',
            'codex',
            'full-access',
            'idle',
            ${now},
            '{"cursor":"erase"}',
            '{"payload":"erase"}'
          ),
          (
            ${survivorThreadId},
            'codex',
            'codex',
            'codex',
            'full-access',
            'idle',
            ${now},
            '{"cursor":"keep"}',
            '{"payload":"keep"}'
          )
      `;

      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        VALUES
          (
            'approval-hard-delete',
            ${targetThreadId},
            'turn-hard-delete',
            'pending',
            NULL,
            ${now},
            NULL
          ),
          (
            'approval-survivor',
            ${survivorThreadId},
            'turn-survivor',
            'pending',
            NULL,
            ${now},
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES
          (
            'plan-hard-delete',
            ${targetThreadId},
            'turn-hard-delete',
            '# Erase',
            NULL,
            NULL,
            ${now},
            ${now}
          ),
          (
            'plan-survivor',
            ${survivorThreadId},
            'turn-survivor',
            '# Keep',
            ${now},
            ${targetThreadId},
            ${now},
            ${now}
          )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            ${targetThreadId},
            'turn-hard-delete',
            NULL,
            NULL,
            NULL,
            'message-hard-delete',
            'completed',
            ${now},
            ${now},
            ${now},
            1,
            'checkpoint-hard-delete',
            'ready',
            '[{"path":"README.md","kind":"modified","additions":1,"deletions":0}]'
          ),
          (
            ${survivorThreadId},
            'turn-survivor',
            NULL,
            ${targetThreadId},
            'plan-hard-delete',
            'message-survivor',
            'completed',
            ${now},
            ${now},
            ${now},
            1,
            'checkpoint-survivor',
            'ready',
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO checkpoint_diff_blobs (
          thread_id,
          from_turn_count,
          to_turn_count,
          diff,
          created_at
        )
        VALUES
          (${targetThreadId}, 0, 1, 'secret diff', ${now}),
          (${survivorThreadId}, 0, 1, 'survivor diff', ${now})
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'event-hard-delete',
            'thread',
            ${targetThreadId},
            1,
            'thread.message-sent',
            ${now},
            'command-hard-delete',
            NULL,
            'command-hard-delete',
            'system',
            '{"text":"erase"}',
            '{}'
          ),
          (
            'event-survivor',
            'thread',
            ${survivorThreadId},
            1,
            'thread.message-sent',
            ${now},
            'command-survivor',
            NULL,
            'command-survivor',
            'system',
            '{"text":"keep"}',
            '{}'
          )
      `;

      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error
        )
        VALUES
          ('command-hard-delete', 'thread', ${targetThreadId}, ${now}, 1, 'accepted', NULL),
          ('command-survivor', 'thread', ${survivorThreadId}, ${now}, 2, 'accepted', NULL)
      `;

      const deletedBefore = yield* snapshotQuery.getDeletedShellSnapshot();
      assert.deepEqual(
        deletedBefore.threads.map((thread) => thread.id),
        [targetThreadId],
      );
      assert.isTrue(yield* exists(attachmentPath));
      assert.isTrue(yield* exists(survivorAttachmentPath));

      const result = yield* hardDeleteThreadLocalData({ threadId: targetThreadId });
      assert.deepEqual(result, { deleted: true });

      const deletedAfter = yield* snapshotQuery.getDeletedShellSnapshot();
      assert.deepEqual(deletedAfter.threads, []);
      assert.isFalse(yield* exists(attachmentPath));
      assert.isTrue(yield* exists(survivorAttachmentPath));

      const survivorDetail = yield* snapshotQuery.getThreadDetailById(survivorThreadId);
      assert.isTrue(Option.isSome(survivorDetail));
      assert.equal(survivorDetail.pipe(Option.getOrThrow).messages[0]?.text, "keep this");

      const targetProjectionRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM projection_threads
        WHERE thread_id = ${targetThreadId}
      `;
      const targetDetailRows = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM projection_pending_approvals WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM projection_thread_proposed_plans WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM projection_turns WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM checkpoint_diff_blobs WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_command_receipts WHERE aggregate_kind = 'thread' AND aggregate_id = ${targetThreadId})
          AS "count"
      `;
      assert.equal(targetProjectionRows[0]?.count, 0);
      assert.equal(targetDetailRows[0]?.count, 0);

      const survivorPlanRows = yield* sql<{ readonly implementationThreadId: string | null }>`
        SELECT implementation_thread_id AS "implementationThreadId"
        FROM projection_thread_proposed_plans
        WHERE plan_id = 'plan-survivor'
      `;
      const survivorTurnRows = yield* sql<{
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
      }>`
        SELECT
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE thread_id = ${survivorThreadId}
      `;
      assert.equal(survivorPlanRows[0]?.implementationThreadId, null);
      assert.equal(survivorTurnRows[0]?.sourceProposedPlanThreadId, null);
      assert.equal(survivorTurnRows[0]?.sourceProposedPlanId, null);

      assert.deepEqual(checkpointDeleteCalls, [
        {
          cwd: "/tmp/project-hard-delete/worktree",
          checkpointRefs: [CheckpointRef.make("checkpoint-hard-delete")],
        },
      ]);
    }),
  );
});
