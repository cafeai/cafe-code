import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { UsageStatsGetResult } from "@cafecode/contracts";

const usageHarness = vi.hoisted(() => ({
  getUsageStats: vi.fn<() => Promise<UsageStatsGetResult>>(),
}));

vi.mock("~/environments/runtime", () => ({
  getPrimaryEnvironmentConnection: () => ({
    client: { server: { getUsageStats: usageHarness.getUsageStats } },
  }),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (settings: { modelPricingOverrides: undefined }) => unknown) =>
    selector({ modelPricingOverrides: undefined }),
}));

import { useUsageCostSummary } from "./useUsageCostSummary";

function createUsage(outputTokens: number, todayOutputTokens: number): UsageStatsGetResult {
  const today = {
    day: "2026-08-25",
    generatingMs: 1_000,
    inputTokens: 2_000,
    cachedInputTokens: 1_000,
    cacheWriteInputTokens: 0,
    outputTokens: todayOutputTokens,
    reasoningOutputTokens: 0,
    userMessages: 1,
  };
  return {
    totals: {
      ...today,
      outputTokens,
    },
    today,
    activeSessionCount: 0,
    collectionEnabled: true,
    asOfMs: Date.now(),
    days: [today],
    tokenBreakdown: [
      {
        provider: "codex",
        model: "gpt-5.6-codex",
        inputTokens: 2_000,
        cachedInputTokens: 1_000,
        cacheWriteInputTokens: 0,
        outputTokens,
        reasoningOutputTokens: 0,
      },
    ],
  } as unknown as UsageStatsGetResult;
}

function UsageSummaryProbe() {
  const summary = useUsageCostSummary(true);
  return (
    <div>
      <span data-summary-output="true">{summary.outputTokens}</span>
      <span data-raw-output="true">{summary.raw?.totals.outputTokens ?? "loading"}</span>
      <span data-chart-day-output="true">
        {summary.raw?.days.at(-1)?.outputTokens ?? "loading"}
      </span>
    </div>
  );
}

function textNumber(selector: string): number {
  const value = document.querySelector(selector)?.textContent;
  expect(value).toBeDefined();
  return Number(value);
}

describe("useUsageCostSummary", () => {
  let visibility: DocumentVisibilityState;
  let visibilitySpy: ReturnType<typeof vi.spyOn>;
  let nextIntervalId: number;
  let activeIntervals: Map<number, () => void>;
  let intervalDelays: number[];
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    visibility = "visible";
    nextIntervalId = 1;
    activeIntervals = new Map();
    intervalDelays = [];
    visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    // Own only the polling clock. RAF stays real so the same test can observe
    // the production odometer without globally freezing browser rendering.
    setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
      if (typeof handler !== "function") throw new Error("Expected an interval callback");
      const id = nextIntervalId++;
      activeIntervals.set(id, () => handler(undefined));
      intervalDelays.push(Number(delay));
      return id as unknown as ReturnType<typeof window.setInterval>;
    });
    clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation((id) => {
      activeIntervals.delete(Number(id));
    });
    usageHarness.getUsageStats.mockReset();
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    visibilitySpy.mockRestore();
    document.body.innerHTML = "";
  });

  it("refreshes headline and graph data every five seconds without overlapping or leaking", async () => {
    const first = createUsage(1_000, 100);
    const second = createUsage(1_250, 250);
    let resolveRefresh!: (usage: UsageStatsGetResult) => void;
    const blockedRefresh = new Promise<UsageStatsGetResult>((resolve) => {
      resolveRefresh = resolve;
    });
    usageHarness.getUsageStats
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(blockedRefresh)
      .mockResolvedValue(second);

    const screen = await render(<UsageSummaryProbe />);
    let mounted = true;
    try {
      await vi.waitFor(() => {
        expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);
        expect(textNumber('[data-raw-output="true"]')).toBe(1_000);
        expect(textNumber('[data-chart-day-output="true"]')).toBe(100);
      });
      expect(activeIntervals.size).toBe(1);
      expect(intervalDelays).toEqual([5_000]);
      await Promise.resolve();
      await Promise.resolve();

      activeIntervals.values().next().value?.();
      await vi.waitFor(() => expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(2));

      // An unresolved request spans two more ticks. The in-flight guard must
      // coalesce them rather than building a queue of stale detail reads.
      activeIntervals.values().next().value?.();
      activeIntervals.values().next().value?.();
      expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(2);

      resolveRefresh(second);
      await vi.waitFor(() => {
        expect(textNumber('[data-raw-output="true"]')).toBe(1_250);
        expect(textNumber('[data-chart-day-output="true"]')).toBe(250);
      });
      await vi.waitFor(() => {
        const animated = textNumber('[data-summary-output="true"]');
        expect(animated).toBeGreaterThan(0);
        expect(animated).toBeLessThan(1_250);
      });
      await vi.waitFor(() => expect(textNumber('[data-summary-output="true"]')).toBe(1_250), {
        timeout: 3_000,
      });

      activeIntervals.values().next().value?.();
      await vi.waitFor(() => expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(3));
      await Promise.resolve();
      await Promise.resolve();

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(activeIntervals.size).toBe(0);
      expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(3);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(4));
      expect(activeIntervals.size).toBe(1);
      expect(intervalDelays).toEqual([5_000, 5_000]);
      // Duplicate browser events must not create a second timer or request.
      document.dispatchEvent(new Event("visibilitychange"));
      expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(4);
      expect(activeIntervals.size).toBe(1);

      await screen.unmount();
      mounted = false;
      expect(activeIntervals.size).toBe(0);
      expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(4);
    } finally {
      if (mounted) await screen.unmount();
    }
  });
});
