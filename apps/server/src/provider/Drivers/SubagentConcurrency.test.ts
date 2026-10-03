import { describe, expect, it } from "vitest";
import {
  resolveConfiguredSubagentLimit,
  supportsSubagentConcurrency,
} from "./SubagentConcurrency.ts";

describe("qualified native subagent concurrency", () => {
  it("requires an observed stable native version rather than a model name", () => {
    for (const version of [null, undefined, "", "GPT-6.1 Sol", "invalid", "2.1.217-beta.1"]) {
      expect(supportsSubagentConcurrency("claudeAgent", version)).toBe(false);
    }
    expect(supportsSubagentConcurrency("claudeAgent", "2.1.216")).toBe(false);
    expect(supportsSubagentConcurrency("claudeAgent", "2.1.217")).toBe(true);
    expect(supportsSubagentConcurrency("claudeAgent", "2.1.286")).toBe(true);
    expect(supportsSubagentConcurrency("codex", "0.158.0")).toBe(false);
    expect(supportsSubagentConcurrency("codex", "0.159.0")).toBe(true);
    expect(supportsSubagentConcurrency("codex", "0.160.0")).toBe(true);
    expect(supportsSubagentConcurrency("codex", "0.160.0-beta.1")).toBe(false);
  });

  it("resolves chat then instance overrides without inventing native defaults", () => {
    expect(resolveConfiguredSubagentLimit(4, 20)).toBe(4);
    expect(resolveConfiguredSubagentLimit(null, 20)).toBe(20);
    expect(resolveConfiguredSubagentLimit(undefined, 20)).toBe(20);
    expect(resolveConfiguredSubagentLimit(null, undefined)).toBeNull();
    expect(resolveConfiguredSubagentLimit(undefined, undefined)).toBeNull();
    expect(resolveConfiguredSubagentLimit(1, undefined)).toBe(1);
    expect(resolveConfiguredSubagentLimit(64, undefined)).toBe(64);
  });

  it("rejects malformed process overrides rather than serializing them", () => {
    for (const value of [0, 65, -1, 1.5, NaN, Infinity, "4", "4; injected"] as const) {
      expect(() => resolveConfiguredSubagentLimit(value as number, undefined)).toThrow(RangeError);
      expect(() => resolveConfiguredSubagentLimit(null, value as number)).toThrow(RangeError);
    }
  });
});
