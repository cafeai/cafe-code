import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { UsageStatsRepository } from "../Services/UsageStats.ts";
import { UsageStatsRepositoryLive } from "../Layers/UsageStats.ts";

const layer = it.layer(
  UsageStatsRepositoryLive.pipe(Layer.provideMerge(TestSqliteClient.layerMemory())),
);

layer("103_UsageCacheDurations", (it) => {
  it.effect(
    "preserves previously recorded writes as unknown rather than inventing their duration",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* UsageStatsRepository;
        yield* runMigrations({ toMigrationInclusive: 102 });
        yield* sql`INSERT INTO usage_stats_token_breakdown_days
        (day, provider_driver, model, output_tokens, input_tokens, cache_write_input_tokens)
        VALUES ('2026-10-01', 'claudeAgent', 'claude-sonnet-5', 4, 100, 70)`;
        yield* runMigrations();
        const rows = yield* repository.listTokenBreakdownDays;
        assert.equal(rows[0]?.cacheWriteInputTokens, 70);
        assert.isUndefined(rows[0]?.cacheWrite5mInputTokens);
        assert.isUndefined(rows[0]?.cacheWrite1hInputTokens);
      }),
  );
});
