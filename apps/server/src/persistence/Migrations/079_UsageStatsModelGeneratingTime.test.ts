import { ProviderDriverKind } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import { UsageStatsRepository } from "../Services/UsageStats.ts";
import { UsageStatsRepositoryLive } from "../Layers/UsageStats.ts";
import migrate from "./079_UsageStatsModelGeneratingTime.ts";

const layer = it.layer(
  UsageStatsRepositoryLive.pipe(Layer.provideMerge(TestSqliteClient.layerMemory())),
);

layer("079_UsageStatsModelGeneratingTime", (it) => {
  it.effect(
    "preserves old aggregates, starts an empty ledger, and never moves the persisted boundary",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* UsageStatsRepository;
        yield* runMigrations({ toMigrationInclusive: 78 });
        yield* sql`INSERT INTO usage_stats_days (day, generating_ms, output_tokens, user_messages) VALUES ('2026-09-01', 60000, 100, 2)`;
        yield* sql`INSERT INTO usage_stats_token_breakdown_days (day, provider_driver, model, output_tokens) VALUES ('2026-09-01', 'codex', 'gpt-old', 100)`;
        const oldDays = yield* repository.listDays;
        const oldTokens = yield* repository.listTokenBreakdownDays;
        yield* runMigrations();
        const first = yield* repository.readModelGeneratingTime;
        assert.equal(new Date(first.startedAt).toISOString(), first.startedAt);
        assert.deepEqual(first.days, []);
        assert.deepEqual(yield* repository.listDays, oldDays);
        assert.deepEqual(yield* repository.listTokenBreakdownDays, oldTokens);
        // A repeat migration and a fresh repository build model a backend restart
        // without relying on native time sleeps or accessing a user database.
        const row = {
          day: "2026-10-02",
          provider: ProviderDriverKind.make("codex"),
          model: "gpt-new",
          generatingMs: 2000,
        };
        yield* repository.flushDeltas({
          days: [],
          tokenBreakdowns: [],
          modelGeneratingTimes: [row],
        });
        yield* migrate;
        yield* runMigrations();
        const context = yield* Layer.build(Layer.fresh(UsageStatsRepositoryLive));
        const rebuilt = Context.get(context, UsageStatsRepository);
        assert.deepEqual(yield* rebuilt.readModelGeneratingTime, {
          startedAt: first.startedAt,
          days: [row],
        });
        const columns = yield* sql<{
          name: string;
        }>`PRAGMA table_info(usage_stats_model_generating_time_days)`;
        assert.deepEqual(
          columns.map((column) => column.name),
          ["day", "provider_driver", "model", "generating_ms"],
        );
      }),
  );
});
