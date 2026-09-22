import { describe, expect, it } from "vitest";
import { hasLowCodexUsage } from "./providerUsageReset.ts";

describe("Codex reset threshold", () => {
  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, 94, 95])(
    "does not offer reset for %s percent used",
    (usedPercent) => {
      expect(
        hasLowCodexUsage({
          checkedAt: "2026-09-09T00:00:00.000Z",
          rateLimits: { primary: usedPercent === undefined ? {} : { usedPercent } },
        }),
      ).toBe(false);
    },
  );
  it("uses the canonical bucket and unrounded percentages in either window", () => {
    expect(
      hasLowCodexUsage({
        checkedAt: "2026-09-09T00:00:00.000Z",
        rateLimits: { primary: { usedPercent: 100 } },
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 10 }, secondary: { usedPercent: 95 } },
        },
      }),
    ).toBe(false);
    expect(
      hasLowCodexUsage({
        checkedAt: "2026-09-09T00:00:00.000Z",
        rateLimits: { secondary: { usedPercent: 95.001 } },
      }),
    ).toBe(true);
  });
});
