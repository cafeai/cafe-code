vi.mock("../../environments/workspace", () => ({
  useWorkspaceEnvironmentId: () => null,
  useIsSavedRemoteEnvironment: () => false,
  readWorkspaceEnvironmentId: () => null,
}));
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  ProviderDriverKind,
  type UsageStatsDay,
  type UsageStatsGetResult,
  type UsageStatsTokenBreakdownEntry,
  type UsageStatsTotals,
} from "@cafecode/contracts";
import { rollUpCost } from "@cafecode/shared/modelPricing";

import { applyInterfaceScalePercent } from "../../interfaceScale";
import {
  getUsageStatsDetailDiagnostics,
  resetUsageStatsDetailResourceForTests,
} from "../stats/usageStatsDetailResource";
import { UsageCostContent } from "./UsageCostSection";
import { UsageStatsPanel } from "./UsageStatsPanel";
import {
  formatCompactTokenCount,
  formatFullTokenCount,
  formatGeneratingTime,
} from "./usageStatsPresentation";

/** Independent time observations deliberately do not follow token-row values. */
function createModelTimeUsageDetail(): UsageStatsGetResult {
  const codex = ProviderDriverKind.make("codex");
  const claude = ProviderDriverKind.make("claudeAgent");
  return {
    ...createRangeUsageDetail(),
    modelGeneratingTime: {
      startedAt: "2026-04-23T00:00:00.000Z",
      totals: [
        { provider: codex, model: "gpt-5.6-codex", generatingMs: 40 * 3_600_000 },
        { provider: claude, model: "claude-opus-5", generatingMs: 180_000 },
        { provider: codex, model: "gpt-4.1", generatingMs: 60_000 },
        { provider: codex, model: "waiting-only", generatingMs: 20 * 3_600_000 },
      ],
      days: [
        { day: "2026-04-23", provider: codex, model: "gpt-4.1", generatingMs: 60_000 },
        { day: "2026-06-22", provider: claude, model: "claude-opus-5", generatingMs: 0 },
        { day: "2026-07-15", provider: codex, model: "gpt-5.6-codex", generatingMs: 3_601_000 },
        { day: "2026-07-21", provider: codex, model: "gpt-5.6-codex", generatingMs: 5_400_000 },
        {
          day: "2026-07-20",
          provider: codex,
          model: "waiting-only",
          generatingMs: 16 * 3_600_000 + 123_000,
        },
      ],
    },
  };
}

const usageHarness = vi.hoisted(() => {
  let detail: unknown;
  let snapshot: unknown;
  const snapshotListeners = new Set<(event: unknown) => void>();
  const connectionListeners = new Set<(event: { reconnected: boolean }) => void>();
  const updateSettings = vi.fn();
  const getUsageStats = vi.fn(async () => detail);
  const subscribeConnectionOpened = vi.fn((listener: (event: { reconnected: boolean }) => void) => {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  });
  const subscribeUsageStats = vi.fn((nextListener: (event: unknown) => void) => {
    snapshotListeners.add(nextListener);
    nextListener(snapshot);
    return () => snapshotListeners.delete(nextListener);
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
      snapshotListeners.clear();
      connectionListeners.clear();
    },
    emitSnapshot(nextSnapshot: unknown) {
      snapshot = nextSnapshot;
      for (const listener of snapshotListeners) listener(snapshot);
    },
    refreshDetail(nextDetail: unknown) {
      detail = nextDetail;
      for (const listener of connectionListeners) listener({ reconnected: true });
    },
  };
});

vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: () => undefined,
  requireEnvironmentConnection: () => undefined,
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
  // This fixture represents one recorded day. Its ledger and daily model
  // rows must carry the same counts as the aggregate so the default 30-day
  // view does not accidentally exercise the old lifetime-only behavior.
  const today = { ...snapshot.today, ...totals };
  const tokenBreakdown = [
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
  ];
  return {
    ...snapshot,
    today,
    days: [today],
    tokenBreakdown,
    tokenBreakdownDays: tokenBreakdown.map((entry) => ({ ...entry, day: today.day })),
  } as unknown as UsageStatsGetResult;
}

function createAnimatedUsageUpdate(): readonly [UsageStatsGetResult, UsageStatsGetResult] {
  const initial = createUsageDetail();
  const codex = ProviderDriverKind.make("codex");
  const first: UsageStatsGetResult = {
    ...initial,
    modelGeneratingTime: {
      startedAt: "2026-07-21T00:00:00.000Z",
      totals: [{ provider: codex, model: "gpt-5.6-codex", generatingMs: 60_000 }],
      days: [
        {
          day: initial.today.day,
          provider: codex,
          model: "gpt-5.6-codex",
          generatingMs: 60_000,
        },
      ],
    },
  };
  const tokenBreakdown = first.tokenBreakdown
    .map((entry) =>
      entry.provider === codex && entry.model === "gpt-5.6-codex"
        ? {
            ...entry,
            inputTokens: entry.inputTokens + 400_000,
            cachedInputTokens: entry.cachedInputTokens + 200_000,
            outputTokens: entry.outputTokens + 400_000,
            reasoningOutputTokens: entry.reasoningOutputTokens + 20_000,
          }
        : entry,
    )
    .concat({
      provider: ProviderDriverKind.make("opencode"),
      model: "unpriced-live-model",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    });
  const second: UsageStatsGetResult = {
    ...first,
    totals: {
      ...first.totals,
      inputTokens: first.totals.inputTokens + 1_400_000,
      cachedInputTokens: first.totals.cachedInputTokens + 200_000,
      outputTokens: first.totals.outputTokens + 400_000,
      reasoningOutputTokens: first.totals.reasoningOutputTokens + 20_000,
    },
    tokenBreakdown,
    modelGeneratingTime: {
      ...first.modelGeneratingTime!,
      totals: [{ provider: codex, model: "gpt-5.6-codex", generatingMs: 180_000 }],
      days: [
        {
          day: first.today.day,
          provider: codex,
          model: "gpt-5.6-codex",
          generatingMs: 180_000,
        },
      ],
    },
  };
  return [first, second];
}

const emptyTotals: UsageStatsTotals = {
  generatingMs: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  userMessages: 0,
};

function sumTotals(rows: ReadonlyArray<UsageStatsTotals>): UsageStatsTotals {
  return rows.reduce(
    (sum, row) => ({
      generatingMs: sum.generatingMs + row.generatingMs,
      inputTokens: sum.inputTokens + row.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + row.cachedInputTokens,
      cacheWriteInputTokens: sum.cacheWriteInputTokens + row.cacheWriteInputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      reasoningOutputTokens: sum.reasoningOutputTokens + row.reasoningOutputTokens,
      userMessages: sum.userMessages + row.userMessages,
    }),
    emptyTotals,
  );
}

/**
 * Boundary days have distinct providers and cache/output proportions. The
 * absent calendar days are intentional: a range is a calendar interval,
 * never the last N stored rows. July 20 also has real unattributed traffic,
 * while the lifetime-only Grok row predates the daily attribution ledger.
 */
function createRangeUsageDetail(): UsageStatsGetResult {
  const attributedDays = [
    {
      day: "2026-04-22",
      provider: "codex",
      model: "gpt-4o",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 100_000,
      reasoningOutputTokens: 70_000,
      generatingMs: 420_000,
      userMessages: 7,
    },
    {
      day: "2026-04-23",
      provider: "codex",
      model: "gpt-4.1",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 100_000,
      reasoningOutputTokens: 60_000,
      generatingMs: 360_000,
      userMessages: 6,
    },
    {
      day: "2026-06-21",
      provider: "opencode",
      model: "unknown-local-model",
      inputTokens: 1_000_000,
      cachedInputTokens: 250_000,
      cacheWriteInputTokens: 0,
      outputTokens: 100_000,
      reasoningOutputTokens: 50_000,
      generatingMs: 300_000,
      userMessages: 5,
    },
    {
      day: "2026-06-22",
      provider: "claudeAgent",
      model: "claude-opus-5",
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      cacheWriteInputTokens: 100_000,
      outputTokens: 100_000,
      reasoningOutputTokens: 40_000,
      generatingMs: 240_000,
      userMessages: 4,
    },
    {
      day: "2026-07-14",
      provider: "claudeAgent",
      model: "claude-opus-5",
      inputTokens: 2_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteInputTokens: 0,
      outputTokens: 200_000,
      reasoningOutputTokens: 30_000,
      generatingMs: 180_000,
      userMessages: 3,
    },
    {
      day: "2026-07-15",
      provider: "codex",
      model: "gpt-5.6-codex",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 100_000,
      reasoningOutputTokens: 20_000,
      generatingMs: 120_000,
      userMessages: 2,
    },
    {
      day: "2026-07-21",
      provider: "codex",
      model: "gpt-5.6-codex",
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      cacheWriteInputTokens: 100_000,
      outputTokens: 100_000,
      reasoningOutputTokens: 10_000,
      generatingMs: 60_000,
      userMessages: 1,
    },
  ];
  const days: UsageStatsDay[] = attributedDays.map(
    ({ provider: _provider, model: _model, ...day }) => day,
  );
  days.splice(6, 0, {
    ...emptyTotals,
    day: "2026-07-20",
    inputTokens: 500_000,
    outputTokens: 50_000,
    reasoningOutputTokens: 5_000,
    generatingMs: 30_000,
    userMessages: 1,
  });
  const tokenBreakdownDays = attributedDays.map(
    ({ generatingMs: _time, userMessages: _messages, ...entry }) => ({
      ...entry,
      provider: ProviderDriverKind.make(entry.provider),
    }),
  );
  const lifetimeOnly = {
    ...emptyTotals,
    inputTokens: 750_000,
    outputTokens: 75_000,
    reasoningOutputTokens: 7_500,
    generatingMs: 450_000,
    userMessages: 8,
  };
  const lifetimeByModel = new Map<string, UsageStatsTokenBreakdownEntry>();
  for (const { day: _day, ...entry } of tokenBreakdownDays) {
    const key = `${entry.provider}:${entry.model}`;
    const previous = lifetimeByModel.get(key);
    lifetimeByModel.set(
      key,
      previous
        ? {
            ...entry,
            inputTokens: previous.inputTokens + entry.inputTokens,
            cachedInputTokens: previous.cachedInputTokens + entry.cachedInputTokens,
            cacheWriteInputTokens: previous.cacheWriteInputTokens + entry.cacheWriteInputTokens,
            outputTokens: previous.outputTokens + entry.outputTokens,
            reasoningOutputTokens: previous.reasoningOutputTokens + entry.reasoningOutputTokens,
          }
        : entry,
    );
  }
  const tokenBreakdown = [...lifetimeByModel.values()];
  tokenBreakdown.push({
    provider: ProviderDriverKind.make("grok"),
    model: "grok-legacy-model",
    inputTokens: 500_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 50_000,
    reasoningOutputTokens: 5_000,
  });
  return {
    ...snapshot,
    totals: sumTotals([...days, lifetimeOnly]),
    today: days.at(-1)!,
    days,
    tokenBreakdown,
    tokenBreakdownDays,
  };
}

