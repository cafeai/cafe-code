import {
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadActivityCursor,
  type OrchestrationThreadTurnActivityPage,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { deriveWorkLogEntries } from "../../session-logic";
import {
  activityCursor,
  cursorKey,
  deriveEarlierWorkLogEntries,
  EARLIER_WORK_LOG_RETAINED_LIMIT,
  mergeEarlierWorkLogPages,
  validateEarlierWorkLogPage,
} from "./EarlierWorkLog.logic";

const threadId = ThreadId.make("earlier-thread");
const turnId = TurnId.make("earlier-current-turn");
const timestamp = (second: number) => new Date(Date.UTC(2026, 9, 11, 0, 0, second)).toISOString();
const activity = (
  id: string,
  sequence: number | null,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  turnId,
  ...(sequence === null ? {} : { sequence }),
  createdAt: timestamp(sequence ?? 0),
  kind: "tool.completed",
  tone: "tool",
  summary: "Synthetic saved work",
  payload: {},
  ...overrides,
});
const before: OrchestrationThreadActivityCursor = {
  sequence: 10,
  createdAt: timestamp(10),
  activityId: EventId.make("bound"),
};
const validPage = (
  activities = [activity("earlier-1", 1), activity("earlier-2", 2)],
): OrchestrationThreadTurnActivityPage => ({
  threadId,
  turnId,
  offset: 0,
  limit: 4,
  totalCount: activities.length,
  activities,
  before,
});
const validate = (page: OrchestrationThreadTurnActivityPage, limit = 4) =>
  validateEarlierWorkLogPage({ page, threadId, turnId, before, limit });
// Deliberately model malformed received JSON so runtime validation, not the
// compile-time fixture type, must reject it before any display is derived.
const malformedPage = (changes: Record<string, unknown>): OrchestrationThreadTurnActivityPage =>
  ({ ...validPage(), ...changes }) as OrchestrationThreadTurnActivityPage;

