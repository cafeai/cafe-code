/**
 * UsageStatsService - Live lifetime usage counters.
 *
 * Tracks tokens generated, user chats sent, and time spent generating across
 * every thread, accumulating in memory and flushing aggregated per-day deltas
 * to SQLite every few seconds. Reads never touch SQL after startup hydration.
 *
 * @module UsageStatsService
 */
import type { UsageStatsGetResult, UsageStatsSnapshot } from "@cafecode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface UsageStatsServiceShape {
  /**
   * Lifetime totals plus the full per-day history for the activity heatmap.
   * Served from memory.
   */
  readonly get: Effect.Effect<UsageStatsGetResult>;

  /**
   * Lifetime totals including time accrued by in-flight turns up to `asOfMs`.
   * Pushed to stats-page subscribers roughly once per second.
   */
  readonly snapshot: Effect.Effect<UsageStatsSnapshot>;

  /**
   * Persist pending deltas now. The service flushes on an interval and on
   * shutdown; this exists for tests.
   */
  readonly flush: Effect.Effect<void>;
}

export class UsageStatsService extends Context.Service<UsageStatsService, UsageStatsServiceShape>()(
  "cafecode/usageStats/Services/UsageStatsService",
) {}
