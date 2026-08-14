import { describe, expect, it } from "vitest";

import { parseCodexRateLimitUpdate } from "./codexRateLimits.ts";

describe("parseCodexRateLimitUpdate", () => {
  it("maps the documented sparse rolling notification into the canonical Codex bucket", () => {
    expect(
      parseCodexRateLimitUpdate({
        rateLimits: {
          limitId: "codex",
          planType: "pro",
          primary: {
            usedPercent: 1,
            windowDurationMins: 10_080,
            resetsAt: 1_786_400_000,
          },
          secondary: null,
        },
      }),
    ).toEqual({
      limitId: "codex",
      snapshot: {
        limitId: "codex",
        planType: "pro",
        primary: {
          usedPercent: 1,
          windowDurationMins: 10_080,
          resetsAt: 1_786_400_000,
        },
      },
    });
  });

  it("defaults legacy single-bucket notifications to codex and omits nullable metadata", () => {
    expect(
      parseCodexRateLimitUpdate({
        rateLimits: {
          limitId: null,
          planType: null,
          primary: { usedPercent: 12, windowDurationMins: null, resetsAt: null },
        },
      }),
    ).toEqual({
      limitId: "codex",
      snapshot: {
        limitId: "codex",
        primary: { usedPercent: 12 },
      },
    });
  });

  it("rejects malformed and empty rolling updates", () => {
    expect(parseCodexRateLimitUpdate(null)).toBeNull();
    expect(parseCodexRateLimitUpdate({})).toBeNull();
    expect(parseCodexRateLimitUpdate({ rateLimits: { primary: null } })).toBeNull();
    expect(parseCodexRateLimitUpdate({ rateLimits: { primary: { usedPercent: "1" } } })).toBeNull();
  });
});
