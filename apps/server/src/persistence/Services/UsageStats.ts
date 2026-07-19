/**
 * UsageStatsRepository - Persistence for aggregated usage counters.
 *
 * One row per server-local day. The UsageStatsService keeps live counters in
 * memory and flushes accumulated deltas here every few seconds, so writes are
 * additive increments rather than absolute values. Output-token attribution is
 * stored separately by provider driver and model; configured provider instance
 * ids are intentionally excluded so this table never becomes an account-usage
 * ledger.
 *
 * @module UsageStatsRepository
 */
import {
  NonNegativeInt,
  ProviderDriverKind,
  TrimmedNonEmptyString,
  UsageStatsDayKey,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const UsageStatsDayRow = Schema.Struct({
  day: UsageStatsDayKey,
  generatingMs: NonNegativeInt,
  outputTokens: NonNegativeInt,
  userMessages: NonNegativeInt,
});
export type UsageStatsDayRow = typeof UsageStatsDayRow.Type;

/**
 * Provider model identifiers originate outside Cafe. Bound their persisted
 * size so a hostile or malformed runtime event cannot create unbounded SQLite
 * index keys. The service maps invalid/missing values to a short sentinel.
 */
export const UsageStatsModel = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type UsageStatsModel = typeof UsageStatsModel.Type;

export const UsageStatsTokenBreakdownDayRow = Schema.Struct({
  day: UsageStatsDayKey,
  provider: ProviderDriverKind,
  model: UsageStatsModel,
  outputTokens: NonNegativeInt,
});
export type UsageStatsTokenBreakdownDayRow = typeof UsageStatsTokenBreakdownDayRow.Type;

export interface UsageStatsFlushDeltas {
  readonly days: ReadonlyArray<UsageStatsDayRow>;
  readonly tokenBreakdowns: ReadonlyArray<UsageStatsTokenBreakdownDayRow>;
}

export interface UsageStatsRepositoryShape {
  /**
   * List every recorded day ascending. Row counts stay tiny (one per active
   * day), so callers hydrate the whole table into memory at startup.
   */
  readonly listDays: Effect.Effect<ReadonlyArray<UsageStatsDayRow>, ProjectionRepositoryError>;

  /**
   * List provider/model output-token attribution ascending by day and stable
   * key order. This is deliberately not loaded by the aggregate usage service
   * or exposed through the current Usage UI.
   */
  readonly listTokenBreakdownDays: Effect.Effect<
    ReadonlyArray<UsageStatsTokenBreakdownDayRow>,
    ProjectionRepositoryError
  >;

  /**
   * Add aggregate and provider/model deltas, creating rows as needed. Both
   * tables commit in one transaction so a retry can never double-count only
   * one side of the same output-token observation.
   */
  readonly flushDeltas: (
    deltas: UsageStatsFlushDeltas,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class UsageStatsRepository extends Context.Service<
  UsageStatsRepository,
  UsageStatsRepositoryShape
>()("cafecode/persistence/Services/UsageStats/UsageStatsRepository") {}