describe("Earlier work page validation", () => {
  it("requires the captured start-receipt filter echo and refuses a filtered receipt", () => {
    const input = { threadId, turnId, before, limit: 4, excludeTurnStartAck: true };
    expect(() =>
      validateEarlierWorkLogPage({ ...input, page: { ...validPage(), excludeTurnStartAck: true } }),
    ).not.toThrow();
    expect(() => validateEarlierWorkLogPage({ ...input, page: validPage() })).toThrow();
    expect(() =>
      validateEarlierWorkLogPage({
        ...input,
        page: { ...validPage(), excludeTurnStartAck: false },
      }),
    ).toThrow();
    const ack = activity("hidden-start-ack", 1, {
      kind: "task.progress",
      payload: { taskId: `codex-turn-start:${turnId}` },
    });
    expect(() =>
      validateEarlierWorkLogPage({
        ...input,
        page: { ...validPage([ack]), excludeTurnStartAck: true },
      }),
    ).toThrow();
  });

  it("requires the captured exclusions to be echoed and refuses excluded rows", () => {
    const excludeActivityIds = [EventId.make("retained-settings")];
    const input = { threadId, turnId, before, limit: 4, excludeActivityIds };
    expect(() =>
      validateEarlierWorkLogPage({ ...input, page: { ...validPage(), excludeActivityIds } }),
    ).not.toThrow();
    expect(() => validateEarlierWorkLogPage({ ...input, page: validPage() })).toThrow();
    expect(() =>
      validateEarlierWorkLogPage({
        ...input,
        page: { ...validPage(), excludeActivityIds: [EventId.make("foreign-settings")] },
      }),
    ).toThrow();
    expect(() =>
      validateEarlierWorkLogPage({
        ...input,
        page: { ...validPage([activity("retained-settings", 1)]), excludeActivityIds },
      }),
    ).toThrow();
  });

  it("admits only exact-scoped echoed chronological pages, including a genuinely empty range", () => {
    expect(() => validate(validPage())).not.toThrow();
    expect(() => validate(validPage([]))).not.toThrow();
    expect(cursorKey(before)).toBe(JSON.stringify([10, timestamp(10), "bound"]));
  });

  it.each([
    { threadId: "other-thread" },
    { turnId: "other-turn" },
    { offset: 1 },
    { limit: 5 },
    { before: undefined },
    { before: { ...before, sequence: 11 } },
    { before: { ...before, createdAt: timestamp(11) } },
    { before: { ...before, activityId: "other-bound" } },
    { before: { ...before, sequence: null } },
    { activities: "not-an-array" },
    { activities: null },
    { activities: undefined },
  ])("rejects wrong scope or ignored/changed cursor %j", (changes) => {
    expect(() => validate(malformedPage(changes))).toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects nonfinite or unsafe remaining count %s",
    (totalCount) => {
      expect(() => validate(malformedPage({ totalCount }))).toThrow();
    },
  );

  it("refuses contradictory counts, empty positive pages and more rows than requested", () => {
    expect(() => validate(malformedPage({ totalCount: 1 }))).toThrow();
    expect(() => validate(malformedPage({ totalCount: 1, activities: [] }))).toThrow();
    expect(() =>
      validate(
        validPage(Array.from({ length: 5 }, (_, index) => activity("work-" + index, index + 1))),
      ),
    ).toThrow();
    expect(() => validate(malformedPage({ limit: Number.NaN }), Number.NaN)).toThrow();
  });

  it.each([
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: Number.POSITIVE_INFINITY },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { createdAt: "x".repeat(129) },
    { createdAt: "timestamp\u0000" },
    { id: "x".repeat(4_097) },
    { id: "id\u202Eother" },
    { turnId: "other-turn" },
    { turnId: null },
    { id: undefined },
  ])("rejects malformed or foreign activity ordering %j", (changes) => {
    const row = { ...activity("earlier-1", 1), ...changes } as OrchestrationThreadActivity;
    expect(() => validate(validPage([row]))).toThrow();
  });

  it("refuses duplicate identities, reverse order and entries on or after the exclusive boundary", () => {
    expect(() =>
      validate(validPage([activity("duplicate", 1), activity("duplicate", 2)])),
    ).toThrow();
    expect(() => validate(validPage([activity("second", 2), activity("first", 1)]))).toThrow();
    expect(() => validate(validPage([activity("bound", 10)]))).toThrow();
    expect(() => validate(validPage([activity("later", 11)]))).toThrow();
  });

  it("validates null legacy and mixed-case Unicode ties using binary rather than locale order", () => {
    const legacy = ["A", "a", "\uE000", "\u{10000}"].map((id) => activity(id, null));
    expect(() => validate(validPage(legacy))).not.toThrow();
    expect(() => validate(validPage([legacy[1]!, legacy[0]!]))).toThrow();
    expect(() => validate(validPage([legacy[3]!, legacy[2]!]))).toThrow();
  });

  it("keeps a legacy null boundary exclusive without admitting any modern sequence", () => {
    const legacyBefore: OrchestrationThreadActivityCursor = {
      sequence: null,
      createdAt: timestamp(0),
      activityId: EventId.make("m"),
    };
    const validateLegacy = (activities: OrchestrationThreadActivity[]) =>
      validateEarlierWorkLogPage({
        page: { ...validPage(activities), before: legacyBefore },
        threadId,
        turnId,
        before: legacyBefore,
        limit: 4,
      });
    expect(() => validateLegacy([activity("A", null), activity("a", null)])).not.toThrow();
    expect(() => validateLegacy([activity("m", null)])).toThrow();
    expect(() => validateLegacy([activity("\uE000", null)])).toThrow();
    expect(() => validateLegacy([activity("modern-zero", 0)])).toThrow();
  });

  it("admits a zero-sequence range and exact maximum safe counters without inventing an offset", () => {
    const zeroBefore: OrchestrationThreadActivityCursor = {
      sequence: 0,
      createdAt: timestamp(0),
      activityId: EventId.make("zero-bound"),
    };
    expect(() =>
      validateEarlierWorkLogPage({
        page: { ...validPage([activity("legacy", null)]), before: zeroBefore },
        threadId,
        turnId,
        before: zeroBefore,
        limit: 4,
      }),
    ).not.toThrow();
    const maximumBefore = { ...before, sequence: Number.MAX_SAFE_INTEGER };
    const lastSafeActivity = {
      ...activity("last-safe", 1),
      sequence: Number.MAX_SAFE_INTEGER - 1,
    };
    expect(() =>
      validateEarlierWorkLogPage({
        page: {
          ...validPage([lastSafeActivity]),
          totalCount: Number.MAX_SAFE_INTEGER,
          before: maximumBefore,
        },
        threadId,
        turnId,
        before: maximumBefore,
        limit: 4,
      }),
    ).not.toThrow();
  });
});

