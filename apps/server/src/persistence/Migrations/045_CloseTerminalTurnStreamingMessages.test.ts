import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_CloseTerminalTurnStreamingMessages", (it) => {
  it.effect("closes stale streaming messages whose turns are already terminal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 44 });

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
            'assistant-terminal-streaming',
            'thread-terminal',
            'turn-terminal',
            'assistant',
            'partial terminal text',
            NULL,
            1,
            '2026-05-24T23:16:34.769Z',
            '2026-05-24T23:16:38.666Z'
          ),
          (
            'assistant-running-streaming',
            'thread-running',
            'turn-running',
            'assistant',
            'partial running text',
            NULL,
            1,
            '2026-05-24T23:20:00.000Z',
            '2026-05-24T23:20:01.000Z'
          ),
          (
            'user-terminal-streaming',
            'thread-terminal',
            'turn-terminal',
            'user',
            'malformed user streaming row',
            NULL,
            1,
            '2026-05-24T23:21:00.000Z',
            '2026-05-24T23:21:01.000Z'
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
            'thread-terminal',
            'turn-terminal',
            NULL,
            'assistant-terminal-streaming',
            'interrupted',
            '2026-05-24T23:16:30.000Z',
            '2026-05-24T23:16:31.000Z',
            '2026-05-25T07:48:30.960Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-running',
            'turn-running',
            NULL,
            'assistant-running-streaming',
            'running',
            '2026-05-24T23:20:00.000Z',
            '2026-05-24T23:20:01.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const rows = yield* sql<{
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

      assert.deepStrictEqual(rows, [
        {
          messageId: "assistant-running-streaming",
          isStreaming: 1,
          updatedAt: "2026-05-24T23:20:01.000Z",
        },
        {
          messageId: "assistant-terminal-streaming",
          isStreaming: 0,
          updatedAt: "2026-05-25T07:48:30.960Z",
        },
        {
          messageId: "user-terminal-streaming",
          isStreaming: 1,
          updatedAt: "2026-05-24T23:21:01.000Z",
        },
      ]);
    }),
  );
});
