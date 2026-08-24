import { useEffect, useMemo, useState } from "react";
import type { UsageStatsGetResult } from "@cafecode/contracts";
import { rollUpCost, type ModelRate } from "@cafecode/shared/modelPricing";

import { useSettings } from "../../hooks/useSettings";

/**
 * Lifetime token and cost totals, for surfaces that want the headline figure
 * without the whole Usage page.
 *
 * Deliberately does not subscribe to the 10 Hz snapshot stream: this exists for
 * ambient readouts, and a decorative counter has no business re-rendering its
 * host ten times a second. It polls the same detail endpoint the Usage page
 * uses, slowly, and stops entirely while the document is hidden.
 */

const REFRESH_INTERVAL_MS = 30_000;

export interface UsageCostSummary {
  readonly cost: number;
  readonly tokens: number;
  /** True once a response has arrived, so callers can hold their layout. */
  readonly loaded: boolean;
  /** Some recorded volume has no rate, so `cost` covers only part of it. */
  readonly hasUnpriced: boolean;
  /** Daily totals for a sparkline, oldest first. Covers all usage, not one view. */
  readonly daily: ReadonlyArray<{ day: string; tokens: number; cost: number }>;
}

const EMPTY: UsageCostSummary = {
  cost: 0,
  tokens: 0,
  loaded: false,
  hasUnpriced: false,
  daily: [],
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

    const load = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
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

    void load();
    const interval = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", load);
    };
  }, [enabled]);

  return useMemo(() => {
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
    };
  }, [usage, overrides, dayWindow]);
}
