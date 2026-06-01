import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_ProjectionThreadActivityTurnPageIndexes", (it) => {
  it.effect("creates turn-scoped work-log page indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* runMigrations({ toMigrationInclusive: 55 });

      const indexes = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_list(projection_thread_activities)
      `;

      assert.ok(
        indexes.some(
          (index) => index.name === "idx_projection_thread_activities_thread_turn_order",
        ),
      );
      assert.ok(
        indexes.some(
          (index) => index.name === "idx_projection_thread_activities_thread_turn_kind_created_id",
        ),
      );
    }),
  );
});
