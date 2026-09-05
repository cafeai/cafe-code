import { ProviderDriverKind, type UsageAccountingSnapshot } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { UsageStatsRepository } from "../Services/UsageStats.ts";
import { UsageStatsRepositoryLive } from "./UsageStats.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

/**
 * Token-detail columns default to zero; these builders keep the existing cases
 * focused on the counters they actually exercise.
 */
const ZERO_TOKEN_DETAIL = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
} as const;

const day = (row: {
  day: string;
  generatingMs: number;
  outputTokens: number;
  userMessages: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
}) => ({ ...ZERO_TOKEN_DETAIL, ...row });

const breakdown = (row: {
  day: string;
  provider: ProviderDriverKind;
  model: string;
  outputTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
}) => ({ ...ZERO_TOKEN_DETAIL, ...row });

const layer = it.layer(UsageStatsRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

const clearUsageStats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM usage_stats_token_breakdown_days`;
  yield* sql`DELETE FROM usage_stats_days`;
  yield* sql`DELETE FROM usage_accounting_checkpoints`;
});

layer("UsageStatsRepository", (it) => {
  const accounting = (
    revision: number,
    inputTokens: number,
    outputTokens = 0,
  ): UsageAccountingSnapshot => ({
    scopeId: "10000000-0000-4000-8000-000000000000",
    revision,
    completeness: "complete",
    models: [
      {
        model: "claude-sonnet-5",
        inputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens,
        reasoningOutputTokens: 0,
      },
    ],
  });

  it.effect(
    "commits cumulative accounting checkpoints with daily/model deltas and ignores repeated or stale revisions",
    () =>
      Effect.gen(function* () {
        const repository = yield* UsageStatsRepository;
        yield* clearUsageStats;
        const record = (snapshot: UsageAccountingSnapshot) =>
          repository.recordAccountingSnapshot({
            provider: CLAUDE,
            snapshot,
            day: "2026-09-05",
            enabled: true,
          });
        yield* record(accounting(1, 100000));
        yield* record(accounting(2, 201000, 1000));
        assert.deepEqual(yield* record(accounting(2, 201000, 1000)), []);
        assert.deepEqual(yield* record(accounting(1, 100000)), []);
        assert.equal((yield* repository.listDays)[0]?.inputTokens, 201000);
        assert.equal((yield* repository.listDays)[0]?.outputTokens, 1000);
        assert.equal((yield* repository.listTokenBreakdownDays)[0]?.inputTokens, 201000);
        // A new query's counter scope is independent even when its first value
        // exceeds the last total observed for the previous resumable session.
        yield* record({
          ...accounting(1, 300000),
          scopeId: "20000000-0000-4000-8000-000000000000",
        });
        assert.equal((yield* repository.listDays)[0]?.inputTokens, 501000);
      }),
  );

  it.effect("advances disabled accounting checkpoints without charging the disabled interval", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      yield* clearUsageStats;
      yield* repository.recordAccountingSnapshot({
        provider: CLAUDE,
        snapshot: accounting(1, 100),
        day: "2026-09-05",
        enabled: false,
      });
      assert.deepEqual(yield* repository.listDays, []);
      yield* repository.recordAccountingSnapshot({
        provider: CLAUDE,
        snapshot: accounting(2, 150, 20),
        day: "2026-09-06",
        enabled: true,
      });
      assert.equal((yield* repository.listDays)[0]?.inputTokens, 50);
      assert.equal((yield* repository.listDays)[0]?.day, "2026-09-06");
    }),
  );

  it.effect(
    "rejects across-day redistribution that would create cache or reasoning larger than its new token delta",
    () =>
      Effect.gen(function* () {
        const repository = yield* UsageStatsRepository;
        yield* clearUsageStats;
        yield* repository.recordAccountingSnapshot({
          provider: CLAUDE,
          snapshot: accounting(1, 100, 50),
          day: "2026-09-05",
          enabled: true,
        });
        for (const subset of [{ cachedInputTokens: 80 }, { reasoningOutputTokens: 40 }]) {
          const next = accounting(2, 100, 50);
          const invalid = { ...next, models: [{ ...next.models[0]!, ...subset }] };
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                repository.recordAccountingSnapshot({
                  provider: CLAUDE,
                  snapshot: invalid,
                  day: "2026-09-06",
                  enabled: true,
                }),
              ),
            ),
          );
        }
        const rows = yield* repository.listDays;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.day, "2026-09-05");
        assert.equal(rows[0]?.cachedInputTokens, 0);
      }),
  );

  it.effect(
    "rolls back the checkpoint if an aggregate write fails so retry charges exactly once",
    () =>
      Effect.gen(function* () {
        const repository = yield* UsageStatsRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* clearUsageStats;
        yield* sql`CREATE TRIGGER reject_accounting_day BEFORE INSERT ON usage_stats_days BEGIN SELECT RAISE(ABORT, 'test atomic failure'); END`;
        const input = {
          provider: CLAUDE,
          snapshot: accounting(1, 123, 4),
          day: "2026-09-05",
          enabled: true,
        };
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(repository.recordAccountingSnapshot(input))),
        );
        assert.equal((yield* sql`SELECT * FROM usage_accounting_checkpoints`).length, 0);
        yield* sql`DROP TRIGGER reject_accounting_day`;
        yield* repository.recordAccountingSnapshot(input);
        yield* repository.recordAccountingSnapshot(input);
        assert.equal((yield* repository.listDays)[0]?.inputTokens, 123);
      }),
  );

  it.effect(
    "rejects duplicate models, invalid subsets, and counter regressions without modifying accepted totals",
    () =>
      Effect.gen(function* () {
        const repository = yield* UsageStatsRepository;
        yield* clearUsageStats;
        const record = (snapshot: UsageAccountingSnapshot) =>
          repository.recordAccountingSnapshot({
            provider: CLAUDE,
            snapshot,
            day: "2026-09-05",
            enabled: true,
          });
        yield* record(accounting(1, 100, 20));
        const next = accounting(2, 120, 25);
        for (const invalid of [
          accounting(2, 99, 20),
          { ...next, models: [...next.models, ...next.models] },
          { ...next, models: [{ ...next.models[0]!, cachedInputTokens: 121 }] },
          { ...next, models: [] },
        ])
          assert.isTrue(Exit.isFailure(yield* Effect.exit(record(invalid))));
        assert.equal((yield* repository.listDays)[0]?.inputTokens, 100);
        yield* record(next);
        assert.equal((yield* repository.listDays)[0]?.inputTokens, 120);
      }),
  );
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
        days: [day({ day: "2026-07-06", generatingMs: 4000, outputTokens: 120, userMessages: 1 })],
        tokenBreakdowns: [
          breakdown(
            breakdown({
              day: "2026-07-06",
              provider: CODEX,
              model: "gpt-5.6-codex",
              outputTokens: 120,
            }),
          ),
        ],
      });
      yield* repository.flushDeltas({
        days: [day({ day: "2026-07-06", generatingMs: 6000, outputTokens: 30, userMessages: 2 })],
        tokenBreakdowns: [
          breakdown(
            breakdown({
              day: "2026-07-06",
              provider: CODEX,
              model: "gpt-5.6-codex",
              outputTokens: 30,
            }),
          ),
        ],
      });

      const rows = yield* repository.listDays;
      assert.deepEqual(rows, [
        day({ day: "2026-07-06", generatingMs: 10_000, outputTokens: 150, userMessages: 3 }),
      ]);
      assert.deepEqual(yield* repository.listTokenBreakdownDays, [
        breakdown(
          breakdown({
            day: "2026-07-06",
            provider: CODEX,
            model: "gpt-5.6-codex",
            outputTokens: 150,
          }),
        ),
      ]);
    }),
  );

  it.effect("keeps provider and model keys separate in stable order", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      yield* clearUsageStats;

      yield* repository.flushDeltas({
        days: [
          day({ day: "2026-08-03", generatingMs: 1000, outputTokens: 10, userMessages: 0 }),
          day({ day: "2026-08-01", generatingMs: 2000, outputTokens: 20, userMessages: 1 }),
        ],
        tokenBreakdowns: [
          breakdown({ day: "2026-08-03", provider: CODEX, model: "gpt-b", outputTokens: 4 }),
          breakdown({ day: "2026-08-03", provider: CLAUDE, model: "claude-a", outputTokens: 3 }),
          breakdown({ day: "2026-08-03", provider: CODEX, model: "gpt-a", outputTokens: 3 }),
        ],
      });

      const rows = yield* repository.listDays;
      const augustDays = rows.map((row) => row.day).filter((day) => day.startsWith("2026-08"));
      assert.deepEqual(augustDays, ["2026-08-01", "2026-08-03"]);
      assert.deepEqual(yield* repository.listTokenBreakdownDays, [
        breakdown({ day: "2026-08-03", provider: CLAUDE, model: "claude-a", outputTokens: 3 }),
        breakdown({ day: "2026-08-03", provider: CODEX, model: "gpt-a", outputTokens: 3 }),
        breakdown({ day: "2026-08-03", provider: CODEX, model: "gpt-b", outputTokens: 4 }),
      ]);
    }),
  );

  it.effect("rolls back aggregate deltas when attribution validation fails", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      yield* clearUsageStats;

      const outcome = yield* Effect.exit(
        repository.flushDeltas({
          days: [day({ day: "2026-09-01", generatingMs: 0, outputTokens: 7, userMessages: 0 })],
          tokenBreakdowns: [
            {
              day: "2026-09-01",
              provider: CODEX,
              model: "x".repeat(257),
              outputTokens: 7,
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              reasoningOutputTokens: 0,
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
