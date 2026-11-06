import { describe, expect, it } from "vitest";

import { registerSecretIconTap } from "./secretIconTaps";

function tapAt(times: readonly number[]) {
  let taps: readonly number[] = [];
  const results = [];
  for (const time of times) {
    const result = registerSecretIconTap(taps, time);
    taps = result.taps;
    results.push(result);
  }
  return results;
}

describe("registerSecretIconTap", () => {
  it("stays quiet for four clicks, counts down from the fifth and toggles on the tenth", () => {
    const results = tapAt(Array.from({ length: 10 }, (_, index) => index * 500));
    expect(results.slice(0, 4).map((result) => result.remaining)).toEqual([null, null, null, null]);
    expect(results.slice(4, 9).map((result) => result.remaining)).toEqual([5, 4, 3, 2, 1]);
    expect(results.slice(0, 9).some((result) => result.toggled)).toBe(false);
    expect(results[9]).toEqual({ taps: [], remaining: null, toggled: true });
  });

  it("only counts clicks inside the rolling ten-second window", () => {
    // Nine quick clicks, then a pause: the first clicks expire before the tenth.
    const times = [...Array.from({ length: 9 }, (_, index) => index * 100), 10_050];
    const last = tapAt(times).at(-1)!;
    expect(last.toggled).toBe(false);
    expect(last.taps.length).toBeLessThan(10);
  });

  it("starts a fresh sequence after toggling", () => {
    const first = tapAt(Array.from({ length: 11 }, (_, index) => index * 100));
    expect(first[9]?.toggled).toBe(true);
    expect(first[10]).toMatchObject({ remaining: null, toggled: false });
  });
});
