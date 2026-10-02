import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const USAGE_STATS_MODEL_MAX_CHARS = 256;

/** Local-date key, `YYYY-MM-DD` in the server's timezone. */
export const UsageStatsDayKey = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type UsageStatsDayKey = typeof UsageStatsDayKey.Type;

/**
 * Token counters shared by day rows, totals and the model breakdown.
 *
 * `cachedInputTokens` and `cacheWriteInputTokens` are subsets of `inputTokens`;
 * `reasoningOutputTokens` is a subset of `outputTokens`. Adding a subset to its
 * parent double counts. Uncached input is `inputTokens - cachedInputTokens -
 * cacheWriteInputTokens`.
 *
 * Every field but `outputTokens` was added after the fact, so rows recorded
 * before that migration carry zeroes rather than real counts — the discarded
 * values were never stored and cannot be back-filled. Readers that show cost
 * must treat a day with output but no input as unmeasured, not as free.
 */
const UsageStatsTokenCountFields = {
  outputTokens: NonNegativeInt,
  inputTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  cachedInputTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  cacheWriteInputTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  reasoningOutputTokens: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
} as const;

export const UsageStatsDay = Schema.Struct({
  day: UsageStatsDayKey,
  generatingMs: NonNegativeInt,
  userMessages: NonNegativeInt,
  ...UsageStatsTokenCountFields,
});
export type UsageStatsDay = typeof UsageStatsDay.Type;

export const UsageStatsTotals = Schema.Struct({
  generatingMs: NonNegativeInt,
  userMessages: NonNegativeInt,
  ...UsageStatsTokenCountFields,
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
  ...UsageStatsTokenCountFields,
});
export type UsageStatsTokenBreakdownEntry = typeof UsageStatsTokenBreakdownEntry.Type;

/** Daily attribution used for rate-aware graphs; never sent on the live stream. */
export const UsageStatsTokenBreakdownDayEntry = Schema.Struct({
  day: UsageStatsDayKey,
  ...UsageStatsTokenBreakdownEntry.fields,
});
export type UsageStatsTokenBreakdownDayEntry = typeof UsageStatsTokenBreakdownDayEntry.Type;

/** Prospective active-turn wall time, aggregated across configured accounts. */
export const UsageStatsModelGeneratingTimeStartedAt = Schema.String.check(
  Schema.makeFilter((value) => {
    // The existing general-purpose IsoDateTime is deliberately permissive.
    // This measurement boundary is durable metadata, so require one canonical
    // UTC spelling and a real calendar instant rather than accepting Date's
    // rollover of impossible dates (e.g. February 30).
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const millis = Date.parse(value);
    return Number.isFinite(millis) && new Date(millis).toISOString() === value;
  }),
);

export const UsageStatsModelGeneratingTimeEntry = Schema.Struct({
  provider: ProviderDriverKind,
  model: UsageStatsModel,
  generatingMs: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
});
export type UsageStatsModelGeneratingTimeEntry = typeof UsageStatsModelGeneratingTimeEntry.Type;

export const UsageStatsModelGeneratingTimeDayEntry = Schema.Struct({
  day: UsageStatsDayKey,
  ...UsageStatsModelGeneratingTimeEntry.fields,
});
export type UsageStatsModelGeneratingTimeDayEntry =
  typeof UsageStatsModelGeneratingTimeDayEntry.Type;

/**
 * Measurement starts when the server installs its separate model-time ledger.
 * Historical aggregate time has no recoverable model attribution; startedAt
 * makes that boundary explicit instead of presenting missing history as zero.
 * Tools/waits count as active-turn time and concurrent turns add independently.
 */
export const UsageStatsModelGeneratingTime = Schema.Struct({
  startedAt: UsageStatsModelGeneratingTimeStartedAt,
  totals: Schema.Array(UsageStatsModelGeneratingTimeEntry),
  days: Schema.Array(UsageStatsModelGeneratingTimeDayEntry),
});
export type UsageStatsModelGeneratingTime = typeof UsageStatsModelGeneratingTime.Type;

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
  // Optional for older saved environments. Absence means unavailable daily
  // attribution, not permission to invent a daily rate from lifetime totals.
  tokenBreakdownDays: Schema.optional(Schema.Array(UsageStatsTokenBreakdownDayEntry)),
  // Older saved environments cannot supply model-time history. Keep absence
  // distinct from a measured empty ledger and never infer it from token share.
  modelGeneratingTime: Schema.optional(UsageStatsModelGeneratingTime),
});
export type UsageStatsGetResult = typeof UsageStatsGetResult.Type;
