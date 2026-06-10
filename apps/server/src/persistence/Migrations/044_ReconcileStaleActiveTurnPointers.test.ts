import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("044_ReconcileStaleActiveTurnPointers", (it) => {
  it.effect(
    "repairs sessions and shell latest-turn pointers that still reference old active turns",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 43 });

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
            'thread-stale-active',
            'project',
            'Stale Active',
            '{"instanceId":"codex","model":"gpt-5"}',
            'turn-old',
            '2026-05-24T20:00:00.000Z',
            '2026-05-24T20:01:00.000Z'
          ),
          (
            'thread-current-running',
            'project',
            'Current Running',
            '{"instanceId":"codex","model":"gpt-5"}',
            'turn-current',
            '2026-05-24T21:00:00.000Z',
            '2026-05-24T21:00:02.000Z'
          ),
          (
            'thread-terminal-active',
            'project',
            'Terminal Active',
            '{"instanceId":"codex","model":"gpt-5"}',
            'turn-terminal',
            '2026-05-24T22:00:00.000Z',
            '2026-05-24T22:00:02.000Z'
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
            'thread-stale-active',
            'turn-old',
            NULL,
            NULL,
            'running',
            '2026-05-24T20:00:01.000Z',
            '2026-05-24T20:00:02.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-stale-active',
            'turn-newer',
            NULL,
            NULL,
            'interrupted',
            '2026-05-24T20:10:00.000Z',
            '2026-05-24T20:10:01.000Z',
            '2026-05-24T20:10:30.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-current-running',
            'turn-current',
            NULL,
            NULL,
            'running',
            '2026-05-24T21:00:01.000Z',
            '2026-05-24T21:00:02.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-terminal-active',
            'turn-terminal',
            NULL,
            NULL,
            'completed',
            '2026-05-24T22:00:01.000Z',
            '2026-05-24T22:00:02.000Z',
            '2026-05-24T22:00:03.000Z',
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
            'thread-stale-active',
            'running',
            'codex',
            'codex',
            'full-access',
            'turn-old',
            NULL,
            '2026-05-24T20:00:02.000Z'
          ),
          (
            'thread-current-running',
            'running',
            'codex',
            'codex',
            'full-access',
            'turn-current',
            NULL,
            '2026-05-24T21:00:02.000Z'
          ),
          (
            'thread-terminal-active',
            'running',
            'codex',
            'codex',
            'full-access',
            'turn-terminal',
            'old terminal error',
            '2026-05-24T22:00:02.000Z'
          )
      `;

        yield* runMigrations({ toMigrationInclusive: 44 });

        const sessionRows = yield* sql<{
          readonly threadId: string;
          readonly status: string;
          readonly activeTurnId: string | null;
          readonly lastError: string | null;
          readonly updatedAt: string;
        }>`
        SELECT
          thread_id AS "threadId",
          status,
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `;
        const threadRows = yield* sql<{
          readonly threadId: string;
          readonly latestTurnId: string | null;
        }>`
        SELECT
          thread_id AS "threadId",
          latest_turn_id AS "latestTurnId"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;
        const oldTurnRows = yield* sql<{
          readonly state: string;
          readonly completedAt: string | null;
        }>`
        SELECT
          state,
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = 'thread-stale-active'
          AND turn_id = 'turn-old'
      `;

        assert.deepStrictEqual(sessionRows, [
          {
            threadId: "thread-current-running",
            status: "running",
            activeTurnId: "turn-current",
            lastError: null,
            updatedAt: "2026-05-24T21:00:02.000Z",
          },
          {
            threadId: "thread-stale-active",
            status: "interrupted",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-05-24T20:10:30.000Z",
          },
          {
            threadId: "thread-terminal-active",
            status: "ready",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-05-24T22:00:03.000Z",
          },
        ]);
        assert.deepStrictEqual(threadRows, [
          {
            threadId: "thread-current-running",
            latestTurnId: "turn-current",
          },
          {
            threadId: "thread-stale-active",
            latestTurnId: "turn-newer",
          },
          {
            threadId: "thread-terminal-active",
            latestTurnId: "turn-terminal",
          },
        ]);
        assert.deepStrictEqual(oldTurnRows, [
          {
            state: "interrupted",
            completedAt: "2026-05-24T20:10:00.000Z",
          },
        ]);
      }),
  );
});
