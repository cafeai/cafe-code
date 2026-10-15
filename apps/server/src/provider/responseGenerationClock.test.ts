import { describe, expect, it } from "vitest";

import {
  makeResponseGenerationSample,
  RESPONSE_GENERATION_MIN_DURATION_MS,
  ResponseGenerationClock,
} from "./responseGenerationClock.ts";

describe("makeResponseGenerationSample", () => {
  it("accepts a plausible response and normalizes to integers", () => {
    expect(makeResponseGenerationSample(400.9, 4_999.6)).toEqual({
      outputTokens: 400,
      durationMs: 5_000,
    });
  });

  it("treats missing, empty, jitter-sized and implausible measurements as unmeasured", () => {
    expect(makeResponseGenerationSample(undefined, 1_000)).toBeUndefined();
    expect(makeResponseGenerationSample(100, undefined)).toBeUndefined();
    expect(makeResponseGenerationSample(0, 1_000)).toBeUndefined();
    expect(makeResponseGenerationSample(Number.NaN, 1_000)).toBeUndefined();
    expect(
      makeResponseGenerationSample(10, RESPONSE_GENERATION_MIN_DURATION_MS - 1),
    ).toBeUndefined();
    // 10,000 tok/s means part of the generation interval was not observed.
    expect(makeResponseGenerationSample(10_000, 1_000)).toBeUndefined();
  });
});

describe("ResponseGenerationClock", () => {
  it("measures from the first output to the last edge", () => {
    const clock = new ResponseGenerationClock();
    clock.observeOutput(1_000);
    clock.observeOutput(1_500);
    clock.observeEdge(3_000);
    expect(clock.finish(200)).toEqual({ outputTokens: 200, durationMs: 2_000 });
  });

  it("uses an explicit end frame and resets after finishing", () => {
    const clock = new ResponseGenerationClock();
    clock.observeOutput(1_000);
    expect(clock.finish(100, 2_000)).toEqual({ outputTokens: 100, durationMs: 1_000 });
    expect(clock.isOpen).toBe(false);
    expect(clock.finish(100, 3_000)).toBeUndefined();
  });

  it("never opens a window from an edge alone", () => {
    const clock = new ResponseGenerationClock();
    clock.observeEdge(1_000);
    expect(clock.isOpen).toBe(false);
    expect(clock.finish(100, 2_000)).toBeUndefined();
  });

  it("keeps the latest edge when observations arrive out of order", () => {
    const clock = new ResponseGenerationClock();
    clock.observeOutput(1_000);
    clock.observeEdge(4_000);
    clock.observeEdge(2_000);
    expect(clock.finish(300)).toEqual({ outputTokens: 300, durationMs: 3_000 });
  });

  it("drops an invalidated response but measures the next one", () => {
    const clock = new ResponseGenerationClock();
    clock.observeOutput(1_000);
    clock.invalidate();
    expect(clock.finish(100, 3_000)).toBeUndefined();
    clock.observeOutput(5_000);
    expect(clock.finish(100, 6_000)).toEqual({ outputTokens: 100, durationMs: 1_000 });
  });
});
