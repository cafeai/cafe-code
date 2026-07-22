import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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
  useSettings: () => ({ usageStatsEnabled: true }),
  useUpdateSettings: () => ({ updateSettings: usageHarness.updateSettings }),
}));

const totals = {
  generatingMs: 3_661_000,
  outputTokens: 250_000,
  userMessages: 42,
};

const snapshot = {
  totals,
  today: {
    day: "2026-07-21",
    generatingMs: 61_000,
    outputTokens: 25_000,
    userMessages: 4,
  },
  activeSessionCount: 0,
  collectionEnabled: true,
  asOfMs: Date.now(),
};

describe("UsageStatsPanel", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(() => {
    usageHarness.reset(
      {
        ...snapshot,
        days: [snapshot.today],
        tokenBreakdown: [
          { provider: "codex", model: "gpt-5.6-codex", outputTokens: 100_000 },
          { provider: "codex", model: "gpt-5.6-codex-mini", outputTokens: 25_000 },
          { provider: "claudeAgent", model: "claude-opus-5", outputTokens: 75_000 },
        ],
      },
      snapshot,
    );
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
    await expect.element(page.getByText("Codex", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Claude", { exact: true })).toBeVisible();
    await expect.element(page.getByText("gpt-5.6-codex", { exact: true })).toBeVisible();
    await expect.element(page.getByText("gpt-5.6-codex-mini", { exact: true })).toBeVisible();
    await expect.element(page.getByText("claude-opus-5", { exact: true })).toBeVisible();
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
});
