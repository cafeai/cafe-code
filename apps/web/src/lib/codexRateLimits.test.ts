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
            resetsAt: 1_779_580_800,
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
    expect(summary?.primaryReset).toContain("5h reset:");
    expect(summary?.primaryReset).toContain("2026");
    expect(summary?.weeklyReset).toContain("Weekly reset:");
    expect(summary?.weeklyReset).toContain("2026");
  });

  it("falls back to a generic primary reset label when window duration is unknown", () => {
    const summary = formatCodexRateLimitSummary(
      {
        checkedAt: "2026-05-28T00:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 40,
            resetsAt: 1_779_580_800,
          },
        },
      },
      { locale: "en-US", timeZone: "UTC" },
    );

    expect(summary?.primaryReset).toContain("Primary reset:");
  });

  it("shows only the reset for a window with no usage figure, and omits absent windows", () => {
    const summary = formatCodexRateLimitSummary(
      {
        checkedAt: "2026-06-23T00:00:00.000Z",
        rateLimits: {
          limitId: "claude",
          // Claude often reports a window with only a reset time (no utilization),
          // and may not report the weekly window at all.
          primary: {
            windowDurationMins: 300,
            resetsAt: 1_782_274_800,
          },
        },
      },
      { locale: "en-US", timeZone: "UTC" },
    );

    // No usage figure → no usage line; the reset still surfaces.
    expect(summary?.primary).toBeNull();
    expect(summary?.primaryReset).toContain("5h reset:");
    // No weekly window was reported, so it must not appear at all.
    expect(summary?.secondary).toBeNull();
    expect(summary?.weeklyReset).toBeNull();
  });

  it("returns null when there is no rate-limit information at all", () => {
    const summary = formatCodexRateLimitSummary({
      checkedAt: "2026-06-23T00:00:00.000Z",
      rateLimits: { limitId: "claude" },
    });
    expect(summary).toBeNull();
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
