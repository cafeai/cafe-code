import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const USAGE_STATS_MODEL_MAX_CHARS = 256;

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
 * Effective provider model attached to output-token observations. Provider
 * runtimes control this value, so the shared contract enforces the same bound
 * as the SQLite composite key before data can cross an RPC boundary.
 */
export const UsageStatsModel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(USAGE_STATS_MODEL_MAX_CHARS),
);
export type UsageStatsModel = typeof UsageStatsModel.Type;

/** Lifetime output-token attribution, intentionally aggregated across accounts. */
export const UsageStatsTokenBreakdownEntry = Schema.Struct({
  provider: ProviderDriverKind,
  model: UsageStatsModel,
  outputTokens: NonNegativeInt,
});
export type UsageStatsTokenBreakdownEntry = typeof UsageStatsTokenBreakdownEntry.Type;

/**
 * Live totals pushed to subscribers at a high cadence. `totals`
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
  /**
   * Lifetime provider/model token totals, sorted by provider then descending
   * token count. Kept off the high-frequency snapshot stream so historical
   * model cardinality cannot inflate the live counter hot path.
   */
  tokenBreakdown: Schema.Array(UsageStatsTokenBreakdownEntry).pipe(
    // Saved remote environments can run an older Cafe server during a
    // staggered upgrade. Treat the absent additive field as an empty ledger
    // instead of making the entire Usage page fail schema decoding.
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type UsageStatsGetResult = typeof UsageStatsGetResult.Type;