/** Synthetic long-running usage keeps the layout checks independent of providers. */
function createBillionScaleUsageDetail(): UsageStatsGetResult {
  const baseline = createUsageDetail();
  const scale = 1_000;
  const scaledToday = {
    ...baseline.today,
    generatingMs: baseline.today.generatingMs * scale,
    inputTokens: baseline.today.inputTokens * scale,
    cachedInputTokens: baseline.today.cachedInputTokens * scale,
    cacheWriteInputTokens: baseline.today.cacheWriteInputTokens * scale,
    outputTokens: baseline.today.outputTokens * scale,
    reasoningOutputTokens: baseline.today.reasoningOutputTokens * scale,
    userMessages: baseline.today.userMessages * scale,
  };
  return {
    ...baseline,
    totals: {
      generatingMs: baseline.totals.generatingMs * scale,
      inputTokens: baseline.totals.inputTokens * scale,
      cachedInputTokens: baseline.totals.cachedInputTokens * scale,
      cacheWriteInputTokens: baseline.totals.cacheWriteInputTokens * scale,
      outputTokens: baseline.totals.outputTokens * scale,
      reasoningOutputTokens: baseline.totals.reasoningOutputTokens * scale,
      userMessages: baseline.totals.userMessages * scale,
    },
    today: scaledToday,
    days: Array.from({ length: 7 }, (_, index) => ({
      ...(index === 6 ? scaledToday : emptyTotals),
      day: `2026-07-${15 + index}` as typeof scaledToday.day,
    })),
    tokenBreakdown: baseline.tokenBreakdown.map((entry) => ({
      ...entry,
      inputTokens: entry.inputTokens * scale,
      cachedInputTokens: entry.cachedInputTokens * scale,
      cacheWriteInputTokens: entry.cacheWriteInputTokens * scale,
      outputTokens: entry.outputTokens * scale,
      reasoningOutputTokens: entry.reasoningOutputTokens * scale,
    })),
    tokenBreakdownDays: baseline.tokenBreakdownDays?.map((entry) => ({
      ...entry,
      inputTokens: entry.inputTokens * scale,
      cachedInputTokens: entry.cachedInputTokens * scale,
      cacheWriteInputTokens: entry.cacheWriteInputTokens * scale,
      outputTokens: entry.outputTokens * scale,
      reasoningOutputTokens: entry.reasoningOutputTokens * scale,
    })),
  };
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

function overviewValue(label: string): string | null {
  // The model table shares the global duration heading. The overview precedes
  // that table and owns the first label/value pair in the dashboard.
  return (
    page.getByText(label, { exact: true }).first().element().nextElementSibling?.textContent ?? null
  );
}

function costQualityValue(label: string): string | null {
  const term = Array.from(document.querySelectorAll("dt")).find(
    (entry) => entry.textContent === label,
  );
  expect(term).toBeDefined();
  return term!.nextElementSibling?.textContent ?? null;
}

function providerCostRows() {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-usage-provider-cost-value]"),
    (cost) => {
      const heading = cost.parentElement!;
      return {
        provider: heading.firstElementChild!.lastElementChild!.textContent,
        cost: cost.textContent,
        tokens: heading.parentElement!.querySelector("[data-usage-token-full='provider']")!
          .textContent,
      };
    },
  ).toSorted((left, right) => (left.provider ?? "").localeCompare(right.provider ?? ""));
}

function modelCostRows() {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-usage-model-cost-value]"),
    (cost) => {
      const row = cost.closest("tr")!;
      return {
        model: row.firstElementChild!.textContent,
        cost: cost.textContent,
        tokens: row.querySelector("[data-usage-token-full='model']")!.textContent,
      };
    },
  ).toSorted((left, right) => (left.model ?? "").localeCompare(right.model ?? ""));
}

function requiredModelTime(model: string, provider?: string): HTMLElement {
  const row = requiredModelRow(model, provider);
  const time = row.querySelector<HTMLElement>("[data-usage-model-generating-time]");
  expect(time).not.toBeNull();
  return time!;
}

function requiredModelRow(model: string, provider?: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>("[data-usage-model]")).find(
    (element) =>
      element.dataset.usageModel === model &&
      (provider === undefined || element.dataset.usageProvider === provider),
  );
  expect(row).toBeDefined();
  return row!;
}

const testCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Values keep the dollar sign; the surface names the USD currency once. */
function expectedUsd(value: number): string {
  return testCurrency.format(value);
}

function parseUsd(value: string | null): number {
  expect(value).not.toBeNull();
  const normalized = value!.replaceAll(",", "").trim();
  const sign = normalized.startsWith("-") ? -1 : 1;
  const numeric = Number(normalized.replaceAll("-", "").replace("$", ""));
  expect(Number.isFinite(numeric)).toBe(true);
  return sign * numeric;
}

function parseFullTokenFigure(element: Element): number {
  const numeric = element.textContent?.match(/[\d,]+/)?.[0];
  expect(numeric).toBeDefined();
  return Number(numeric!.replaceAll(",", ""));
}

function activeActivityCellCount(): number {
  const heatmap = requiredElement('[role="img"][aria-label^="Daily generating time"]');
  return Array.from(heatmap.querySelectorAll<HTMLElement>("div[style]")).filter((cell) =>
    cell.style.backgroundColor.includes("--color-primary"),
  ).length;
}

function infoTipTrigger(name: string): HTMLElement {
  return page.getByRole("button", { name }).element() as HTMLElement;
}

/** Hover an info/tooltip trigger and return the text of the popup it opens. */
async function tooltipTextFor(trigger: HTMLElement): Promise<string> {
  await page.elementLocator(trigger).hover();
  await vi.waitFor(() => expect(requiredElement('[data-slot="tooltip-popup"]')).toBeVisible());
  return requiredElement('[data-slot="tooltip-popup"]').textContent ?? "";
}

function unattributedTokens(): string | null {
  return (
    document.querySelector("[data-usage-unattributed-row] [data-usage-token-full='unattributed']")
      ?.textContent ?? null
  );
}

async function hoverActivityCell(day: string): Promise<HTMLElement> {
  // The Activity calendar can be below the fold or still resizing after fresh
  // detail replaces its bounds. A synthetic event bypasses layout stability
  // and leaves the native pointer elsewhere, so a later resize/scroll can
  // correctly retire that stale tooltip anchor. Move the real pointer to the
  // exact actionable cell, as the dedicated ActivityHeatmap fixtures do.
  await page
    .elementLocator(requiredElement(`[data-activity-day="${day}"][data-activity-in-range="true"]`))
    .hover();
  await vi.waitFor(() =>
    expect(requiredElement('[role="tooltip"]').getAttribute("data-activity-tooltip-day")).toBe(day),
  );
  return requiredElement('[role="tooltip"]');
}

const rangeExpectations = {
  "7 days": {
    cost: "$3.94",
    processed: 2_750_000,
    cached: 500_000,
    uncached: 1_900_000,
    output: 250_000,
    reasoning: "35,000 reasoning tokens",
    cachePercent: "20.0% of input",
    cacheSavings: "$0.56",
    priced: "80.0%",
    unpriced: "20.0%",
    chats: "4",
    time: "3m 30s",
    activityDays: 8,
    unattributed: "550,000",
    providers: [{ provider: "Codex", cost: "$3.94", tokens: "2,200,000 tokens" }],
    models: [{ model: "gpt-5.6-codex", cost: "$3.94", tokens: "2,200,000" }],
  },
  "30 days": {
    cost: "$19.81",
    processed: 6_050_000,
    cached: 2_000_000,
    uncached: 3_300_000,
    output: 550_000,
    reasoning: "105,000 reasoning tokens",
    cachePercent: "36.4% of input",
    cacheSavings: "$7.19",
    priced: "90.9%",
    unpriced: "9.1%",
    chats: "11",
    time: "10m 30s",
    activityDays: 8,
    unattributed: "550,000",
    providers: [
      { provider: "Claude", cost: "$15.88", tokens: "3,300,000 tokens" },
      { provider: "Codex", cost: "$3.94", tokens: "2,200,000 tokens" },
    ],
    models: [
      { model: "claude-opus-5", cost: "$15.88", tokens: "3,300,000" },
      { model: "gpt-5.6-codex", cost: "$3.94", tokens: "2,200,000" },
    ],
  },
  "90 days": {
    cost: "$22.61",
    processed: 8_250_000,
    cached: 2_250_000,
    uncached: 5_050_000,
    output: 750_000,
    reasoning: "215,000 reasoning tokens",
    cachePercent: "30.0% of input",
    cacheSavings: "$7.19",
    priced: "80.0%",
    unpriced: "20.0%",
    chats: "22",
    time: "21m 30s",
    activityDays: 8,
    unattributed: "550,000",
    providers: [
      { provider: "Claude", cost: "$15.88", tokens: "3,300,000 tokens" },
      { provider: "Codex", cost: "$6.74", tokens: "3,300,000 tokens" },
      { provider: "OpenCode", cost: "Unpriced", tokens: "1,100,000 tokens" },
    ],
    models: [
      { model: "claude-opus-5", cost: "$15.88", tokens: "3,300,000" },
      { model: "gpt-4.1", cost: "$2.80", tokens: "1,100,000" },
      { model: "gpt-5.6-codex", cost: "$3.94", tokens: "2,200,000" },
      { model: "unknown-local-model", cost: "Unpriced", tokens: "1,100,000" },
    ],
  },
  All: {
    cost: "$28.36",
    processed: 10_175_000,
    cached: 2_250_000,
    uncached: 6_800_000,
    output: 925_000,
    reasoning: "292,500 reasoning tokens",
    cachePercent: "24.3% of input",
    cacheSavings: "$7.19",
    priced: "81.1%",
    unpriced: "18.9%",
    chats: "37",
    time: "36m 00s",
    activityDays: 8,
    unattributed: "825,000",
    providers: [
      { provider: "Claude", cost: "$15.88", tokens: "3,300,000 tokens" },
      { provider: "Codex", cost: "$10.24", tokens: "4,400,000 tokens" },
      { provider: "Grok", cost: "$2.25", tokens: "550,000 tokens" },
      { provider: "OpenCode", cost: "Unpriced", tokens: "1,100,000 tokens" },
    ],
    models: [
      { model: "claude-opus-5", cost: "$15.88", tokens: "3,300,000" },
      { model: "gpt-4.1", cost: "$2.80", tokens: "1,100,000" },
      { model: "gpt-4o", cost: "$3.50", tokens: "1,100,000" },
      { model: "gpt-5.6-codex", cost: "$3.94", tokens: "2,200,000" },
      { model: "grok-legacy-model", cost: "$2.25", tokens: "550,000" },
      { model: "unknown-local-model", cost: "Unpriced", tokens: "1,100,000" },
    ],
  },
} as const;

function expectCostRange(label: keyof typeof rangeExpectations): void {
  const expected = rangeExpectations[label];
  expect(requiredElement("[data-usage-cost-hero-value]").textContent).toBe(expected.cost);
  for (const id of ["processed", "cached", "uncached", "output"] as const) {
    expect(displayedRawCount(id)).toBe(expected[id]);
  }
  expect(requiredElement("[data-usage-token-full='range']").textContent).toBe(
    `${expected.processed.toLocaleString("en-US")} tokens in range`,
  );
  expect(requiredElement("[data-usage-token-full='reasoning']").textContent).toBe(
    expected.reasoning,
  );
  expect(requiredElement("[data-usage-composition-tile='cached']").textContent).toContain(
    expected.cachePercent,
  );
  expect(requiredElement("[data-usage-composition-value='cache-savings']").textContent).toBe(
    expected.cacheSavings,
  );
  // Net cache savings is shown once, in its composition tile.
  expect(document.querySelector("[data-usage-cost-quality-cache-savings]")).toBeNull();
  expect(unattributedTokens()).toBe(expected.unattributed);
  expect(costQualityValue("Priced")).toBe(expected.priced);
  expect(costQualityValue("Unpriced")).toBe(expected.unpriced);
  expect(providerCostRows()).toEqual(expected.providers);
  expect(modelCostRows()).toEqual(expected.models);
}

