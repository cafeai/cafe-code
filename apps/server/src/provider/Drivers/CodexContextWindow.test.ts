import { describe, expect, it } from "vitest";
import { supportsCodexContextWindow } from "./CodexContextWindow.ts";

describe("qualified native Codex context-window configuration", () => {
  it("requires the reviewed stable owning CLI version, never a model label", () => {
    for (const version of [
      null,
      undefined,
      "",
      "invalid",
      "GPT-6.1 Sol",
      "0.162.0",
      "0.162.1-alpha.1",
      "0.163.0-alpha.5",
      "x".repeat(65),
    ]) {
      expect(supportsCodexContextWindow(version)).toBe(false);
    }
    expect(supportsCodexContextWindow("0.162.1")).toBe(true);
    expect(supportsCodexContextWindow("0.163.0")).toBe(true);
  });
});
