import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderInstanceId,
  ScheduledFollowupId,
  ThreadId,
  type ScheduledFollowupRecord,
  type ScheduledFollowupRecurrence,
} from "@cafecode/contracts";
import {
  browserScheduleTimeZone,
  formatScheduleTime,
  parseScheduleNumbers,
  parseScheduleZonedInput,
  scheduleModelLabel,
  scheduleRecurrenceLabel,
  scheduleRunIssuePresentation,
  scheduleTimeZoneOptions,
  scheduleZonedInput,
} from "./schedulePresentation";

const NativeDateTimeFormat = Intl.DateTimeFormat;

/** Simulate the browser's default locale/zone through its own constructor.
 * Explicit selected zones remain authoritative and native Intl still formats
 * their dates. Never mutate process.env.TZ or other workers' process state. */
function mockLocalTimeZone(timeZone: string): void {
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (_locales, options) {
    return new NativeDateTimeFormat("en-US", {
      ...options,
      timeZone: options?.timeZone ?? timeZone,
    });
  });
}

function makeSchedule(recurrence: ScheduledFollowupRecurrence): ScheduledFollowupRecord {
  const now = "2026-10-04T09:30:00.000Z";
  return {
    id: ScheduledFollowupId.make("11111111-1111-4111-8111-111111111111"),
    threadId: ThreadId.make("schedule-presentation-fixture"),
    revision: 1,
    state: "active",
    name: "Synthetic schedule",
    prompt: "Check synthetic results.",
    recurrence,
    modelSelection: null,
    notificationPolicy: "changes-and-errors",
    endAt: null,
    maxRuns: null,
    allowAutoFinish: false,
    authorizedInstanceId: ProviderInstanceId.make("codex"),
    permissionCeiling: "approval-required",
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    runCount: 0,
    lastRun: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("schedule presentation", () => {
  it("explains provider unavailability using the saved pre-admission classification", () => {
    expect(
      scheduleRunIssuePresentation({ state: "failed", errorCode: "provider-unavailable" }),
    ).toEqual({
      reason:
        "The saved provider account or selected model was unavailable. This run was not submitted.",
      action:
        "Check the saved account and model in Settings, then review the schedule before enabling it again.",
    });
  });

  it.each([
    null,
    "constructor",
    "__proto__",
    "private_fixture_token",
    "provider-unavailable.private",
    '<img src="x" onerror="alert(1)">',
  ])("never echoes an unrecognized failure classification %s", (errorCode) => {
    const presentation = scheduleRunIssuePresentation({ state: "failed", errorCode });
    expect(presentation).toEqual({
      reason: "This run failed.",
      action: "Check this chat and run history, then review and enable the schedule when ready.",
    });
    expect(JSON.stringify(presentation)).not.toContain("not submitted");
    if (errorCode !== null) expect(JSON.stringify(presentation)).not.toContain(errorCode);
  });

  it("does not call uncertain acceptance an unsent or safely repeatable run", () => {
    for (const errorCode of [
      "acceptance-unknown",
      "provider-unavailable",
      "private_fixture_token",
      null,
    ]) {
      expect(scheduleRunIssuePresentation({ state: "unknown", errorCode })).toEqual({
        reason: "Cafe could not confirm whether the provider accepted this run.",
        action:
          "Wait for Cafe to reconcile this run. Check this chat for existing work; do not repeat an unconfirmed run.",
      });
    }
  });

  it.each(["waiting", "dispatching", "running", "completed"] as const)(
    "does not present a failure for a %s run even with an obsolete error code",
    (state) => {
      expect(scheduleRunIssuePresentation({ state, errorCode: "provider-unavailable" })).toBeNull();
    },
  );

  it.each(["interrupted", "skipped"] as const)(
    "does not grant an unsent guarantee to a mismatched %s provider-unavailable classification",
    (state) => {
      const presentation = scheduleRunIssuePresentation({
        state,
        errorCode: "provider-unavailable",
      });
      expect(presentation?.reason).toBe(
        state === "interrupted" ? "This run was interrupted." : "This run was skipped.",
      );
      expect(JSON.stringify(presentation)).not.toContain("not submitted");
    },
  );

  it("keeps cancelled, exhausted, busy and changed occurrences distinct from provider failure", () => {
    expect(scheduleRunIssuePresentation(null)).toBeNull();
    for (const errorCode of ["user-control", "admission-revoked"]) {
      expect(scheduleRunIssuePresentation({ state: "skipped", errorCode })?.reason).toBe(
        "This run was cancelled before starting.",
      );
    }
    expect(
      scheduleRunIssuePresentation({ state: "skipped", errorCode: "limit-reached" })?.reason,
    ).toBe("This run was skipped because the schedule reached its end or run limit.");
    expect(
      scheduleRunIssuePresentation({ state: "skipped", errorCode: "runtime-busy" })?.reason,
    ).toBe("This run was skipped because the chat was already working.");
    expect(
      scheduleRunIssuePresentation({ state: "skipped", errorCode: "schedule-changed" })?.reason,
    ).toBe("This run was skipped because the schedule changed before it started.");
    expect(
      scheduleRunIssuePresentation({ state: "failed", errorCode: "settings-changed" })?.reason,
    ).toBe("The chat's account or permission settings changed and need renewed review.");
  });

  it.each([
    ["UTC", "2026-10-04T09:30", "2026-10-04T09:30:00.000Z"],
    ["Asia/Tokyo", "2026-10-04T09:30", "2026-10-04T00:30:00.000Z"],
    ["Asia/Tokyo", "2026-10-04T00:15", "2026-10-03T15:15:00.000Z"],
    ["America/New_York", "2026-10-04T23:30", "2026-10-05T03:30:00.000Z"],
    ["America/New_York", "2026-01-04T09:30", "2026-01-04T14:30:00.000Z"],
    ["Asia/Kathmandu", "2026-10-04T09:30", "2026-10-04T03:45:00.000Z"],
    ["Pacific/Chatham", "2026-10-04T09:30", "2026-10-03T19:45:00.000Z"],
    ["Australia/Lord_Howe", "2026-10-04T02:30", "2026-10-03T15:30:00.000Z"],
  ])("round-trips selected-zone civil input for %s", (timeZone, civil, instant) => {
    // Choose a deliberately different default zone: parsing must never inherit
    // it merely because datetime-local fields lack an embedded UTC offset.
    mockLocalTimeZone("Europe/London");
    expect(parseScheduleZonedInput(civil, timeZone)).toBe(instant);
    expect(scheduleZonedInput(instant, timeZone)).toBe(civil);
  });

  it.each([
    "",
    "2026-02-30T09:30",
    "2026-02-29T09:30",
    "2026-13-04T09:30",
    "2026-00-04T09:30",
    "2026-10-00T09:30",
    "2026-10-04T25:30",
    "2026-10-04T24:00",
    "2026-10-04T09:60",
    "2026-10-04T09:30+09:00",
    "2026-10-04T09:30Z",
    "2026-10-04T09:30:00",
    "2026-10-04 09:30",
    " 2026-10-04T09:30",
    "2026-10-04T09:30\n",
  ])("rejects invalid or noncanonical civil input %j", (civil) => {
    expect(parseScheduleZonedInput(civil, "Asia/Tokyo")).toBeNull();
  });

  it("accepts a valid leap day without normalizing calendar fields", () => {
    expect(parseScheduleZonedInput("2028-02-29T09:30", "Asia/Tokyo")).toBe(
      "2028-02-29T00:30:00.000Z",
    );
  });

  it.each([
    ["America/New_York", "2026-03-08T02:30"],
    ["Australia/Lord_Howe", "2026-10-04T02:15"],
    ["Pacific/Apia", "2011-12-30T12:00"],
  ])("rejects a nonexistent civil time in %s", (timeZone, civil) => {
    expect(parseScheduleZonedInput(civil, timeZone)).toBeNull();
  });

  it.each([
    [
      "America/New_York",
      "2026-11-01T01:30",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ],
    [
      "Australia/Lord_Howe",
      "2026-04-05T01:45",
      "2026-04-04T14:45:00.000Z",
      "2026-04-04T15:15:00.000Z",
    ],
  ])("selects the first fold occurrence in %s", (timeZone, civil, first, second) => {
    expect(parseScheduleZonedInput(civil, timeZone)).toBe(first);
    expect(scheduleZonedInput(first, timeZone)).toBe(civil);
    expect(scheduleZonedInput(second, timeZone)).toBe(civil);
    // The helper cannot recover fold identity or subminute precision from a
    // datetime-local string. The editor must preserve an untouched saved instant.
    expect(scheduleZonedInput(first.replace("00.000Z", "37.125Z"), timeZone)).toBe(civil);
  });

  it.each(["invalid", "", "+09:00", "UTC\n", "UTC".repeat(40)])(
    "fails closed for an inadmissible selected timezone %j",
    (timeZone) => {
      expect(parseScheduleZonedInput("2026-10-04T09:30", timeZone)).toBeNull();
      expect(scheduleZonedInput("2026-10-04T09:30:00.000Z", timeZone)).toBe("");
      expect(scheduleTimeZoneOptions(timeZone)).not.toContain(timeZone);
    },
  );

  it("rejects invalid saved instants and civil years outside the contract range", () => {
    expect(scheduleZonedInput(null, "Asia/Tokyo")).toBe("");
    expect(scheduleZonedInput("invalid", "Asia/Tokyo")).toBe("");
    expect(scheduleZonedInput("2026-02-30T09:30:00.000Z", "Asia/Tokyo")).toBe("");
    expect(scheduleZonedInput("9999-12-31T23:30:00.000Z", "Asia/Tokyo")).toBe("");
    expect(parseScheduleZonedInput("9999-12-31T23:30", "America/New_York")).toBeNull();
  });

  it("offers the complete supported timezone catalog and exact valid aliases", () => {
    mockLocalTimeZone("Asia/Tokyo");
    const supported = Intl.supportedValuesOf("timeZone");
    const options = scheduleTimeZoneOptions("US/Eastern");
    expect(options).toEqual(expect.arrayContaining(supported));
    expect(options).toEqual(expect.arrayContaining(["UTC", "Asia/Tokyo", "US/Eastern"]));
    expect(options).toEqual([...new Set(options)].toSorted());
    expect(options.length).toBeGreaterThanOrEqual(supported.length);
    expect(scheduleTimeZoneOptions("Etc/UTC")).toContain("Etc/UTC");
  });

  it("binds an explicit viewer-local catalog alias without admitting invalid names", () => {
    expect(scheduleTimeZoneOptions("US/Eastern", "Etc/GMT-9")).toEqual(
      expect.arrayContaining(["UTC", "US/Eastern", "Etc/GMT-9"]),
    );
    expect(scheduleTimeZoneOptions("US/Eastern", "invalid")).not.toContain("invalid");
  });

  it.each(["absent", "throws"])(
    "retains explicit local and saved aliases when catalog enumeration %s",
    (failure) => {
      mockLocalTimeZone("Asia/Tokyo");
      if (failure === "absent") {
        // Native Intl methods are non-enumerable. Inherit them while omitting
        // only catalog support, preserving the actual formatting/validation.
        vi.stubGlobal("Intl", Object.assign(Object.create(Intl), { supportedValuesOf: undefined }));
      } else {
        vi.spyOn(Intl, "supportedValuesOf").mockImplementation(() => {
          throw new RangeError("Synthetic unavailable timezone catalog");
        });
      }
      expect(scheduleTimeZoneOptions("US/Eastern")).toEqual(["Asia/Tokyo", "US/Eastern", "UTC"]);
    },
  );

  it("uses the validated computer zone and falls back explicitly to UTC", () => {
    mockLocalTimeZone("Asia/Tokyo");
    expect(browserScheduleTimeZone()).toBe("Asia/Tokyo");
    vi.restoreAllMocks();
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      const formatter = new NativeDateTimeFormat(locales, options);
      if (options?.timeZone === undefined) {
        const resolved = formatter.resolvedOptions();
        vi.spyOn(formatter, "resolvedOptions").mockReturnValue({
          ...resolved,
          timeZone: "invalid",
        });
      }
      return formatter;
    });
    expect(browserScheduleTimeZone()).toBe("UTC");
  });

  it("does not throw when the browser cannot resolve any local timezone", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
      throw new Error("Synthetic unavailable Intl formatter");
    });
    expect(browserScheduleTimeZone()).toBe("UTC");
    expect(scheduleTimeZoneOptions("invalid")).toContain("UTC");
    expect(formatScheduleTime("2026-10-04T09:30:00.000Z")).toBe("Time unavailable");
  });

  it("strictly parses bounded structured calendar selections", () => {
    expect(parseScheduleNumbers("", 0, 6)).toBeUndefined();
    expect(parseScheduleNumbers("5, 1, 1", 0, 6)).toEqual([1, 5]);
    for (const input of ["-1", "7", "1,,2", "1;2", "1e0", "1.5", "1,2,3,4,5,6,0,1"]) {
      expect(() => parseScheduleNumbers(input, 0, 6)).toThrow();
    }
  });

  it("labels saved model options without inventing provider-observed settings", () => {
    expect(
      scheduleModelLabel({
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.1-sol",
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "fastMode", value: false },
        ],
      }),
    ).toBe("gpt-6.1-sol · Effort: medium · Fast: off");
  });

  it.each([
    ["Asia/Tokyo", "2026-10-04T16:15:00.000Z", "Oct 5, 2026, 1:15 AM"],
    ["America/New_York", "2026-10-04T02:15:00.000Z", "Oct 3, 2026, 10:15 PM"],
    ["America/New_York", "2026-11-01T05:30:00.000Z", "Nov 1, 2026, 1:30 AM"],
    ["America/New_York", "2026-11-01T06:30:00.000Z", "Nov 1, 2026, 1:30 AM"],
    ["Asia/Kathmandu", "2026-10-04T00:30:00.000Z", "Oct 4, 2026, 6:15 AM"],
    ["UTC", "2026-10-04T00:30:00.000Z", "Oct 4, 2026, 12:30 AM"],
  ])(
    "displays computer-local date/time and an explicit short zone for %s",
    (localZone, instant, expectedClock) => {
      mockLocalTimeZone(localZone);
      const label = new NativeDateTimeFormat("en-US", {
        timeZone: localZone,
        timeZoneName: "short",
      })
        .formatToParts(new Date(instant))
        .find((part) => part.type === "timeZoneName")!.value;
      expect(formatScheduleTime(instant)).toBe(`${expectedClock} ${label}`);
    },
  );

  it("distinguishes overlapping local display times by their actual offset labels", () => {
    mockLocalTimeZone("America/New_York");
    expect(formatScheduleTime("2026-11-01T05:30:00.000Z")).toBe("Nov 1, 2026, 1:30 AM EDT");
    expect(formatScheduleTime("2026-11-01T06:30:00.000Z")).toBe("Nov 1, 2026, 1:30 AM EST");
  });

  it("fails closed for corrupt or normalized saved dates", () => {
    expect(formatScheduleTime("invalid")).toBe("Time unavailable");
    expect(formatScheduleTime("2026-02-30T09:30:00.000Z")).toBe("Time unavailable");
  });

  it("keeps calendar summaries free of unqualified clocks in the schedule zone", () => {
    const calendar = { kind: "calendar", hour: 9, minute: 30, timeZone: "Asia/Tokyo" } as const;
    expect(scheduleRecurrenceLabel(makeSchedule(calendar))).toBe("Daily");
    expect(scheduleRecurrenceLabel(makeSchedule({ ...calendar, weekdays: [1, 2, 3, 4, 5] }))).toBe(
      "Weekdays",
    );
    expect(scheduleRecurrenceLabel(makeSchedule({ ...calendar, weekdays: [1, 4] }))).toBe(
      "Mon, Thu",
    );
    expect(scheduleRecurrenceLabel(makeSchedule({ ...calendar, monthDays: [4] }))).toBe(
      "Custom calendar",
    );
    expect(
      scheduleRecurrenceLabel(
        makeSchedule({
          kind: "interval",
          anchorAt: "2026-10-04T09:30:00.000Z",
          everyMinutes: 5,
          timeZone: "Asia/Tokyo",
        }),
      ),
    ).toBe("Every 5 minutes");
    expect(
      scheduleRecurrenceLabel(
        makeSchedule({ kind: "once", at: "2026-10-04T09:30:00.000Z", timeZone: "Asia/Tokyo" }),
      ),
    ).toBe("One-time follow-up");
  });
});
