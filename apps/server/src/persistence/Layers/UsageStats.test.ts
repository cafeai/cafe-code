import { ProviderDriverKind } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { UsageStatsRepository } from "../Services/UsageStats.ts";
import { UsageStatsRepositoryLive } from "./UsageStats.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(UsageStatsRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

const clearUsageStats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM usage_stats_token_breakdown_days`;
  yield* sql`DELETE FROM usage_stats_days`;
});

layer("UsageStatsRepository", (it) => {
  it.effect("returns no rows before any deltas are flushed", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      yield* clearUsageStats;
      const rows = yield* repository.listDays;
      const tokenBreakdowns = yield* repository.listTokenBreakdownDays;
      assert.deepEqual(rows, []);
      assert.deepEqual(tokenBreakdowns, []);
    }),
  );

  it.effect("accumulates aggregate and provider/model deltas on conflict", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      yield* clearUsageStats;

      yield* repository.flushDeltas({
        days: [{ day: "2026-07-06", generatingMs: 4000, outputTokens: 120, userMessages: 1 }],
        tokenBreakdowns: [
          {
            day: "2026-07-06",
            provider: CODEX,
            model: "gpt-5.6-codex",
            outputTokens: 120,
          },
        ],
      });
      yield* repository.flushDeltas({
        days: [{ day: "2026-07-06", generatingMs: 6000, outputTokens: 30, userMessages: 2 }],
        tokenBreakdowns: [
          {
            day: "2026-07-06",
            provider: CODEX,
            model: "gpt-5.6-codex",
            outputTokens: 30,
          },
        ],
      });

      const rows = yield* repository.listDays;
      assert.deepEqual(rows, [
        { day: "2026-07-06", generatingMs: 10_000, outputTokens: 150, userMessages: 3 },
      ]);
      assert.deepEqual(yield* repository.listTokenBreakdownDays, [
        {
          day: "2026-07-06",
          provider: CODEX,
          model: "gpt-5.6-codex",
          outputTokens: 150,
        },
      ]);
    }),
  );

  it.effect("keeps provider and model keys separate in stable order", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      yield* clearUsageStats;

      yield* repository.flushDeltas({
        days: [
          { day: "2026-08-03", generatingMs: 1000, outputTokens: 10, userMessages: 0 },
          { day: "2026-08-01", generatingMs: 2000, outputTokens: 20, userMessages: 1 },
        ],
        tokenBreakdowns: [
          { day: "2026-08-03", provider: CODEX, model: "gpt-b", outputTokens: 4 },
          { day: "2026-08-03", provider: CLAUDE, model: "claude-a", outputTokens: 3 },
          { day: "2026-08-03", provider: CODEX, model: "gpt-a", outputTokens: 3 },
        ],
      });

      const rows = yield* repository.listDays;
      const augustDays = rows.map((row) => row.day).filter((day) => day.startsWith("2026-08"));
      assert.deepEqual(augustDays, ["2026-08-01", "2026-08-03"]);
      assert.deepEqual(yield* repository.listTokenBreakdownDays, [
        { day: "2026-08-03", provider: CLAUDE, model: "claude-a", outputTokens: 3 },
        { day: "2026-08-03", provider: CODEX, model: "gpt-a", outputTokens: 3 },
        { day: "2026-08-03", provider: CODEX, model: "gpt-b", outputTokens: 4 },
      ]);
    }),
  );

  it.effect("rolls back aggregate deltas when attribution validation fails", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      yield* clearUsageStats;

      const outcome = yield* Effect.exit(
        repository.flushDeltas({
          days: [{ day: "2026-09-01", generatingMs: 0, outputTokens: 7, userMessages: 0 }],
          tokenBreakdowns: [
            {
              day: "2026-09-01",
              provider: CODEX,
              model: "x".repeat(257),
              outputTokens: 7,
            },
          ],
        }),
      );

      assert.isTrue(Exit.isFailure(outcome));
      assert.deepEqual(yield* repository.listDays, []);
      assert.deepEqual(yield* repository.listTokenBreakdownDays, []);
    }),
  );
});
