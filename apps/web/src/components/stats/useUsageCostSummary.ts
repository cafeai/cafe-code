import { useEffect, useMemo, useState } from "react";
import type { UsageStatsGetResult } from "@cafecode/contracts";
import { rollUpCost, type ModelRate } from "@cafecode/shared/modelPricing";

import { useSettings } from "../../hooks/useSettings";
import { useCountUp } from "./useCountUp";

/**
 * Lifetime token and cost totals, for surfaces that want the headline figure
 * without the whole Usage page.
 *
 * Deliberately does not subscribe to the 10 Hz snapshot stream: this exists for
 * ambient readouts, and a decorative counter has no business re-rendering its
 * host ten times a second. It polls the same detail endpoint the Usage page
 * uses every five seconds and stops entirely while the document is hidden.
 */

const REFRESH_INTERVAL_MS = 5_000;

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
  const [usage, setUsage] = useState<UsageStatsGetResult | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    let interval: number | null = null;

    const load = async () => {
      if (cancelled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        // Imported on demand: this hook hangs off decorative surfaces, and a
        // static import would drag the whole environment runtime into their
        // module graph for a readout that may never be shown.
        const { getPrimaryEnvironmentConnection } = await import("~/environments/runtime");
        const result = await getPrimaryEnvironmentConnection().client.server.getUsageStats();
        if (!cancelled) setUsage(result);
      } catch {
        // An ambient readout must never surface a transport failure; it simply
        // keeps showing the last figure it had.
      } finally {
        inFlight = false;
      }
    };

    const stop = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };
    const syncVisibility = () => {
      if (document.visibilityState !== "visible") {
        stop();
        return;
      }
      // Repeated visibility events must not create parallel timers or eager
      // duplicate requests. A newly visible surface catches up immediately,
      // then owns exactly one bounded polling interval until it hides again.
      if (interval !== null) return;
      void load();
      interval = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    };

    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, [enabled]);

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
