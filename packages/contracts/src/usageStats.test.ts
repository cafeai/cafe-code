import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { UsageStatsGetResult } from "./usageStats.ts";

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
