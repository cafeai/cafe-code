import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("047_RecloseLateTerminalTurnStreamingMessages", (it) => {
  it.effect("closes terminal streaming rows created after earlier cleanup migrations ran", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });

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
            'assistant-late-terminal-streaming',
            'thread-late-terminal',
            'turn-late-terminal',
            'assistant',
            'late replay text',
            NULL,
            1,
            '2026-05-26T13:50:00.000Z',
            '2026-05-26T13:50:01.000Z'
          ),
          (
            'assistant-still-running',
            'thread-running',
            'turn-running',
            'assistant',
            'live text',
            NULL,
            1,
            '2026-05-26T13:51:00.000Z',
            '2026-05-26T13:51:01.000Z'
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
            'thread-late-terminal',
            'turn-late-terminal',
            NULL,
            'assistant-late-terminal-streaming',
            'interrupted',
            '2026-05-26T13:49:00.000Z',
            '2026-05-26T13:49:01.000Z',
            '2026-05-26T13:52:00.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-running',
            'turn-running',
            NULL,
            'assistant-still-running',
            'running',
            '2026-05-26T13:51:00.000Z',
            '2026-05-26T13:51:01.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

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
          messageId: "assistant-late-terminal-streaming",
          isStreaming: 0,
          updatedAt: "2026-05-26T13:52:00.000Z",
        },
        {
          messageId: "assistant-still-running",
          isStreaming: 1,
          updatedAt: "2026-05-26T13:51:01.000Z",
        },
      ]);
    }),
  );
});