describe("bounded Earlier work page merging", () => {
  it("merges progressive older pages chronologically with current received rows winning duplicate ids", () => {
    const older = [
      activity("work-1", 1),
      activity("shared", 2, { summary: "Saved older version" }),
    ];
    const current = [
      activity("shared", 2, { summary: "Current authoritative version" }),
      activity("work-3", 3),
    ];
    const olderBefore = JSON.stringify(older);
    const currentBefore = JSON.stringify(current);
    const merged = mergeEarlierWorkLogPages(older, current);
    expect(merged.map((row) => row.id)).toEqual(["work-1", "shared", "work-3"]);
    expect(merged[1]).toBe(current[0]);
    expect(merged[1]?.summary).toBe("Current authoritative version");
    expect(mergeEarlierWorkLogPages([activity("work-0", 0)], merged).map((row) => row.id)).toEqual([
      "work-0",
      "work-1",
      "shared",
      "work-3",
    ]);
    expect(JSON.stringify(older)).toBe(olderBefore);
    expect(JSON.stringify(current)).toBe(currentBefore);
  });

  it("enforces the existing 1000-row reader ceiling even for overlapping oversized inputs", () => {
    const rows = Array.from({ length: 1_301 }, (_, index) =>
      activity("work-" + index.toString().padStart(4, "0"), index),
    );
    const merged = mergeEarlierWorkLogPages(rows.slice(0, 800), rows.slice(700));
    expect(EARLIER_WORK_LOG_RETAINED_LIMIT).toBe(1_000);
    expect(merged).toHaveLength(1_000);
    expect(new Set(merged.map((row) => row.id)).size).toBe(1_000);
    expect(merged[0]?.sequence).toBe(0);
    expect(merged.at(-1)?.sequence).toBe(999);
  });

  it("moves an authoritative duplicate forward while keeping every unrelated older row", () => {
    const older = [activity("oldest", 1), activity("moving-summary", 2)];
    const moving = activity("moving-summary", 7, { summary: "Newest received projection" });
    const merged = mergeEarlierWorkLogPages(older, [activity("middle", 4), moving]);
    expect(merged.map((row) => row.id)).toEqual(["oldest", "middle", "moving-summary"]);
    expect(merged.at(-1)).toBe(moving);
    expect(merged.at(-1)?.sequence).toBe(7);
  });

  it("retains the same null/Unicode tie order used by page validation and renderer retention", () => {
    const merged = mergeEarlierWorkLogPages(
      [activity("\u{10000}", null), activity("a", null)],
      [activity("\uE000", null), activity("A", null)],
    );
    expect(merged.map((row) => row.id)).toEqual(["A", "a", "\uE000", "\u{10000}"]);
    expect(merged.map(activityCursor).map((row) => row.sequence)).toEqual([null, null, null, null]);
  });
});

const claudeCommand = (
  id: string,
  sequence: number,
  kind: "tool.started" | "tool.completed",
  itemId = "bash-item",
): OrchestrationThreadActivity =>
  activity(id, sequence, {
    kind,
    payload: {
      itemId,
      itemType: "command_execution",
      status: kind === "tool.started" ? "inProgress" : "completed",
      data: {
        toolName: "Bash",
        commandInspectionVersion: 1,
        inspectionProvider: "claudeAgent",
        ...(kind === "tool.started"
          ? { input: { description: "Run isolated tests", command: "yarn test" } }
          : { output: "Received test output" }),
      },
    },
  });
