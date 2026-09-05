import type { UsageStatsGetResult, UsageStatsTokenBreakdownDayEntry } from "@cafecode/contracts";
import { rollUpCost, type ModelRate } from "@cafecode/shared/modelPricing";

/** Price each local day from that day's models and cache mix, never a lifetime average. */
export function dailyUsageCost(
  usage: Pick<UsageStatsGetResult, "days" | "tokenBreakdownDays">,
  overrides?: Readonly<Record<string, ModelRate>>,
) {
  const rowsByDay = new Map<string, UsageStatsTokenBreakdownDayEntry[]>();
  for (const row of usage.tokenBreakdownDays ?? []) {
    const rows = rowsByDay.get(row.day) ?? [];
    rows.push(row);
    rowsByDay.set(row.day, rows);
  }
  return usage.days.map((day) => {
    const rollup = rollUpCost(rowsByDay.get(day.day) ?? [], overrides);
    const tokens = day.inputTokens + day.outputTokens;
    // Older servers/rows may not have daily attribution. Keep that volume
    // explicitly unpriced rather than retroactively assigning today's model
    // or an unrelated lifetime blended rate to it.
    const unpricedTokens =
      rollup.unpricedTokens + Math.max(0, tokens - rollup.pricedTokens - rollup.unpricedTokens);
    return { day: day.day, tokens, cost: rollup.cost, unpricedTokens };
  });
}
