import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { UsageStatsGetResult } from "@cafecode/contracts";

import { UsageCostContent } from "./UsageCostSection";
import { UsageStatsPanel } from "./UsageStatsPanel";

const usageHarness = vi.hoisted(() => {
  let detail: unknown;
  let snapshot: unknown;
  const updateSettings = vi.fn();
  const getUsageStats = vi.fn(async () => detail);
  const subscribeUsageStats = vi.fn((nextListener: (event: unknown) => void) => {
    nextListener(snapshot);
    return () => undefined;
  });

  return {
    updateSettings,
    getUsageStats,
    subscribeUsageStats,
    reset(nextDetail: unknown, nextSnapshot: unknown) {
      detail = nextDetail;
      snapshot = nextSnapshot;
      updateSettings.mockReset();
      getUsageStats.mockClear();
      subscribeUsageStats.mockClear();
    },
  };
});

vi.mock("../../environments/runtime", () => ({
  getPrimaryEnvironmentConnection: () => ({
    client: {
      server: {
        getUsageStats: usageHarness.getUsageStats,
        subscribeUsageStats: usageHarness.subscribeUsageStats,
      },
    },
  }),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (
    selector?: (settings: {
      usageStatsEnabled: boolean;
      modelPricingOverrides: undefined;
    }) => unknown,
  ) => {
    const settings = { usageStatsEnabled: true, modelPricingOverrides: undefined };
    return selector ? selector(settings) : settings;
  },
  useUpdateSettings: () => ({ updateSettings: usageHarness.updateSettings }),
}));

const totals = {
  generatingMs: 3_661_000,
  inputTokens: 2_750_000,
  cachedInputTokens: 1_250_000,
  cacheWriteInputTokens: 250_000,
  outputTokens: 250_000,
  reasoningOutputTokens: 50_000,
  userMessages: 42,
};

const snapshot = {
  totals,
  today: {
    day: "2026-07-21",
    generatingMs: 61_000,
    inputTokens: 325_000,
    cachedInputTokens: 125_000,
    cacheWriteInputTokens: 25_000,
    outputTokens: 25_000,
    reasoningOutputTokens: 5_000,
    userMessages: 4,
  },
  activeSessionCount: 0,
  collectionEnabled: true,
  asOfMs: Date.now(),
};

function createUsageDetail(): UsageStatsGetResult {
  return {
    ...snapshot,
    days: [snapshot.today],
    tokenBreakdown: [
      {
        provider: "codex",
        model: "gpt-5.6-codex",
        inputTokens: 1_500_000,
        cachedInputTokens: 750_000,
        cacheWriteInputTokens: 100_000,
        outputTokens: 100_000,
        reasoningOutputTokens: 20_000,
      },
      {
        provider: "codex",
        model: "gpt-5.6-codex-mini",
        inputTokens: 500_000,
        cachedInputTokens: 250_000,
        cacheWriteInputTokens: 50_000,
        outputTokens: 25_000,
        reasoningOutputTokens: 5_000,
      },
      {
        provider: "claudeAgent",
        model: "claude-opus-5",
        inputTokens: 750_000,
        cachedInputTokens: 250_000,
        cacheWriteInputTokens: 100_000,
        outputTokens: 75_000,
        reasoningOutputTokens: 25_000,
      },
    ],
  } as unknown as UsageStatsGetResult;
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  return element!;
}

function displayedRawCount(id: string): number {
  const text = requiredElement(`[data-usage-composition-raw="${id}"]`).textContent ?? "";
  const numeric = text.match(/[\d,]+/)?.[0];
  expect(numeric).toBeDefined();
  return Number(numeric!.replaceAll(",", ""));
}

