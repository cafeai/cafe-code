import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { UsageStatsRepository } from "../Services/UsageStats.ts";
import { UsageStatsRepositoryLive } from "../Layers/UsageStats.ts";
import repair from "./078_RepairUsageStatsTokenDetail.ts";

const layer = it.layer(
  UsageStatsRepositoryLive.pipe(Layer.provideMerge(TestSqliteClient.layerMemory())),
);

layer("078_RepairUsageStatsTokenDetail", (it) => {
  it.effect("repairs the shipped id collision and preserves history through later writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* UsageStatsRepository;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (63, 'WorkflowPersistence')`;
      yield* sql`INSERT INTO usage_stats_days (day, generating_ms, output_tokens, user_messages)
        VALUES ('2026-08-05', 12345, 600, 8), ('2026-08-25', 67890, 900, 12)`;
      yield* sql`INSERT INTO usage_stats_token_breakdown_days (day, provider_driver, model, output_tokens)
        VALUES ('2026-08-05', 'codex', 'gpt-5', 600)`;
      yield* runMigrations({ toMigrationInclusive: 77 });
      yield* runMigrations();

      // Runtime recovery already owns the shipped id 77. The usage repair
      // must run afterward rather than replacing or being skipped by that id.
      const recentMigrations = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id IN (77, 78) ORDER BY migration_id
      `;
      assert.deepEqual(recentMigrations, [
        { migration_id: 77, name: "RuntimeRecoveryControls" },
        { migration_id: 78, name: "RepairUsageStatsTokenDetail" },
      ]);

      const history = yield* repository.listDays;
      assert.equal(history.length, 2);
      assert.equal(history[0]?.generatingMs, 12345);
      assert.equal(history[0]?.outputTokens, 600);
      assert.equal(history[0]?.userMessages, 8);
      assert.equal(history[0]?.inputTokens, 0);
      assert.equal((yield* repository.listTokenBreakdownDays)[0]?.outputTokens, 600);
      const delta = {
        day: "2026-09-09",
        generatingMs: 5000,
        userMessages: 1,
        outputTokens: 100,
        inputTokens: 1000,
        cachedInputTokens: 500,
        cacheWriteInputTokens: 100,
        reasoningOutputTokens: 20,
      };
      yield* repository.flushDeltas({
        days: [delta],
        tokenBreakdowns: [{ ...delta, provider: ProviderDriverKind.make("codex"), model: "gpt-5" }],
      });
      const persistedDays = yield* repository.listDays;
      const persistedModels = yield* repository.listTokenBreakdownDays;
      assert.deepEqual(persistedDays, [...history, delta]);
      assert.equal(persistedModels[1]?.inputTokens, 1000);

      // A healthy schema (including populated detail) is a no-op. Reapplying
      // the repair must never zero any existing aggregate or attribution.
      yield* repair;
      assert.deepEqual(yield* repository.listDays, persistedDays);
      assert.deepEqual(yield* repository.listTokenBreakdownDays, persistedModels);
      const legacy = yield* sql<{
        name: string;
      }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 63`;
      assert.equal(legacy[0]?.name, "WorkflowPersistence");

      // A partially widened table is independently repaired without touching
      // the other table or the detailed values already present.
      yield* sql`ALTER TABLE usage_stats_days DROP COLUMN cache_write_input_tokens`;
      yield* repair;
      assert.equal((yield* repository.listDays)[2]?.cacheWriteInputTokens, 0);
      assert.equal((yield* repository.listDays)[2]?.inputTokens, 1000);
      assert.deepEqual(yield* repository.listTokenBreakdownDays, persistedModels);
    }),
  );
});
