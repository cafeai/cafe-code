import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { UsageStatsRepository } from "../Services/UsageStats.ts";
import { UsageStatsRepositoryLive } from "./UsageStats.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(UsageStatsRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("UsageStatsRepository", (it) => {
  it.effect("returns no rows before any deltas are flushed", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM usage_stats_days`;
      const rows = yield* repository.listDays;
      assert.deepEqual(rows, []);
    }),
  );

  it.effect("creates day rows and accumulates deltas on conflict", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM usage_stats_days`;

      yield* repository.upsertDayDeltas([
        { day: "2026-07-06", generatingMs: 4000, outputTokens: 120, userMessages: 1 },
      ]);
      yield* repository.upsertDayDeltas([
        { day: "2026-07-06", generatingMs: 6000, outputTokens: 30, userMessages: 2 },
      ]);

      const rows = yield* repository.listDays;
      assert.deepEqual(rows, [
        { day: "2026-07-06", generatingMs: 10_000, outputTokens: 150, userMessages: 3 },
      ]);
    }),
  );

  it.effect("applies multi-day batches atomically and lists days ascending", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM usage_stats_days`;

      yield* repository.upsertDayDeltas([
        { day: "2026-08-03", generatingMs: 1000, outputTokens: 10, userMessages: 0 },
        { day: "2026-08-01", generatingMs: 2000, outputTokens: 20, userMessages: 1 },
      ]);

      const rows = yield* repository.listDays;
      const augustDays = rows.map((row) => row.day).filter((day) => day.startsWith("2026-08"));
      assert.deepEqual(augustDays, ["2026-08-01", "2026-08-03"]);
    }),
  );
});