describe("UsageStatsPanel", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(() => {
    usageHarness.reset(createUsageDetail(), snapshot);
  });

  afterEach(async () => {
    const teardown = mounted?.cleanup ?? mounted?.unmount;
    await teardown?.call(mounted).catch(() => {});
    mounted = null;
    document.body.innerHTML = "";
  });

  it("renders stored provider and model token attribution with earlier usage separated", async () => {
    mounted = await render(<UsageStatsPanel />);

    await expect.element(page.getByText("Tokens by provider and model")).toBeVisible();
    await expect.element(page.getByText("200,000 attributed")).toBeVisible();
    // Provider and model names now appear in the Cost section as well, so these
    // match more than once. Both are legitimate renders and the assertion is
    // only that the name appears; the section-specific strings above and below
    // are what actually pin this test to the attribution list.
    await expect.element(page.getByText("Codex", { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText("Claude", { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText("gpt-5.6-codex", { exact: true }).first()).toBeVisible();
    await expect
      .element(page.getByText("gpt-5.6-codex-mini", { exact: true }).first())
      .toBeVisible();
    await expect.element(page.getByText("claude-opus-5", { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText("Earlier usage")).toBeVisible();
    await expect
      .element(page.getByText("Recorded before provider and model attribution"))
      .toBeVisible();
    expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);
    expect(usageHarness.subscribeUsageStats).toHaveBeenCalledTimes(1);
  });

  it("renders a quiet empty state before attributed tokens exist", async () => {
    usageHarness.reset(
      {
        ...snapshot,
        totals: { ...totals, outputTokens: 0 },
        days: [],
        tokenBreakdown: [],
      },
      { ...snapshot, totals: { ...totals, outputTokens: 0 } },
    );

    mounted = await render(<UsageStatsPanel />);

    await expect
      .element(
        page.getByText(
          "Provider and model attribution will appear after output tokens are recorded.",
        ),
      )
      .toBeVisible();
  });

  it("labels every monetary estimate as USD and pairs compact tokens with exact counts", async () => {
    mounted = await render(<UsageCostContent usage={createUsageDetail()} />);

    const hero = requiredElement('[data-usage-cost-hero-value="true"]');
    expect(hero.textContent).toMatch(/^\$[\d,.]+ USD\*/);
    expect(requiredElement('[data-usage-cost-chart-label="true"]').textContent).toContain("USD");

    const providerCosts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-provider-cost-value="true"]'),
    );
    expect(providerCosts).toHaveLength(2);
    expect(providerCosts.every((entry) => /\$[\d,.]+ USD/.test(entry.textContent ?? ""))).toBe(
      true,
    );

    expect(requiredElement('[data-usage-composition-value="cache-savings"]').textContent).toMatch(
      /\$[\d,.]+ USD/,
    );
    expect(requiredElement('[data-usage-cost-quality-cache-savings="true"]').textContent).toMatch(
      /\$[\d,.]+ USD/,
    );
    const modelCosts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-model-cost-value="true"]'),
    );
    expect(modelCosts).toHaveLength(3);
    expect(modelCosts.every((entry) => /\$[\d,.]+ USD/.test(entry.textContent ?? ""))).toBe(true);

    expect(requiredElement('[data-usage-range-token-compact="true"]').textContent).toContain(
      "350K tokens in range",
    );
    expect(requiredElement('[data-usage-range-token-raw="true"]').textContent).toContain(
      "350,000 tokens exact",
    );

    const providerCompacts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-provider-token-compact="true"]'),
    );
    const providerRaws = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-provider-token-raw="true"]'),
    );
    expect(providerCompacts).toHaveLength(2);
    expect(providerRaws).toHaveLength(2);
    expect(providerCompacts.every((entry) => /[KM] tokens/.test(entry.textContent ?? ""))).toBe(
      true,
    );
    expect(
      providerRaws.every((entry) => /\d{1,3}(,\d{3})+ tokens exact/.test(entry.textContent ?? "")),
    ).toBe(true);

    const aggregateExpectations = {
      processed: ["3.00M", "3,000,000 tokens exact"],
      cached: ["1.25M", "1,250,000 tokens exact"],
      uncached: ["1.25M", "1,250,000 tokens exact"],
      output: ["250K", "250,000 tokens exact"],
    } as const;
    for (const [id, [compact, raw]] of Object.entries(aggregateExpectations)) {
      expect(requiredElement(`[data-usage-composition-compact="${id}"]`).textContent).toBe(compact);
      expect(requiredElement(`[data-usage-composition-raw="${id}"]`).textContent).toBe(raw);
    }

    expect(requiredElement('[data-usage-reasoning-token-compact="true"]').textContent).toContain(
      "50K reasoning",
    );
    expect(requiredElement('[data-usage-reasoning-token-raw="true"]').textContent).toContain(
      "50,000 tokens exact",
    );

    const modelCompacts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-model-token-compact="true"]'),
    );
    const modelRaws = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-model-token-raw="true"]'),
    );
    expect(modelCompacts).toHaveLength(3);
    expect(modelRaws).toHaveLength(3);
    expect(modelCompacts.every((entry) => /[KM]/.test(entry.textContent ?? ""))).toBe(true);
    expect(modelRaws.every((entry) => /\d{1,3}(,\d{3})+ exact/.test(entry.textContent ?? ""))).toBe(
      true,
    );
  });

  it("animates the exact aggregate count through a small increment", async () => {
    const initialUsage = createUsageDetail();
    mounted = await render(<UsageCostContent usage={initialUsage} />);
    expect(displayedRawCount("processed")).toBe(3_000_000);

    const nextUsage = {
      ...initialUsage,
      totals: {
        ...initialUsage.totals,
        outputTokens: initialUsage.totals.outputTokens + 10,
      },
    };
    await mounted.rerender(<UsageCostContent usage={nextUsage} />);

    await vi.waitFor(
      () => {
        expect(displayedRawCount("processed")).toBeGreaterThan(3_000_000);
        expect(displayedRawCount("processed")).toBeLessThan(3_000_010);
      },
      { interval: 10, timeout: 1_000 },
    );
    await vi.waitFor(() => expect(displayedRawCount("processed")).toBe(3_000_010), {
      timeout: 3_000,
    });
  });

  it("contains the cost layout within a narrow viewport", async () => {
    const originalViewport = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(320, 720);
    try {
      mounted = await render(<UsageCostContent usage={createUsageDetail()} />);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(requiredElement('[data-usage-composition-raw="processed"]')).toBeVisible();
    } finally {
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });
});
