import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { UsageStatsGetResult, UsageStatsModelGeneratingTimeStartedAt } from "./usageStats.ts";

const decodeUsageStatsGetResult = Schema.decodeUnknownSync(UsageStatsGetResult);

describe("UsageStatsGetResult", () => {
  it("decodes legacy aggregate-only responses with an empty token breakdown", () => {
    const decoded = decodeUsageStatsGetResult({
      totals: { generatingMs: 10, outputTokens: 20, userMessages: 1 },
      today: { day: "2026-07-21", generatingMs: 10, outputTokens: 20, userMessages: 1 },
      activeSessionCount: 0,
      collectionEnabled: true,
      asOfMs: 100,
      days: [],
    });

    expect(decoded.tokenBreakdown).toEqual([]);
    expect(decoded.tokenBreakdownDays).toBeUndefined();
    expect(decoded.modelGeneratingTime).toBeUndefined();
  });

  it("keeps prospective model wall time separate from token attribution and live snapshots", () => {
    const decoded = decodeUsageStatsGetResult({
      totals: { generatingMs: 900, outputTokens: 0, userMessages: 0 },
      today: { day: "2026-10-02", generatingMs: 900, outputTokens: 0, userMessages: 0 },
      activeSessionCount: 1,
      collectionEnabled: true,
      asOfMs: 1000,
      days: [],
      modelGeneratingTime: {
        startedAt: "2026-10-02T00:00:00.000Z",
        totals: [{ provider: "codex", model: "unknown", generatingMs: 100 }],
        days: [{ day: "2026-10-02", provider: "codex", model: "unknown", generatingMs: 100 }],
      },
    });
    expect(decoded.modelGeneratingTime?.totals[0]?.generatingMs).toBe(100);
    expect(decoded.totals).not.toHaveProperty("modelGeneratingTime");
    expect(() =>
      decodeUsageStatsGetResult({
        ...decoded,
        modelGeneratingTime: {
          ...decoded.modelGeneratingTime,
          totals: [{ provider: "codex", model: "x".repeat(257), generatingMs: 100 }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeUsageStatsGetResult({
        ...decoded,
        modelGeneratingTime: {
          ...decoded.modelGeneratingTime,
          totals: [{ provider: "codex", model: "unknown", generatingMs: -1 }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeUsageStatsGetResult({
        ...decoded,
        modelGeneratingTime: {
          ...decoded.modelGeneratingTime,
          totals: [
            { provider: "codex", model: "unknown", generatingMs: Number.MAX_SAFE_INTEGER + 1 },
          ],
        },
      }),
    ).toThrow();
  });

  it("requires a canonical real UTC measurement boundary", () => {
    const decode = Schema.decodeUnknownSync(UsageStatsModelGeneratingTimeStartedAt);
    expect(decode("2026-10-02T00:00:00.000Z")).toBe("2026-10-02T00:00:00.000Z");
    for (const invalid of [
      "not a timestamp",
      "2026-02-30T00:00:00.000Z",
      "2026-10-02T00:00:00Z",
      "2026-10-02T00:00:00.000+00:00",
    ]) {
      expect(() => decode(invalid)).toThrow();
    }
  });

  it("decodes daily model attribution without putting it in live totals", () => {
    const decoded = decodeUsageStatsGetResult({
      totals: { generatingMs: 0, outputTokens: 20, userMessages: 1 },
      today: { day: "2026-09-05", generatingMs: 0, outputTokens: 20, userMessages: 1 },
      activeSessionCount: 0,
      collectionEnabled: true,
      asOfMs: 100,
      days: [],
      tokenBreakdownDays: [
        { day: "2026-09-05", provider: "claudeAgent", model: "test-model", outputTokens: 20 },
      ],
    });
    expect(decoded.tokenBreakdownDays).toHaveLength(1);
    expect(decoded.tokenBreakdownDays?.[0]?.inputTokens).toBe(0);
    expect(decoded.totals).not.toHaveProperty("tokenBreakdownDays");
  });
});
