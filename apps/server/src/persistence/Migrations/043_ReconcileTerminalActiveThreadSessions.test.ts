import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ReconcileTerminalActiveThreadSessions", (it) => {
  it.effect("clears sessions that still point at terminal active turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

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
            'thread-interrupted-active',
            'project',
            'Interrupted Active',
            '{"instanceId":"codex","model":"gpt-5"}',
            'turn-interrupted',
            '2026-05-24T15:32:41.260Z',
            '2026-05-24T15:44:04.415Z'
          ),
          (
            'thread-running-active',
            'project',
            'Running Active',
            '{"instanceId":"codex","model":"gpt-5"}',
            'turn-running',
            '2026-05-24T15:40:00.000Z',
            '2026-05-24T15:40:01.000Z'
          ),
          (
            'thread-running-null-active-terminal-latest',
            'project',
            'Running Null Active',
            '{"instanceId":"codex","model":"gpt-5"}',
            'turn-ready',
            '2026-05-24T15:50:00.000Z',
            '2026-05-24T15:50:02.000Z'
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
            'thread-interrupted-active',
            'turn-interrupted',
            NULL,
            NULL,
            'interrupted',
            '2026-05-24T15:32:41.260Z',
            '2026-05-24T15:32:41.409Z',
            '2026-05-24T15:44:04.415Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-running-active',
            'turn-running',
            NULL,
            NULL,
            'running',
            '2026-05-24T15:40:00.000Z',
            '2026-05-24T15:40:01.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-running-null-active-terminal-latest',
            'turn-ready',
            NULL,
            NULL,
            'completed',
            '2026-05-24T15:50:00.000Z',
            '2026-05-24T15:50:01.000Z',
            '2026-05-24T15:50:02.000Z',
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
            'thread-interrupted-active',
            'running',
            'codex',
            'codex',
            'full-access',
            'turn-interrupted',
            NULL,
            '2026-05-24T15:32:36.027Z'
          ),
          (
            'thread-running-active',
            'running',
            'codex',
            'codex',
            'full-access',
            'turn-running',
            NULL,
            '2026-05-24T15:40:01.000Z'
          ),
          (
            'thread-running-null-active-terminal-latest',
            'running',
            'codex',
            'codex',
            'full-access',
            NULL,
            NULL,
            '2026-05-24T15:50:01.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly activeTurnId: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          thread_id AS "threadId",
          status,
          active_turn_id AS "activeTurnId",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-interrupted-active",
          status: "interrupted",
          activeTurnId: null,
          updatedAt: "2026-05-24T15:44:04.415Z",
        },
        {
          threadId: "thread-running-active",
          status: "running",
          activeTurnId: "turn-running",
          updatedAt: "2026-05-24T15:40:01.000Z",
        },
        {
          threadId: "thread-running-null-active-terminal-latest",
          status: "ready",
          activeTurnId: null,
          updatedAt: "2026-05-24T15:50:02.000Z",
        },
      ]);
    }),
  );
});
