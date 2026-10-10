import { describe, expect, it } from "vitest";

import { sanitizeProviderToolData } from "./activityPayloadSanitizer.ts";

describe("sanitizeProviderToolData", () => {
  it("retains prior output omission and computed overflow across sanitization and key order", () => {
    for (const input of [
      { outputTruncated: true, output: "bounded preview" },
      { output: "bounded preview", outputTruncated: true },
      { outputTruncated: false, output: "x".repeat(3_000) },
      { output: "x".repeat(3_000), outputTruncated: false },
    ]) {
      const once = sanitizeProviderToolData(input);
      const twice = sanitizeProviderToolData(once);
      expect(once?.outputTruncated).toBe(true);
      expect(twice?.outputTruncated).toBe(true);
    }
  });
  it("preserves full snake-case file paths as changed files", () => {
    const sanitized = sanitizeProviderToolData({
      item: {
        input: {
          file_path: "/Users/mike/selia/selia/.selene/adrs/0110-deferred-coverage-arcs.md",
          old_path: "/Users/mike/selia/selia/.selene/adrs/0110-old.md",
          new_path: "/Users/mike/selia/selia/.selene/adrs/0110-new.md",
        },
      },
    });

    expect(sanitized?.changedFiles).toEqual([
      { path: "/Users/mike/selia/selia/.selene/adrs/0110-deferred-coverage-arcs.md" },
      { path: "/Users/mike/selia/selia/.selene/adrs/0110-old.md" },
      { path: "/Users/mike/selia/selia/.selene/adrs/0110-new.md" },
    ]);
  });

  it("does not advertise truncated file paths as changed files", () => {
    const sanitized = sanitizeProviderToolData({
      item: {
        input: {
          file_path: "/Users/mike/selia/.../0110-deferred-coverage-arcs.md",
        },
      },
    });

    expect(sanitized?.changedFiles).toBeUndefined();
  });

  it("does not advertise command metadata paths as changed files", () => {
    const sanitized = sanitizeProviderToolData(
      {
        commandActions: [
          {
            command: "rg -n deferred /Users/mike/selia/selia/.selene/adrs",
            path: "selia/...",
            type: "search",
          },
        ],
        changedFiles: [{ path: "selia/..." }],
      },
      { itemType: "command_execution" },
    );

    expect(sanitized?.changedFiles).toBeUndefined();
  });
});
