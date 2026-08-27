import { useMemo } from "react";
import type { UsageStatsGetResult } from "@cafecode/contracts";
import { rollUpCost, type ModelRate } from "@cafecode/shared/modelPricing";

import { useSettings } from "../../hooks/useSettings";
import { useCountUp } from "./useCountUp";
import { useUsageStatsDetail } from "./usageStatsDetailResource";

/**
 * Lifetime token and cost totals, for surfaces that want the headline figure
 * without the whole Usage page.
 *
 * Deliberately does not subscribe to the 10 Hz snapshot stream: this exists for
 * ambient readouts, and a decorative counter has no business re-rendering its
 * host ten times a second. The shared detail resource single-flights one
 * five-second refresh across Atrium and Settings, retains the last successful
 * response across unmounts, and refreshes immediately after reconnection.
 */

export interface UsageCostSummary {
  readonly cost: number;
  readonly tokens: number;
  /** True once a response has arrived, so callers can hold their layout. */
  readonly loaded: boolean;
  /** Some recorded volume has no rate, so `cost` covers only part of it. */
  readonly hasUnpriced: boolean;
  /** Daily totals for a sparkline, oldest first. Covers all usage, not one view. */
  readonly daily: ReadonlyArray<{ day: string; tokens: number; cost: number }>;
  /** Totals over `dayWindow` only, for surfaces that offer a range selector. */
  readonly rangeTokens: number;
  readonly rangeCost: number;
  /** Lifetime output tokens, for surfaces showing composition. */
  readonly outputTokens: number;
  /** Share of input served from cache, 0..1, or null when there is no input. */
  readonly cachedShare: number | null;
  /** USD not spent because the cache served input at its lower rate. */
  readonly cacheSavings: number;
  /** The raw response, for surfaces rendering the full cost panels. */
  readonly raw: UsageStatsGetResult | null;
}

const EMPTY: UsageCostSummary = {
  cost: 0,
  tokens: 0,
  loaded: false,
  hasUnpriced: false,
  daily: [],
  rangeTokens: 0,
  rangeCost: 0,
  outputTokens: 0,
  cachedShare: null,
  cacheSavings: 0,
  raw: null,
};

export function useUsageCostSummary(enabled: boolean, dayWindow = 30): UsageCostSummary {
  const overrides = useSettings((settings) => settings.modelPricingOverrides) as
    | Record<string, ModelRate>
    | undefined;
  const usage = useUsageStatsDetail(enabled).data;

  const summary = useMemo(() => {
    if (usage === null) return EMPTY;
    const rollup = rollUpCost(usage.tokenBreakdown, overrides);
    // Daily rows carry no model dimension, so per-day cost uses the blended
    // rate implied by the lifetime ledger. Good enough for a sparkline's shape;
    // the exact figure is the headline beside it.
    const blended = rollup.pricedTokens > 0 ? rollup.cost / rollup.pricedTokens : 0;
    const daily = usage.days.slice(-dayWindow).map((day) => {
      const tokens = day.inputTokens + day.outputTokens;
      return { day: day.day, tokens, cost: tokens * blended };
    });
    return {
      cost: rollup.cost,
      tokens: usage.totals.inputTokens + usage.totals.outputTokens,
      loaded: true,
      hasUnpriced: rollup.unpricedTokens > 0,
      daily,
      rangeTokens: daily.reduce((total, day) => total + day.tokens, 0),
      // Blended, like the daily series it is summed from. The lifetime `cost`
      // above is the exact figure; this one is scoped to the window.
      rangeCost: daily.reduce((total, day) => total + day.cost, 0),
      outputTokens: usage.totals.outputTokens,
      cachedShare:
        usage.totals.inputTokens > 0
          ? usage.totals.cachedInputTokens / usage.totals.inputTokens
          : null,
      cacheSavings: rollup.cacheSavings,
      raw: usage,
    };
  }, [usage, overrides, dayWindow]);

  // The Atrium's exact output counter uses the same odometer as the detailed
  // Usage composition. The raw response remains exact and unanimated so every
  // graph series is recalculated atomically from one server snapshot.
  const displayedOutputTokens = useCountUp(summary.outputTokens);
  return useMemo(
    () => ({ ...summary, outputTokens: displayedOutputTokens }),
    [displayedOutputTokens, summary],
  );
}
