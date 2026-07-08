import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

/** Local-date key, `YYYY-MM-DD` in the server's timezone. */
export const UsageStatsDayKey = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type UsageStatsDayKey = typeof UsageStatsDayKey.Type;

export const UsageStatsDay = Schema.Struct({
  day: UsageStatsDayKey,
  generatingMs: NonNegativeInt,
  outputTokens: NonNegativeInt,
  userMessages: NonNegativeInt,
});
export type UsageStatsDay = typeof UsageStatsDay.Type;

export const UsageStatsTotals = Schema.Struct({
  generatingMs: NonNegativeInt,
  outputTokens: NonNegativeInt,
  userMessages: NonNegativeInt,
});
export type UsageStatsTotals = typeof UsageStatsTotals.Type;

/**
 * Live totals pushed to subscribers roughly once per second. `totals`
 * includes time accrued by in-flight turns up to `asOfMs`; clients
 * extrapolate between pushes as `activeSessionCount` ms per elapsed ms
 * (three concurrently generating sessions advance the clock 3x).
 */
export const UsageStatsSnapshot = Schema.Struct({
  totals: UsageStatsTotals,
  today: UsageStatsDay,
  activeSessionCount: NonNegativeInt,
  collectionEnabled: Schema.Boolean,
  asOfMs: NonNegativeInt,
});
export type UsageStatsSnapshot = typeof UsageStatsSnapshot.Type;

export const UsageStatsGetResult = Schema.Struct({
  ...UsageStatsSnapshot.fields,
  /** Every recorded day, ascending; days with no activity have no entry. */
  days: Schema.Array(UsageStatsDay),
});
export type UsageStatsGetResult = typeof UsageStatsGetResult.Type;
