import { describe, expect, it } from "vitest";
import { dailyUsageCost } from "./dailyUsageCost";
import {
  ProviderDriverKind,
  type UsageStatsDay,
  type UsageStatsTokenBreakdownDayEntry,
} from "@cafecode/contracts";

const counts = {
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 100_000,
  reasoningOutputTokens: 0,
};
const day = (key: string): UsageStatsDay => ({
  day: key,
  ...counts,
  generatingMs: 0,
  userMessages: 1,
});
const row = (key: string, model: string): UsageStatsTokenBreakdownDayEntry => ({
  day: key,
  provider: ProviderDriverKind.make("claudeAgent"),
  model,
  ...counts,
});
const rates = {
  cheap: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
  costly: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
};

describe("dailyUsageCost", () => {
  it("uses each day's effective models rather than a lifetime blended rate", () => {
    const result = dailyUsageCost(
      {
        days: [day("2026-09-04"), day("2026-09-05")],
        tokenBreakdownDays: [row("2026-09-04", "cheap"), row("2026-09-05", "costly")],
      },
      rates,
    );
    expect(result.map((entry) => entry.cost)).toEqual([1.5, 15]);
    expect(result.map((entry) => entry.tokens)).toEqual([1_100_000, 1_100_000]);
    expect(result.every((entry) => entry.unpricedTokens === 0)).toBe(true);
  });

  it("prices daily cache reads/writes as input subsets and never adds reasoning twice", () => {
    const result = dailyUsageCost(
      {
        days: [day("2026-09-05")],
        tokenBreakdownDays: [
          {
            ...row("2026-09-05", "cheap"),
            cachedInputTokens: 600_000,
            cacheWriteInputTokens: 200_000,
            reasoningOutputTokens: 80_000,
          },
        ],
      },
      rates,
    );
    expect(result[0]?.cost).toBeCloseTo(0.2 + 0.06 + 0.25 + 0.5);
    expect(result[0]?.tokens).toBe(1_100_000);
  });

  it("keeps old-server and unattributed history explicitly unpriced", () => {
    expect(dailyUsageCost({ days: [day("2026-09-05")] }, rates)).toEqual([
      { day: "2026-09-05", tokens: 1_100_000, cost: 0, unpricedTokens: 1_100_000 },
    ]);
    const mixed = dailyUsageCost(
      {
        days: [day("2026-09-05")],
        tokenBreakdownDays: [
          { ...row("2026-09-05", "cheap"), inputTokens: 500_000, outputTokens: 0 },
        ],
      },
      rates,
    );
    expect(mixed[0]?.cost).toBe(0.5);
    expect(mixed[0]?.unpricedTokens).toBe(600_000);
  });

  it("does not assign another model's rate to unknown models or other dates", () => {
    const result = dailyUsageCost(
      {
        days: [day("2026-09-05")],
        tokenBreakdownDays: [row("2026-09-04", "cheap"), row("2026-09-05", "unrecognized-model")],
      },
      rates,
    );
    expect(result[0]?.cost).toBe(0);
    expect(result[0]?.unpricedTokens).toBe(1_100_000);
  });
});
