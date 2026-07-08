import { describe, expect, it } from "vitest";

import { selectOutputCounter, tokenDelta } from "./tokenDelta.ts";

function accumulate(values: ReadonlyArray<number>, countFirstObservation: boolean): number {
  let watermark: number | undefined;
  let total = 0;
  for (const value of values) {
    const result = tokenDelta(watermark, value, countFirstObservation);
    total += result.delta;
    watermark = result.watermark;
  }
  return total;
}

describe("tokenDelta", () => {
  it("accumulates a growing per-message counter exactly", () => {
    // Claude message_delta snapshots grow while one message streams.
    expect(accumulate([3, 120, 450], true)).toBe(450);
  });

  it("treats a drop as a reset and counts the new value in full", () => {
    // Message boundary: 450-token message ends, the next starts at 2.
    expect(accumulate([450, 2, 200], true)).toBe(650);
  });

  it("accumulates a session-cumulative counter across turns, including equal-valued requests", () => {
    // Codex usage.total.outputTokens: two consecutive requests can report the
    // same cumulative value when a notification is repeated.
    expect(accumulate([250, 560, 560, 850], true)).toBe(850);
  });

  it("counts a session restart's fresh counter in full", () => {
    expect(accumulate([850, 40], true)).toBe(890);
  });

  it("only seeds the watermark on first observation when countFirstObservation is false", () => {
    // Reattaching to a long-lived session must not recount its history.
    expect(accumulate([9000, 9100], false)).toBe(100);
  });

  it("returns a zero delta for an unchanged counter", () => {
    expect(tokenDelta(300, 300, true)).toEqual({ delta: 0, watermark: 300 });
  });
});

describe("selectOutputCounter", () => {
  it("prefers the session-cumulative counter when present", () => {
    expect(
      selectOutputCounter({ usedTokens: 500, totalOutputTokens: 42, outputTokens: 7 }),
    ).toEqual({ value: 42, kind: "session-cumulative" });
  });

  it("falls back to the per-message counter", () => {
    expect(selectOutputCounter({ usedTokens: 500, outputTokens: 7 })).toEqual({
      value: 7,
      kind: "per-message",
    });
  });

  it("returns undefined when no output counter is reported", () => {
    expect(selectOutputCounter({ usedTokens: 500, inputTokens: 400 })).toBeUndefined();
  });
});
