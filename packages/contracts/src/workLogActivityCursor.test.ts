import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  OrchestrationThreadActivityCursor,
  OrchestrationThreadTurnActivityPage,
  OrchestrationThreadTurnActivityPageInput,
  OrchestrationThreadTurnWorkLogPresenceInput,
  THREAD_DETAIL_ACTIVITY_WINDOW_LIMIT,
  THREAD_TURN_ACTIVITY_PAGE_MAX_LIMIT,
} from "./orchestration.ts";

const before = {
  sequence: 501,
  createdAt: "2026-10-11T00:00:00.000Z",
  activityId: "activity-boundary",
};
const request = { threadId: "thread", turnId: "turn", offset: 0, limit: 50 };
const decodePageInput = Schema.decodeUnknownSync(OrchestrationThreadTurnActivityPageInput);
const decodePage = Schema.decodeUnknownSync(OrchestrationThreadTurnActivityPage);
const decodeCursor = Schema.decodeUnknownSync(OrchestrationThreadActivityCursor);
const decodePresence = Schema.decodeUnknownSync(OrchestrationThreadTurnWorkLogPresenceInput);

describe("bounded earlier work-log contracts", () => {
  it("restricts start-receipt exclusions to cursor reads and preserves the explicit echo", () => {
    for (const excludeTurnStartAck of [true, false]) {
      const input = decodePageInput({ ...request, before, excludeTurnStartAck });
      expect(decodePage({ ...input, totalCount: 0, activities: [] }).excludeTurnStartAck).toBe(
        excludeTurnStartAck,
      );
      expect(
        decodePresence({ threadId: "thread", turnIds: ["turn"], before, excludeTurnStartAck })
          .excludeTurnStartAck,
      ).toBe(excludeTurnStartAck);
      expect(() => decodePageInput({ ...request, excludeTurnStartAck })).toThrow();
      expect(() =>
        decodePresence({ threadId: "thread", turnIds: ["turn"], excludeTurnStartAck }),
      ).toThrow();
    }
    expect(() => decodePageInput({ ...request, before, excludeTurnStartAck: "true" })).toThrow();
  });

  it("preserves offset readers and admits an echoed exclusive ordering cursor", () => {
    expect(decodePageInput(request)).toEqual(request);
    const input = decodePageInput({
      ...request,
      before,
    });
    expect(input.before).toEqual(before);
    expect(
      decodePage({
        ...input,
        totalCount: 500,
        activities: [],
      }).before,
    ).toEqual(before);
    expect(THREAD_DETAIL_ACTIVITY_WINDOW_LIMIT).toBe(500);
  });

  it("allows null legacy sequence and rejects offset arithmetic in keyset mode", () => {
    expect(decodeCursor({ ...before, sequence: null })).toEqual({ ...before, sequence: null });
    expect(() =>
      decodePageInput({
        ...request,
        before,
        offset: 1,
      }),
    ).toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe cursor sequence %s",
    (sequence) => {
      expect(() => decodeCursor({ ...before, sequence })).toThrow();
    },
  );

  it.each([
    { createdAt: "" },
    { createdAt: "x".repeat(129) },
    { createdAt: "2026-10-11\u0000" },
    { activityId: "" },
    { activityId: "x".repeat(4_097) },
    { activityId: "activity\u202Eother" },
    { sequence: undefined },
  ])("rejects malformed bounded tuple %j", (malformed) => {
    expect(() => decodeCursor({ ...before, ...malformed })).toThrow();
  });

  it("keeps presence batches unbounded by a cursor and cursor presence singleton-only", () => {
    expect(decodePresence({ threadId: "thread", turnIds: ["turn", "older"] }).turnIds).toHaveLength(
      2,
    );
    expect(decodePresence({ threadId: "thread", turnIds: ["turn"], before }).before).toEqual(
      before,
    );
    expect(() =>
      decodePresence({ threadId: "thread", turnIds: ["turn", "older"], before }),
    ).toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed remaining count %s",
    (totalCount) => {
      expect(() =>
        decodePage({
          ...request,
          before,
          totalCount,
          activities: [],
        }),
      ).toThrow();
    },
  );

  it("retains the existing page cap in either mode", () => {
    for (const bound of [undefined, before]) {
      expect(() =>
        decodePageInput({
          ...request,
          ...(bound === undefined ? {} : { before: bound }),
          limit: THREAD_TURN_ACTIVITY_PAGE_MAX_LIMIT + 1,
        }),
      ).toThrow();
    }
  });

  it("bounds retained-inline exclusions to exact cursor reads and echoes them on pages", () => {
    const excludeActivityIds = ["retained-settings", "retained-live-work"];
    const input = decodePageInput({ ...request, before, excludeActivityIds });
    expect(input.excludeActivityIds).toEqual(excludeActivityIds);
    expect(decodePage({ ...input, totalCount: 0, activities: [] }).excludeActivityIds).toEqual(
      excludeActivityIds,
    );
    expect(
      decodePresence({ threadId: "thread", turnIds: ["turn"], before, excludeActivityIds })
        .excludeActivityIds,
    ).toEqual(excludeActivityIds);
    for (const invalidIds of [
      [""],
      ["bad\u0000id"],
      Array(THREAD_TURN_ACTIVITY_PAGE_MAX_LIMIT + 1).fill("id"),
    ]) {
      expect(() =>
        decodePageInput({ ...request, before, excludeActivityIds: invalidIds }),
      ).toThrow();
      expect(() =>
        decodePresence({
          threadId: "thread",
          turnIds: ["turn"],
          before,
          excludeActivityIds: invalidIds,
        }),
      ).toThrow();
    }
    expect(() => decodePageInput({ ...request, excludeActivityIds })).toThrow();
    expect(() =>
      decodePresence({ threadId: "thread", turnIds: ["turn"], excludeActivityIds }),
    ).toThrow();
  });

  it("bounds operation exclusions to exact earlier-turn reads and echoes their complete identity", () => {
    const excludeOperations = [
      { kind: "tool", id: "native-tool" },
      { kind: "summary", id: "native-tool" },
    ];
    const input = decodePageInput({ ...request, before, excludeOperations });
    expect(decodePage({ ...input, totalCount: 0, activities: [] }).excludeOperations).toEqual(
      excludeOperations,
    );
    expect(
      decodePresence({ threadId: "thread", turnIds: ["turn"], before, excludeOperations })
        .excludeOperations,
    ).toEqual(excludeOperations);
    for (const invalid of [
      [{ kind: "unknown", id: "native-tool" }],
      [{ kind: "tool", id: "" }],
      [{ kind: "tool", id: "bad\u0000id" }],
      [{ kind: "tool", id: "x".repeat(4_097) }],
      Array(THREAD_TURN_ACTIVITY_PAGE_MAX_LIMIT + 1).fill({ kind: "tool", id: "native-tool" }),
    ]) {
      expect(() => decodePageInput({ ...request, before, excludeOperations: invalid })).toThrow();
      expect(() =>
        decodePresence({
          threadId: "thread",
          turnIds: ["turn"],
          before,
          excludeOperations: invalid,
        }),
      ).toThrow();
    }
    expect(() => decodePageInput({ ...request, excludeOperations })).toThrow();
    expect(() =>
      decodePresence({ threadId: "thread", turnIds: ["turn"], excludeOperations }),
    ).toThrow();
    expect(() =>
      decodePresence({ threadId: "thread", turnIds: ["turn", "other"], before, excludeOperations }),
    ).toThrow();
  });
});
