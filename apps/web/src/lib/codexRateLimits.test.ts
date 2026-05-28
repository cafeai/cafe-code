import { describe, expect, it } from "vitest";

import {
  formatCodexRateLimitInlineText,
  formatCodexRateLimitSummary,
  selectCodexRateLimitSnapshot,
} from "./codexRateLimits";

describe("codexRateLimits", () => {
  it("prefers the codex bucket when additional rate limit buckets are present", () => {
    const snapshot = selectCodexRateLimitSnapshot({
      checkedAt: "2026-05-28T00:00:00.000Z",
      rateLimits: {
        limitId: "other",
        primary: { usedPercent: 90 },
      },
      rateLimitsByLimitId: {
        other: {
          limitId: "other",
          primary: { usedPercent: 90 },
        },
        codex: {
          limitId: "codex",
          primary: { usedPercent: 20 },
        },
      },
    });

    expect(snapshot?.limitId).toBe("codex");
    expect(snapshot?.primary?.usedPercent).toBe(20);
  });

  it("formats primary hours, secondary days, left percentages, and local weekly reset", () => {
    const summary = formatCodexRateLimitSummary(
      {
        checkedAt: "2026-05-28T00:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 62.5,
            windowDurationMins: 10_080,
            resetsAt: 1_780_172_059,
          },
        },
      },
      { locale: "en-US", timeZone: "Asia/Tokyo" },
    );

    expect(summary?.primary?.text).toBe("Primary window (5 hours): 75% left");
    expect(summary?.secondary?.text).toBe("Secondary window (7 days): 37.5% left");
    expect(summary?.weeklyReset).toContain("Weekly reset:");
    expect(summary?.weeklyReset).toContain("2026");
  });

  it("produces a compact inline string for settings rows", () => {
    const text = formatCodexRateLimitInlineText(
      {
        checkedAt: "2026-05-28T00:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 0,
            windowDurationMins: 10_080,
          },
        },
      },
      { locale: "en-US", timeZone: "UTC" },
    );

    expect(text).toBe("Primary window (5 hours): 0% left · Secondary window (7 days): 100% left");
  });
});
