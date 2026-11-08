import { describe, expect, it } from "vitest";
import {
  deriveAvailableRateLimitResetCount,
  deriveCodexRateLimitBuckets,
  deriveContextWindowUsage,
  deriveLatestContextWindowUsage,
  deriveProviderRateLimitWindow,
} from "./threadResourceUsage.ts";

const observedAt = "2026-03-23T00:00:00.000Z";
const activity = (kind: string, payload: unknown, createdAt = observedAt) => ({
  kind,
  payload,
  createdAt,
});

describe("reported thread resource usage", () => {
  it("uses the latest usable native context without adding reasoning or saved intent", () => {
    const usage = deriveLatestContextWindowUsage([
      activity("context-window.updated", { usedTokens: 1_000 }),
      activity("tool.started", { usedTokens: 900_000 }),
      activity("context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        reasoningOutputTokens: 5_000,
        codexContextWindowOverride: 1_000_000,
        compactsAutomatically: true,
        autoCompactTokenLimit: 200_000,
      }),
    ]);

    expect(usage).not.toBeNull();
    expect(usage?.usedTokens).toBe(14_000);
    expect(usage?.totalProcessedTokens).toBeNull();
    expect(usage?.maxTokens).toBe(258_000);
    expect(usage?.remainingTokens).toBe(244_000);
    expect(usage?.usedPercentage).toBeCloseTo(5.426356589);
    expect(usage?.compactsAutomatically).toBe(true);
    expect(usage?.autoCompactTokenLimit).toBe(200_000);
    expect(usage?.updatedAt).toBe(observedAt);
  });

  it.each([undefined, null, 0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "42"])(
    "does not turn an invalid occupancy into a context snapshot (%s)",
    (usedTokens) => {
      expect(deriveContextWindowUsage({ usedTokens })).toBeNull();
    },
  );

  it("retains the previous usable observation when newer rows are malformed", () => {
    expect(
      deriveLatestContextWindowUsage([
        activity("context-window.updated", { usedTokens: 25 }),
        activity("context-window.updated", { usedTokens: "200" }, "2026-03-23T00:00:01Z"),
        activity("context-window.updated", { usedTokens: 30 }, "not-an-observation-time"),
      ]),
    ).toMatchObject({ usedTokens: 25, updatedAt: observedAt });
    expect(deriveLatestContextWindowUsage([activity("context-window.updated", {})])).toBeNull();
  });

  it("keeps missing capacity and policy unknown while preserving reported zero counters", () => {
    expect(
      deriveContextWindowUsage({
        usedTokens: 42,
        totalProcessedTokens: 0,
        inputTokens: 0,
        reasoningOutputTokens: 12,
        codexContextWindowOverride: 800_000,
      }),
    ).toMatchObject({
      usedTokens: 42,
      totalProcessedTokens: 0,
      inputTokens: 0,
      maxTokens: null,
      remainingTokens: null,
      usedPercentage: null,
      remainingPercentage: null,
      compactsAutomatically: null,
      autoCompactTokenLimit: null,
    });
    expect(deriveContextWindowUsage({ usedTokens: 200, maxTokens: 100 })).toMatchObject({
      usedPercentage: 100,
      remainingPercentage: 0,
      remainingTokens: 0,
    });
  });

  it("keeps cumulative processed tokens independent of current occupancy", () => {
    const usage = deriveContextWindowUsage({
      usedTokens: 81_659,
      totalProcessedTokens: 748_126,
      maxTokens: 258_400,
      lastUsedTokens: 81_659,
    });
    expect(usage?.usedTokens).toBe(81_659);
    expect(usage?.totalProcessedTokens).toBe(748_126);
  });

  it("does not invoke received payload accessors or expose failed proxy observations", () => {
    let reads = 0;
    const payload = Object.defineProperty({}, "usedTokens", {
      get() {
        reads += 1;
        throw new Error("private synthetic accessor");
      },
    });
    expect(deriveContextWindowUsage(payload)).toBeNull();
    expect(reads).toBe(0);
    expect(
      deriveContextWindowUsage(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("private synthetic descriptor");
            },
          },
        ),
      ),
    ).toBeNull();
  });
});

