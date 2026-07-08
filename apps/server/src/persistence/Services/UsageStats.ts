/**
 * UsageStatsRepository - Persistence for aggregated usage counters.
 *
 * One row per server-local day. The UsageStatsService keeps live counters in
 * memory and flushes accumulated deltas here every few seconds, so writes are
 * additive increments rather than absolute values.
 *
 * @module UsageStatsRepository
 */
import { NonNegativeInt, UsageStatsDayKey } from "@cafecode/contracts";
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

export interface UsageStatsRepositoryShape {
  /**
   * List every recorded day ascending. Row counts stay tiny (one per active
   * day), so callers hydrate the whole table into memory at startup.
   */
  readonly listDays: Effect.Effect<ReadonlyArray<UsageStatsDayRow>, ProjectionRepositoryError>;

  /**
   * Add the given deltas onto the stored counters for each row's day,
   * creating rows as needed. All rows apply atomically.
   */
  readonly upsertDayDeltas: (
    rows: ReadonlyArray<UsageStatsDayRow>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class UsageStatsRepository extends Context.Service<
  UsageStatsRepository,
  UsageStatsRepositoryShape
>()("cafecode/persistence/Services/UsageStats/UsageStatsRepository") {}
