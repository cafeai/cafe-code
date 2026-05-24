import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ReconcileActiveTurnSessionStatus", (it) => {
  it.effect("restores active-turn session invariants", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });

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
            'thread-ready-running',
            'turn-running',
            NULL,
            NULL,
            'running',
            '2026-04-06T00:00:00.000Z',
            '2026-04-06T00:00:01.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-running-completed',
            'turn-completed',
            NULL,
            NULL,
            'completed',
            '2026-04-06T00:01:00.000Z',
            '2026-04-06T00:01:01.000Z',
            '2026-04-06T00:01:02.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-running-interrupted',
            'turn-interrupted',
            NULL,
            NULL,
            'interrupted',
            '2026-04-06T00:02:00.000Z',
            '2026-04-06T00:02:01.000Z',
            '2026-04-06T00:02:02.000Z',
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
            'thread-ready-running',
            'ready',
            'codex',
            'codex',
            'full-access',
            'turn-running',
            NULL,
            '2026-04-06T00:00:00.500Z'
          ),
          (
            'thread-running-completed',
            'running',
            'codex',
            'codex',
            'full-access',
            'turn-completed',
            NULL,
            '2026-04-06T00:01:01.500Z'
          ),
          (
            'thread-running-interrupted',
            'running',
            'codex',
            'codex',
            'full-access',
            'turn-interrupted',
            NULL,
            '2026-04-06T00:02:01.500Z'
          ),
          (
            'thread-ready-missing',
            'ready',
            'codex',
            'codex',
            'full-access',
            'turn-missing',
            NULL,
            '2026-04-06T00:03:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly activeTurnId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          status,
          active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-ready-missing",
          status: "ready",
          activeTurnId: null,
        },
        {
          threadId: "thread-ready-running",
          status: "running",
          activeTurnId: "turn-running",
        },
        {
          threadId: "thread-running-completed",
          status: "ready",
          activeTurnId: null,
        },
        {
          threadId: "thread-running-interrupted",
          status: "interrupted",
          activeTurnId: null,
        },
      ]);
    }),
  );
});
