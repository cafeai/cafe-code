import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { UsageStatsGetResult } from "@cafecode/contracts";

const usageHarness = vi.hoisted(() => ({
  getUsageStats: vi.fn<() => Promise<UsageStatsGetResult>>(),
  connectionOpenedListener: null as
    | ((event: { readonly openCount: number; readonly reconnected: boolean }) => void)
    | null,
  subscribeConnectionOpened: vi.fn(
    (listener: (event: { readonly openCount: number; readonly reconnected: boolean }) => void) => {
      usageHarness.connectionOpenedListener = listener;
      return () => {
        if (usageHarness.connectionOpenedListener === listener) {
          usageHarness.connectionOpenedListener = null;
        }
      };
    },
  ),
}));

vi.mock("~/environments/runtime", () => ({
  getPrimaryEnvironmentConnection: () => ({
    client: {
      server: { getUsageStats: usageHarness.getUsageStats },
      subscribeConnectionOpened: usageHarness.subscribeConnectionOpened,
    },
  }),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (settings: { modelPricingOverrides: undefined }) => unknown) =>
    selector({ modelPricingOverrides: undefined }),
}));

import { useUsageCostSummary } from "./useUsageCostSummary";
import {
  getUsageStatsDetailDiagnostics,
  resetUsageStatsDetailResourceForTests,
} from "./usageStatsDetailResource";

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
      <span data-summary-range-cost="true">{summary.rangeCost}</span>
      <span data-summary-unpriced="true">{String(summary.hasUnpriced)}</span>
      <span data-raw-output="true">{summary.raw?.totals.outputTokens ?? "loading"}</span>
      <span data-chart-day-output="true">
        {summary.raw?.days.at(-1)?.outputTokens ?? "loading"}
      </span>
    </div>
  );
}

function TwoUsageSummaryProbes() {
  return (
    <>
      <UsageSummaryProbe />
      <UsageSummaryProbe />
    </>
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
    usageHarness.subscribeConnectionOpened.mockClear();
    usageHarness.connectionOpenedListener = null;
    resetUsageStatsDetailResourceForTests();
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    visibilitySpy.mockRestore();
    document.body.innerHTML = "";
  });

  it("uses daily model attribution and marks missing history unpriced", async () => {
    const usage = createUsage(100_000, 100);
    usageHarness.getUsageStats.mockResolvedValue({
      ...usage,
      tokenBreakdownDays: [
        {
          ...usage.tokenBreakdown[0]!,
          day: usage.today.day,
          model: "gpt-6-astra",
          inputTokens: 2_000,
          cachedInputTokens: 1_000,
          outputTokens: 100,
        },
      ],
    });
    const screen = await render(<UsageSummaryProbe />);
    try {
      await vi.waitFor(() => {
        // 1k fresh at $10/M + 1k cached at $1/M + 100 output at $50/M.
        // The much larger lifetime output must not inflate this day's cost.
        expect(textNumber('[data-summary-range-cost="true"]')).toBeCloseTo(0.016);
      });
      expect(document.querySelector('[data-summary-unpriced="true"]')?.textContent).toBe("false");
      usageHarness.getUsageStats.mockResolvedValue(usage);
      activeIntervals.values().next().value?.();
      await vi.waitFor(() => {
        expect(textNumber('[data-summary-range-cost="true"]')).toBe(0);
        expect(document.querySelector('[data-summary-unpriced="true"]')?.textContent).toBe("true");
      });
    } finally {
      await screen.unmount();
    }
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

  it("single-flights multiple consumers and reuses cached detail across an Atrium remount", async () => {
    const first = createUsage(2_000, 200);
    let resolveRefresh!: (usage: UsageStatsGetResult) => void;
    const blockedRefresh = new Promise<UsageStatsGetResult>((resolve) => {
      resolveRefresh = resolve;
    });
    usageHarness.getUsageStats.mockResolvedValueOnce(first).mockReturnValueOnce(blockedRefresh);

    const firstScreen = await render(<TwoUsageSummaryProbes />);
    await vi.waitFor(() => {
      expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll('[data-raw-output="true"]')).toHaveLength(2);
      for (const node of document.querySelectorAll('[data-raw-output="true"]')) {
        expect(node.textContent).toBe("2000");
      }
    });
    expect(activeIntervals.size).toBe(1);
    await firstScreen.unmount();
    expect(activeIntervals.size).toBe(0);

    const secondScreen = await render(<UsageSummaryProbe />);
    try {
      // The remount starts one background refresh, but the graph/headline can
      // render the retained server-authoritative snapshot immediately.
      await vi.waitFor(() => expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(2));
      expect(textNumber('[data-raw-output="true"]')).toBe(2_000);
      expect(textNumber('[data-chart-day-output="true"]')).toBe(200);
      resolveRefresh(createUsage(2_100, 210));
      await vi.waitFor(() => expect(textNumber('[data-raw-output="true"]')).toBe(2_100));
    } finally {
      await secondScreen.unmount();
    }
  });

  it("refreshes cached detail immediately after a websocket reconnect", async () => {
    usageHarness.getUsageStats
      .mockResolvedValueOnce(createUsage(3_000, 300))
      .mockResolvedValueOnce(createUsage(3_100, 310));

    const screen = await render(<UsageSummaryProbe />);
    try {
      await vi.waitFor(() => expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1));
      usageHarness.connectionOpenedListener?.({ openCount: 1, reconnected: false });
      await Promise.resolve();
      expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);
      usageHarness.connectionOpenedListener?.({ openCount: 2, reconnected: true });

      await vi.waitFor(() => {
        expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(2);
        expect(textNumber('[data-raw-output="true"]')).toBe(3_100);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("queues exactly one reconnect refresh behind an in-flight request", async () => {
    let resolveInitial!: (usage: UsageStatsGetResult) => void;
    const blockedInitial = new Promise<UsageStatsGetResult>((resolve) => {
      resolveInitial = resolve;
    });
    usageHarness.getUsageStats
      .mockReturnValueOnce(blockedInitial)
      .mockResolvedValueOnce(createUsage(4_100, 410));

    const screen = await render(<UsageSummaryProbe />);
    try {
      await vi.waitFor(() => expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1));

      usageHarness.connectionOpenedListener?.({ openCount: 2, reconnected: true });
      usageHarness.connectionOpenedListener?.({ openCount: 3, reconnected: true });
      expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);

      resolveInitial(createUsage(4_000, 400));
      await vi.waitFor(() => {
        expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(2);
        expect(textNumber('[data-raw-output="true"]')).toBe(4_100);
      });
      expect(getUsageStatsDetailDiagnostics().reconnectRefreshCount).toBe(1);
    } finally {
      await screen.unmount();
    }
  });
});