function expectPanelRange(label: keyof typeof rangeExpectations): void {
  const expected = rangeExpectations[label];
  expectCostRange(label);
  expect(overviewValue("Tokens generated")).toBe(expected.output.toLocaleString("en-US"));
  expect(overviewValue("Chats sent")).toBe(expected.chats);
  expect(overviewValue("Time spent generating")).toBe(expected.time);
  expect(activeActivityCellCount()).toBe(expected.activityDays);
}

/**
 * Full totals remain visible above a smaller abbreviation. Check rendered
 * geometry and accessibility so neither line can silently become a tooltip or
 * duplicate the value in screen-reader narration again.
 */
function expectFullAboveCompact(context: string): void {
  const figures = document.querySelectorAll<HTMLElement>(`[data-usage-token-figure="${context}"]`);
  expect(figures.length).toBeGreaterThan(0);
  for (const figure of figures) {
    const compact = figure.querySelector<HTMLElement>(`[data-usage-token-compact="${context}"]`)!;
    const exact = figure.querySelector<HTMLElement>(`[data-usage-token-full="${context}"]`)!;
    expect(exact).toBeVisible();
    expect(compact).toBeVisible();
    expect(exact.getAttribute("aria-hidden")).toBeNull();
    expect(exact.classList.contains("sr-only")).toBe(false);
    expect(compact.getAttribute("aria-hidden")).toBe("true");
    expect(compact.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      exact.getBoundingClientRect().bottom,
    );
    expect(Number.parseFloat(getComputedStyle(exact).fontSize)).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(compact).fontSize),
    );
  }
}

function expectNoHorizontalOverflow(element: HTMLElement): void {
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
}

function expectCompositionNumbersOnOneLine(): void {
  for (const id of ["processed", "cached", "uncached", "output"]) {
    const figure = requiredElement(`[data-usage-token-full="composition-${id}"]`);
    const numericText = Array.from(figure.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && /^[\d.,]+[KMB]?/.test(node.textContent ?? ""),
    );
    expect(numericText).toBeDefined();
    const digitLength = numericText!.textContent!.match(/^[\d.,]+[KMB]?/)![0].length;
    // Measure the figure itself: the supporting word "tokens" may wrap, but a
    // billion-scale full count must remain one complete number.
    const range = document.createRange();
    range.setStart(numericText!, 0);
    range.setEnd(numericText!, digitLength);
    expect(Array.from(range.getClientRects()).filter((rect) => rect.width > 0)).toHaveLength(1);
    expectNoHorizontalOverflow(requiredElement(`[data-usage-composition-tile="${id}"]`));
  }
}

function expectOverviewStacked(): void {
  const overview = requiredElement("[data-usage-cost-overview]");
  const hero = overview.children[0]!.getBoundingClientRect();
  const chart = overview.children[1]!.getBoundingClientRect();
  expect(chart.top).toBeGreaterThanOrEqual(hero.bottom);
  expect(Math.abs(chart.left - hero.left)).toBeLessThanOrEqual(1);
}

function settleLayoutCountersImmediately(): void {
  const matchMedia = window.matchMedia.bind(window);
  // Geometry cases exercise the supported reduced-motion path so unrelated
  // odometer timing cannot change measured text widths. Other media queries
  // and the existing intermediate-counter animation test remain unaffected.
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const media = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(media, "matches", { value: true });
    }
    return media;
  });
}

