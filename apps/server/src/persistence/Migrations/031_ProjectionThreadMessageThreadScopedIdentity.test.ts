import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("031_ProjectionThreadMessageThreadScopedIdentity", (it) => {
  it.effect("rebuilds projection messages with a thread-scoped primary key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 30 });
      yield* runMigrations({ toMigrationInclusive: 31 });

      const columns = yield* sql<{
        readonly name: string;
        readonly pk: number;
      }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const primaryKeyColumns = columns
        .filter((column) => column.pk > 0)
        .toSorted((left, right) => left.pk - right.pk)
        .map((column) => column.name);
      assert.deepStrictEqual(primaryKeyColumns, ["thread_id", "message_id"]);

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
            'message-shared-provider-id',
            'thread-a',
            NULL,
            'assistant',
            'first thread',
            NULL,
            0,
            '2026-02-28T20:00:00.000Z',
            '2026-02-28T20:00:01.000Z'
          ),
          (
            'message-shared-provider-id',
            'thread-b',
            NULL,
            'assistant',
            'second thread',
            NULL,
            0,
            '2026-02-28T20:00:00.000Z',
            '2026-02-28T20:00:02.000Z'
          )
      `;

      const rows = yield* sql<{
        readonly threadId: string;
        readonly text: string;
      }>`
        SELECT thread_id AS "threadId", text
        FROM projection_thread_messages
        WHERE message_id = 'message-shared-provider-id'
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread-a", text: "first thread" },
        { threadId: "thread-b", text: "second thread" },
      ]);
    }),
  );
});
