import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("037_ReconcileCompletedLatestTurnPostCompletionEvents", (it) => {
  it.effect("moves non-running completed latest turns after their last same-turn event", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });

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
        VALUES
          (
            'thread-ready-late-events',
            'project',
            'Ready late events',
            '{"provider":"codex","model":"gpt-5"}',
            'turn-ready',
            '2026-04-06T00:00:00.000Z',
            '2026-04-06T00:00:02.000Z'
          ),
          (
            'thread-running-late-events',
            'project',
            'Running late events',
            '{"provider":"codex","model":"gpt-5"}',
            'turn-running',
            '2026-04-06T00:10:00.000Z',
            '2026-04-06T00:10:02.000Z'
          ),
          (
            'thread-old-turn-late-events',
            'project',
            'Old turn late events',
            '{"provider":"codex","model":"gpt-5"}',
            'turn-latest',
            '2026-04-06T00:20:00.000Z',
            '2026-04-06T00:20:02.000Z'
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
            'thread-ready-late-events',
            'turn-ready',
            NULL,
            NULL,
            'completed',
            '2026-04-06T00:00:00.000Z',
            '2026-04-06T00:00:01.000Z',
            '2026-04-06T00:00:02.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-running-late-events',
            'turn-running',
            NULL,
            NULL,
            'completed',
            '2026-04-06T00:10:00.000Z',
            '2026-04-06T00:10:01.000Z',
            '2026-04-06T00:10:02.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-old-turn-late-events',
            'turn-old',
            NULL,
            NULL,
            'completed',
            '2026-04-06T00:20:00.000Z',
            '2026-04-06T00:20:01.000Z',
            '2026-04-06T00:20:02.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-old-turn-late-events',
            'turn-latest',
            NULL,
            NULL,
            'completed',
            '2026-04-06T00:21:00.000Z',
            '2026-04-06T00:21:01.000Z',
            '2026-04-06T00:21:02.000Z',
            NULL,
            NULL,
            NULL,
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
        VALUES
          (
            'thread-ready-late-events',
            'ready',
            'codex',
            'codex',
            'full-access',
            NULL,
            NULL,
            '2026-04-06T00:00:02.500Z'
          ),
          (
            'thread-running-late-events',
            'running',
            'codex',
            'codex',
            'full-access',
            'turn-running',
            NULL,
            '2026-04-06T00:10:02.500Z'
          ),
          (
            'thread-old-turn-late-events',
            'ready',
            'codex',
            'codex',
            'full-access',
            NULL,
            NULL,
            '2026-04-06T00:21:02.500Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-ready',
            'thread-ready-late-events',
            'turn-ready',
            'assistant',
            'late message',
            0,
            '2026-04-06T00:00:03.000Z',
            '2026-04-06T00:00:03.000Z'
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
            'activity-ready',
            'thread-ready-late-events',
            'turn-ready',
            'tool',
            'tool.completed',
            'late activity',
            '{}',
            '2026-04-06T00:00:04.000Z'
          ),
          (
            'activity-running',
            'thread-running-late-events',
            'turn-running',
            'tool',
            'tool.completed',
            'late running activity',
            '{}',
            '2026-04-06T00:10:04.000Z'
          ),
          (
            'activity-old',
            'thread-old-turn-late-events',
            'turn-old',
            'tool',
            'tool.completed',
            'late old activity',
            '{}',
            '2026-04-06T00:20:04.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 37 });

      const turns = yield* sql<{
        readonly threadId: string;
        readonly turnId: string;
        readonly completedAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          completed_at AS "completedAt"
        FROM projection_turns
        ORDER BY thread_id ASC, turn_id ASC
      `;

      assert.deepStrictEqual(turns, [
        {
          threadId: "thread-old-turn-late-events",
          turnId: "turn-latest",
          completedAt: "2026-04-06T00:21:02.000Z",
        },
        {
          threadId: "thread-old-turn-late-events",
          turnId: "turn-old",
          completedAt: "2026-04-06T00:20:02.000Z",
        },
        {
          threadId: "thread-ready-late-events",
          turnId: "turn-ready",
          completedAt: "2026-04-06T00:00:04.000Z",
        },
        {
          threadId: "thread-running-late-events",
          turnId: "turn-running",
          completedAt: "2026-04-06T00:10:02.000Z",
        },
      ]);

      const rows = yield* sql<{
        readonly threadId: string;
        readonly threadUpdatedAt: string;
        readonly sessionUpdatedAt: string | null;
      }>`
        SELECT
          threads.thread_id AS "threadId",
          threads.updated_at AS "threadUpdatedAt",
          sessions.updated_at AS "sessionUpdatedAt"
        FROM projection_threads threads
        LEFT JOIN projection_thread_sessions sessions
          ON sessions.thread_id = threads.thread_id
        ORDER BY threads.thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-old-turn-late-events",
          threadUpdatedAt: "2026-04-06T00:21:02.000Z",
          sessionUpdatedAt: "2026-04-06T00:21:02.500Z",
        },
        {
          threadId: "thread-ready-late-events",
          threadUpdatedAt: "2026-04-06T00:00:04.000Z",
          sessionUpdatedAt: "2026-04-06T00:00:04.000Z",
        },
        {
          threadId: "thread-running-late-events",
          threadUpdatedAt: "2026-04-06T00:10:02.000Z",
          sessionUpdatedAt: "2026-04-06T00:10:02.500Z",
        },
      ]);
    }),
  );
});