describe("reported account quota", () => {
  it("preserves exact named bucket identities and prefers the native codex map entry", () => {
    const input = {
      checkedAt: observedAt,
      rateLimits: { limitId: "codex", primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        research: { limitName: "Research quota", primary: { usedPercent: 25 } },
        codex: { limitId: "codex", primary: { usedPercent: 20 } },
        other: { limitName: "Other quota", primary: { usedPercent: 25 } },
      },
    };
    const buckets = deriveCodexRateLimitBuckets(input);
    expect(buckets.map((bucket) => bucket.id)).toEqual(["codex", "research", "other"]);
    expect(buckets[0]?.snapshot.limitId).toBe("codex");
    expect(buckets[0]?.snapshot.primary?.usedPercent).toBe(20);
    expect(buckets[1]?.label).toBe("Research quota");
    expect(
      deriveCodexRateLimitBuckets({
        ...input,
        rateLimits: { limitId: "legacy-only", primary: { usedPercent: 10 } },
      }).map((bucket) => bucket.id),
    ).toContain("legacy-only");
  });

  it("retains prototype-like bucket IDs as ordinary own identities", () => {
    const buckets = deriveCodexRateLimitBuckets({
      checkedAt: observedAt,
      rateLimits: {},
      rateLimitsByLimitId: Object.fromEntries([
        ["__proto__", { limitName: "Own quota", primary: { usedPercent: 10 } }],
      ]),
    });
    expect(buckets.find((bucket) => bucket.id === "__proto__")?.label).toBe("Own quota");
  });

  it.each([
    { window: {}, expected: { usedPercent: null, remainingPercent: null, resetsAt: null } },
    {
      window: { usedPercent: 0 },
      expected: { usedPercent: 0, remainingPercent: 100, resetsAt: null },
    },
    {
      window: { usedPercent: 25 },
      expected: { usedPercent: 25, remainingPercent: 75, resetsAt: null },
    },
    {
      window: { usedPercent: 150 },
      expected: { usedPercent: 100, remainingPercent: 0, resetsAt: null },
    },
    {
      window: { usedPercent: -1 },
      expected: { usedPercent: null, remainingPercent: null, resetsAt: null },
    },
    {
      window: { usedPercent: Number.NaN },
      expected: { usedPercent: null, remainingPercent: null, resetsAt: null },
    },
    {
      window: { resetsAt: 1_780_172_059 },
      expected: { usedPercent: null, remainingPercent: null, resetsAt: 1_780_172_059 },
    },
  ])("keeps reported utilization distinct from unknown/reset-only data", ({ window, expected }) => {
    expect(deriveProviderRateLimitWindow(window)).toMatchObject(expected);
  });

  it("preserves native minute/epoch-second units and refuses invalid integer metadata", () => {
    expect(deriveProviderRateLimitWindow(undefined)).toBeNull();
    expect(
      deriveProviderRateLimitWindow({ windowDurationMins: 10_080, resetsAt: 1_780_172_059 }),
    ).toMatchObject({ windowDurationMins: 10_080, resetsAt: 1_780_172_059 });
    expect(deriveProviderRateLimitWindow({ windowDurationMins: 0, resetsAt: 0 })).toMatchObject({
      windowDurationMins: 0,
      resetsAt: 0,
    });
    expect(deriveProviderRateLimitWindow({ windowDurationMins: 1.5, resetsAt: -1 })).toMatchObject({
      windowDurationMins: null,
      resetsAt: null,
    });
  });

  it("uses the authoritative reset aggregate including zero rather than counting detail rows", () => {
    expect(
      deriveAvailableRateLimitResetCount({ checkedAt: observedAt, rateLimits: {} }),
    ).toBeNull();
    expect(
      deriveAvailableRateLimitResetCount({
        checkedAt: observedAt,
        rateLimits: {},
        rateLimitResetCredits: { availableCount: 0, credits: null },
      }),
    ).toBe(0);
  });
});
