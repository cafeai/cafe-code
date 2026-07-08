// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vitest";

import { localDayKey, splitSpanIntoDays } from "./dayBuckets.ts";

function localMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime();
}

describe("localDayKey", () => {
  it("formats a timestamp as its local YYYY-MM-DD key", () => {
    expect(localDayKey(localMs(2026, 7, 6, 15, 30))).toBe("2026-07-06");
  });

  it("zero-pads single-digit months and days", () => {
    expect(localDayKey(localMs(2026, 1, 3))).toBe("2026-01-03");
  });
});

describe("splitSpanIntoDays", () => {
  it("keeps a same-day span in one bucket", () => {
    const from = localMs(2026, 7, 6, 10, 0);
    expect(splitSpanIntoDays(from, from + 5000)).toEqual([{ day: "2026-07-06", ms: 5000 }]);
  });

  it("starts a fresh bucket for a span beginning exactly at midnight", () => {
    const from = localMs(2026, 7, 6, 0, 0);
    expect(splitSpanIntoDays(from, from + 1000)).toEqual([{ day: "2026-07-06", ms: 1000 }]);
  });

  it("splits a span crossing one midnight", () => {
    const from = localMs(2026, 7, 6, 23, 59, 58);
    const to = localMs(2026, 7, 7, 0, 0, 3);
    expect(splitSpanIntoDays(from, to)).toEqual([
      { day: "2026-07-06", ms: 2000 },
      { day: "2026-07-07", ms: 3000 },
    ]);
  });

  it("splits a span longer than 24 hours across every touched day", () => {
    const from = localMs(2026, 7, 6, 12, 0);
    const to = localMs(2026, 7, 8, 6, 0);
    const spans = splitSpanIntoDays(from, to);
    expect(spans.map((span) => span.day)).toEqual(["2026-07-06", "2026-07-07", "2026-07-08"]);
    expect(spans.reduce((total, span) => total + span.ms, 0)).toBe(to - from);
  });

  it("returns nothing for empty or inverted spans", () => {
    const at = localMs(2026, 7, 6, 10, 0);
    expect(splitSpanIntoDays(at, at)).toEqual([]);
    expect(splitSpanIntoDays(at, at - 1)).toEqual([]);
  });

  it("preserves total duration across any boundary, including DST days", () => {
    // March/November shifts only occur in some timezones; asserting the sum
    // keeps this test correct regardless of the zone vitest runs in.
    const from = localMs(2026, 3, 8, 0, 30);
    const to = localMs(2026, 3, 9, 0, 30);
    const spans = splitSpanIntoDays(from, to);
    expect(spans.reduce((total, span) => total + span.ms, 0)).toBe(to - from);
    expect(spans[0]?.day).toBe("2026-03-08");
  });
});
