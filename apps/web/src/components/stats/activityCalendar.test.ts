import { expect, it } from "vitest";
import { buildActivityCalendar } from "./activityCalendar";
import { usageDayToUtcDayIndex } from "./usageRange";
const calendar = (overrides: Partial<Parameters<typeof buildActivityCalendar>[0]> = {}) =>
  buildActivityCalendar({
    byDay: new Map(),
    bounded: true,
    startDayKey: "2026-03-01",
    endDayKey: "2026-03-10",
    browserDay: "2026-10-16",
    ...overrides,
  });
it("uses the server bounds independently of the browser day and aligns complete weeks", () => {
  const a = calendar(),
    b = calendar({ browserDay: "2026-12-31" });
  expect(a).toEqual(b);
  expect(a.rangeStart).toBe(usageDayToUtcDayIndex("2026-03-01"));
  expect(a.endDay - a.rangeStart + 1).toBe(10);
  expect(a.weekCount).toBe(2);
});
it("scales only valid in-range history and excludes the live day from the historical peak", () => {
  const value = calendar({
    todayDayKey: "2026-03-10",
    byDay: new Map([
      ["2026-02-28", 900],
      ["2026-03-01", 10],
      ["2026-03-04", 30],
      ["2026-03-10", 800],
      ["invalid", 1000],
    ]),
  });
  expect(value.historicalMaxMs).toBe(30);
});
it.each([
  ["invalid", "2026-03-10"],
  ["2026-03-11", "2026-03-10"],
  ["2026-03-01", "bad"],
])(
  "rejects invalid explicit bounds %s..%s without inventing a current range",
  (startDayKey, endDayKey) => {
    expect(calendar({ startDayKey, endDayKey })).toMatchObject({
      weekCount: 0,
      endDay: -1,
      calendarKey: "",
    });
  },
);
it("retains the complete sparse history without allocating one object per missing day", () => {
  const value = calendar({ startDayKey: "0001-01-01", endDayKey: "2026-03-10" });
  expect(value.weekCount).toBeGreaterThan(100000);
  expect(value.historicalMaxMs).toBe(0);
});
it("keeps the 26-week local default only when no explicit bounds were supplied", () => {
  expect(calendar({ bounded: false })).toMatchObject({
    weekCount: 26,
    endDay: usageDayToUtcDayIndex("2026-10-16"),
  });
});