describe("UsageStatsPanel", () => {
  it("discloses partial prospective child usage without claiming root context growth", async () => {
    mounted = await render(<UsageCostContent usage={createUsageDetail()} />);
    // One visible line at the figures; the specifics are one focus/hover away.
    await expect
      .element(page.getByText("Estimates from recorded usage; may be incomplete.", { exact: true }))
      .toBeVisible();
    const details = await tooltipTextFor(infoTipTrigger("About cost estimates"));
    expect(details).toContain("Priced share covers recorded tokens only");
    expect(details).toContain("not a complete billing record");
    expect(details).toContain("Codex subagent usage includes only observed increments");
    expect(details).toContain("child tokens do not increase the main chat’s context-window meter");
  });
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;
  let originalViewport = { height: window.innerHeight, width: window.innerWidth };
  let originalRootFontSize = "";
  let originalRootFontPriority = "";
  let detailPollCallbacks = new Map<number, () => void>();

  beforeEach(() => {
    originalViewport = { height: window.innerHeight, width: window.innerWidth };
    originalRootFontSize = document.documentElement.style.getPropertyValue("font-size");
    originalRootFontPriority = document.documentElement.style.getPropertyPriority("font-size");
    resetUsageStatsDetailResourceForTests();
    usageHarness.reset(createUsageDetail(), snapshot);
    detailPollCallbacks = new Map();
    let nextPollId = -1;
    const setInterval = window.setInterval.bind(window);
    const clearInterval = window.clearInterval.bind(window);
    // Own only the detail resource's five-second polling boundary. A full CI
    // browser run can take longer than five seconds to inspect all calendar
    // ranges; that legitimate refresh must not be mistaken for a range-triggered
    // request. The 250ms live projection interval, RAF odometer, tooltip timers,
    // browser layout, and reconnect-triggered requests remain real.
    vi.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) => {
      if (delay !== 5_000) {
        return setInterval(handler, delay, ...args) as unknown as ReturnType<
          typeof window.setInterval
        >;
      }
      if (typeof handler !== "function") throw new Error("Expected a usage polling callback");
      // Browser-owned timer handles are positive; these private negative ids
      // cannot alias the real timers delegated above or escape this fixture.
      const id = nextPollId--;
      detailPollCallbacks.set(id, () => handler(...args));
      return id as unknown as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation((id) => {
      if (typeof id === "number" && detailPollCallbacks.delete(id)) return;
      clearInterval(id);
    });
  });

  afterEach(async () => {
    const teardown = mounted?.cleanup ?? mounted?.unmount;
    await teardown?.call(mounted).catch(() => {});
    mounted = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalRootFontSize) {
      document.documentElement.style.setProperty(
        "font-size",
        originalRootFontSize,
        originalRootFontPriority,
      );
    } else {
      document.documentElement.style.removeProperty("font-size");
    }
    if (
      window.innerWidth !== originalViewport.width ||
      window.innerHeight !== originalViewport.height
    ) {
      await page.viewport(originalViewport.width, originalViewport.height);
    }
    // The real resource still owns subscription cleanup. Holding its polling
    // clock must not hide a leaked subscription or interval after unmount.
    expect(detailPollCallbacks.size).toBe(0);
  });

  it("selects per-model generating time for 7/30/90/All independently of token attribution", async () => {
    settleLayoutCountersImmediately();
    const usage = createModelTimeUsageDetail();
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);
    await vi.waitFor(() =>
      expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("2h 30m 01s"),
    );
    expect(requiredModelTime("claude-opus-5").textContent).toBe("0s");
    expect(requiredModelTime("waiting-only").textContent).toBe("16h 02m 03s");
    const timeOnlyRow = requiredModelTime("waiting-only").closest("tr")!;
    expect(timeOnlyRow.querySelector("[data-usage-model-cost-value]")?.textContent).toBe("—");
    expect(timeOnlyRow.querySelector("[data-usage-token-full='model']")?.textContent).toBe("0");
    expect(displayedRawCount("processed")).toBe(rangeExpectations["30 days"].processed);
    expect(requiredElement("[data-usage-model-time-coverage]").textContent).toContain(
      "Time recorded since ",
    );
    expect(requiredElement("[data-usage-model-time-coverage] time").getAttribute("datetime")).toBe(
      usage.modelGeneratingTime!.startedAt,
    );

    await page.getByRole("button", { name: "7 days", exact: true }).click();
    expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("2h 30m 01s");
    expect(document.querySelector('[data-usage-model="claude-opus-5"]')).toBeNull();
    expect(displayedRawCount("processed")).toBe(rangeExpectations["7 days"].processed);
    await page.getByRole("button", { name: "90 days", exact: true }).click();
    expect(requiredModelTime("gpt-4.1").textContent).toBe("1m 00s");
    expect(requiredModelTime("unknown-local-model").textContent).toBe("Not recorded");
    await page.getByRole("button", { name: "All", exact: true }).click();
    expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("1d 16h 00m 00s");
    expect(requiredModelTime("waiting-only").textContent).toBe("20h 00m 00s");
    expect(requiredModelTime("gpt-4o").textContent).toBe("Not recorded");
    expect(requiredModelTime("grok-legacy-model").textContent).toBe("Not recorded");
    expect(displayedRawCount("processed")).toBe(rangeExpectations.All.processed);
    expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);

    const explanation = await tooltipTextFor(infoTipTrigger("About time spent generating"));
    expect(explanation).toContain("full active-turn time, including tools and waits");
    expect(explanation).toContain("Concurrent chats count separately");
    expect(explanation).toContain(`${usage.modelGeneratingTime!.startedAt} (UTC)`);
    expect(explanation).toContain("earlier history is not included");
  });

  it("keeps older responses and post-start helper rows Not recorded instead of inventing zeroes", async () => {
    mounted = await render(<UsageCostContent usage={createUsageDetail()} />);
    const olderTimes = Array.from(document.querySelectorAll("[data-usage-model-generating-time]"));
    expect(olderTimes).toHaveLength(3);
    expect(olderTimes.every((time) => time.textContent === "Not recorded")).toBe(true);
    expect(requiredElement("[data-usage-model-time-coverage]").textContent).toBe(
      "Per-model time is unavailable on this server.",
    );

    const usage = createUsageDetail();
    await mounted.rerender(
      <UsageCostContent
        usage={{
          ...usage,
          modelGeneratingTime: {
            startedAt: "2026-07-19T00:00:00.000Z",
            totals: [
              {
                provider: ProviderDriverKind.make("codex"),
                model: "gpt-5.6-codex",
                generatingMs: 61_000,
              },
            ],
            days: [
              {
                day: usage.today.day,
                provider: ProviderDriverKind.make("codex"),
                model: "gpt-5.6-codex",
                generatingMs: 61_000,
              },
            ],
          },
        }}
      />,
    );
    await vi.waitFor(() => expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("1m 01s"), {
      timeout: 4_000,
    });
    // These token/helper rows occurred after recording began. Their lack of a
    // time observation still means unavailable, never a guessed zero duration.
    expect(requiredModelTime("gpt-5.6-codex-mini").textContent).toBe("Not recorded");
    expect(requiredModelTime("claude-opus-5").textContent).toBe("Not recorded");
  });

  it("does not display partial or rounded model time from an overflowing mixed-version response", async () => {
    const usage = createUsageDetail();
    const provider = ProviderDriverKind.make("codex");
    const timeEntries = [
      { provider, model: "gpt-5.6-codex", generatingMs: Number.MAX_SAFE_INTEGER },
      { provider, model: "gpt-5.6-codex", generatingMs: 1 },
      { provider, model: "time-only", generatingMs: 100 },
    ];
    mounted = await render(
      <UsageCostContent
        usage={{
          ...usage,
          modelGeneratingTime: {
            startedAt: "2026-07-19T00:00:00.000Z",
            totals: timeEntries,
            days: timeEntries.map((entry) => Object.assign({ day: usage.today.day }, entry)),
          },
        }}
      />,
    );
    expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("Not recorded");
    expect(document.querySelector('[data-usage-model="time-only"]')).toBeNull();
    await page.getByRole("button", { name: "All", exact: true }).click();
    expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("Not recorded");
    expect(document.querySelector('[data-usage-model="time-only"]')).toBeNull();
    expect(requiredElement("[data-usage-model-time-coverage]").textContent).toBe(
      "Per-model time is unavailable on this server.",
    );
  });

  it("holds model time through active snapshots and updates only from new detailed observations", async () => {
    const usage = createModelTimeUsageDetail();
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);
    await vi.waitFor(() =>
      expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("2h 30m 01s"),
    );
    usageHarness.emitSnapshot({
      ...usage,
      activeSessionCount: 3,
      asOfMs: Date.now(),
      totals: { ...usage.totals, generatingMs: 999_999_999 },
      today: { ...usage.today, generatingMs: 999_999_999 },
    });
    await expect.element(page.getByText("3 chats generating", { exact: true })).toBeVisible();
    expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("2h 30m 01s");
    expect(requiredModelTime("waiting-only").textContent).toBe("16h 02m 03s");
    const time = usage.modelGeneratingTime!;
    usageHarness.refreshDetail({
      ...usage,
      asOfMs: Date.now() + 1,
      modelGeneratingTime: {
        ...time,
        days: time.days.map((entry) =>
          entry.day === usage.today.day
            ? Object.assign({}, entry, { generatingMs: entry.generatingMs + 60_000 })
            : entry,
        ),
        totals: time.totals.map((entry) =>
          entry.model === "gpt-5.6-codex"
            ? Object.assign({}, entry, { generatingMs: entry.generatingMs + 60_000 })
            : entry,
        ),
      },
    });
    await vi.waitFor(
      () => expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("2h 31m 01s"),
      { timeout: 4_000 },
    );
    await page.getByRole("button", { name: "All", exact: true }).click();
    expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("1d 16h 01m 00s");
  });

  it("makes every time-only model discoverable in the shared standalone Atrium table", async () => {
    settleLayoutCountersImmediately();
    const usage = createUsageDetail();
    const timeEntries = Array.from({ length: 13 }, (_, index) => ({
      provider: ProviderDriverKind.make("codex"),
      model: `time-only-${String(index).padStart(2, "0")}`,
      generatingMs: (index + 1) * 1_000,
    }));
    mounted = await render(
      <UsageCostContent
        usage={{
          ...usage,
          modelGeneratingTime: {
            startedAt: "2026-07-19T00:00:00.000Z",
            totals: timeEntries,
            days: timeEntries.map((entry) => Object.assign({ day: usage.today.day }, entry)),
          },
        }}
      />,
    );
    expect(document.querySelectorAll("[data-usage-model]")).toHaveLength(12);
    expect(document.querySelector('[data-usage-model="time-only-00"]')).toBeNull();
    expect(displayedRawCount("processed")).toBe(3_000_000);
    await page.getByRole("button", { name: "Show all 16 models", exact: true }).click();
    expect(document.querySelectorAll("[data-usage-model]")).toHaveLength(16);
    expect(requiredModelTime("time-only-00").textContent).toBe("1s");
    expect(requiredModelTime("gpt-5.6-codex").textContent).toBe("Not recorded");
    expect(displayedRawCount("processed")).toBe(3_000_000);
    await page.getByRole("button", { name: "Show fewer models", exact: true }).click();
    expect(document.querySelectorAll("[data-usage-model]")).toHaveLength(12);
  });

  it.each([80, 130])(
    "keeps large model durations on one line without page overflow at %i%% scale",
    async (scale) => {
      applyInterfaceScalePercent(scale);
      settleLayoutCountersImmediately();
      const usage = createBillionScaleUsageDetail();
      const entry = {
        provider: ProviderDriverKind.make("codex"),
        model: "gpt-5.6-codex",
        generatingMs: 1_234 * 86_400_000 + 3_661_000,
      };
      const timedUsage = {
        ...usage,
        modelGeneratingTime: {
          startedAt: "2026-07-19T00:00:00.000Z",
          totals: [entry],
          days: [{ ...entry, day: usage.today.day }],
        },
      };
      for (const width of [1_800, 320]) {
        await page.viewport(width, 1_000);
        if (mounted) await mounted.rerender(<UsageCostContent usage={timedUsage} />);
        else mounted = await render(<UsageCostContent usage={timedUsage} />);
        const duration = requiredModelTime(entry.model);
        expect(duration.textContent).toBe("1,234d 01h 01m 01s");
        expect(getComputedStyle(duration).whiteSpace).toBe("nowrap");
        const textRange = document.createRange();
        textRange.selectNodeContents(duration);
        expect(
          Array.from(textRange.getClientRects()).filter((rect) => rect.width > 0),
        ).toHaveLength(1);
        expectNoHorizontalOverflow(requiredElement("[data-usage-cost-layout]"));
        expectNoHorizontalOverflow(document.documentElement);
        const scroller = requiredElement("[data-usage-model-table-scroll]");
        const table = requiredElement("[data-usage-model-table]");
        expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
        if (width === 320) {
          expect(table.scrollWidth).toBeGreaterThan(scroller.clientWidth);
          expect(getComputedStyle(scroller).overflowX).toBe("auto");
        }
      }
    },
  );

  it("filters usage and cost figures immediately while retaining the full Activity calendar", async () => {
    await page.viewport(1400, 1000);
    const usage = createRangeUsageDetail();
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);

    // Initial loading may animate from zero; the range-change assertions below
    // keep normal motion and still require immediate accounting transitions.
    await vi.waitFor(() => expectPanelRange("30 days"), { timeout: 5_000 });
    const ranges = document.querySelectorAll('[role="group"][aria-label="Usage date range"]');
    expect(ranges).toHaveLength(1);
    expect(page.getByRole("button", { name: "30 days", exact: true }).element().ariaPressed).toBe(
      "true",
    );
    expect(
      ranges[0]!.compareDocumentPosition(requiredElement("[data-usage-cost-layout]")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    const heatmap = requiredElement('[role="img"][aria-label^="Daily generating time"]');
    expect(heatmap.getAttribute("aria-label")).toContain("from 2026-04-22 through 2026-07-21");
    // Verify the actual Settings opt-in, not only the shared heatmap fixture:
    // a short lifetime calendar uses larger capped squares, centers within the
    // available card and keeps its legend attached to that same calendar width.
    await vi.waitFor(() => {
      const firstCell = requiredElement('[data-activity-day="2026-04-22"]');
      const row = heatmap.parentElement!.getBoundingClientRect();
      const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
      const viewport = scroller.getBoundingClientRect();
      const legend = requiredElement('[data-activity-heatmap-legend="true"]');
      expect(firstCell.getBoundingClientRect().width).toBeCloseTo(24, 1);
      expect(row.left - viewport.left).toBeCloseTo(viewport.right - row.right, 1);
      expect(legend.getBoundingClientRect().right).toBeCloseTo(row.right, 1);
    });
    const activityColors = usage.days.map(({ day }) => ({
      day,
      cell: requiredElement(`[data-activity-day="${day}"][data-activity-in-range="true"]`),
      color: requiredElement(`[data-activity-day="${day}"]`).style.backgroundColor,
    }));

    for (const label of ["7 days", "90 days", "All", "30 days"] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      // These assertions intentionally run immediately with ordinary motion.
      // A range switch changes accounting scope, so a tween through the old
      // range's figures would temporarily disagree with the model rows.
      expectPanelRange(label);
      expect(page.getByRole("button", { name: label, exact: true }).element().ariaPressed).toBe(
        "true",
      );
      expect(heatmap.getAttribute("aria-label")).toContain("from 2026-04-22 through 2026-07-21");
      // A range change affects accounting cards only. April 22 is outside the
      // ninety-day window, and its retained color also pins the lifetime peak used
      // by every Activity cell instead of recoloring each shorter selection.
      for (const { day, cell, color } of activityColors) {
        const current = requiredElement(
          `[data-activity-day="${day}"][data-activity-in-range="true"]`,
        );
        expect(current).toBe(cell);
        expect(current.style.backgroundColor).toBe(color);
      }
    }
    expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);
  });

  it("retains accessible history older than 26 weeks and its scroll position across every range", async () => {
    await page.viewport(640, 900);
    const oldDay: UsageStatsDay = {
      ...emptyTotals,
      day: "2022-01-01",
      generatingMs: 60_000,
    };
    const baseline = createRangeUsageDetail();
    const usage: UsageStatsGetResult = {
      ...baseline,
      days: [oldDay, ...baseline.days],
      totals: sumTotals([oldDay, baseline.totals]),
    };
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);
    await vi.waitFor(() => expectCostRange("30 days"), { timeout: 5_000 });

    const heatmap = requiredElement('[role="img"][aria-label^="Daily generating time"]');
    expect(heatmap.getAttribute("aria-label")).toContain("from 2022-01-01 through 2026-07-21");
    expect(heatmap.dataset.activityRangeDayCount).toBe("1663");
    // A multi-year ledger uses the existing virtualized calendar. Its oldest
    // stored day remains present at the beginning and can reveal its duration
    // without inflating the rendered DOM to include every empty calendar day.
    expect(heatmap.querySelectorAll('[data-activity-in-range="true"]').length).toBeLessThan(500);
    const oldCell = requiredElement(
      '[data-activity-day="2022-01-01"][data-activity-in-range="true"]',
    );
    expect(oldCell).toBeVisible();
    const oldColor = oldCell.style.backgroundColor;
    expect(oldColor).toContain("--color-primary");
    expect((await hoverActivityCell("2022-01-01")).textContent).toContain("1m generating");

    const scroller = requiredElement('[data-activity-heatmap-scroll="true"]');
    scroller.scrollLeft = scroller.scrollWidth;
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-activity-day="2026-07-21"][data-activity-in-range="true"]'),
      ).not.toBeNull(),
    );
    const scrollLeft = scroller.scrollLeft;
    expect(scrollLeft).toBeGreaterThan(0);
    const currentCell = requiredElement('[data-activity-day="2026-07-21"]');
    const currentColor = currentCell.style.backgroundColor;

    for (const label of ["7 days", "90 days", "All", "30 days"] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      expectCostRange(label);
      expect(heatmap.getAttribute("aria-label")).toContain("from 2022-01-01 through 2026-07-21");
      expect(heatmap.dataset.activityRangeDayCount).toBe("1663");
      expect(scroller.scrollLeft).toBe(scrollLeft);
      expect(requiredElement('[data-activity-day="2026-07-21"]')).toBe(currentCell);
      expect(currentCell.style.backgroundColor).toBe(currentColor);
      expect((await hoverActivityCell("2026-07-21")).textContent).toContain("1m generating");
    }

    // Range selection must reuse one detail response regardless of how long
    // browser interactions take. Separately advance the actual polling callback
    // and prove its single refresh preserves the selected range and calendar.
    expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);
    expect(detailPollCallbacks.size).toBe(1);
    const poll = detailPollCallbacks.values().next().value;
    if (!poll) throw new Error("Usage detail polling was not scheduled");
    poll();
    await vi.waitFor(() => {
      expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(2);
      expect(getUsageStatsDetailDiagnostics().successCount).toBe(2);
    });
    expectCostRange("30 days");
    expect(page.getByRole("button", { name: "30 days", exact: true }).element().ariaPressed).toBe(
      "true",
    );
    expect(scroller.scrollLeft).toBe(scrollLeft);
    expect(requiredElement('[data-activity-day="2026-07-21"]')).toBe(currentCell);
    expect(currentCell.style.backgroundColor).toBe(currentColor);

    scroller.scrollLeft = 0;
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-activity-day="2022-01-01"][data-activity-in-range="true"]'),
      ).not.toBeNull(),
    );
    expect(requiredElement('[data-activity-day="2022-01-01"]').style.backgroundColor).toBe(
      oldColor,
    );
    expect((await hoverActivityCell("2022-01-01")).textContent).toContain("1m generating");
    expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(2);
  });

  it("gives standalone cost content the same default and complete range filtering", async () => {
    mounted = await render(<UsageCostContent usage={createRangeUsageDetail()} />);
    expectCostRange("30 days");
    const ranges = document.querySelectorAll('[role="group"][aria-label="Usage date range"]');
    expect(ranges).toHaveLength(1);
    expect(
      ranges[0]!.compareDocumentPosition(requiredElement("[data-usage-cost-overview]")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    for (const label of ["7 days", "90 days", "All", "30 days"] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      expectCostRange(label);
    }
    await page.getByRole("button", { name: "Tokens", exact: true }).click();
    expect(requiredElement("[data-usage-cost-chart-label]").textContent).toBe("Daily tokens");
    await page.getByRole("button", { name: "7 days", exact: true }).click();
    expectCostRange("7 days");
    expect(page.getByRole("button", { name: "Tokens", exact: true }).element().ariaPressed).toBe(
      "true",
    );
    await expect.element(page.getByText("Cache writes", { exact: true })).toBeVisible();
    const chart = requiredElement('[data-usage-cost-overview] svg[role="img"]');
    const chartBounds = chart.getBoundingClientRect();
    chart.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: chartBounds.right - 1,
        clientY: chartBounds.top + 10,
      }),
    );
    // Today's 500K cache reads, 100K writes, 400K fresh input, and 100K
    // output must stack to the complete daily processed-token count.
    await expect.element(page.getByText("1,100,000 tokens (1.10M)", { exact: true })).toBeVisible();
  });

  it("keeps daily counters but discloses unpriced coverage when daily attribution is absent", async () => {
    const usage = { ...createRangeUsageDetail(), tokenBreakdownDays: undefined };
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);

    await vi.waitFor(() => expect(displayedRawCount("processed")).toBe(6_050_000), {
      timeout: 5_000,
    });
    expect(overviewValue("Tokens generated")).toBe("550,000");
    expect(overviewValue("Chats sent")).toBe("11");
    expect(overviewValue("Time spent generating")).toBe("10m 30s");
    expect(requiredElement("[data-usage-cost-hero-value]").textContent).toBe("$0.00");
    expect(providerCostRows()).toEqual([]);
    expect(modelCostRows()).toEqual([]);
    expect(costQualityValue("Priced")).toBe("0.0%");
    expect(costQualityValue("Unpriced")).toBe("100.0%");
    // Without daily attribution the whole period is counted as unattributed,
    // never assigned to a model from lifetime shares.
    expect(unattributedTokens()).toBe("6,050,000");
    expect(document.body.textContent).not.toContain("grok-legacy-model");
    expect(activeActivityCellCount()).toBe(8);

    await page.getByRole("button", { name: "All", exact: true }).click();
    expectPanelRange("All");
  });

  it("uses live snapshots for generating status and detailed refreshes for matching counters and models", async () => {
    const usage = createRangeUsageDetail();
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);
    await vi.waitFor(() => expectPanelRange("30 days"), { timeout: 5_000 });

    usageHarness.emitSnapshot({
      ...usage,
      totals: { ...usage.totals, outputTokens: 5_000_000, userMessages: 500 },
      today: { ...usage.today, outputTokens: 4_000_000, userMessages: 400 },
      activeSessionCount: 1,
      asOfMs: Date.now(),
    });
    await expect.element(page.getByText("Generating", { exact: true })).toBeVisible();
    expect(overviewValue("Tokens generated")).toBe("550,000");
    expect(overviewValue("Chats sent")).toBe("11");
    expectCostRange("30 days");

    const freshToday = {
      ...usage.today,
      inputTokens: usage.today.inputTokens + 1_000,
      outputTokens: usage.today.outputTokens + 100,
      userMessages: usage.today.userMessages + 1,
    };
    const freshUsage: UsageStatsGetResult = {
      ...usage,
      totals: {
        ...usage.totals,
        inputTokens: usage.totals.inputTokens + 1_000,
        outputTokens: usage.totals.outputTokens + 100,
        userMessages: usage.totals.userMessages + 1,
      },
      today: freshToday,
      days: usage.days.map((day) => (day.day === freshToday.day ? freshToday : day)),
      tokenBreakdown: usage.tokenBreakdown.map((entry) =>
        entry.model === "gpt-5.6-codex"
          ? {
              ...entry,
              inputTokens: entry.inputTokens + 1_000,
              outputTokens: entry.outputTokens + 100,
            }
          : entry,
      ),
      tokenBreakdownDays: usage.tokenBreakdownDays?.map((entry) =>
        entry.day === freshToday.day
          ? {
              ...entry,
              inputTokens: entry.inputTokens + 1_000,
              outputTokens: entry.outputTokens + 100,
            }
          : entry,
      ),
      asOfMs: Date.now(),
    };
    usageHarness.refreshDetail(freshUsage);
    await vi.waitFor(() => expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(2));
    await vi.waitFor(
      () => {
        expect(overviewValue("Tokens generated")).toBe("550,100");
        expect(overviewValue("Chats sent")).toBe("12");
        expect(displayedRawCount("processed")).toBe(6_051_100);
        expect(displayedRawCount("output")).toBe(550_100);
        expect(modelCostRows().find((entry) => entry.model === "gpt-5.6-codex")?.tokens).toBe(
          "2,201,100",
        );
        expect(unattributedTokens()).toBe("550,000");
      },
      { timeout: 3_000 },
    );
  });

  it("resets the selected total's floor while retaining today's Activity floor across ranges", async () => {
    // Mock Date without installing fake timers: waitFor auto-advances an
    // installed fake clock, even when only Date is faked. Tooltip/layout waits
    // must not add time to these exact accounting assertions. The component's
    // real 250ms projection timer and browser layout still run normally.
    const baseMs = Date.parse("2026-07-21T12:00:00Z");
    vi.setSystemTime(baseMs);
    const usage = { ...createRangeUsageDetail(), asOfMs: baseMs };
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);
    await vi.waitFor(() => expectPanelRange("30 days"));

    vi.setSystemTime(baseMs + 10_000);
    usageHarness.emitSnapshot({
      ...usage,
      today: { ...usage.today, generatingMs: usage.today.generatingMs + 10_000 },
      activeSessionCount: 2,
      asOfMs: baseMs + 10_000,
    });
    await vi.waitFor(() => expect(overviewValue("Time spent generating")).toBe("10m 40s"));
    await expect.element(page.getByText("2 chats generating", { exact: true })).toBeVisible();

    // Two current sessions add two seconds after this newer observation; they
    // must not be charged for all ten seconds since the earlier detail read.
    vi.setSystemTime(baseMs + 11_000);
    await vi.waitFor(() => expect(overviewValue("Time spent generating")).toBe("10m 42s"));
    expect((await hoverActivityCell("2026-07-21")).textContent).toContain("1m 12s generating");
    expectCostRange("30 days");

    // A lower settled observation may trail projection. Hold both the hero
    // time and today's heatmap value at the same floor until accounting catches
    // up, and do not let an out-of-order stream event re-enable activity.
    vi.setSystemTime(baseMs + 12_000);
    usageHarness.emitSnapshot({
      ...usage,
      today: { ...usage.today, generatingMs: usage.today.generatingMs + 1_000 },
      activeSessionCount: 0,
      asOfMs: baseMs + 12_000,
    });
    await expect
      .element(page.getByText("2 chats generating", { exact: true }))
      .not.toBeInTheDocument();
    expect(overviewValue("Time spent generating")).toBe("10m 42s");
    expect((await hoverActivityCell("2026-07-21")).textContent).toContain("1m 12s generating");
    usageHarness.emitSnapshot({
      ...usage,
      today: { ...usage.today, generatingMs: usage.today.generatingMs + 30_000 },
      activeSessionCount: 3,
      asOfMs: baseMs + 9_000,
    });
    await page.getByRole("button", { name: "7 days", exact: true }).click();
    expect(overviewValue("Time spent generating")).toBe("3m 31s");
    expect(overviewValue("Tokens generated")).toBe("250,000");
    expectCostRange("7 days");
    expect(document.body.textContent).not.toContain("chats generating");
    expect((await hoverActivityCell("2026-07-21")).textContent).toContain("1m 12s generating");
    for (const label of ["90 days", "All", "30 days", "7 days"] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      expectCostRange(label);
      // The latest settled detail is below the earlier live projection. Only
      // the summary's accounting scope resets; Activity must keep today's
      // already displayed duration even when a selector is clicked repeatedly.
      expect((await hoverActivityCell("2026-07-21")).textContent).toContain("1m 12s generating");
    }
  });

  it("freezes the old server day at midnight until a newer detailed response replaces its calendar", async () => {
    const baseMs = Date.parse("2026-07-21T23:59:58Z");
    vi.setSystemTime(baseMs);
    const usage = { ...createRangeUsageDetail(), activeSessionCount: 1, asOfMs: baseMs };
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);
    await vi.waitFor(() => expect(overviewValue("Time spent generating")).toBe("10m 30s"));
    await page.getByRole("button", { name: "7 days", exact: true }).click();
    expect(overviewValue("Time spent generating")).toBe("3m 30s");
    vi.setSystemTime(baseMs + 1_000);
    await vi.waitFor(() => expect(overviewValue("Time spent generating")).toBe("3m 31s"));

    vi.setSystemTime(baseMs + 2_000);
    usageHarness.emitSnapshot({
      ...usage,
      today: { ...emptyTotals, day: "2026-07-22", generatingMs: 1_000 },
      activeSessionCount: 2,
      asOfMs: baseMs + 2_000,
    });
    await expect.element(page.getByText("2 chats generating", { exact: true })).toBeVisible();
    vi.setSystemTime(baseMs + 12_000);
    // Let the real projection interval read the post-midnight clock before
    // checking the unchanged value; an immediate assertion would only inspect
    // the render from the midnight event and miss continued extrapolation.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    expect(overviewValue("Time spent generating")).toBe("3m 31s");
    expectCostRange("7 days");
    expect(overviewValue("Tokens generated")).toBe("250,000");
    expect(
      document.querySelector('[data-activity-day="2026-07-22"][data-activity-in-range="true"]'),
    ).toBeNull();
    expect((await hoverActivityCell("2026-07-21")).textContent).toContain("1m 1s generating");

    const newToday: UsageStatsDay = {
      ...emptyTotals,
      day: "2026-07-22",
      generatingMs: 2_000,
      inputTokens: 100,
      outputTokens: 10,
      reasoningOutputTokens: 1,
      userMessages: 1,
    };
    const newAttribution = {
      day: newToday.day,
      provider: ProviderDriverKind.make("codex"),
      model: "gpt-5.6-codex",
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 1,
    };
    const freshUsage: UsageStatsGetResult = {
      ...usage,
      totals: sumTotals([usage.totals, newToday]),
      today: newToday,
      days: [...usage.days, newToday],
      tokenBreakdown: usage.tokenBreakdown.map((entry) =>
        entry.model === newAttribution.model
          ? {
              ...entry,
              inputTokens: entry.inputTokens + newAttribution.inputTokens,
              outputTokens: entry.outputTokens + newAttribution.outputTokens,
              reasoningOutputTokens:
                entry.reasoningOutputTokens + newAttribution.reasoningOutputTokens,
            }
          : entry,
      ),
      tokenBreakdownDays: [...(usage.tokenBreakdownDays ?? []), newAttribution],
      activeSessionCount: 0,
      // This completed detail is newer than the active midnight stream event.
      asOfMs: baseMs + 12_000,
    };
    usageHarness.refreshDetail(freshUsage);
    await vi.waitFor(() => {
      expect(overviewValue("Time spent generating")).toBe("1m 32s");
      expect(overviewValue("Tokens generated")).toBe("150,010");
      expect(overviewValue("Chats sent")).toBe("3");
      expect(displayedRawCount("processed")).toBe(1_650_110);
      expect(displayedRawCount("output")).toBe(150_010);
    });
    expect(document.body.textContent).not.toContain("chats generating");
    expect(
      requiredElement('[role="img"][aria-label^="Daily generating time"]').getAttribute(
        "aria-label",
      ),
    ).toContain("from 2026-04-22 through 2026-07-22");
    expect(activeActivityCellCount()).toBe(9);
    expect((await hoverActivityCell("2026-07-15")).textContent).toContain("2m generating");
    expect((await hoverActivityCell("2026-04-22")).textContent).toContain("7m generating");
    expect((await hoverActivityCell("2026-07-22")).textContent).toContain("2s generating");
    const refreshedActivity = freshUsage.days.map(({ day }) => ({
      day,
      color: requiredElement(`[data-activity-day="${day}"]`).style.backgroundColor,
    }));
    for (const label of ["30 days", "90 days", "All", "7 days"] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      expect(
        requiredElement('[role="img"][aria-label^="Daily generating time"]').getAttribute(
          "aria-label",
        ),
      ).toContain("from 2026-04-22 through 2026-07-22");
      expect(activeActivityCellCount()).toBe(9);
      for (const { day, color } of refreshedActivity) {
        expect(
          requiredElement(`[data-activity-day="${day}"][data-activity-in-range="true"]`).style
            .backgroundColor,
        ).toBe(color);
      }
      expect((await hoverActivityCell("2026-07-22")).textContent).toContain("2s generating");
    }
  });

  it("renders stored provider and model attribution with unattributed usage separated", async () => {
    mounted = await render(<UsageStatsPanel />);

    // One table lists every attributed model; the separate output-only
    // breakdown was removed because it repeated these rows.
    await vi.waitFor(() =>
      expect(modelCostRows().map((row) => row.model)).toEqual([
        "claude-opus-5",
        "gpt-5.6-codex",
        "gpt-5.6-codex-mini",
      ]),
    );
    expect(document.body.textContent).not.toContain("Output tokens by provider and model");
    expect(providerCostRows().map((row) => row.provider)).toEqual(["Claude", "Codex"]);
    // 3,000,000 recorded processed tokens, of which 2,950,000 carry attribution.
    const unattributed = requiredElement("[data-usage-unattributed-row]");
    expect(unattributed.textContent).toContain("Unattributed usage");
    expect(unattributed.textContent).toContain("Unpriced");
    expect(unattributedTokens()).toBe("50,000");
    expect(await tooltipTextFor(infoTipTrigger("About unattributed usage"))).toContain(
      "counted but not priced",
    );
    expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);
    expect(usageHarness.subscribeConnectionOpened).toHaveBeenCalledTimes(1);
    expect(usageHarness.subscribeUsageStats).toHaveBeenCalledTimes(1);
  });

  it("keeps input-only Fable visible in the cost table without counting it as generated output", async () => {
    const codex = ProviderDriverKind.make("codex");
    const claude = ProviderDriverKind.make("claudeAgent");
    const rows: UsageStatsTokenBreakdownEntry[] = [
      {
        provider: codex,
        model: "gpt-6-astra",
        inputTokens: 1_453_045_932,
        outputTokens: 5_037_075,
      },
      {
        provider: codex,
        model: "gpt-6.1-sol",
        inputTokens: 1_174_928_287,
        outputTokens: 4_975_605,
      },
      { provider: claude, model: "claude-fable-5-1", inputTokens: 2_853_296, outputTokens: 0 },
    ].map((row) => ({
      ...row,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    }));
    const today: UsageStatsDay = {
      ...emptyTotals,
      day: "2026-07-21",
      inputTokens: 2_630_827_515,
      outputTokens: 10_012_680,
    };
    const usage: UsageStatsGetResult = {
      ...snapshot,
      totals: today,
      today,
      days: [today],
      tokenBreakdown: rows,
      tokenBreakdownDays: rows.map((row) => ({ ...row, day: today.day })),
    };
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);
    await vi.waitFor(() => {
      expect(overviewValue("Tokens generated")).toBe("10,012,680");
      expect(displayedRawCount("processed")).toBe(2_640_840_195);
    });
    for (const range of ["7 days", "90 days", "All", "30 days"] as const) {
      await page.getByRole("button", { name: range, exact: true }).click();
      expect(providerCostRows().find((row) => row.provider === "Claude")?.tokens).toBe(
        "2,853,296 tokens",
      );
      expect(modelCostRows().find((row) => row.model === "claude-fable-5-1")?.tokens).toBe(
        "2,853,296",
      );
      expect(displayedRawCount("output")).toBe(10_012_680);
      expect(unattributedTokens()).toBeNull();
      expect(overviewValue("Tokens generated")).toBe("10,012,680");
    }
    expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);

    // The same atomic detailed response can later include validated output.
    // It replaces the input-only presentation without treating input as output,
    // inventing a provider call or retaining a stale zero-output explanation.
    const completedRows = rows.map((row) =>
      row.provider === claude ? { ...row, outputTokens: 200 } : row,
    );
    const completedToday = { ...today, outputTokens: 10_012_880 };
    usageHarness.refreshDetail({
      ...usage,
      totals: completedToday,
      today: completedToday,
      days: [completedToday],
      tokenBreakdown: completedRows,
      tokenBreakdownDays: completedRows.map((row) => ({ ...row, day: today.day })),
    });
    await vi.waitFor(
      () => {
        expect(displayedRawCount("output")).toBe(10_012_880);
        expect(overviewValue("Tokens generated")).toBe("10,012,880");
        expect(modelCostRows().find((row) => row.model === "claude-fable-5-1")?.tokens).toBe(
          "2,853,496",
        );
      },
      { timeout: 4_000 },
    );
  });

  it("explains an omitted effective model while retaining its exact counted and unpriced usage", async () => {
    // This synthetic observation has a known provider but no effective model.
    // Cached input is a subset of input, so the unpriced processed volume is
    // 20,511 input + 16 output, never input plus cached input a second time.
    const today: UsageStatsDay = {
      ...emptyTotals,
      day: "2026-07-21",
      inputTokens: 20_511,
      cachedInputTokens: 9_984,
      outputTokens: 16,
      userMessages: 1,
    };
    const unknownModel: UsageStatsTokenBreakdownEntry = {
      provider: ProviderDriverKind.make("codex"),
      model: "unknown",
      inputTokens: 20_511,
      cachedInputTokens: 9_984,
      cacheWriteInputTokens: 0,
      outputTokens: 16,
      reasoningOutputTokens: 0,
    };
    const usage: UsageStatsGetResult = {
      ...snapshot,
      totals: today,
      today,
      days: [today],
      tokenBreakdown: [unknownModel],
      tokenBreakdownDays: [{ ...unknownModel, day: today.day }],
    };
    usageHarness.reset(usage, usage);
    mounted = await render(<UsageStatsPanel />);
    await vi.waitFor(
      () => {
        expect(overviewValue("Tokens generated")).toBe("16");
        expect(displayedRawCount("processed")).toBe(20_527);
        expect(displayedRawCount("cached")).toBe(9_984);
        expect(displayedRawCount("uncached")).toBe(10_527);
        expect(displayedRawCount("output")).toBe(16);
      },
      { timeout: 5_000 },
    );

    const explanation =
      "The provider didn't report which model served these tokens. They're counted but not priced.";
    expect(requiredModelRow("unknown", "codex").firstElementChild!.textContent).toBe(
      "Model not reported",
    );
    // The explanation is reachable by hover and keyboard focus, not a title.
    expect(await tooltipTextFor(infoTipTrigger("About Model not reported"))).toBe(explanation);
    // A missing model must not turn a known provider into unattributed usage
    // or silently price the observation as the user's requested model.
    expect(unattributedTokens()).toBeNull();
    expect(document.body.textContent).not.toContain("Unattributed usage");

    for (const label of ["7 days", "90 days", "All", "30 days"] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      expect(overviewValue("Tokens generated")).toBe("16");
      expect(displayedRawCount("processed")).toBe(20_527);
      expect(displayedRawCount("output")).toBe(16);
      expect(requiredElement("[data-usage-cost-hero-value]").textContent).toBe("$0.00");
      expect(costQualityValue("Priced")).toBe("0.0%");
      expect(costQualityValue("Unpriced")).toBe("100.0%");
      expect(providerCostRows()).toEqual([
        { provider: "Codex", cost: "Unpriced", tokens: "20,527 tokens" },
      ]);
      expect(modelCostRows()).toEqual([
        { model: "Model not reported", cost: "Unpriced", tokens: "20,527" },
      ]);
      expect(infoTipTrigger("About Model not reported")).toBeVisible();
    }
    expect(usageHarness.getUsageStats).toHaveBeenCalledTimes(1);
  });

  it("renders quiet empty states once a period with no attributed usage has loaded", async () => {
    usageHarness.reset(
      {
        ...snapshot,
        totals: { ...totals, outputTokens: 0 },
        today: { ...snapshot.today, outputTokens: 0 },
        days: [],
        tokenBreakdown: [],
      },
      { ...snapshot, totals: { ...totals, outputTokens: 0 } },
    );

    mounted = await render(<UsageStatsPanel />);

    await expect
      .element(page.getByText("No usage by model in this period.", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Nothing recorded in this period.", { exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-usage-cost-skeleton]")).toBeNull();
  });

  it("shows a delayed layout skeleton, never zero figures, while the first response loads", async () => {
    // A pending request keeps the page in its first-load state.
    usageHarness.reset(new Promise(() => {}), snapshot);
    mounted = await render(<UsageStatsPanel />);

    // Fast loads show nothing: the skeleton reserves space but stays hidden.
    const skeleton = requiredElement("[data-usage-cost-skeleton]");
    expect(getComputedStyle(skeleton).visibility).toBe("hidden");
    await vi.waitFor(() => expect(getComputedStyle(skeleton).visibility).toBe("visible"));
    expect(document.querySelector("[data-usage-cost-hero-value]")).toBeNull();
    expect(document.body.textContent).not.toContain("$0.00");
    expect(document.body.textContent).not.toContain("in this period");
    expect(document.body.textContent).not.toContain("unavailable");
  });

  it("states a failed first load once instead of showing empty cost and activity", async () => {
    usageHarness.getUsageStats.mockImplementationOnce(async () => {
      throw new Error("Usage request failed");
    });
    mounted = await render(<UsageStatsPanel />);

    await expect
      .element(
        page.getByText("Usage is unavailable right now. Reconnect to the server and try again."),
      )
      .toBeVisible();
    expect(document.querySelector("[data-usage-cost-layout]")).toBeNull();
    expect(document.querySelector("[data-usage-cost-skeleton]")).toBeNull();
    expect(document.body.textContent).not.toContain("Activity");
    await expect
      .element(page.getByRole("switch", { name: "Collect usage statistics" }))
      .toBeVisible();
  });

  it("names the USD currency once and shows full token totals above smaller abbreviations", async () => {
    mounted = await render(<UsageCostContent usage={createUsageDetail()} />);

    // Standalone content (Atrium) names the currency on its headline estimate;
    // every value keeps the dollar sign without repeating the currency code.
    const hero = requiredElement('[data-usage-cost-hero-value="true"]');
    expect(hero.textContent).toMatch(/^\$[\d,.]+$/);
    await expect.element(page.getByText("Estimated cost (USD)", { exact: true })).toBeVisible();
    expect(document.body.textContent?.match(/\bUSD\b/g)).toHaveLength(1);
    expect(requiredElement('[data-usage-cost-chart-label="true"]').textContent).toBe("Daily cost");
    const estimateNote = await tooltipTextFor(infoTipTrigger("About estimated cost"));
    expect(estimateNote).toContain("Excludes long-context and speed-tier adjustments");
    expect(estimateNote).not.toContain("Add your own in Settings");

    const providerCosts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-provider-cost-value="true"]'),
    );
    expect(providerCosts).toHaveLength(2);
    expect(providerCosts.every((entry) => /^\$[\d,.]+$/.test(entry.textContent ?? ""))).toBe(true);
    expect(requiredElement('[data-usage-composition-value="cache-savings"]').textContent).toMatch(
      /^\$[\d,.]+$/,
    );
    // Net cache savings appears once, in its composition tile.
    expect(page.getByText("Net cache savings", { exact: true }).elements()).toHaveLength(1);
    const modelCosts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-model-cost-value="true"]'),
    );
    expect(modelCosts).toHaveLength(3);
    expect(modelCosts.every((entry) => /^\$[\d,.]+$/.test(entry.textContent ?? ""))).toBe(true);

    expect(requiredElement('[data-usage-token-full="range"]').textContent).toBe(
      "3,000,000 tokens in range",
    );
    expect(requiredElement('[data-usage-token-compact="range"]').textContent).toBe("3.00M");
    expectFullAboveCompact("range");

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
    expect(providerCompacts.every((entry) => /[KM]$/.test(entry.textContent ?? ""))).toBe(true);
    expectFullAboveCompact("provider");

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
      expectFullAboveCompact(context);
    }

    expect(requiredElement('[data-usage-token-full="reasoning"]').textContent).toBe(
      "50,000 reasoning tokens",
    );
    expect(requiredElement('[data-usage-token-compact="reasoning"]').textContent).toBe("50K");
    expectFullAboveCompact("reasoning");

    const modelFullCounts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-token-full="model"]'),
    );
    const modelCompacts = Array.from(
      document.querySelectorAll<HTMLElement>('[data-usage-token-compact="model"]'),
    );
    expect(modelFullCounts).toHaveLength(3);
    expect(modelCompacts).toHaveLength(3);
    expect(modelCompacts.every((entry) => /^[\d.]+[KM]$/.test(entry.textContent ?? ""))).toBe(true);
    expect(modelFullCounts.every((entry) => /\d{1,3}(,\d{3})+/.test(entry.textContent ?? ""))).toBe(
      true,
    );

    expectFullAboveCompact("model");
    expect(document.body.textContent).not.toMatch(/\btokens? exact\b/i);
  });

  it("shows a negative net cache saving while writes exceed read discounts", async () => {
    const usage = createUsageDetail();
    mounted = await render(
      <UsageCostContent
        usage={{
          ...usage,
          tokenBreakdown: [
            {
              provider: ProviderDriverKind.make("claudeAgent"),
              model: "claude-opus-5-5",
              inputTokens: 1_000_000,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 1_000_000,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
          ],
        }}
      />,
    );
    await page.getByRole("button", { name: "All", exact: true }).click();
    expect(requiredElement('[data-usage-composition-value="cache-savings"]').textContent).toBe(
      "-$1.00",
    );
    await expect
      .element(page.getByText("Cache writes cost more than reads have saved"))
      .toBeVisible();
    await expect.element(page.getByText("Net cache savings", { exact: true })).toBeVisible();
  });

  it("renders the full billion-scale counter above its shorthand", async () => {
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
    await page.getByRole("button", { name: "All", exact: true }).click();

    expect(requiredElement('[data-usage-token-full="composition-processed"]').textContent).toBe(
      "3,539,966,200 tokens",
    );
    expect(requiredElement('[data-usage-token-compact="composition-processed"]').textContent).toBe(
      "3.54B",
    );
    expectFullAboveCompact("composition-processed");
  });

  it("animates the full aggregate count through a small increment", async () => {
    const initialUsage = createUsageDetail();
    mounted = await render(<UsageCostContent usage={initialUsage} />);
    await page.getByRole("button", { name: "All", exact: true }).click();
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
        expect(requiredElement('[data-usage-token-full="composition-processed"]')).toBeVisible();
        expect(
          requiredElement('[data-usage-token-compact="composition-processed"]').textContent,
        ).toBe(formatCompactTokenCount(displayedRawCount("processed")));
        expect(parseFullTokenFigure(requiredElement('[data-usage-token-full="range"]'))).toBe(
          displayedRawCount("processed"),
        );
      },
      { interval: 10, timeout: 1_000 },
    );
    await vi.waitFor(() => expect(displayedRawCount("processed")).toBe(3_000_010), {
      timeout: 3_000,
    });
  });

  it("animates live model, composition, savings, and cost-quality figures together", async () => {
    const [initialUsage, updatedUsage] = createAnimatedUsageUpdate();
    mounted = await render(<UsageCostContent usage={initialUsage} range="all" />);

    expect(document.querySelector<HTMLElement>("[data-usage-model]")?.dataset.usageModel).not.toBe(
      "gpt-5.6-codex",
    );
    const initialModel = requiredModelRow("gpt-5.6-codex", "codex");
    const initialModelTokens = parseFullTokenFigure(
      initialModel.querySelector('[data-usage-token-full="model"]')!,
    );
    const initialModelCost = parseUsd(
      initialModel.querySelector("[data-usage-model-cost-value]")!.textContent,
    );
    const initialModelTime = requiredModelTime("gpt-5.6-codex", "codex").textContent;
    const initialReasoning = parseFullTokenFigure(
      requiredElement('[data-usage-token-full="reasoning"]'),
    );
    const provider = requiredElement('[data-usage-provider-summary="codex"]');
    const initialProviderTokens = parseFullTokenFigure(
      provider.querySelector('[data-usage-token-full="provider"]')!,
    );
    const initialProviderCost = parseUsd(
      provider.querySelector("[data-usage-provider-cost-value]")!.textContent,
    );
    const initialSavings = parseUsd(
      requiredElement('[data-usage-composition-value="cache-savings"]').textContent,
    );
    const initialPriced = Number.parseFloat(costQualityValue("Priced")!);

    const updatedModel = updatedUsage.tokenBreakdown.find(
      (entry) => entry.provider === "codex" && entry.model === "gpt-5.6-codex",
    )!;
    const targetModelTokens = updatedModel.inputTokens + updatedModel.outputTokens;
    const targetModelCost = rollUpCost([updatedModel]).cost;
    const targetModelTime = updatedUsage.modelGeneratingTime!.totals.find(
      (entry) => entry.provider === "codex" && entry.model === "gpt-5.6-codex",
    )!.generatingMs;
    const targetRollup = rollUpCost(updatedUsage.tokenBreakdown);
    const providerEntries = updatedUsage.tokenBreakdown.filter(
      (entry) => entry.provider === "codex",
    );
    const targetProviderTokens = providerEntries.reduce(
      (sum, entry) => sum + entry.inputTokens + entry.outputTokens,
      0,
    );
    const targetProviderCost = rollUpCost(providerEntries).cost;
    const targetProcessed = updatedUsage.totals.inputTokens + updatedUsage.totals.outputTokens;
    const targetFresh = Math.max(
      0,
      updatedUsage.totals.inputTokens -
        updatedUsage.totals.cachedInputTokens -
        updatedUsage.totals.cacheWriteInputTokens,
    );
    const targetShare = Math.max(
      targetProcessed,
      targetRollup.pricedTokens + targetRollup.unpricedTokens,
    );
    const targetPriced = (targetRollup.pricedTokens / targetShare) * 100;

    await mounted.rerender(<UsageCostContent usage={updatedUsage} range="all" />);
    // Target ordering updates immediately, but the keyed row must carry its
    // old displayed figures into the new position and count from there.
    expect(document.querySelector<HTMLElement>("[data-usage-model]")?.dataset.usageModel).toBe(
      "gpt-5.6-codex",
    );

    await vi.waitFor(
      () => {
        const row = requiredModelRow("gpt-5.6-codex", "codex");
        const tokens = parseFullTokenFigure(row.querySelector('[data-usage-token-full="model"]')!);
        const compact = row.querySelector('[data-usage-token-compact="model"]')!.textContent;
        const cost = parseUsd(row.querySelector("[data-usage-model-cost-value]")!.textContent);
        const time = requiredModelTime("gpt-5.6-codex", "codex").textContent;
        const reasoning = parseFullTokenFigure(
          requiredElement('[data-usage-token-full="reasoning"]'),
        );
        const savings = parseUsd(
          requiredElement('[data-usage-composition-value="cache-savings"]').textContent,
        );
        const priced = Number.parseFloat(costQualityValue("Priced")!);
        const providerTokens = parseFullTokenFigure(
          provider.querySelector('[data-usage-token-full="provider"]')!,
        );
        const providerCost = parseUsd(
          provider.querySelector("[data-usage-provider-cost-value]")!.textContent,
        );

        expect(tokens).toBeGreaterThan(initialModelTokens);
        expect(tokens).toBeLessThan(targetModelTokens);
        expect(compact).toBe(formatCompactTokenCount(tokens));
        expect(providerTokens).toBeGreaterThan(initialProviderTokens);
        expect(providerTokens).toBeLessThan(targetProviderTokens);
        expect(provider.querySelector('[data-usage-token-compact="provider"]')!.textContent).toBe(
          formatCompactTokenCount(providerTokens),
        );
        expect(providerCost).toBeGreaterThan(initialProviderCost);
        expect(providerCost).toBeLessThan(targetProviderCost);
        expect(parseFullTokenFigure(requiredElement('[data-usage-token-full="range"]'))).toBe(
          displayedRawCount("processed"),
        );
        expect(cost).toBeGreaterThan(initialModelCost);
        expect(cost).toBeLessThan(targetModelCost);
        expect(time).not.toBe(initialModelTime);
        expect(time).not.toBe(formatGeneratingTime(targetModelTime));
        expect(reasoning).toBeGreaterThan(initialReasoning);
        expect(reasoning).toBeLessThan(updatedUsage.totals.reasoningOutputTokens);
        expect(savings).toBeGreaterThan(Math.min(initialSavings, targetRollup.cacheSavings));
        expect(savings).toBeLessThan(Math.max(initialSavings, targetRollup.cacheSavings));
        expect(priced).toBeLessThan(initialPriced);
        expect(priced).toBeGreaterThan(targetPriced);
      },
      { interval: 10, timeout: 1_500 },
    );

    await vi.waitFor(
      () => {
        const row = requiredModelRow("gpt-5.6-codex", "codex");
        expect(row.querySelector("[data-usage-model-cost-value]")!.textContent).toBe(
          expectedUsd(targetModelCost),
        );
        expect(row.querySelector('[data-usage-token-full="model"]')!.textContent).toBe(
          formatFullTokenCount(targetModelTokens),
        );
        expect(row.querySelector('[data-usage-token-compact="model"]')!.textContent).toBe(
          formatCompactTokenCount(targetModelTokens),
        );
        expect(requiredModelTime("gpt-5.6-codex", "codex").textContent).toBe(
          formatGeneratingTime(targetModelTime),
        );
        expect(displayedRawCount("processed")).toBe(targetProcessed);
        expect(
          parseFullTokenFigure(provider.querySelector('[data-usage-token-full="provider"]')!),
        ).toBe(targetProviderTokens);
        expect(provider.querySelector("[data-usage-provider-cost-value]")!.textContent).toBe(
          expectedUsd(targetProviderCost),
        );
        expect(parseFullTokenFigure(requiredElement('[data-usage-token-full="range"]'))).toBe(
          targetProcessed,
        );
        expect(displayedRawCount("cached")).toBe(updatedUsage.totals.cachedInputTokens);
        expect(displayedRawCount("uncached")).toBe(targetFresh);
        expect(displayedRawCount("output")).toBe(updatedUsage.totals.outputTokens);
        expect(requiredElement('[data-usage-token-full="reasoning"]').textContent).toBe(
          `${formatFullTokenCount(updatedUsage.totals.reasoningOutputTokens)} reasoning tokens`,
        );
        expect(requiredElement('[data-usage-composition-value="cache-savings"]').textContent).toBe(
          expectedUsd(targetRollup.cacheSavings),
        );
        expect(requiredElement("[data-usage-composition-tile='cached']").textContent).toContain(
          `${((updatedUsage.totals.cachedInputTokens / updatedUsage.totals.inputTokens) * 100).toFixed(1)}% of input`,
        );
        expect(costQualityValue("Priced")).toBe(`${targetPriced.toFixed(1)}%`);
        expect(costQualityValue("Unpriced")).toBe(`${(100 - targetPriced).toFixed(1)}%`);
      },
      { timeout: 4_000 },
    );
  });

  it("snaps every live usage figure when reduced motion is requested", async () => {
    settleLayoutCountersImmediately();
    const [initialUsage, updatedUsage] = createAnimatedUsageUpdate();
    mounted = await render(<UsageCostContent usage={initialUsage} range="all" />);
    const targetModel = updatedUsage.tokenBreakdown.find(
      (entry) => entry.provider === "codex" && entry.model === "gpt-5.6-codex",
    )!;
    const targetModelTokens = targetModel.inputTokens + targetModel.outputTokens;
    const targetRollup = rollUpCost(updatedUsage.tokenBreakdown);

    // With RAF callbacks deliberately withheld, only the reduced-motion snap
    // path can paint the new values. This guards every row/stat without making
    // the test depend on an animation-frame race.
    const animationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 91_337);
    await mounted.rerender(<UsageCostContent usage={updatedUsage} range="all" />);

    await vi.waitFor(() => {
      const row = requiredModelRow("gpt-5.6-codex", "codex");
      expect(row.querySelector("[data-usage-model-cost-value]")!.textContent).toBe(
        expectedUsd(rollUpCost([targetModel]).cost),
      );
      expect(row.querySelector('[data-usage-token-full="model"]')!.textContent).toBe(
        formatFullTokenCount(targetModelTokens),
      );
      expect(requiredModelTime("gpt-5.6-codex", "codex").textContent).toBe("3m 00s");
      expect(displayedRawCount("processed")).toBe(
        updatedUsage.totals.inputTokens + updatedUsage.totals.outputTokens,
      );
      const provider = requiredElement('[data-usage-provider-summary="codex"]');
      const providerEntries = updatedUsage.tokenBreakdown.filter(
        (entry) => entry.provider === "codex",
      );
      expect(
        parseFullTokenFigure(provider.querySelector('[data-usage-token-full="provider"]')!),
      ).toBe(
        providerEntries.reduce((sum, entry) => sum + entry.inputTokens + entry.outputTokens, 0),
      );
      expect(provider.querySelector("[data-usage-provider-cost-value]")!.textContent).toBe(
        expectedUsd(rollUpCost(providerEntries).cost),
      );
      expect(parseFullTokenFigure(requiredElement('[data-usage-token-full="range"]'))).toBe(
        displayedRawCount("processed"),
      );
      expect(requiredElement('[data-usage-token-full="reasoning"]').textContent).toBe(
        `${formatFullTokenCount(updatedUsage.totals.reasoningOutputTokens)} reasoning tokens`,
      );
      expect(requiredElement('[data-usage-composition-value="cache-savings"]').textContent).toBe(
        expectedUsd(targetRollup.cacheSavings),
      );
    });
    expect(animationFrame).not.toHaveBeenCalled();
  });

  it("snaps a lower reporting range instead of relabeling animated lifetime values", async () => {
    const usage = createModelTimeUsageDetail();
    mounted = await render(<UsageCostContent usage={usage} range="all" />);
    expect(displayedRawCount("processed")).toBe(rangeExpectations.All.processed);
    expect(requiredModelTime("gpt-5.6-codex", "codex").textContent).toBe("1d 16h 00m 00s");

    const animationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 73_311);
    await mounted.rerender(<UsageCostContent usage={usage} range="7" />);

    expect(displayedRawCount("processed")).toBe(rangeExpectations["7 days"].processed);
    expect(displayedRawCount("cached")).toBe(rangeExpectations["7 days"].cached);
    expect(requiredModelTime("gpt-5.6-codex", "codex").textContent).toBe("2h 30m 01s");
    expect(modelCostRows().find((row) => row.model === "gpt-5.6-codex")).toEqual(
      rangeExpectations["7 days"].models[0],
    );
    expect(modelCostRows().find((row) => row.model === "waiting-only")).toEqual({
      model: "waiting-only",
      cost: "—",
      tokens: "0",
    });
    expect(costQualityValue("Priced")).toBe(rangeExpectations["7 days"].priced);
    expect(animationFrame).not.toHaveBeenCalled();
  });

  it("keeps a tiny positive animated cost-quality share visible below 0.1%", async () => {
    const baseline = createUsageDetail();
    const unpriced = {
      provider: ProviderDriverKind.make("opencode"),
      model: "unpriced-dominant-model",
      inputTokens: 2_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };
    const initialUsage: UsageStatsGetResult = {
      ...baseline,
      totals: { ...emptyTotals, inputTokens: unpriced.inputTokens },
      tokenBreakdown: [unpriced],
    };
    const onePricedToken = {
      provider: ProviderDriverKind.make("codex"),
      model: "gpt-5.6-codex",
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };
    const updatedUsage: UsageStatsGetResult = {
      ...initialUsage,
      totals: { ...emptyTotals, inputTokens: unpriced.inputTokens + 1 },
      tokenBreakdown: [unpriced, onePricedToken],
    };
    mounted = await render(<UsageCostContent usage={initialUsage} range="all" />);
    expect(costQualityValue("Priced")).toBe("0.0%");

    await mounted.rerender(<UsageCostContent usage={updatedUsage} range="all" />);
    await vi.waitFor(() => {
      expect(costQualityValue("Priced")).toBe("<0.1%");
      expect(costQualityValue("Unpriced")).toBe("100.0%");
    });
  });

  it("contains the cost layout within a narrow viewport", async () => {
    const originalViewport = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(320, 720);
    try {
      mounted = await render(<UsageCostContent usage={createUsageDetail()} />);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(requiredElement('[data-usage-token-compact="composition-processed"]')).toBeVisible();
    } finally {
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("uses the wide settings page width for the chart and complete metrics", async () => {
    await page.viewport(1_800, 1_000);
    applyInterfaceScalePercent(100);
    settleLayoutCountersImmediately();
    const usage = createBillionScaleUsageDetail();
    usageHarness.reset(usage, usage);
    mounted = await render(
      <div className="flex h-dvh min-w-0 w-full">
        <aside data-usage-test-sidebar style={{ width: 280, flexShrink: 0 }}>
          Settings navigation
        </aside>
        <UsageStatsPanel />
      </div>,
    );
    await vi.waitFor(() => expect(displayedRawCount("processed")).toBe(3_000_000_000));

    const sidebar = requiredElement("[data-usage-test-sidebar]").getBoundingClientRect();
    const layout = requiredElement("[data-usage-cost-layout]");
    const bounds = layout.getBoundingClientRect();
    // Usage is a dashboard: it takes the shared wide page width (64rem), wider
    // than the standard 48rem settings column but no longer unbounded.
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    expect(bounds.width).toBeGreaterThan(60 * rootFontSize);
    expect(bounds.width).toBeLessThanOrEqual(64 * rootFontSize);
    expect(bounds.left).toBeGreaterThan(sidebar.right);
    const chart = requiredElement('[data-usage-cost-overview] svg[role="img"]');
    expect(chart.getBoundingClientRect().width).toBeGreaterThan(560);
    expect(chart.getBoundingClientRect().height).toBeGreaterThanOrEqual(12 * rootFontSize - 1);
    const tiles = Array.from(document.querySelectorAll("[data-usage-composition-tile]"));
    expect(tiles).toHaveLength(5);
    for (const tile of tiles) {
      expect(
        Math.abs(tile.getBoundingClientRect().top - tiles[0]!.getBoundingClientRect().top),
      ).toBeLessThanOrEqual(1);
    }
    expectCompositionNumbersOnOneLine();
    expectNoHorizontalOverflow(layout);
    expectNoHorizontalOverflow(document.documentElement);
  });

  it("stacks in a narrow parent inside a wide viewport and grows the chart with its parent", async () => {
    await page.viewport(1_800, 1_000);
    applyInterfaceScalePercent(100);
    settleLayoutCountersImmediately();
    const usage = createBillionScaleUsageDetail();
    const content = (width: number) => (
      <div data-usage-test-parent style={{ width, maxWidth: "100%" }}>
        <UsageCostContent usage={usage} />
      </div>
    );
    mounted = await render(content(640));
    expectOverviewStacked();
    const narrowChart = requiredElement(
      '[data-usage-cost-overview] svg[role="img"]',
    ).getBoundingClientRect();
    expect(narrowChart.width).toBeGreaterThan(540);
    expectNoHorizontalOverflow(requiredElement("[data-usage-test-parent]"));

    await mounted.rerender(content(1_320));
    const wideChart = requiredElement(
      '[data-usage-cost-overview] svg[role="img"]',
    ).getBoundingClientRect();
    expect(wideChart.width).toBeGreaterThan(narrowChart.width + 200);
    expect(wideChart.height).toBeGreaterThan(narrowChart.height + 80);
    expectCompositionNumbersOnOneLine();
    expectNoHorizontalOverflow(requiredElement("[data-usage-test-parent]"));
  });

  it.each([80, 130])(
    "contains billion-scale usage at %i%% interface scale in wide and 320px panels",
    async (scale) => {
      await page.viewport(1_800, 1_000);
      applyInterfaceScalePercent(scale);
      settleLayoutCountersImmediately();
      const usage = createBillionScaleUsageDetail();
      usageHarness.reset(usage, usage);
      mounted = await render(
        <div className="flex h-dvh min-w-0 w-full">
          <aside style={{ width: 280, flexShrink: 0 }}>Settings navigation</aside>
          <UsageStatsPanel />
        </div>,
      );
      await vi.waitFor(() => expect(displayedRawCount("processed")).toBe(3_000_000_000));
      expectCompositionNumbersOnOneLine();
      expectNoHorizontalOverflow(requiredElement("[data-usage-cost-layout]"));
      expectNoHorizontalOverflow(document.documentElement);

      await page.viewport(320, 1_000);
      await mounted.rerender(
        <div className="flex h-dvh min-w-0 w-full">
          <UsageStatsPanel />
        </div>,
      );
      await vi.waitFor(() => expect(displayedRawCount("processed")).toBe(3_000_000_000));
      expectOverviewStacked();
      const layout = requiredElement("[data-usage-cost-layout]");
      expectNoHorizontalOverflow(layout);
      expectNoHorizontalOverflow(document.documentElement);
      for (const tile of document.querySelectorAll<HTMLElement>("[data-usage-composition-tile]")) {
        expectNoHorizontalOverflow(tile);
      }
    },
  );
});
