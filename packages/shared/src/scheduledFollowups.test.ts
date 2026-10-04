import type { ScheduledFollowupRecurrence } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  coalesceScheduledFollowupDue,
  nextScheduleOccurrences,
  ScheduledFollowupRecurrenceError,
} from "./scheduledFollowups.ts";

const daily = (
  timeZone: string,
  hour: number,
  minute = 0,
): Extract<ScheduledFollowupRecurrence, { kind: "calendar" }> => ({
  kind: "calendar",
  timeZone,
  hour,
  minute,
});
const interval: ScheduledFollowupRecurrence = {
  kind: "interval",
  timeZone: "America/New_York",
  anchorAt: "2026-03-08T06:58:00.000Z",
  everyMinutes: 5,
};

describe("scheduled follow-up occurrence calculation", () => {
  it("returns a once-only instant strictly after the boundary and never repeats it", () => {
    const recurrence = {
      kind: "once",
      timeZone: "Asia/Tokyo",
      at: "2026-10-05T03:00:00.000Z",
    } as const;
    expect(nextScheduleOccurrences(recurrence, "2026-10-05T02:59:59.999Z")).toEqual([
      recurrence.at,
    ]);
    expect(nextScheduleOccurrences(recurrence, recurrence.at)).toEqual([]);
    expect(nextScheduleOccurrences(recurrence, "2026-10-06T03:00:00.000Z")).toEqual([]);
  });

  it("includes the interval anchor before it begins and preserves elapsed minutes over DST", () => {
    expect(nextScheduleOccurrences(interval, "2026-03-08T06:57:59.999Z")).toEqual([
      "2026-03-08T06:58:00.000Z",
      "2026-03-08T07:03:00.000Z",
      "2026-03-08T07:08:00.000Z",
    ]);
    expect(nextScheduleOccurrences(interval, interval.anchorAt, 1)).toEqual([
      "2026-03-08T07:03:00.000Z",
    ]);
  });

  it("uses the requested calendar timezone instead of the host's local date", () => {
    expect(nextScheduleOccurrences(daily("Asia/Tokyo", 9), "2026-10-04T23:59:59.999Z")).toEqual([
      "2026-10-05T00:00:00.000Z",
      "2026-10-06T00:00:00.000Z",
      "2026-10-07T00:00:00.000Z",
    ]);
    expect(
      nextScheduleOccurrences(daily("America/Los_Angeles", 9), "2026-10-04T23:59:59.999Z", 1),
    ).toEqual(["2026-10-05T16:00:00.000Z"]);
  });

  it("skips nonexistent spring-forward clock times rather than shifting them forward", () => {
    expect(
      nextScheduleOccurrences(daily("America/New_York", 2, 30), "2026-03-07T08:00:00.000Z"),
    ).toEqual(["2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z", "2026-03-11T06:30:00.000Z"]);
  });

  it("selects only the first repeated fall-back clock time, including restart during the overlap", () => {
    const recurrence = daily("America/New_York", 1, 30);
    expect(nextScheduleOccurrences(recurrence, "2026-11-01T04:00:00.000Z", 2)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
    for (const after of [
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:15:00.000Z",
    ]) {
      expect(nextScheduleOccurrences(recurrence, after, 1)).toEqual(["2026-11-02T06:30:00.000Z"]);
    }
  });

  it("handles half-hour gaps and overlaps without assuming a one-hour DST change", () => {
    expect(
      nextScheduleOccurrences(daily("Australia/Lord_Howe", 2, 15), "2026-10-03T00:00:00.000Z", 1),
    ).toEqual(["2026-10-04T15:15:00.000Z"]);
    expect(
      nextScheduleOccurrences(daily("Australia/Lord_Howe", 1, 45), "2026-04-04T14:00:00.000Z", 2),
    ).toEqual(["2026-04-04T14:45:00.000Z", "2026-04-05T15:15:00.000Z"]);
    expect(
      nextScheduleOccurrences(daily("Australia/Lord_Howe", 1, 45), "2026-04-04T15:00:00.000Z", 1),
    ).toEqual(["2026-04-05T15:15:00.000Z"]);
  });

  it("skips an entire missing civil date at a timezone date-line transition", () => {
    expect(
      nextScheduleOccurrences(daily("Pacific/Apia", 9), "2011-12-29T20:00:00.000Z", 1),
    ).toEqual(["2011-12-30T19:00:00.000Z"]);
  });

  it("supports weekdays/weekly presets and intersects custom calendar constraints", () => {
    expect(
      nextScheduleOccurrences(
        { ...daily("UTC", 9), weekdays: [1, 2, 3, 4, 5] },
        "2026-10-02T09:00:00.000Z",
      ),
    ).toEqual(["2026-10-05T09:00:00.000Z", "2026-10-06T09:00:00.000Z", "2026-10-07T09:00:00.000Z"]);
    expect(
      nextScheduleOccurrences({ ...daily("UTC", 9), weekdays: [1] }, "2026-10-04T09:00:00.000Z", 2),
    ).toEqual(["2026-10-05T09:00:00.000Z", "2026-10-12T09:00:00.000Z"]);
    expect(
      nextScheduleOccurrences(
        { ...daily("UTC", 9), weekdays: [1], monthDays: [31], months: [8] },
        "2026-08-01T00:00:00.000Z",
        1,
      ),
    ).toEqual(["2026-08-31T09:00:00.000Z"]);
  });

  it("finds sparse leap-day weekday intersections without walking every intervening day", () => {
    expect(
      nextScheduleOccurrences(
        { ...daily("UTC", 9), weekdays: [1], monthDays: [29], months: [2] },
        "2026-01-01T00:00:00.000Z",
        1,
      ),
    ).toEqual(["2044-02-29T09:00:00.000Z"]);
  });

  it("treats the end time as inclusive and returns no occurrences beyond it", () => {
    const recurrence = daily("UTC", 9);
    expect(
      nextScheduleOccurrences(
        recurrence,
        "2026-10-04T00:00:00.000Z",
        3,
        "2026-10-05T09:00:00.000Z",
      ),
    ).toEqual(["2026-10-04T09:00:00.000Z", "2026-10-05T09:00:00.000Z"]);
    expect(
      nextScheduleOccurrences(
        recurrence,
        "2026-10-04T00:00:00.000Z",
        3,
        "2026-10-04T08:59:59.999Z",
      ),
    ).toEqual([]);
  });

  it("rejects impossible calendars with fixed diagnostics and bounded work", () => {
    expect(() =>
      nextScheduleOccurrences(
        { ...daily("UTC", 9), monthDays: [30], months: [2] },
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow(ScheduledFollowupRecurrenceError);
    // Every selected date is New York's missing second-Sunday-of-March 02:30.
    // This is not allowed to loop forever trying to construct three previews.
    expect(() =>
      nextScheduleOccurrences(
        {
          ...daily("America/New_York", 2, 30),
          weekdays: [0],
          monthDays: [8, 9, 10, 11, 12, 13, 14],
          months: [3],
        },
        "2026-01-01T00:00:00.000Z",
        1,
      ),
    ).toThrow(ScheduledFollowupRecurrenceError);
  });

  it.each([0, 4, Number.POSITIVE_INFINITY, 1.5])(
    "rejects unbounded or invalid preview size %s",
    (limit) => {
      expect(() => nextScheduleOccurrences(interval, interval.anchorAt, limit)).toThrow(
        ScheduledFollowupRecurrenceError,
      );
    },
  );

  it("never incorporates malformed date or timezone input into public error text", () => {
    const sensitive = "private-value-not-for-errors";
    for (const work of [
      () => nextScheduleOccurrences(daily(sensitive, 9), interval.anchorAt),
      () => nextScheduleOccurrences(interval, sensitive),
      () => nextScheduleOccurrences(interval, new Date(Number.NaN)),
    ]) {
      expect(work).toThrow(
        "The schedule has no supported occurrence. Check its dates, time and timezone.",
      );
    }
  });
});

describe("scheduled follow-up missed-occurrence coalescing", () => {
  it("coalesces a century of missed five-minute intervals into one latest due occurrence", () => {
    const recurrence = { ...interval, anchorAt: "2000-01-01T00:00:00.000Z" };
    expect(
      coalesceScheduledFollowupDue(recurrence, recurrence.anchorAt, "2100-01-01T00:02:00.000Z"),
    ).toEqual({
      dueAt: "2100-01-01T00:00:00.000Z",
      nextRunAt: "2100-01-01T00:05:00.000Z",
    });
  });

  it("keeps future work pending and never revives an exhausted cursor", () => {
    expect(
      coalesceScheduledFollowupDue(interval, interval.anchorAt, "2026-03-08T06:00:00.000Z"),
    ).toEqual({ dueAt: null, nextRunAt: interval.anchorAt });
    expect(coalesceScheduledFollowupDue(interval, null, "2026-03-08T06:00:00.000Z")).toEqual({
      dueAt: null,
      nextRunAt: null,
    });
  });

  it("dispatches an overdue once-only occurrence at most once", () => {
    const recurrence = { kind: "once", at: "2026-10-04T00:00:00.000Z", timeZone: "UTC" } as const;
    expect(
      coalesceScheduledFollowupDue(recurrence, recurrence.at, "2026-10-05T00:00:00.000Z"),
    ).toEqual({ dueAt: recurrence.at, nextRunAt: null });
  });

  it("coalesces calendars across spring gaps and chooses the first overlap occurrence", () => {
    expect(
      coalesceScheduledFollowupDue(
        daily("America/New_York", 2, 30),
        "2026-03-07T07:30:00.000Z",
        "2026-03-08T08:00:00.000Z",
      ),
    ).toEqual({
      dueAt: "2026-03-07T07:30:00.000Z",
      nextRunAt: "2026-03-09T06:30:00.000Z",
    });
    expect(
      coalesceScheduledFollowupDue(
        daily("America/New_York", 1, 30),
        "2026-10-31T05:30:00.000Z",
        "2026-11-01T06:40:00.000Z",
      ),
    ).toEqual({
      dueAt: "2026-11-01T05:30:00.000Z",
      nextRunAt: "2026-11-02T06:30:00.000Z",
    });
  });

  it("settles only the latest eligible run before an inclusive end time after an outage", () => {
    expect(
      coalesceScheduledFollowupDue(
        daily("UTC", 9),
        "2026-10-01T09:00:00.000Z",
        "2026-10-10T12:00:00.000Z",
        "2026-10-05T09:00:00.000Z",
      ),
    ).toEqual({ dueAt: "2026-10-05T09:00:00.000Z", nextRunAt: null });
  });
});
