import { Buffer } from "node:buffer";
import {
  EventId,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadActivityCursor,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  activityCursor,
  compareActivityCursors,
  compareActivityWindowOrder,
} from "./activityOrder";

const timestamp = "2026-10-11T00:00:00.000Z";
const cursor = (
  activityId: string,
  sequence: number | null = 1,
  createdAt = timestamp,
): OrchestrationThreadActivityCursor => ({
  sequence,
  createdAt,
  activityId: EventId.make(activityId),
});
const activity = (id: string, sequence: number | undefined): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  turnId: TurnId.make("current-turn"),
  ...(sequence === undefined ? {} : { sequence }),
  createdAt: timestamp,
  kind: "tool.completed",
  tone: "tool",
  summary: "Synthetic work",
  payload: {},
});

describe("shared SQLite activity order", () => {
  it("captures exact received ordering without inventing legacy or zero sequences", () => {
    const legacy = activity("legacy", undefined);
    expect(activityCursor(legacy)).toEqual(cursor("legacy", null));
    expect(activityCursor(activity("zero", 0))).toEqual(cursor("zero", 0));
    expect(activityCursor(activity("modern", 7))).toEqual(cursor("modern", 7));
    expect(legacy.sequence).toBeUndefined();
  });

  it("keeps legacy nulls before modern sequences regardless of timestamps or identifiers", () => {
    const rows = [
      cursor("modern-two", 2, "1999"),
      cursor("legacy-z", null, "2099"),
      cursor("modern-zero", 0, "1998"),
      cursor("legacy-a", null, "1998"),
    ];
    expect(rows.toSorted(compareActivityCursors).map((row) => row.activityId)).toEqual([
      "legacy-a",
      "legacy-z",
      "modern-zero",
      "modern-two",
    ]);
    expect(compareActivityCursors(cursor("legacy-z", null), cursor("modern-zero", 0))).toBeLessThan(
      0,
    );
    expect(
      compareActivityCursors(cursor("modern-zero", 0), cursor("legacy-z", null)),
    ).toBeGreaterThan(0);
  });

  it("uses sequence first, then the exact timestamp and finally binary identifier order", () => {
    expect(compareActivityCursors(cursor("z", 2, "1999"), cursor("a", 1, "2099"))).toBeGreaterThan(
      0,
    );
    expect(compareActivityCursors(cursor("z", 1, "1999"), cursor("a", 1, "2099"))).toBeLessThan(0);
    expect(compareActivityCursors(cursor("A"), cursor("a"))).toBeLessThan(0);
    expect(compareActivityCursors(cursor("a"), cursor("aa"))).toBeLessThan(0);
    expect(compareActivityCursors(cursor("same"), cursor("same"))).toBe(0);
  });

  it.each([null, 1])(
    "matches UTF-8 SQLite BINARY ties for mixed case and Unicode at sequence %s",
    (sequence) => {
      // UTF-8 byte comparison is an independent oracle for SQLite's default
      // text collation. U+E000 must precede U+10000, contrary to a UTF-16
      // surrogate comparison; localeCompare also orders case/accent ties
      // differently and must never decide a cursor boundary.
      const ids = ["z", "Z", "a", "A", "aa", "á", "a\u0301", "\uE000", "\u{10000}", "😀"];
      const expected = ids.toSorted((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      );
      const actual = ids
        .map((id) => cursor(id, sequence))
        .toSorted(compareActivityCursors)
        .map((row) => row.activityId);
      expect(actual).toEqual(expected);
      for (const left of ids)
        for (const right of ids) {
          expect(
            Math.sign(compareActivityCursors(cursor(left, sequence), cursor(right, sequence))),
          ).toBe(Math.sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))));
        }
    },
  );

  it("uses the same tuple order for renderer retention and received-page cursors", () => {
    const rows = [
      activity("z", 3),
      activity("a", undefined),
      activity("A", undefined),
      activity("modern", 0),
      activity("\u{10000}", 3),
      activity("\uE000", 3),
    ];
    const windowIds = rows.toSorted(compareActivityWindowOrder).map((row) => row.id);
    const pageIds = rows
      .map(activityCursor)
      .toSorted(compareActivityCursors)
      .map((row) => row.activityId);
    expect(windowIds).toEqual(pageIds);
    expect(windowIds).toEqual(["A", "a", "modern", "z", "\uE000", "\u{10000}"]);
  });
});
