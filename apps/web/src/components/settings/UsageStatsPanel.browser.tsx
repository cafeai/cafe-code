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
  const subscribeConnectionOpened = vi.fn(() => () => undefined);
  const subscribeUsageStats = vi.fn((nextListener: (event: unknown) => void) => {
    nextListener(snapshot);
    return () => undefined;
  });

  return {
    updateSettings,
    getUsageStats,
    subscribeConnectionOpened,
    subscribeUsageStats,
    reset(nextDetail: unknown, nextSnapshot: unknown) {
      detail = nextDetail;
      snapshot = nextSnapshot;
      updateSettings.mockReset();
      getUsageStats.mockClear();
      subscribeConnectionOpened.mockClear();
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
      subscribeConnectionOpened: usageHarness.subscribeConnectionOpened,
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
  const text = requiredElement(`[data-usage-token-full="composition-${id}"]`).textContent ?? "";
  const numeric = text.match(/[\d,]+/)?.[0];
  expect(numeric).toBeDefined();
  return Number(numeric!.replaceAll(",", ""));
}

function expectFullBeforeCompact(context: string): void {
  const full = requiredElement(`[data-usage-token-full="${context}"]`);
  const compact = requiredElement(`[data-usage-token-compact="${context}"]`);
  expect(full.compareDocumentPosition(compact) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(Number.parseFloat(getComputedStyle(full).fontSize)).toBeGreaterThan(
    Number.parseFloat(getComputedStyle(compact).fontSize),
  );
  expect(compact.getAttribute("aria-hidden")).toBe("true");
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
    expect(usageHarness.subscribeConnectionOpened).toHaveBeenCalledTimes(1);
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

  it("labels monetary estimates as USD and makes full token counts primary", async () => {
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

    expect(requiredElement('[data-usage-token-full="range"]').textContent).toContain(
      "350,000 tokens in range",
    );
    expect(requiredElement('[data-usage-token-compact="range"]').textContent).toBe("350K");
    expectFullBeforeCompact("range");

    const providerFullCounts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-token-full="provider"]'),
    );
    const providerCompacts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-token-compact="provider"]'),
    );
    expect(providerFullCounts).toHaveLength(2);
    expect(providerCompacts).toHaveLength(2);
    expect(
      providerFullCounts.every((entry) => /\d{1,3}(,\d{3})+ tokens/.test(entry.textContent ?? "")),
    ).toBe(true);
    expect(providerCompacts.every((entry) => /[KM]/.test(entry.textContent ?? ""))).toBe(true);
    for (const figure of document.querySelectorAll<HTMLElement>(
      '[data-usage-token-figure="provider"]',
    )) {
      const children = figure.querySelectorAll<HTMLElement>(
        "[data-usage-token-full], [data-usage-token-compact]",
      );
      expect(children[0]?.dataset.usageTokenFull).toBe("provider");
      expect(children[1]?.dataset.usageTokenCompact).toBe("provider");
    }

    const aggregateExpectations = {
      processed: ["3,000,000 tokens", "3.00M"],
      cached: ["1,250,000 tokens", "1.25M"],
      uncached: ["1,250,000 tokens", "1.25M"],
      output: ["250,000 tokens", "250K"],
    } as const;
    for (const [id, [full, compact]] of Object.entries(aggregateExpectations)) {
      const context = `composition-${id}`;
      expect(requiredElement(`[data-usage-token-full="${context}"]`).textContent).toBe(full);
      expect(requiredElement(`[data-usage-token-compact="${context}"]`).textContent).toBe(compact);
      expectFullBeforeCompact(context);
    }

    expect(requiredElement('[data-usage-token-full="reasoning"]').textContent).toContain(
      "50,000 reasoning tokens",
    );
    expect(requiredElement('[data-usage-token-compact="reasoning"]').textContent).toBe("50K");
    expectFullBeforeCompact("reasoning");

    const modelFullCounts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-token-full="model"]'),
    );
    const modelCompacts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-token-compact="model"]'),
    );
    expect(modelFullCounts).toHaveLength(3);
    expect(modelCompacts).toHaveLength(3);
    expect(modelCompacts.every((entry) => /[KM]/.test(entry.textContent ?? ""))).toBe(true);
    expect(modelFullCounts.every((entry) => /\d{1,3}(,\d{3})+/.test(entry.textContent ?? ""))).toBe(
      true,
    );
    expect(document.body.textContent).not.toMatch(/\btokens? exact\b/i);
  });

  it("renders the billion-scale shorthand beneath the full counter", async () => {
    const baseline = createUsageDetail();
    const usage = {
      ...baseline,
      totals: {
        ...baseline.totals,
        inputTokens: 3_500_000_000,
        outputTokens: 39_966_200,
      },
    };
    mounted = await render(<UsageCostContent usage={usage} />);

    expect(requiredElement('[data-usage-token-full="composition-processed"]').textContent).toBe(
      "3,539,966,200 tokens",
    );
    expect(requiredElement('[data-usage-token-compact="composition-processed"]').textContent).toBe(
      "3.54B",
    );
    expectFullBeforeCompact("composition-processed");
  });

  it("animates the full aggregate count through a small increment", async () => {
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
      expect(requiredElement('[data-usage-token-full="composition-processed"]')).toBeVisible();
    } finally {
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });
});
