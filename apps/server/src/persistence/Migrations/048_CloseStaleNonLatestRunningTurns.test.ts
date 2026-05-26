import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_CloseStaleNonLatestRunningTurns", (it) => {
  it.effect("interrupts stale non-latest running turns and clears their streaming messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });

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
        VALUES
          (
            'thread-stale',
            'project',
            'stale running',
            NULL,
            NULL,
            'turn-newer-completed',
            '2026-05-24T18:46:00.000Z',
            '2026-05-24T18:49:10.000Z'
          ),
          (
            'thread-live',
            'project',
            'live running',
            NULL,
            NULL,
            'turn-live',
            '2026-05-24T19:00:00.000Z',
            '2026-05-24T19:00:10.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES
          (
            'thread-stale',
            'ready',
            'codex',
            'session-stale',
            'provider-thread-stale',
            NULL,
            NULL,
            '2026-05-24T18:49:10.000Z'
          ),
          (
            'thread-live',
            'running',
            'codex',
            'session-live',
            'provider-thread-live',
            'turn-live',
            NULL,
            '2026-05-24T19:00:10.000Z'
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
            'thread-stale',
            'turn-stale-running',
            'user-stale',
            'assistant-stale-streaming',
            'running',
            '2026-05-24T18:46:45.000Z',
            '2026-05-24T18:46:46.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-stale',
            'turn-newer-completed',
            'user-newer',
            'assistant-newer-completed',
            'completed',
            '2026-05-24T18:49:00.000Z',
            '2026-05-24T18:49:01.000Z',
            '2026-05-24T18:49:10.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-live',
            'turn-live',
            'user-live',
            'assistant-live-streaming',
            'running',
            '2026-05-24T19:00:00.000Z',
            '2026-05-24T19:00:01.000Z',
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
        VALUES
          (
            'assistant-stale-streaming',
            'thread-stale',
            'turn-stale-running',
            'assistant',
            'stale partial text',
            NULL,
            1,
            '2026-05-24T18:46:54.000Z',
            '2026-05-24T18:47:04.000Z'
          ),
          (
            'assistant-live-streaming',
            'thread-live',
            'turn-live',
            'assistant',
            'live partial text',
            NULL,
            1,
            '2026-05-24T19:00:02.000Z',
            '2026-05-24T19:00:03.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const turns = yield* sql<{
        readonly threadId: string;
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          completed_at AS "completedAt"
        FROM projection_turns
        ORDER BY turn_id ASC
      `;

      assert.deepStrictEqual(turns, [
        {
          threadId: "thread-live",
          turnId: "turn-live",
          state: "running",
          completedAt: null,
        },
        {
          threadId: "thread-stale",
          turnId: "turn-newer-completed",
          state: "completed",
          completedAt: "2026-05-24T18:49:10.000Z",
        },
        {
          threadId: "thread-stale",
          turnId: "turn-stale-running",
          state: "interrupted",
          completedAt: "2026-05-24T18:49:00.000Z",
        },
      ]);

      const messages = yield* sql<{
        readonly messageId: string;
        readonly isStreaming: number;
        readonly updatedAt: string;
      }>`
        SELECT
          message_id AS "messageId",
          is_streaming AS "isStreaming",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY message_id ASC
      `;

      assert.deepStrictEqual(messages, [
        {
          messageId: "assistant-live-streaming",
          isStreaming: 1,
          updatedAt: "2026-05-24T19:00:03.000Z",
        },
        {
          messageId: "assistant-stale-streaming",
          isStreaming: 0,
          updatedAt: "2026-05-24T18:49:00.000Z",
        },
      ]);
    }),
  );
});
