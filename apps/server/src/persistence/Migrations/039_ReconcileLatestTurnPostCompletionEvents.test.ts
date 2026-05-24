import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_ReconcileLatestTurnPostCompletionEvents", (it) => {
  it.effect("reconciles completed latest turns created after the earlier one-shot repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          latest_turn_id,
          created_at,
          updated_at
        )
        VALUES (
          'thread-late-after-038',
          'project',
          'Late after 038',
          '{"provider":"codex","model":"gpt-5"}',
          'turn-late',
          '2026-05-24T10:00:00.000Z',
          '2026-05-24T10:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
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
        VALUES (
          'thread-late-after-038',
          'turn-late',
          NULL,
          NULL,
          'completed',
          '2026-05-24T10:00:00.000Z',
          '2026-05-24T10:00:01.000Z',
          '2026-05-24T10:00:02.000Z',
          1,
          'provider-diff:late',
          'missing',
          '[]'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-late-after-038',
          'ready',
          'codex',
          'codex',
          'full-access',
          NULL,
          NULL,
          '2026-05-24T10:00:02.000Z'
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
        VALUES (
          'activity-late-after-038',
          'thread-late-after-038',
          'turn-late',
          'tool',
          'tool.completed',
          'late activity',
          '{}',
          '2026-05-24T10:00:05.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const rows = yield* sql<{
        readonly completedAt: string | null;
        readonly sessionUpdatedAt: string | null;
        readonly threadUpdatedAt: string | null;
      }>`
        SELECT
          turns.completed_at AS "completedAt",
          sessions.updated_at AS "sessionUpdatedAt",
          threads.updated_at AS "threadUpdatedAt"
        FROM projection_turns turns
        JOIN projection_threads threads
          ON threads.thread_id = turns.thread_id
        JOIN projection_thread_sessions sessions
          ON sessions.thread_id = turns.thread_id
        WHERE turns.thread_id = 'thread-late-after-038'
      `;

      assert.deepStrictEqual(rows, [
        {
          completedAt: "2026-05-24T10:00:05.000Z",
          sessionUpdatedAt: "2026-05-24T10:00:05.000Z",
          threadUpdatedAt: "2026-05-24T10:00:05.000Z",
        },
      ]);
    }),
  );
});
