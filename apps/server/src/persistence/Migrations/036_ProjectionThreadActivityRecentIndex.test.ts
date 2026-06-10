import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("036_ProjectionThreadActivityRecentIndex", (it) => {
  it.effect("creates the recent activity ordering index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* runMigrations({ toMigrationInclusive: 36 });

      const indexes = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_list(projection_thread_activities)
      `;

      assert.ok(
        indexes.some((index) => index.name === "idx_projection_thread_activities_thread_recent"),
      );
    }),
  );
});