const publicSummary = (
  id: string,
  sequence: number,
  itemId: string,
  status: "inProgress" | "completed" = "inProgress",
): OrchestrationThreadActivity =>
  activity(id, sequence, {
    kind: "reasoning.summary",
    tone: "info",
    payload: {
      summaryVersion: 1,
      provider: "claudeAgent",
      streamKind: "reasoning_summary_text",
      itemId,
      detail: "Received public summary",
      status,
      truncated: false,
    },
  });

describe("Earlier work lifecycle folding", () => {
  it("omits a paged Claude command start when the same operation completion is already inline", () => {
    const start = claudeCommand("paged-start", 1, "tool.started");
    const completed = claudeCommand("inline-completed", 4, "tool.completed");
    const unrelated = activity("older-unrelated", 2);
    const result = deriveEarlierWorkLogEntries({
      activities: [start, unrelated],
      liveActivities: [completed],
      turnId,
    });
    expect(result.map((entry) => entry.id)).toEqual(["older-unrelated"]);
    expect(deriveWorkLogEntries([completed], turnId)[0]?.commandInspection).toMatchObject({
      status: "completed",
      completedAt: completed.createdAt,
    });
  });

  it("deduplicates received summary snapshots but does not conflate tool and summary identities", () => {
    const oldSummary = publicSummary("summary-old", 1, "same-item");
    const currentSummary = publicSummary("summary-current", 5, "same-item", "completed");
    expect(
      deriveEarlierWorkLogEntries({
        activities: [oldSummary],
        liveActivities: [currentSummary],
        turnId,
      }),
    ).toEqual([]);
    const start = claudeCommand("command-start", 2, "tool.started", "same-item");
    const result = deriveEarlierWorkLogEntries({
      activities: [start],
      liveActivities: [currentSummary],
      turnId,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(start.id);
    expect(result[0]?.commandInspection?.status).toBe("inProgress");
  });

  it("uses current raw rows for the same activity id and ignores other turns with reused native ids", () => {
    const earlier = publicSummary("same-activity", 1, "summary-item");
    const current = publicSummary("same-activity", 5, "summary-item", "completed");
    expect(
      deriveEarlierWorkLogEntries({
        activities: [earlier],
        liveActivities: [current],
        turnId,
      }),
    ).toEqual([]);
    const foreign = claudeCommand("foreign-completed", 5, "tool.completed");
    const result = deriveEarlierWorkLogEntries({
      activities: [claudeCommand("owned-start", 1, "tool.started")],
      liveActivities: [{ ...foreign, turnId: TurnId.make("other-turn") }],
      turnId,
    });
    expect(result[0]?.id).toBe("owned-start");
    expect(result[0]?.commandInspection?.status).toBe("inProgress");
  });

  it("never turns historical starts into terminal/liveness truth or mutates received data", () => {
    const start = claudeCommand("saved-in-progress", 1, "tool.started");
    const summary = publicSummary("saved-summary", 2, "summary-item");
    const subagent = activity("saved-child", 3, {
      kind: "task.started",
      tone: "info",
      payload: {
        subagent: {
          threadId: "child",
          label: "Saved child",
          status: "active",
          startedAt: timestamp(3),
        },
      },
    });
    const input = Object.freeze([
      Object.freeze(start),
      Object.freeze(summary),
      Object.freeze(subagent),
    ]);
    const previous = JSON.stringify(input);
    const result = deriveEarlierWorkLogEntries({ activities: input, liveActivities: [], turnId });
    expect(result.map((entry) => entry.id)).toEqual([start.id, summary.id]);
    expect(result[0]?.commandInspection?.status).toBe("inProgress");
    expect(result[0]?.commandInspection?.completedAt).toBeUndefined();
    expect(result[1]?.publicSummary?.status).toBe("inProgress");
    expect(result.every((entry) => entry.subagent === undefined)).toBe(true);
    expect(JSON.stringify(input)).toBe(previous);
  });
});
