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
  });
});
