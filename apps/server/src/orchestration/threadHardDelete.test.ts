import { CheckpointRef, ProjectId, ThreadId } from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CheckpointStore,
  type DeleteCheckpointRefsInput,
} from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { hydrateLegacyUnsettledCodexSteerIntentsForThread } from "./codexSteerIntentLedger.ts";
import { hydrateLegacyMessageIdentitiesForThread } from "./messageIdentityLedger.ts";
import {
  hardDeleteThreadLocalData,
  purgeHardDeletedThreadPersistence,
} from "./threadHardDelete.ts";

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

const hardDeleteEngineLayer = Layer.effect(
  OrchestrationEngineService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die("unused"),
      retireThreadForHardDelete: ({ threadId }) =>
        sql`
          INSERT INTO hard_deleted_threads (thread_id, deleted_at)
          VALUES (${threadId}, '2026-05-22T00:01:00.000Z')
          ON CONFLICT (thread_id) DO NOTHING
        `.pipe(Effect.orDie, Effect.asVoid),
      purgeHardDeletedThread: (input) =>
        purgeHardDeletedThreadPersistence(input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.orDie,
        ),
      diagnosticsSnapshot: Effect.die("unused"),
      streamDomainEvents: Stream.empty,
    } satisfies OrchestrationEngineShape;
  }),
);

const testLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(hardDeleteEngineLayer),
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
        INSERT INTO provider_supervisor_sessions (
          session_id,
          supervisor_id,
          owner_id,
          owner_kind,
          thread_id,
          protocol_version,
          io_generation,
          raw_byte_cursor,
          parser_cursor,
          transfer_state,
          created_at,
          updated_at
        ) VALUES
          (
            'supervisor-session-hard-delete',
            'supervisor-hard-delete',
            'owner-hard-delete',
            'backend',
            ${targetThreadId},
            1,
            1,
            0,
            0,
            'attached',
            ${now},
            ${now}
          ),
          (
            'supervisor-session-survivor',
            'supervisor-survivor',
            'owner-survivor',
            'backend',
            ${survivorThreadId},
            1,
            1,
            0,
            0,
            'attached',
            ${now},
            ${now}
          )
      `;

      yield* sql`
        INSERT INTO provider_subagent_history_roots (
          thread_id,
          turn_id,
          provider_name,
          provider_instance_id,
          resume_cursor_json,
          cwd,
          created_at,
          updated_at
        )
        VALUES
          (
            ${targetThreadId},
            'turn-hard-delete',
            'codex',
            'codex',
            '{"threadId":"erase"}',
            '/tmp/erase',
            ${now},
            ${now}
          ),
          (
            ${survivorThreadId},
            'turn-survivor',
            'codex',
            'codex',
            '{"threadId":"keep"}',
            '/tmp/keep',
            ${now},
            ${now}
          )
      `;

      yield* sql`
        INSERT INTO provider_subagent_history_bindings (
          thread_id,
          turn_id,
          subagent_id,
          history_id,
          created_at,
          updated_at
        )
        VALUES
          (
            ${targetThreadId},
            'turn-hard-delete',
            'child-hard-delete',
            '',
            ${now},
            ${now}
          ),
          (
            ${survivorThreadId},
            'turn-survivor',
            'child-survivor',
            '',
            ${now},
            ${now}
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
            ${now},
            ${targetThreadId},
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
            ${targetThreadId},
            'plan-hard-delete',
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
            '{"messageId":"message-event-hard-delete","role":"user","text":"erase","attachments":[]}',
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
            '{"messageId":"message-event-survivor","role":"user","text":"keep","attachments":[]}',
            '{}'
          )
      `;

      yield* sql`
        INSERT INTO orchestration_message_identity_hydration (
          thread_id,
          through_sequence
        )
        VALUES
          (${targetThreadId}, 0),
          (${survivorThreadId}, 0)
      `;

      // Exercise all compact steer-ledger cleanup paths. Candidate and barrier
      // rows reference event sequences, while hydration is standalone state
      // that hard delete must remove explicitly.
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
            'event-hard-delete-steer',
            'thread',
            ${targetThreadId},
            2,
            'thread.turn-steer-requested',
            ${now},
            'command-hard-delete-steer',
            NULL,
            'command-hard-delete-steer',
            'client',
            ${JSON.stringify({
              threadId: targetThreadId,
              messageId: "message-hard-delete-steer",
              expectedTurnId: "turn-hard-delete",
              createdAt: now,
            })},
            '{}'
          ),
          (
            'event-hard-delete-accepted',
            'thread',
            ${targetThreadId},
            3,
            'thread.activity-appended',
            ${now},
            'command-hard-delete-accepted',
            NULL,
            'command-hard-delete-steer',
            'server',
            ${JSON.stringify({
              threadId: targetThreadId,
              activity: {
                id: "activity-hard-delete-accepted",
                kind: "provider.turn.steer.accepted",
                turnId: "turn-hard-delete",
                createdAt: now,
                payload: {
                  provider: "codex",
                  messageId: "message-hard-delete-barrier",
                  acceptedTurnId: "turn-hard-delete",
                  clientCorrelationId: null,
                },
              },
            })},
            '{}'
          ),
          (
            'event-survivor-steer',
            'thread',
            ${survivorThreadId},
            2,
            'thread.turn-steer-requested',
            ${now},
            'command-survivor-steer',
            NULL,
            'command-survivor-steer',
            'client',
            ${JSON.stringify({
              threadId: survivorThreadId,
              messageId: "message-survivor-steer",
              expectedTurnId: "turn-survivor",
              createdAt: now,
            })},
            '{}'
          ),
          (
            'event-survivor-accepted',
            'thread',
            ${survivorThreadId},
            3,
            'thread.activity-appended',
            ${now},
            'command-survivor-accepted',
            NULL,
            'command-survivor-steer',
            'server',
            ${JSON.stringify({
              threadId: survivorThreadId,
              activity: {
                id: "activity-survivor-accepted",
                kind: "provider.turn.steer.accepted",
                turnId: "turn-survivor",
                createdAt: now,
                payload: {
                  provider: "codex",
                  messageId: "message-survivor-barrier",
                  acceptedTurnId: "turn-survivor",
                  clientCorrelationId: null,
                },
              },
            })},
            '{}'
          )
      `;

      yield* sql`
        INSERT INTO orchestration_unsettled_codex_steer_hydration (
          thread_id,
          tail_floor_sequence,
          through_sequence
        )
        VALUES
          (${targetThreadId}, 0, 0),
          (${survivorThreadId}, 0, 0)
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

      // Model an overlapping older backend attempting lazy hydration after
      // the permanent tombstone committed. Neither helper may recreate its
      // standalone watermark row after hard delete.
      yield* hydrateLegacyMessageIdentitiesForThread(sql, targetThreadId);
      const [steerState] = yield* sql<{ readonly cutoff: number }>`
        SELECT legacy_cutoff_sequence AS cutoff
        FROM orchestration_unsettled_codex_steer_state
        WHERE singleton_id = 1
      `;
      assert.isDefined(steerState);
      yield* hydrateLegacyUnsettledCodexSteerIntentsForThread(
        sql,
        targetThreadId,
        steerState!.cutoff,
      );

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
          (SELECT COUNT(*) FROM provider_supervisor_sessions WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM provider_subagent_history_roots WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM provider_subagent_history_bindings WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM projection_pending_approvals WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM projection_thread_proposed_plans WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM projection_turns WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM checkpoint_diff_blobs WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_message_identities WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_message_identity_hydration WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_unsettled_codex_steer_hydration WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_unsettled_codex_steer_intents WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_codex_steer_recovery_barriers WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_pending_codex_steer_acceptances WHERE thread_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${targetThreadId}) +
          (SELECT COUNT(*) FROM orchestration_command_receipts WHERE aggregate_kind = 'thread' AND aggregate_id = ${targetThreadId})
          AS "count"
      `;
      assert.equal(targetProjectionRows[0]?.count, 0);
      assert.equal(targetDetailRows[0]?.count, 0);

      const targetTombstones = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM hard_deleted_threads
        WHERE thread_id = ${targetThreadId}
      `;
      assert.equal(targetTombstones[0]?.count, 1);

      const survivorHistoryRows = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM provider_subagent_history_roots WHERE thread_id = ${survivorThreadId}) +
          (SELECT COUNT(*) FROM provider_subagent_history_bindings WHERE thread_id = ${survivorThreadId})
          AS "count"
      `;
      assert.equal(survivorHistoryRows[0]?.count, 2);

      const survivorIdentityRows = yield* sql<{
        readonly messageIdentities: number;
        readonly messageHydration: number;
        readonly steerHydration: number;
        readonly unsettledSteers: number;
        readonly recoveryBarriers: number;
        readonly pendingAcceptances: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_message_identities WHERE thread_id = ${survivorThreadId}) AS "messageIdentities",
          (SELECT COUNT(*) FROM orchestration_message_identity_hydration WHERE thread_id = ${survivorThreadId}) AS "messageHydration",
          (SELECT COUNT(*) FROM orchestration_unsettled_codex_steer_hydration WHERE thread_id = ${survivorThreadId}) AS "steerHydration",
          (SELECT COUNT(*) FROM orchestration_unsettled_codex_steer_intents WHERE thread_id = ${survivorThreadId}) AS "unsettledSteers",
          (SELECT COUNT(*) FROM orchestration_codex_steer_recovery_barriers WHERE thread_id = ${survivorThreadId}) AS "recoveryBarriers",
          (SELECT COUNT(*) FROM orchestration_pending_codex_steer_acceptances WHERE thread_id = ${survivorThreadId}) AS "pendingAcceptances"
      `;
      // The accepted fixture intentionally lacks an intentSequence, so the
      // strict compact ledger does not authorize a pending acceptance or
      // recovery barrier from it. The valid survivor message, hydration
      // watermarks, and still-unsettled steer must remain untouched.
      assert.deepEqual(survivorIdentityRows, [
        {
          messageIdentities: 1,
          messageHydration: 1,
          steerHydration: 1,
          unsettledSteers: 1,
          recoveryBarriers: 0,
          pendingAcceptances: 0,
        },
      ]);

      const survivorSupervisorRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM provider_supervisor_sessions
        WHERE thread_id = ${survivorThreadId}
      `;
      assert.equal(survivorSupervisorRows[0]?.count, 1);

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
