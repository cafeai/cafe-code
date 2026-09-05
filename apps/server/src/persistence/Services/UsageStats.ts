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
  UsageStatsDayKey,
  UsageStatsModel,
  type UsageAccountingSnapshot,
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
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheWriteInputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
});
export type UsageStatsDayRow = typeof UsageStatsDayRow.Type;

export const UsageStatsTokenBreakdownDayRow = Schema.Struct({
  day: UsageStatsDayKey,
  provider: ProviderDriverKind,
  model: UsageStatsModel,
  outputTokens: NonNegativeInt,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheWriteInputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
});
export type UsageStatsTokenBreakdownDayRow = typeof UsageStatsTokenBreakdownDayRow.Type;

export interface UsageStatsFlushDeltas {
  readonly days: ReadonlyArray<UsageStatsDayRow>;
  readonly tokenBreakdowns: ReadonlyArray<UsageStatsTokenBreakdownDayRow>;
}

export interface UsageStatsRepositoryShape {
  /**
   * Atomically settle a cumulative billing epoch and its daily/model deltas.
   * Durable revision fencing makes repeated daemon replay and reattachment
   * harmless. Disabled collection advances only the checkpoint, never totals.
   */
  readonly recordAccountingSnapshot: (input: {
    readonly provider: ProviderDriverKind;
    readonly snapshot: UsageAccountingSnapshot;
    readonly day: string;
    readonly enabled: boolean;
  }) => Effect.Effect<ReadonlyArray<UsageStatsTokenBreakdownDayRow>, ProjectionRepositoryError>;
  /**
   * List every recorded day ascending. Row counts stay tiny (one per active
   * day), so callers hydrate the whole table into memory at startup.
   */
  readonly listDays: Effect.Effect<ReadonlyArray<UsageStatsDayRow>, ProjectionRepositoryError>;

  /**
   * List provider/model output-token attribution ascending by day and stable
   * key order. The usage service hydrates these rows once and aggregates them
   * in memory; opening Settings must not query SQLite.
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
