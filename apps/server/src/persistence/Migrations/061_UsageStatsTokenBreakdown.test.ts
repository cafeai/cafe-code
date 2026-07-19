import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

layer("061_UsageStatsTokenBreakdown", (it) => {
  it.effect("adds the bounded provider/model output-token ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 60 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'usage_stats_token_breakdown_days'
      `;
      assert.deepEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 61 });
      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(usage_stats_token_breakdown_days)`;

      assert.deepEqual(
        columns.map((column) => ({
          name: column.name,
          notnull: column.notnull,
          pk: column.pk,
        })),
        [
          { name: "day", notnull: 1, pk: 1 },
          { name: "provider_driver", notnull: 1, pk: 2 },
          { name: "model", notnull: 1, pk: 3 },
          { name: "output_tokens", notnull: 1, pk: 0 },
        ],
      );
    }),
  );
});
