import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  UsageStatsDayRow,
  UsageStatsRepository,
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

  const listDays: UsageStatsRepositoryShape["listDays"] = listUsageStatsDayRows({}).pipe(
    Effect.mapError(
      toPersistenceSqlOrDecodeError(
        "UsageStatsRepository.listDays:query",
        "UsageStatsRepository.listDays:decodeRows",
      ),
    ),
  );

  const upsertDayDeltas: UsageStatsRepositoryShape["upsertDayDeltas"] = (rows) =>
    (rows.length === 1
      ? upsertUsageStatsDayDelta(rows[0]!)
      : sql.withTransaction(Effect.forEach(rows, upsertUsageStatsDayDelta, { discard: true }))
    ).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "UsageStatsRepository.upsertDayDeltas:query",
          "UsageStatsRepository.upsertDayDeltas:encodeRequest",
        ),
      ),
    );

  return {
    listDays,
    upsertDayDeltas,
  } satisfies UsageStatsRepositoryShape;
});

export const UsageStatsRepositoryLive = Layer.effect(
  UsageStatsRepository,
  makeUsageStatsRepository,
);
