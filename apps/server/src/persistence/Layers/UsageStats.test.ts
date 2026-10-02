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
  yield* sql`DELETE FROM usage_stats_model_generating_time_days`;
  yield* sql`DELETE FROM usage_stats_days`;
  yield* sql`DELETE FROM usage_accounting_checkpoints`;
});

layer("UsageStatsRepository", (it) => {
  it.effect(
    "hydrates the stable prospective boundary and adds separate model-time rows in key order",
    () =>
      Effect.gen(function* () {
        const repository = yield* UsageStatsRepository;
        yield* clearUsageStats;
        const empty = yield* repository.readModelGeneratingTime;
        assert.match(empty.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.deepEqual(empty.days, []);
        yield* repository.flushDeltas({
          days: [],
          tokenBreakdowns: [],
          modelGeneratingTimes: [
            { day: "2026-10-02", provider: CODEX, model: "b", generatingMs: 20 },
            { day: "2026-10-01", provider: CODEX, model: "a", generatingMs: 10 },
            { day: "2026-10-02", provider: CLAUDE, model: "c", generatingMs: 30 },
            { day: "2026-10-02", provider: CODEX, model: "b", generatingMs: 5 },
          ],
        });
        assert.deepEqual(yield* repository.readModelGeneratingTime, {
          startedAt: empty.startedAt,
          days: [
            { day: "2026-10-01", provider: CODEX, model: "a", generatingMs: 10 },
            { day: "2026-10-02", provider: CLAUDE, model: "c", generatingMs: 30 },
            { day: "2026-10-02", provider: CODEX, model: "b", generatingMs: 25 },
          ],
        });
        assert.deepEqual(yield* repository.listDays, []);
        assert.deepEqual(yield* repository.listTokenBreakdownDays, []);
      }),
  );

  it.effect("rejects invalid model-time rows atomically with aggregate and token deltas", () =>
    Effect.gen(function* () {
      const repository = yield* UsageStatsRepository;
      yield* clearUsageStats;
      for (const invalid of [
        { model: "x".repeat(257), generatingMs: 1 },
        { model: "a", generatingMs: -1 },
        { model: "a", generatingMs: Number.MAX_SAFE_INTEGER + 1 },
      ]) {
        const result = yield* Effect.exit(
          repository.flushDeltas({
            days: [day({ day: "2026-10-02", generatingMs: 1, outputTokens: 7, userMessages: 1 })],
            tokenBreakdowns: [
              breakdown({ day: "2026-10-02", provider: CODEX, model: "a", outputTokens: 7 }),
            ],
            modelGeneratingTimes: [
              { day: "2026-10-02", provider: CODEX, model: "valid", generatingMs: 1 },
              { day: "2026-10-02", provider: CODEX, ...invalid },
            ],
          }),
        );
        assert.isTrue(Exit.isFailure(result));
        assert.deepEqual(yield* repository.listDays, []);
        assert.deepEqual(yield* repository.listTokenBreakdownDays, []);
        assert.deepEqual((yield* repository.readModelGeneratingTime).days, []);
      }
    }),
  );

  it.effect(
    "rolls back a model-time SQL failure and safe-integer overflow without partial charges",
    () =>
      Effect.gen(function* () {
        const repository = yield* UsageStatsRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* clearUsageStats;
        const batch = {
          days: [day({ day: "2026-10-02", generatingMs: 1, outputTokens: 7, userMessages: 1 })],
          tokenBreakdowns: [
            breakdown({ day: "2026-10-02", provider: CODEX, model: "a", outputTokens: 7 }),
          ],
          modelGeneratingTimes: [
            { day: "2026-10-02", provider: CODEX, model: "a", generatingMs: 1 },
          ],
        };
        yield* sql`CREATE TRIGGER reject_model_time BEFORE INSERT ON usage_stats_model_generating_time_days BEGIN SELECT RAISE(ABORT, 'test model-time failure'); END`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(repository.flushDeltas(batch))));
        assert.deepEqual(yield* repository.listDays, []);
        assert.deepEqual(yield* repository.listTokenBreakdownDays, []);
        yield* sql`DROP TRIGGER reject_model_time`;
        yield* repository.flushDeltas(batch);
        assert.equal((yield* repository.readModelGeneratingTime).days[0]?.generatingMs, 1);
        yield* sql`UPDATE usage_stats_model_generating_time_days SET generating_ms = ${Number.MAX_SAFE_INTEGER}`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(repository.flushDeltas(batch))));
        assert.equal((yield* repository.listDays)[0]?.generatingMs, 1);
        assert.equal((yield* repository.listTokenBreakdownDays)[0]?.outputTokens, 7);
        assert.equal(
          (yield* repository.readModelGeneratingTime).days[0]?.generatingMs,
          Number.MAX_SAFE_INTEGER,
        );
      }),
  );

  it.effect(
    "rejects missing or malformed start metadata instead of manufacturing a fresh boundary",
    () =>
      Effect.gen(function* () {
        const repository = yield* UsageStatsRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* clearUsageStats;
        const original = (yield* repository.readModelGeneratingTime).startedAt;
        yield* sql`UPDATE usage_stats_model_generating_time_metadata SET started_at = '2026-02-30T00:00:00.000Z'`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(repository.readModelGeneratingTime)));
        yield* sql`DELETE FROM usage_stats_model_generating_time_metadata`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(repository.readModelGeneratingTime)));
        // The layer is shared by this test group; restore only the synthetic
        // metadata so unrelated cases retain their independently cleared rows.
        yield* sql`INSERT INTO usage_stats_model_generating_time_metadata (singleton, started_at) VALUES (1, ${original})`;
      }),
  );

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
