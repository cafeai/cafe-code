import { describe, expect, it } from "vitest";

import { parseClaudeRateLimitUpdate } from "./claudeRateLimits.ts";

describe("parseClaudeRateLimitUpdate", () => {
  it("maps a five_hour event (full SDK shape) to the primary window, scaling utilization to a percentage", () => {
    const update = parseClaudeRateLimitUpdate({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        resetsAt: 1782274800,
        // utilization is a 0-1 fraction on the wire (0.25 == 25% used).
        utilization: 0.25,
      },
    });

    expect(update).toEqual({
      slot: "primary",
      window: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1782274800 },
    });
  });

  it("emits a reset-only primary window when utilization is absent", () => {
    const update = parseClaudeRateLimitUpdate({
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 1782274800,
      },
    });

    expect(update).toEqual({
      slot: "primary",
      window: { windowDurationMins: 300, resetsAt: 1782274800 },
    });
    expect(update?.window.usedPercent).toBeUndefined();
  });

  it("maps seven_day and its model-specific variants to the secondary window", () => {
    for (const rateLimitType of ["seven_day", "seven_day_opus", "seven_day_sonnet"]) {
      const update = parseClaudeRateLimitUpdate({
        rate_limit_info: { rateLimitType, resetsAt: 1782800000 },
      });
      expect(update?.slot).toBe("secondary");
      expect(update?.window.windowDurationMins).toBe(10_080);
      expect(update?.window.resetsAt).toBe(1782800000);
    }
  });

  it("accepts an already-unwrapped rate_limit_info object", () => {
    const update = parseClaudeRateLimitUpdate({
      rateLimitType: "five_hour",
      resetsAt: 1782274800,
    });
    expect(update?.slot).toBe("primary");
  });

  it("skips windows we do not surface and malformed payloads", () => {
    expect(parseClaudeRateLimitUpdate({ rate_limit_info: { rateLimitType: "overage" } })).toBeNull();
    expect(parseClaudeRateLimitUpdate({ rate_limit_info: { status: "allowed" } })).toBeNull();
    expect(parseClaudeRateLimitUpdate(null)).toBeNull();
    expect(parseClaudeRateLimitUpdate("nope")).toBeNull();
    expect(parseClaudeRateLimitUpdate({})).toBeNull();
  });

  it("ignores a non-positive or non-integer resetsAt", () => {
    const update = parseClaudeRateLimitUpdate({
      rate_limit_info: { rateLimitType: "five_hour", resetsAt: 0, utilization: 0.4 },
    });
    expect(update).toEqual({ slot: "primary", window: { usedPercent: 40, windowDurationMins: 300 } });
    expect(update?.window.resetsAt).toBeUndefined();
  });

  it("scales a fully-used window (utilization 1) to 100 percent", () => {
    const update = parseClaudeRateLimitUpdate({
      rate_limit_info: { rateLimitType: "five_hour", resetsAt: 1782274800, utilization: 1 },
    });
    expect(update?.window.usedPercent).toBe(100);
  });
});
