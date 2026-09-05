import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { UsageAccountingSnapshot } from "@cafecode/contracts";
import { USAGE_TOKEN_FIELDS } from "../../usageStats/tokenDelta.ts";

import {
  isPersistenceError,
  toPersistenceDecodeCauseError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";

import {
  UsageStatsDayRow,
  UsageStatsRepository,
  UsageStatsTokenBreakdownDayRow,
  type UsageStatsRepositoryShape,
} from "../Services/UsageStats.ts";

const decodeAccountingSnapshot = Schema.decodeEffect(UsageAccountingSnapshot);
const accountingCheckpointJson = Schema.fromJsonString(UsageAccountingSnapshot);
const decodeAccountingCheckpoint = Schema.decodeEffect(accountingCheckpointJson);
const encodeAccountingCheckpoint = Schema.encodeEffect(accountingCheckpointJson);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    isPersistenceError(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? toPersistenceDecodeError(decodeOperation)(cause)
        : toPersistenceSqlError(sqlOperation)(cause);
}

const makeUsageStatsRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listUsageStatsDayRows = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: UsageStatsDayRow,
    execute: () =>
      sql`
        SELECT
          day,
          generating_ms AS "generatingMs",
          output_tokens AS "outputTokens",
          user_messages AS "userMessages",
          input_tokens AS "inputTokens",
          cached_input_tokens AS "cachedInputTokens",
          cache_write_input_tokens AS "cacheWriteInputTokens",
          reasoning_output_tokens AS "reasoningOutputTokens"
        FROM usage_stats_days
        ORDER BY day ASC
      `,
  });

  const upsertUsageStatsDayDelta = SqlSchema.void({
    Request: UsageStatsDayRow,
    execute: (row) =>
      sql`
        INSERT INTO usage_stats_days (
          day,
          generating_ms,
          output_tokens,
          user_messages,
          input_tokens,
          cached_input_tokens,
          cache_write_input_tokens,
          reasoning_output_tokens
        )
        VALUES (
          ${row.day},
          ${row.generatingMs},
          ${row.outputTokens},
          ${row.userMessages},
          ${row.inputTokens},
          ${row.cachedInputTokens},
          ${row.cacheWriteInputTokens},
          ${row.reasoningOutputTokens}
        )
        ON CONFLICT (day)
        DO UPDATE SET
          generating_ms = generating_ms + excluded.generating_ms,
          output_tokens = output_tokens + excluded.output_tokens,
          user_messages = user_messages + excluded.user_messages,
          input_tokens = input_tokens + excluded.input_tokens,
          cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
          cache_write_input_tokens =
            cache_write_input_tokens + excluded.cache_write_input_tokens,
          reasoning_output_tokens =
            reasoning_output_tokens + excluded.reasoning_output_tokens
      `,
  });

  const listUsageStatsTokenBreakdownRows = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: UsageStatsTokenBreakdownDayRow,
    execute: () =>
      sql`
        SELECT
          day,
          provider_driver AS provider,
          model,
          output_tokens AS "outputTokens",
          input_tokens AS "inputTokens",
          cached_input_tokens AS "cachedInputTokens",
          cache_write_input_tokens AS "cacheWriteInputTokens",
          reasoning_output_tokens AS "reasoningOutputTokens"
        FROM usage_stats_token_breakdown_days
        ORDER BY day ASC, provider_driver ASC, model ASC
      `,
  });

  const upsertUsageStatsTokenBreakdownDelta = SqlSchema.void({
    Request: UsageStatsTokenBreakdownDayRow,
    execute: (row) =>
      sql`
        INSERT INTO usage_stats_token_breakdown_days (
          day,
          provider_driver,
          model,
          output_tokens,
          input_tokens,
          cached_input_tokens,
          cache_write_input_tokens,
          reasoning_output_tokens
        )
        VALUES (
          ${row.day},
          ${row.provider},
          ${row.model},
          ${row.outputTokens},
          ${row.inputTokens},
          ${row.cachedInputTokens},
          ${row.cacheWriteInputTokens},
          ${row.reasoningOutputTokens}
        )
        ON CONFLICT (day, provider_driver, model)
        DO UPDATE SET
          output_tokens = output_tokens + excluded.output_tokens,
          input_tokens = input_tokens + excluded.input_tokens,
          cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
          cache_write_input_tokens =
            cache_write_input_tokens + excluded.cache_write_input_tokens,
          reasoning_output_tokens =
            reasoning_output_tokens + excluded.reasoning_output_tokens
      `,
  });

  const listDays: UsageStatsRepositoryShape["listDays"] = listUsageStatsDayRows({}).pipe(
    Effect.mapError(
      toPersistenceSqlOrDecodeError(
        "UsageStatsRepository.listDays:query",
        "UsageStatsRepository.listDays:decodeRows",
      ),
    ),
  );

  const listTokenBreakdownDays: UsageStatsRepositoryShape["listTokenBreakdownDays"] =
    listUsageStatsTokenBreakdownRows({}).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "UsageStatsRepository.listTokenBreakdownDays:query",
          "UsageStatsRepository.listTokenBreakdownDays:decodeRows",
        ),
      ),
    );

  const flushDeltas: UsageStatsRepositoryShape["flushDeltas"] = (deltas) => {
    if (deltas.days.length === 0 && deltas.tokenBreakdowns.length === 0) {
      return Effect.void;
    }

    // Always use one transaction even for one-row batches. Aggregate totals
    // and provider/model attribution describe the same token observations; a
    // partial commit followed by retry would permanently skew one side.
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* Effect.forEach(deltas.days, upsertUsageStatsDayDelta, { discard: true });
          yield* Effect.forEach(deltas.tokenBreakdowns, upsertUsageStatsTokenBreakdownDelta, {
            discard: true,
          });
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "UsageStatsRepository.flushDeltas:query",
            "UsageStatsRepository.flushDeltas:encodeRequest",
          ),
        ),
      );
  };

  const recordAccountingSnapshot: UsageStatsRepositoryShape["recordAccountingSnapshot"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Validate again at the durable boundary: auxiliary callers are local,
          // but a malformed provider frame must never poison an accounting cursor.
          const snapshot = yield* decodeAccountingSnapshot(input.snapshot);
          const rows = yield* sql<{ revision: number; snapshot_json: string }>`
        SELECT revision, snapshot_json FROM usage_accounting_checkpoints
        WHERE provider_driver = ${input.provider} AND scope_id = ${snapshot.scopeId}
      `;
          const row = rows[0];
          if (row && row.revision >= snapshot.revision) return [];
          const previous = row ? yield* decodeAccountingCheckpoint(row.snapshot_json) : undefined;
          const accepted = yield* Effect.try({
            try: () => {
              const previousModels = new Map(previous?.models.map((model) => [model.model, model]));
              const names = new Set<string>();
              const deltas: Array<typeof UsageStatsTokenBreakdownDayRow.Type> = [];
              for (const model of snapshot.models) {
                if (
                  names.has(model.model) ||
                  model.cachedInputTokens + model.cacheWriteInputTokens > model.inputTokens ||
                  model.reasoningOutputTokens > model.outputTokens
                ) {
                  throw new Error("Invalid usage accounting model counters.");
                }
                names.add(model.model);
                const prior = previousModels.get(model.model);
                if (prior && USAGE_TOKEN_FIELDS.some((field) => model[field] < prior[field])) {
                  throw new Error("Usage accounting counters regressed without a new scope.");
                }
                const delta = { ...model, day: input.day, provider: input.provider };
                for (const field of USAGE_TOKEN_FIELDS)
                  delta[field] = model[field] - (prior?.[field] ?? 0);
                // Fresh input and non-reasoning output are disjoint billed buckets
                // too. Monotone parent/subset counters alone allow an old request's
                // fresh tokens to be reclassified as cache on a later day, producing
                // an impossible increment with cache > input and inflated costs.
                if (
                  delta.cachedInputTokens > delta.inputTokens - delta.cacheWriteInputTokens ||
                  delta.reasoningOutputTokens > delta.outputTokens
                ) {
                  throw new Error("Usage accounting changed a previously settled token category.");
                }
                if (input.enabled && USAGE_TOKEN_FIELDS.some((field) => delta[field] > 0))
                  deltas.push(delta);
              }
              if (previous?.models.some((model) => !names.has(model.model))) {
                throw new Error("Usage accounting snapshot omitted an existing model.");
              }
              return deltas;
            },
            catch: toPersistenceDecodeCauseError(
              "UsageStatsRepository.recordAccountingSnapshot:validate",
            ),
          });
          const snapshotJson = yield* encodeAccountingCheckpoint(snapshot);
          yield* sql`
        INSERT INTO usage_accounting_checkpoints (provider_driver, scope_id, revision, snapshot_json)
        VALUES (${input.provider}, ${snapshot.scopeId}, ${snapshot.revision}, ${snapshotJson})
        ON CONFLICT (provider_driver, scope_id) DO UPDATE SET
          revision = excluded.revision, snapshot_json = excluded.snapshot_json
      `;
          // The checkpoint and its increments commit together. A repeated event
          // after a lost acknowledgement, daemon overlap, or backend restart can
          // therefore neither lose one side nor charge an observation twice.
          for (const delta of accepted) {
            yield* upsertUsageStatsDayDelta({ ...delta, generatingMs: 0, userMessages: 0 });
            yield* upsertUsageStatsTokenBreakdownDelta(delta);
          }
          return accepted;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "UsageStatsRepository.recordAccountingSnapshot:query",
            "UsageStatsRepository.recordAccountingSnapshot:decode",
          ),
        ),
      );

  return {
    listDays,
    listTokenBreakdownDays,
    flushDeltas,
    recordAccountingSnapshot,
  } satisfies UsageStatsRepositoryShape;
});

export const UsageStatsRepositoryLive = Layer.effect(
  UsageStatsRepository,
  makeUsageStatsRepository,
);
