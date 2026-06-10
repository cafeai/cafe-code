import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("053_CloseLateTerminalStreamingReplays", (it) => {
  it.effect("closes assistant streaming rows for terminal turns created after migration 52", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });

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
            'assistant-terminal-replay',
            'thread-terminal-replay',
            'turn-terminal-replay',
            'assistant',
            'late replay text',
            NULL,
            1,
            '2026-05-27T01:10:00.000Z',
            '2026-05-27T01:10:01.000Z'
          ),
          (
            'assistant-live',
            'thread-live',
            'turn-live',
            'assistant',
            'live text',
            NULL,
            1,
            '2026-05-27T01:11:00.000Z',
            '2026-05-27T01:11:01.000Z'
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
            'thread-terminal-replay',
            'turn-terminal-replay',
            NULL,
            'assistant-terminal-replay',
            'completed',
            '2026-05-27T01:09:00.000Z',
            '2026-05-27T01:09:01.000Z',
            '2026-05-27T01:12:00.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-live',
            'turn-live',
            NULL,
            'assistant-live',
            'running',
            '2026-05-27T01:10:30.000Z',
            '2026-05-27T01:10:31.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

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

      assert.deepEqual(rows, [
        {
          messageId: "assistant-live",
          isStreaming: 1,
          updatedAt: "2026-05-27T01:11:01.000Z",
        },
        {
          messageId: "assistant-terminal-replay",
          isStreaming: 0,
          updatedAt: "2026-05-27T01:12:00.000Z",
        },
      ]);
    }),
  );
});
