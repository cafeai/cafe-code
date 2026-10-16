import "../../index.css";

import type { EnvironmentId, UsageStatsGetResult } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const usageHarness = vi.hoisted(() => ({
  environmentId: "usage-fixture" as EnvironmentId,
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

// Exercise the resource's selected-workspace path while keeping host bootstrap,
// account settings and native persistence outside this synthetic usage fixture.
// Both the hook and diagnostics resolve the same exact controlled resource.
vi.mock("~/environments/workspace", () => ({
  useWorkspaceEnvironmentId: () => usageHarness.environmentId,
  readWorkspaceEnvironmentId: () => usageHarness.environmentId,
}));

vi.mock("~/environments/runtime", () => ({
  requireEnvironmentConnection: (environmentId: EnvironmentId) => {
    if (environmentId !== usageHarness.environmentId)
      throw new Error("Unexpected usage fixture workspace");
    return {
      client: {
        server: { getUsageStats: usageHarness.getUsageStats },
        subscribeConnectionOpened: usageHarness.subscribeConnectionOpened,
      },
    };
  },
  getPrimaryEnvironmentConnection: () => {
    throw new Error("Usage fixture must use its selected workspace");
  },
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (settings: { modelPricingOverrides: undefined }) => unknown) =>
    selector({ modelPricingOverrides: undefined }),
}));

import { resetUsageStatsDetailResourceForTests } from "./usageStatsDetailResource";
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
});
