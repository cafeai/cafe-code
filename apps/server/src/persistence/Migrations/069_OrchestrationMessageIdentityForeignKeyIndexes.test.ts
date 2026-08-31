import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

interface IndexRow {
  readonly name: string;
}

interface QueryPlanRow {
  readonly detail: string;
}

layer("069_OrchestrationMessageIdentityForeignKeyIndexes", (it) => {
  it.effect("indexes both event-sequence child keys used by FK cleanup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Simulate a database that already recorded migration 68 before the
      // adversarial FK-index review landed.
      yield* runMigrations({ toMigrationInclusive: 68 });
      assert.deepStrictEqual(
        yield* sql<IndexRow>`
          SELECT name
          FROM sqlite_schema
          WHERE type = 'index'
            AND tbl_name = 'orchestration_message_identities'
            AND name LIKE 'idx_orchestration_message_identities_%_sequence'
        `,
        [],
      );

      yield* runMigrations({ toMigrationInclusive: 69 });
      const indexes = yield* sql<IndexRow>`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'index'
          AND tbl_name = 'orchestration_message_identities'
          AND name LIKE 'idx_orchestration_message_identities_%_sequence'
        ORDER BY name ASC
      `;
      assert.deepStrictEqual(indexes, [
        { name: "idx_orchestration_message_identities_first_sequence" },
        { name: "idx_orchestration_message_identities_latest_sequence" },
      ]);

      const firstPlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT thread_id, message_id
        FROM orchestration_message_identities
        WHERE first_sequence = 42
      `;
      const latestPlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT thread_id, message_id
        FROM orchestration_message_identities
        WHERE latest_sequence = 42
      `;
      assert.match(
        firstPlan.map((row) => row.detail).join("\n"),
        /idx_orchestration_message_identities_first_sequence/,
      );
      assert.match(
        latestPlan.map((row) => row.detail).join("\n"),
        /idx_orchestration_message_identities_latest_sequence/,
      );
    }),
  );
});
