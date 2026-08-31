import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("066_OrchestrationMessageIdentityIndexes", (it) => {
  it.effect("preserves the durable migration id without scanning the event ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* runMigrations({ toMigrationInclusive: 66 });

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(orchestration_events)
      `;
      const indexNames = new Set(indexes.map((index) => index.name));
      assert.equal(indexNames.has("idx_orch_events_thread_message_identity"), false);
      assert.equal(indexNames.has("idx_orch_events_thread_activity_message_identity"), false);

      const migrationRows = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS "migrationId"
        FROM effect_sql_migrations
        WHERE migration_id = 66
      `;
      assert.deepStrictEqual(migrationRows, [{ migrationId: 66 }]);
    }),
  );
});
