import {
  ProviderDriverKind,
  type UsageStatsDay,
  type UsageStatsGetResult,
  type UsageStatsModelGeneratingTimeDayEntry,
  type UsageStatsTokenBreakdownDayEntry,
  type UsageStatsTotals,
} from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  getUsageRangeBounds,
  selectUsageRange,
  USAGE_RANGES,
  usageDayToUtcDayIndex,
  utcDayIndexToUsageDay,
} from "./usageRange";

const zero: UsageStatsTotals = {
  generatingMs: 0,
  userMessages: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

const day = (key: string, counts: Partial<UsageStatsTotals> = {}): UsageStatsDay => ({
  day: key,
  ...zero,
  ...counts,
});

const row = (
  key: string,
  model: string,
  counts: Partial<UsageStatsTotals> = {},
  provider = ProviderDriverKind.make("codex"),
): UsageStatsTokenBreakdownDayEntry => {
  const tokens = { ...zero, ...counts };
  return {
    day: key,
    provider,
    model,
    inputTokens: tokens.inputTokens,
    cachedInputTokens: tokens.cachedInputTokens,
    cacheWriteInputTokens: tokens.cacheWriteInputTokens,
    outputTokens: tokens.outputTokens,
    reasoningOutputTokens: tokens.reasoningOutputTokens,
  };
};

const usage = (overrides: Partial<UsageStatsGetResult> = {}): UsageStatsGetResult => ({
  totals: { ...zero },
  today: day("2026-10-01"),
  days: [],
  tokenBreakdown: [],
  tokenBreakdownDays: [],
  activeSessionCount: 2,
  collectionEnabled: true,
  asOfMs: 1,
  ...overrides,
});

const timeRow = (
  key: string,
  model: string,
  generatingMs: number,
  provider = ProviderDriverKind.make("codex"),
): UsageStatsModelGeneratingTimeDayEntry => ({ day: key, provider, model, generatingMs });

describe("usage range calendar bounds", () => {
  it("offers the approved finite inclusive day counts and full history", () => {
    expect(USAGE_RANGES.map(({ key, days }) => ({ key, days }))).toEqual([
      { key: "7", days: 7 },
      { key: "30", days: 30 },
      { key: "90", days: 90 },
      { key: "all", days: Infinity },
    ]);
    expect(getUsageRangeBounds(usage(), "7")).toEqual({
      startDay: "2026-09-25",
      endDay: "2026-10-01",
    });
    expect(getUsageRangeBounds(usage(), "30")).toEqual({
      startDay: "2026-09-02",
      endDay: "2026-10-01",
    });
    expect(getUsageRangeBounds(usage(), "90")).toEqual({
      startDay: "2026-07-04",
      endDay: "2026-10-01",
    });
  });

  it("uses the server day independently of the client clock and snapshot timestamp", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-15T23:59:00.000Z"));
      expect(
        getUsageRangeBounds(
          usage({ today: day("2026-01-03"), asOfMs: Date.parse("2026-01-02T15:30:00.000Z") }),
          "7",
        ),
      ).toEqual({ startDay: "2025-12-28", endDay: "2026-01-03" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes leap days and handles month and year transitions", () => {
    const leap = usage({ today: day("2024-03-01") });
    expect(getUsageRangeBounds(leap, "7")).toEqual({
      startDay: "2024-02-24",
      endDay: "2024-03-01",
    });
    expect(getUsageRangeBounds(leap, "30")).toEqual({
      startDay: "2024-02-01",
      endDay: "2024-03-01",
    });
    expect(selectUsageRange(leap, "7").days.map((entry) => entry.day)).toEqual([
      "2024-02-24",
      "2024-02-25",
      "2024-02-26",
      "2024-02-27",
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });

  it("rejects impossible or noncanonical dates without exposing their contents", () => {
    expect(usageDayToUtcDayIndex("2024-02-29")).toBeDefined();
    expect(usageDayToUtcDayIndex("2023-02-29")).toBeUndefined();
    expect(usageDayToUtcDayIndex("2024-02-30")).toBeUndefined();
    expect(usageDayToUtcDayIndex("2024-2-29")).toBeUndefined();
    expect(usageDayToUtcDayIndex("2024-13-01")).toBeUndefined();
    expect(usageDayToUtcDayIndex("2024-02-29T00:00:00Z")).toBeUndefined();
    expect(() => getUsageRangeBounds(usage({ today: day("private-invalid-value") }), "7")).toThrow(
      "Usage statistics returned an invalid current day.",
    );
    expect(utcDayIndexToUsageDay(usageDayToUtcDayIndex("2024-02-29")! + 1)).toBe("2024-03-01");
  });

  it("starts all time at the earliest valid historical day or meaningful attribution", () => {
    expect(
      getUsageRangeBounds(
        usage({
          days: [day("2026-09-28"), day("invalid"), day("2026-10-02")],
          tokenBreakdownDays: [
            row("2026-09-01", "older", { inputTokens: 1 }),
            row("2026-08-01", "empty"),
            row("2026-13-01", "malformed", { inputTokens: 1 }),
            row("2026-10-03", "future", { outputTokens: 1 }),
          ],
        }),
        "all",
      ),
    ).toEqual({ startDay: "2026-09-01", endDay: "2026-10-01" });
    expect(getUsageRangeBounds(usage(), "all")).toEqual({
      startDay: "2026-10-01",
      endDay: "2026-10-01",
    });
  });
});

describe("selectUsageRange", () => {
  it("omits the entire selected time container when exact aggregation would overflow", () => {
    const source = usage({
      modelGeneratingTime: {
        startedAt: "2026-09-25T00:00:00.000Z",
        totals: [],
        days: [
          timeRow("2026-09-25", "overflow", Number.MAX_SAFE_INTEGER),
          timeRow("2026-10-01", "overflow", 1),
          timeRow("2026-10-01", "otherwise-valid", 100),
        ],
      },
    });
    expect(selectUsageRange(source, "7")).not.toHaveProperty("modelGeneratingTime");
    expect(selectUsageRange(source, "7").totals).toEqual(zero);
  });

  it.each(["7", "30", "90"] as const)(
    "selects model time independently of token days in the %s-day range",
    (range) => {
      const source = usage({
        tokenBreakdownDays: undefined,
        modelGeneratingTime: {
          startedAt: "2026-01-01T00:00:00.000Z",
          totals: [
            {
              provider: ProviderDriverKind.make("codex"),
              model: "time-only",
              generatingMs: 999_999,
            },
          ],
          days: [
            timeRow("2026-07-03", "outside", 999_999),
            timeRow("2026-07-04", "ninety-day", 10),
            timeRow("2026-09-01", "outside-thirty", 20),
            timeRow("2026-09-02", "thirty-day", 30),
            timeRow("2026-09-24", "outside-seven", 40),
            timeRow("2026-09-25", "time-only", 50),
            timeRow("2026-09-28", "time-only", 60),
            timeRow("2026-10-01", "time-only", 70),
            timeRow("2026-10-02", "future", 999_999),
            timeRow("2026-09-31", "invalid", 999_999),
          ],
        },
      });
      const selected = selectUsageRange(source, range);
      expect(selected.modelGeneratingTime?.startedAt).toBe(source.modelGeneratingTime?.startedAt);
      expect(selected.tokenBreakdown).toEqual([]);
      expect(selected.totals).toEqual(zero);
      expect(
        selected.modelGeneratingTime?.totals.find(({ model }) => model === "time-only")
          ?.generatingMs,
      ).toBe(180);
      expect(
        selected.modelGeneratingTime?.totals.reduce((sum, entry) => sum + entry.generatingMs, 0),
      ).toBe(range === "7" ? 180 : range === "30" ? 250 : 280);
      expect(
        selected.modelGeneratingTime?.days.some(({ model }) =>
          ["future", "invalid", "outside"].includes(model),
        ),
      ).toBe(false);
      expect(source.modelGeneratingTime?.totals[0]?.generatingMs).toBe(999_999);
    },
  );

  it("preserves authoritative All model time and includes time-only history in its calendar", () => {
    const source = usage({
      modelGeneratingTime: {
        startedAt: "2026-01-01T00:00:00.000Z",
        totals: [
          {
            provider: ProviderDriverKind.make("codex"),
            model: "long-running",
            generatingMs: 50_000,
          },
        ],
        days: [timeRow("2026-01-01", "long-running", 100), timeRow("2025-01-01", "empty", 0)],
      },
    });
    expect(getUsageRangeBounds(source, "all").startDay).toBe("2026-01-01");
    expect(selectUsageRange(source, "all").modelGeneratingTime).toBe(source.modelGeneratingTime);
  });

  it("keeps missing model time unavailable and joins duplicate time rows by exact identities", () => {
    expect(selectUsageRange(usage(), "7")).not.toHaveProperty("modelGeneratingTime");
    const source = usage({
      modelGeneratingTime: {
        startedAt: "2026-09-25T00:00:00.000Z",
        totals: [],
        days: [
          timeRow("2026-09-25", "__proto__", 10),
          timeRow("2026-10-01", "__proto__", 20),
          timeRow("2026-10-01", "__proto__", 40, ProviderDriverKind.make("claudeAgent")),
          timeRow("2026-10-01", "explicit-zero", 0),
        ],
      },
    });
    expect(selectUsageRange(source, "7").modelGeneratingTime?.totals).toEqual([
      { provider: ProviderDriverKind.make("claudeAgent"), model: "__proto__", generatingMs: 40 },
      { provider: ProviderDriverKind.make("codex"), model: "__proto__", generatingMs: 30 },
      { provider: ProviderDriverKind.make("codex"), model: "explicit-zero", generatingMs: 0 },
    ]);
  });

  it("selects calendar days from sparse history, including both bounds and zero gaps", () => {
    const selected = selectUsageRange(
      usage({
        today: day("2026-10-01", { generatingMs: 30, userMessages: 3, outputTokens: 300 }),
        days: [
          day("2026-09-01", { generatingMs: 99_999, outputTokens: 99_999 }),
          day("2026-09-24", { generatingMs: 5_000, outputTokens: 5_000 }),
          day("2026-09-25", { generatingMs: 10, userMessages: 1, outputTokens: 100 }),
          day("2026-09-28", { generatingMs: 20, userMessages: 2, outputTokens: 200 }),
          day("2026-10-02", { generatingMs: 10_000, outputTokens: 10_000 }),
        ],
      }),
      "7",
    );
    expect(selected.days).toEqual([
      day("2026-09-25", { generatingMs: 10, userMessages: 1, outputTokens: 100 }),
      day("2026-09-26"),
      day("2026-09-27"),
      day("2026-09-28", { generatingMs: 20, userMessages: 2, outputTokens: 200 }),
      day("2026-09-29"),
      day("2026-09-30"),
      day("2026-10-01", { generatingMs: 30, userMessages: 3, outputTokens: 300 }),
    ]);
    expect(selected.totals).toEqual({
      ...zero,
      generatingMs: 60,
      userMessages: 6,
      outputTokens: 600,
    });
    expect(selected.activeSessionCount).toBe(2);
    expect(selected.collectionEnabled).toBe(true);
    expect(selected.asOfMs).toBe(1);
  });

  it("replaces a persisted today row with authoritative live detail without adding twice", () => {
    const today = day("2026-10-01", { generatingMs: 500, userMessages: 2, outputTokens: 300 });
    const source = usage({
      today,
      days: [day("2026-09-30", { outputTokens: 100 }), day("2026-10-01", { outputTokens: 200 })],
    });
    const selected = selectUsageRange(source, "7");
    expect(selected.days.at(-1)).toBe(today);
    expect(selected.days.filter((entry) => entry.day === today.day)).toHaveLength(1);
    expect(selected.totals).toEqual({
      ...zero,
      generatingMs: 500,
      userMessages: 2,
      outputTokens: 400,
    });
    expect(source.days.at(-1)?.outputTokens).toBe(200);
  });

  it("sums token dimensions independently instead of adding cache or reasoning subsets twice", () => {
    const counts = {
      generatingMs: 10,
      userMessages: 1,
      inputTokens: 600,
      cachedInputTokens: 300,
      cacheWriteInputTokens: 200,
      outputTokens: 100,
      reasoningOutputTokens: 80,
    };
    const selected = selectUsageRange(
      usage({ today: day("2026-10-01", counts), days: [day("2026-09-25", counts)] }),
      "7",
    );
    expect(selected.totals).toEqual({
      generatingMs: 20,
      userMessages: 2,
      inputTokens: 1_200,
      cachedInputTokens: 600,
      cacheWriteInputTokens: 400,
      outputTokens: 200,
      reasoningOutputTokens: 160,
    });
  });

  it("aggregates only selected daily model rows with structured provider and model identities", () => {
    const counts = {
      inputTokens: 60,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 20,
      outputTokens: 10,
      reasoningOutputTokens: 8,
    };
    const claude = ProviderDriverKind.make("claudeAgent");
    const source = usage({
      tokenBreakdownDays: [
        row("2026-09-24", "same-model", { outputTokens: 99_999 }),
        row("2026-09-25", "same-model", counts),
        row("2026-09-27", "same-model", counts),
        row("2026-10-01", "same-model", counts, claude),
        row("2026-09-26", "__proto__", counts),
        row("2026-09-29", "__proto__", counts),
        row("2026-10-02", "same-model", { outputTokens: 99_999 }),
        row("2026-09-31", "malformed", { outputTokens: 99_999 }),
      ],
      tokenBreakdown: [
        {
          ...row("2026-01-01", "lifetime-model", { outputTokens: 9_999_999 }),
        },
      ],
    });
    const selected = selectUsageRange(source, "7");
    expect(selected.tokenBreakdown).toEqual([
      {
        provider: claude,
        model: "same-model",
        ...counts,
      },
      {
        provider: ProviderDriverKind.make("codex"),
        model: "__proto__",
        inputTokens: 120,
        cachedInputTokens: 60,
        cacheWriteInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 16,
      },
      {
        provider: ProviderDriverKind.make("codex"),
        model: "same-model",
        inputTokens: 120,
        cachedInputTokens: 60,
        cacheWriteInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 16,
      },
    ]);
    expect(selected.tokenBreakdownDays).toHaveLength(5);
    expect(source.tokenBreakdownDays).toHaveLength(8);
  });

  it("keeps absent daily attribution unavailable and never borrows lifetime model totals", () => {
    const { tokenBreakdownDays: _unavailable, ...oldServer } = usage({
      today: day("2026-10-01", { inputTokens: 500, outputTokens: 100 }),
      tokenBreakdown: [row("2026-01-01", "historical", { outputTokens: 1_000 })],
    });
    const selected = selectUsageRange(oldServer, "30");
    expect(selected.totals.inputTokens + selected.totals.outputTokens).toBe(600);
    expect(selected.tokenBreakdown).toEqual([]);
    expect(selected).not.toHaveProperty("tokenBreakdownDays");
    expect(selectUsageRange(usage({ tokenBreakdownDays: [] }), "30").tokenBreakdownDays).toEqual(
      [],
    );
  });

  it("preserves authoritative lifetime totals and model detail for all time", () => {
    const source = usage({
      totals: { ...zero, generatingMs: 50_000, outputTokens: 10_000, inputTokens: 1_000 },
      today: day("2026-10-01", { generatingMs: 50, outputTokens: 10 }),
      days: [day("2026-01-01", { outputTokens: 100 }), day("2026-10-01", { outputTokens: 5 })],
      tokenBreakdown: [row("2026-01-01", "historical", { outputTokens: 9_000 })],
      tokenBreakdownDays: [row("2026-01-01", "historical", { outputTokens: 100 })],
    });
    const selected = selectUsageRange(source, "all");
    expect(selected.totals).toBe(source.totals);
    expect(selected.tokenBreakdown).toBe(source.tokenBreakdown);
    expect(selected.tokenBreakdownDays).toBe(source.tokenBreakdownDays);
    expect(selected.days).toEqual([source.days[0], source.today]);
    expect(selected.today).toBe(source.today);
  });

  it("returns bounded zero calendars for empty history and only today for all time", () => {
    for (const range of ["7", "30", "90"] as const) {
      const selected = selectUsageRange(usage(), range);
      expect(selected.days).toHaveLength(Number(range));
      expect(
        selected.days.every((entry) => entry.outputTokens === 0 && entry.generatingMs === 0),
      ).toBe(true);
      expect(selected.totals).toEqual(zero);
      expect(selected.tokenBreakdown).toEqual([]);
    }
    expect(selectUsageRange(usage(), "all").days).toEqual([day("2026-10-01")]);
  });

  it("ignores corrupt calendar rows and future aggregate rows", () => {
    const source = usage({
      days: [
        day("2026-09-31", { outputTokens: 1_000 }),
        day("2026-9-30", { outputTokens: 1_000 }),
        day("2026-10-02", { outputTokens: 1_000 }),
      ],
    });
    expect(selectUsageRange(source, "7").totals).toEqual(zero);
    expect(selectUsageRange(source, "all").days).toEqual([source.today]);
  });
});
