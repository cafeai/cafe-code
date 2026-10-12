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
});
