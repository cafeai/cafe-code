import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  UsageStatsDayRow,
  UsageStatsRepository,
  UsageStatsTokenBreakdownDayRow,
  type UsageStatsRepositoryShape,
} from "../Services/UsageStats.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
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
          user_messages AS "userMessages"
        FROM usage_stats_days
        ORDER BY day ASC
      `,
  });

  const upsertUsageStatsDayDelta = SqlSchema.void({
    Request: UsageStatsDayRow,
    execute: (row) =>
      sql`
        INSERT INTO usage_stats_days (day, generating_ms, output_tokens, user_messages)
        VALUES (${row.day}, ${row.generatingMs}, ${row.outputTokens}, ${row.userMessages})
        ON CONFLICT (day)
        DO UPDATE SET
          generating_ms = generating_ms + excluded.generating_ms,
          output_tokens = output_tokens + excluded.output_tokens,
          user_messages = user_messages + excluded.user_messages
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
          output_tokens AS "outputTokens"
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
          output_tokens
        )
        VALUES (${row.day}, ${row.provider}, ${row.model}, ${row.outputTokens})
        ON CONFLICT (day, provider_driver, model)
        DO UPDATE SET
          output_tokens = output_tokens + excluded.output_tokens
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

  return {
    listDays,
    listTokenBreakdownDays,
    flushDeltas,
  } satisfies UsageStatsRepositoryShape;
});

export const UsageStatsRepositoryLive = Layer.effect(
  UsageStatsRepository,
  makeUsageStatsRepository,
);
