import { describe, expect, it } from "vitest";
import {
  admittedClaudeControlIdentity,
  isClaudeDetachedToolResult,
  supportsClaudeTaskControls,
} from "./claudeTaskControls.ts";

describe("Claude task-control qualification", () => {
  it("requires a qualified stable native CLI, not just a modern imported SDK", () => {
    for (const version of [
      undefined,
      null,
      "",
      "0.3.288",
      "2.1.286",
      "2.1.287-beta.1",
      "2.1.287 unexpected",
    ]) {
      expect(supportsClaudeTaskControls(version)).toBe(false);
    }
    expect(supportsClaudeTaskControls("2.1.287")).toBe(true);
    expect(supportsClaudeTaskControls("2.1.288")).toBe(true);
  });
  it("retains exact native identities without display normalization or unsafe control bytes", () => {
    expect(admittedClaudeControlIdentity("task:exact-long-id")).toBe("task:exact-long-id");
    for (const value of [undefined, null, "", "bad\0id", "bad\nid", "é".repeat(4097), {}]) {
      expect(admittedClaudeControlIdentity(value)).toBeUndefined();
    }
  });
  it("only recognizes the typed detached result marker", () => {
    expect(isClaudeDetachedToolResult({ detachedToolCall: true })).toBe(true);
    for (const value of [
      null,
      [],
      "detachedToolCall",
      { detachedToolCall: "true" },
      { detachedToolCall: false },
    ]) {
      expect(isClaudeDetachedToolResult(value)).toBe(false);
    }
  });
});
