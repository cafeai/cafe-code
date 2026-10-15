import { assert, it } from "@effect/vitest";
import { describe } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import codexAutoCompactRequest from "./098_CodexAutoCompactRequest.ts";

describe("099_UsageAndCompactionReconciliation", () => {
  for (const lineage of ["fresh", "ReportedUsageCosts", "CodexAutoCompactRequest"] as const) {
    it.effect(`upgrades ${lineage} without rewriting history or measured usage`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 97 });
        yield* sql`INSERT INTO usage_stats_token_breakdown_days
          (day, provider_driver, model, output_tokens)
          VALUES ('2026-10-15', 'codex', 'fixture', 123)`;
        yield* sql`INSERT INTO projection_thread_sessions
          (thread_id, status, provider_name, provider_instance_id, runtime_mode, updated_at)
          VALUES ('merge-fixture', 'ready', 'codex', 'codex', 'full-access', '2026-10-15T00:00:00.000Z')`;
        if (lineage === "ReportedUsageCosts") {
          yield* runMigrations({ toMigrationInclusive: 98 });
          yield* sql`UPDATE usage_stats_token_breakdown_days
            SET reported_cost_json = '{"fixture":"0.0123"}'`;
        } else if (lineage === "CodexAutoCompactRequest") {
          yield* codexAutoCompactRequest;
          yield* sql`INSERT INTO effect_sql_migrations(migration_id, name)
            VALUES (98, 'CodexAutoCompactRequest')`;
          yield* sql`UPDATE projection_thread_sessions
            SET codex_auto_compact_token_limit = 450000, codex_auto_compact_token_limit_known = 1`;
        }
        const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const objects = yield* sql`SELECT name, type, sql FROM sqlite_schema
          WHERE type IN ('index', 'trigger') ORDER BY name`;
        yield* runMigrations();
        assert.deepEqual(
          yield* sql`SELECT * FROM effect_sql_migrations
            WHERE migration_id <= ${lineage === "fresh" ? 97 : 98} ORDER BY migration_id`,
          ledger,
        );
        assert.deepEqual(
          yield* sql`SELECT output_tokens, reported_cost_json FROM usage_stats_token_breakdown_days`,
          [
            {
              output_tokens: 123,
              reported_cost_json: lineage === "ReportedUsageCosts" ? '{"fixture":"0.0123"}' : null,
            },
          ],
        );
        assert.deepEqual(
          yield* sql`SELECT codex_auto_compact_token_limit AS value,
            codex_auto_compact_token_limit_known AS known FROM projection_thread_sessions`,
          [
            {
              value: lineage === "CodexAutoCompactRequest" ? 450000 : null,
              known: lineage === "CodexAutoCompactRequest" ? 1 : 0,
            },
          ],
        );
        assert.deepEqual(
          yield* sql`SELECT name, type, sql FROM sqlite_schema
          WHERE type IN ('index', 'trigger') ORDER BY name`,
          objects,
        );
        assert.deepEqual(yield* runMigrations(), []);
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
    );
  }

  it.effect("refuses unknown migration identity without recording successful reconciliation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      yield* sql`INSERT INTO effect_sql_migrations(migration_id, name) VALUES (98, 'UnknownFixture')`;
      const result = yield* Effect.exit(runMigrations());
      assert.equal(result._tag, "Failure");
      assert.deepEqual(yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id = 99`, []);
      const columns = yield* sql<{
        name: string;
      }>`PRAGMA table_info(usage_stats_token_breakdown_days)`;
      assert.equal(
        columns.some((column) => column.name === "reported_cost_json"),
        false,
      );
    }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
  );
});
