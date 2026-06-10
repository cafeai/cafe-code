import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("054_BackpressureHotPathIndexes", (it) => {
  it.effect("creates indexes used by projection backpressure hot paths", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runMigrations({ toMigrationInclusive: 54 });

      const messageIndexes = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_list(projection_thread_messages)
      `;
      const activityIndexes = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_list(projection_thread_activities)
      `;

      assert.ok(
        messageIndexes.some(
          (index) => index.name === "idx_projection_thread_messages_message_thread",
        ),
      );
      assert.ok(
        activityIndexes.some(
          (index) => index.name === "idx_projection_thread_activities_thread_kind_created_id",
        ),
      );
    }),
  );
});
