import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  ScheduledFollowupDraft,
  ScheduledFollowupHistoryInput,
  ScheduledFollowupModelSelection,
  ScheduledFollowupRecurrence,
  ScheduledFollowupSaveInput,
  ScheduledFollowupSetStatusInput,
  ScheduledFollowupTimestamp,
  ScheduledFollowupTimeZone,
} from "./scheduledFollowups.ts";

const id = "12345678-1234-4123-8123-123456789abc";
const at = "2026-10-05T03:00:00.000Z";
const draft = {
  name: "Watch CI",
  prompt: "  Check the latest run.\nDo not retry anything.  ",
  recurrence: { kind: "interval", anchorAt: at, everyMinutes: 5, timeZone: "Asia/Tokyo" },
  modelSelection: null,
  notificationPolicy: "changes-and-errors",
  endAt: null,
  maxRuns: null,
  allowAutoFinish: false,
} as const;

describe("scheduled follow-up contracts", () => {
  it("retains exact prompt content and explicit inherited settings", () => {
    const decoded = Schema.decodeUnknownSync(ScheduledFollowupDraft)(draft);
    expect(decoded.prompt).toBe(draft.prompt);
    expect(decoded.modelSelection).toBeNull();
    expect(Schema.encodeSync(ScheduledFollowupDraft)(decoded)).toEqual(draft);
  });

  it.each([
    { kind: "once", at, timeZone: "UTC" },
    draft.recurrence,
    { kind: "calendar", hour: 9, minute: 15, weekdays: [1, 2, 3, 4, 5], timeZone: "Asia/Tokyo" },
    {
      kind: "calendar",
      hour: 0,
      minute: 0,
      monthDays: [1, 31],
      months: [1, 12],
      timeZone: "America/New_York",
    },
  ])("round-trips bounded explicit recurrence %j", (recurrence) => {
    const decode = Schema.decodeUnknownSync(ScheduledFollowupRecurrence);
    expect(Schema.encodeSync(ScheduledFollowupRecurrence)(decode(recurrence))).toEqual(recurrence);
  });

  it.each([
    { ...draft.recurrence, everyMinutes: 4 },
    { ...draft.recurrence, everyMinutes: 5.5 },
    { ...draft.recurrence, everyMinutes: 525_601 },
    { ...draft.recurrence, cron: "* * * * *" },
    { kind: "calendar", hour: 24, minute: 0, timeZone: "UTC" },
    { kind: "calendar", hour: 9, minute: 60, timeZone: "UTC" },
    { kind: "calendar", hour: 9, minute: 0, weekdays: [], timeZone: "UTC" },
    { kind: "calendar", hour: 9, minute: 0, weekdays: [1, 1], timeZone: "UTC" },
    { kind: "calendar", hour: 9, minute: 0, weekdays: [7], timeZone: "UTC" },
    { kind: "calendar", hour: 9, minute: 0, monthDays: [0], timeZone: "UTC" },
    { kind: "calendar", hour: 9, minute: 0, months: [13], timeZone: "UTC" },
    { kind: "once", at },
  ])("rejects ambiguous, too-frequent or malformed recurrence %j", (value) => {
    expect(() => Schema.decodeUnknownSync(ScheduledFollowupRecurrence)(value)).toThrow();
  });

  it.each([
    "2026-02-30T00:00:00.000Z",
    "2026-10-05T03:00:00Z",
    "2026-10-05T12:00:00+09:00",
    "not-a-date",
    "2026-10-05",
  ])("rejects noncanonical or invalid instant %s", (value) => {
    expect(() => Schema.decodeUnknownSync(ScheduledFollowupTimestamp)(value)).toThrow();
  });

  it.each(["UTC", "Asia/Tokyo", "America/New_York", "Australia/Lord_Howe"])(
    "accepts named timezone %s",
    (value) => {
      expect(Schema.decodeUnknownSync(ScheduledFollowupTimeZone)(value)).toBe(value);
    },
  );
  it.each(["", "+09:00", "Not/A_Real_Zone", " UTC", "UTC\n"])(
    "rejects invalid timezone %j",
    (value) => {
      expect(() => Schema.decodeUnknownSync(ScheduledFollowupTimeZone)(value)).toThrow();
    },
  );

  it("requires revision identity together and keeps server-owned fields out of create/update input", () => {
    const decode = Schema.decodeUnknownSync(ScheduledFollowupSaveInput);
    expect(decode({ threadId: "thread-1", ...draft })).toMatchObject(draft);
    expect(decode({ threadId: "thread-1", id, expectedRevision: 1, ...draft })).toMatchObject({
      id,
      expectedRevision: 1,
    });
    for (const extra of [
      { id },
      { expectedRevision: 1 },
      { id, expectedRevision: 0 },
      { state: "active" },
      { authorizedInstanceId: "other-account" },
      { permissionCeiling: "full-access" },
    ]) {
      expect(() => decode({ threadId: "thread-1", ...draft, ...extra })).toThrow();
    }
  });

  it("bounds prompts, names, counts and explicit provider option overrides", () => {
    const decode = Schema.decodeUnknownSync(ScheduledFollowupDraft);
    for (const extra of [
      { name: "a".repeat(121) },
      { prompt: "p".repeat(16_001) },
      { prompt: " \n " },
      { maxRuns: 0 },
      { maxRuns: 10_001 },
    ]) {
      expect(() => decode({ ...draft, ...extra })).toThrow();
    }
    const decodeModel = Schema.decodeUnknownSync(ScheduledFollowupModelSelection);
    expect(
      decodeModel({
        instanceId: "codex",
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      }),
    ).toMatchObject({ model: "gpt-6.1-sol" });
    for (const value of [
      { instanceId: "codex", model: "x".repeat(201) },
      {
        instanceId: "codex",
        model: "test",
        options: [
          { id: "fast", value: true },
          { id: "fast", value: false },
        ],
      },
      {
        instanceId: "codex",
        model: "test",
        options: Array.from({ length: 33 }, (_, index) => ({ id: `option-${index}`, value: true })),
      },
      { instanceId: "codex", model: "test", runtimeMode: "full-access" },
    ])
      expect(() => decodeModel(value)).toThrow();
  });

  it("requires optimistic revision for mutations and bounds history reads", () => {
    expect(() =>
      Schema.decodeUnknownSync(ScheduledFollowupSetStatusInput)({
        threadId: "thread-1",
        id,
        state: "active",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ScheduledFollowupSetStatusInput)({
        threadId: "thread-1",
        id,
        expectedRevision: 1,
        state: "completed",
      }),
    ).toThrow();
    const decodeHistory = Schema.decodeUnknownSync(ScheduledFollowupHistoryInput);
    expect(decodeHistory({ threadId: "thread-1", id, limit: 50 })).toMatchObject({ limit: 50 });
    for (const extra of [{ limit: 0 }, { limit: 51 }, { before: "x".repeat(513) }]) {
      expect(() => decodeHistory({ threadId: "thread-1", id, ...extra })).toThrow();
    }
  });
});
