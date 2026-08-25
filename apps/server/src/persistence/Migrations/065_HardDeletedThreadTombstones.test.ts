import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("065_HardDeletedThreadTombstones", (it) => {
  it.effect("installs an immutable cross-process fence without affecting surviving threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at
        ) VALUES
          (
            'thread-hard-deleted',
            'project-migration-65',
            'Delete me',
            NULL,
            NULL,
            NULL,
            '2026-08-25T00:00:00.000Z',
            '2026-08-25T00:00:00.000Z'
          ),
          (
            'thread-survivor',
            'project-migration-65',
            'Keep me',
            NULL,
            NULL,
            NULL,
            '2026-08-25T00:00:00.000Z',
            '2026-08-25T00:00:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* sql`
        INSERT INTO hard_deleted_threads (thread_id, deleted_at)
        VALUES ('thread-hard-deleted', '2026-08-25T00:01:00.000Z')
      `;

      const staleEventWrite = yield* Effect.result(sql`
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
        ) VALUES (
          'event-after-hard-delete',
          'thread',
          'thread-hard-deleted',
          1,
          'thread.activity-appended',
          '2026-08-25T00:02:00.000Z',
          'command-after-hard-delete',
          NULL,
          'command-after-hard-delete',
          'provider',
          '{}',
          '{}'
        )
      `);
      assert.equal(staleEventWrite._tag, "Failure");

      const staleReceiptWrite = yield* Effect.result(sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error
        ) VALUES (
          'command-after-hard-delete',
          'thread',
          'thread-hard-deleted',
          '2026-08-25T00:02:00.000Z',
          1,
          'rejected',
          'retired'
        )
      `);
      assert.equal(staleReceiptWrite._tag, "Failure");

      const staleProviderWrite = yield* Effect.result(sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        ) VALUES (
          'thread-hard-deleted',
          'codex',
          'codex:default',
          'full-access',
          'running',
          '2026-08-25T00:02:00.000Z',
          NULL,
          NULL
        )
      `);
      assert.equal(staleProviderWrite._tag, "Failure");

      const staleProjectionUpdate = yield* Effect.result(sql`
        UPDATE projection_threads
        SET title = 'Resurrected'
        WHERE thread_id = 'thread-hard-deleted'
      `);
      assert.equal(staleProjectionUpdate._tag, "Failure");

      const staleProjectionInsert = yield* Effect.result(sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        ) VALUES (
          'activity-retired-migration-65',
          'thread-hard-deleted',
          NULL,
          'info',
          'runtime.note',
          'must be rejected',
          '{}',
          '2026-08-25T00:02:00.000Z'
        )
      `);
      assert.equal(staleProjectionInsert._tag, "Failure");

      // A different thread continues through the same guarded tables.
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
        ) VALUES (
          'activity-survivor-migration-65',
          'thread-survivor',
          NULL,
          'info',
          'runtime.note',
          'survivor remains writable',
          '{}',
          '2026-08-25T00:02:00.000Z'
        )
      `;

      const tombstoneDelete = yield* Effect.result(sql`
        DELETE FROM hard_deleted_threads
        WHERE thread_id = 'thread-hard-deleted'
      `);
      assert.equal(tombstoneDelete._tag, "Failure");

      const counts = yield* sql<{
        readonly tombstones: number;
        readonly retiredActivities: number;
        readonly survivorActivities: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM hard_deleted_threads) AS tombstones,
          (
            SELECT COUNT(*)
            FROM projection_thread_activities
            WHERE thread_id = 'thread-hard-deleted'
          ) AS "retiredActivities",
          (
            SELECT COUNT(*)
            FROM projection_thread_activities
            WHERE thread_id = 'thread-survivor'
          ) AS "survivorActivities"
      `;
      assert.deepEqual(counts, [
        {
          tombstones: 1,
          retiredActivities: 0,
          survivorActivities: 1,
        },
      ]);
    }),
  );
});
