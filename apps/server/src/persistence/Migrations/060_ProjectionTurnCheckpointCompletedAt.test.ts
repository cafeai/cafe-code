import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("060_ProjectionTurnCheckpointCompletedAt", (it) => {
  it.effect("separates checkpoint observation time from turn completion time", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 59 });
      const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_turns)`;
      assert.equal(
        before.some((column) => column.name === "checkpoint_completed_at"),
        false,
      );

      yield* runMigrations({ toMigrationInclusive: 60 });
      const after = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_turns)`;
      assert.equal(
        after.some((column) => column.name === "checkpoint_completed_at"),
        true,
      );
    }),
  );
});
