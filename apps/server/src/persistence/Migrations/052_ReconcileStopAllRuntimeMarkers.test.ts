import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_ReconcileStopAllRuntimeMarkers", (it) => {
  it.effect("normalizes interrupted stopAll markers and clears projected active turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });

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
          'thread-stopall-marker',
          'project',
          'runtime stop marker',
          NULL,
          NULL,
          'turn-stopall-marker',
          '2026-05-26T22:18:45.444Z',
          '2026-05-26T22:35:59.607Z'
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
          'thread-stopall-marker',
          'running',
          'codex',
          'codex_astrea',
          'full-access',
          'turn-stopall-marker',
          NULL,
          '2026-05-26T22:35:59.607Z'
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
          'thread-stopall-marker',
          'turn-stopall-marker',
          'user-stopall-marker',
          'assistant-stopall-marker',
          'running',
          '2026-05-26T22:18:45.444Z',
          '2026-05-26T22:18:46.665Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
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
        VALUES (
          'assistant-stopall-marker',
          'thread-stopall-marker',
          'turn-stopall-marker',
          'assistant',
          'partial text',
          NULL,
          1,
          '2026-05-26T22:35:58.647Z',
          '2026-05-26T22:35:59.607Z'
        )
      `;

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json,
          provider_instance_id
        )
        VALUES (
          'thread-stopall-marker',
          'codex',
          'codex',
          'full-access',
          'running',
          '2026-05-26T22:36:41.900Z',
          '{"threadId":"codex-thread"}',
          '{"activeTurnId":"turn-stopall-marker","lastRuntimeEvent":"provider.stopAll","lastRuntimeEventAt":"2026-05-26T22:36:41.900Z"}',
          'codex_astrea'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const rows = yield* sql<{
        readonly runtimeStatus: string;
        readonly runtimeActiveTurnId: string | null;
        readonly sessionStatus: string;
        readonly sessionActiveTurnId: string | null;
        readonly turnState: string;
        readonly turnCompletedAt: string | null;
        readonly messageIsStreaming: number;
      }>`
        SELECT
          runtime.status AS "runtimeStatus",
          json_extract(runtime.runtime_payload_json, '$.activeTurnId') AS "runtimeActiveTurnId",
          sessions.status AS "sessionStatus",
          sessions.active_turn_id AS "sessionActiveTurnId",
          turns.state AS "turnState",
          turns.completed_at AS "turnCompletedAt",
          messages.is_streaming AS "messageIsStreaming"
        FROM provider_session_runtime runtime
        JOIN projection_thread_sessions sessions
          ON sessions.thread_id = runtime.thread_id
        JOIN projection_turns turns
          ON turns.thread_id = runtime.thread_id
         AND turns.turn_id = 'turn-stopall-marker'
        JOIN projection_thread_messages messages
          ON messages.thread_id = runtime.thread_id
         AND messages.message_id = 'assistant-stopall-marker'
        WHERE runtime.thread_id = 'thread-stopall-marker'
      `;

      assert.deepStrictEqual(rows, [
        {
          runtimeStatus: "stopped",
          runtimeActiveTurnId: null,
          sessionStatus: "stopped",
          sessionActiveTurnId: null,
          turnState: "interrupted",
          turnCompletedAt: "2026-05-26T22:36:41.900Z",
          messageIsStreaming: 0,
        },
      ]);
    }),
  );
});
