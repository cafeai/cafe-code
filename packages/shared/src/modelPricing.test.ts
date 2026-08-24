import { describe, expect, it } from "vitest";

import {
  computeModelCost,
  pricedShare,
  resolveModelRate,
  rollUpCost,
  type ModelRate,
} from "./modelPricing.ts";

const RATE: ModelRate = { input: 10, cachedInput: 1, cacheWrite: 12, output: 50 };

describe("resolveModelRate", () => {
  it("matches a bundled family by prefix so dated releases inherit it", () => {
    const dated = resolveModelRate("claude-opus-4-5-20260101");
    expect(dated).toBeDefined();
    expect(dated).toEqual(resolveModelRate("claude-opus-4"));
  });

  it("prefers the longest matching prefix over a shorter sibling", () => {
    const haiku = resolveModelRate("claude-haiku-4-5");
    const generic = resolveModelRate("claude-something-else");
    expect(haiku?.output).toBeLessThan(generic!.output);
  });

  it("is case and whitespace insensitive", () => {
    expect(resolveModelRate("  CLAUDE-Opus-4  ")).toEqual(resolveModelRate("claude-opus-4"));
  });

  it("returns undefined for an unknown model rather than guessing", () => {
    expect(resolveModelRate("totally-unknown-model")).toBeUndefined();
  });

  it("lets a user override beat the bundled table", () => {
    const overrides = { "claude-opus-4": RATE };
    expect(resolveModelRate("claude-opus-4-5", overrides)).toEqual(RATE);
  });

  it("prices a model the bundled table has never heard of", () => {
    expect(resolveModelRate("acme-1", { "acme-1": RATE })).toEqual(RATE);
  });
});

describe("computeModelCost", () => {
  it("charges cache reads and writes at their own rates, not the input rate", () => {
    // 1M input of which 600k cached and 300k written, leaving 100k fresh.
    const cost = computeModelCost(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 600_000,
        cacheWriteInputTokens: 300_000,
        outputTokens: 100_000,
      },
      RATE,
    );
    // 0.1*10 + 0.6*1 + 0.3*12 + 0.1*50 = 1 + 0.6 + 3.6 + 5
    expect(cost).toBeCloseTo(10.2, 6);
  });

  it("never charges negative when cache counters exceed the input total", () => {
    const cost = computeModelCost(
      {
        inputTokens: 100,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 900,
        outputTokens: 0,
      },
      RATE,
    );
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("costs nothing for a row with no tokens", () => {
    expect(
      computeModelCost(
        { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 },
        RATE,
      ),
    ).toBe(0);
  });
});

describe("rollUpCost", () => {
  const priced = {
    model: "claude-opus-4",
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
  };
  const unpriced = { ...priced, model: "mystery-model" };

  it("counts unpriced volume separately instead of treating it as free", () => {
    const rollup = rollUpCost([priced, unpriced]);
    expect(rollup.pricedTokens).toBe(1_000_000);
    expect(rollup.unpricedTokens).toBe(1_000_000);
    expect(rollup.cost).toBeGreaterThan(0);
    expect(pricedShare(rollup)).toBeCloseTo(0.5, 6);
  });

  it("reports cache savings as the difference from paying full input rate", () => {
    const rollup = rollUpCost(
      [
        {
          model: "acme-1",
          inputTokens: 1_000_000,
          cachedInputTokens: 1_000_000,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
        },
      ],
      { "acme-1": RATE },
    );
    // 1M cached at 1 instead of 10 saves 9.
    expect(rollup.cacheSavings).toBeCloseTo(9, 6);
    expect(rollup.cost).toBeCloseTo(1, 6);
  });

  it("has no priced share to report when there is nothing to price", () => {
    expect(pricedShare(rollUpCost([]))).toBeNull();
  });
});
