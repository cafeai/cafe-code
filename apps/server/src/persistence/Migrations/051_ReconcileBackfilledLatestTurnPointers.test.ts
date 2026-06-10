import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("051_ReconcileBackfilledLatestTurnPointers", (it) => {
  it.effect("repairs thread shells regressed by late older provider backfill", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 50 });

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
        )
        VALUES (
          'thread-late-backfill',
          'project',
          'Late Backfill',
          NULL,
          NULL,
          'turn-old',
          '2026-05-26T11:00:00.000Z',
          '2026-05-26T11:15:00.000Z'
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
        VALUES
          (
            'thread-late-backfill',
            'turn-old',
            NULL,
            'assistant-old',
            'completed',
            '2026-05-26T11:00:00.000Z',
            '2026-05-26T11:00:01.000Z',
            '2026-05-26T11:15:00.000Z',
            1,
            'refs/checkpoints/old',
            'ready',
            '[]'
          ),
          (
            'thread-late-backfill',
            'turn-new',
            NULL,
            'assistant-new',
            'completed',
            '2026-05-26T12:00:00.000Z',
            '2026-05-26T12:00:01.000Z',
            '2026-05-26T12:10:00.000Z',
            2,
            'refs/checkpoints/new',
            'ready',
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
          'thread-late-backfill',
          'ready',
          'codex',
          'codex_astrea',
          'full-access',
          NULL,
          'stale error',
          '2026-05-26T11:15:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 51 });

      const rows = yield* sql<{
        readonly latestTurnId: string | null;
        readonly threadUpdatedAt: string;
        readonly sessionStatus: string;
        readonly activeTurnId: string | null;
        readonly lastError: string | null;
        readonly sessionUpdatedAt: string;
      }>`
        SELECT
          threads.latest_turn_id AS "latestTurnId",
          threads.updated_at AS "threadUpdatedAt",
          sessions.status AS "sessionStatus",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "sessionUpdatedAt"
        FROM projection_threads threads
        JOIN projection_thread_sessions sessions
          ON sessions.thread_id = threads.thread_id
        WHERE threads.thread_id = 'thread-late-backfill'
      `;

      assert.deepEqual(rows, [
        {
          latestTurnId: "turn-new",
          threadUpdatedAt: "2026-05-26T12:10:00.000Z",
          sessionStatus: "ready",
          activeTurnId: null,
          lastError: null,
          sessionUpdatedAt: "2026-05-26T12:10:00.000Z",
        },
      ]);
    }),
  );
});
