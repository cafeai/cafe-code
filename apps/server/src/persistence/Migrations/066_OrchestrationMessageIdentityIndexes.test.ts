import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("066_OrchestrationMessageIdentityIndexes", (it) => {
  it.effect("indexes canonical message identities and retry receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* runMigrations({ toMigrationInclusive: 66 });

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(orchestration_events)
      `;
      const indexNames = new Set(indexes.map((index) => index.name));
      assert.ok(indexNames.has("idx_orch_events_thread_message_identity"));
      assert.ok(indexNames.has("idx_orch_events_thread_activity_message_identity"));
    }),
  );
});
