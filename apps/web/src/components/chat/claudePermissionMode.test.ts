import { describe, expect, it } from "vitest";

import {
  applyClaudePermissionMode,
  deriveClaudePermissionMode,
  getNextClaudePermissionMode,
} from "./claudePermissionMode";

describe("Claude composer permission modes", () => {
  it.each([
    ["default", "approval-required", "default"],
    ["default", "auto-accept-edits", "acceptEdits"],
    ["default", "full-access", "bypassPermissions"],
    ["plan", "full-access", "plan"],
    ["auto", "full-access", "auto"],
  ] as const)("derives %s / %s as %s", (interactionMode, runtimeMode, expectedPermissionMode) => {
    expect(deriveClaudePermissionMode({ interactionMode, runtimeMode })).toBe(
      expectedPermissionMode,
    );
  });

  it("maps the four normal CUI choices and optional bypass into durable Cafe state", () => {
    const current = { interactionMode: "default", runtimeMode: "full-access" } as const;

    expect(applyClaudePermissionMode(current, "default")).toEqual({
      interactionMode: "default",
      runtimeMode: "approval-required",
    });
    expect(applyClaudePermissionMode(current, "acceptEdits")).toEqual({
      interactionMode: "default",
      runtimeMode: "auto-accept-edits",
    });
    expect(applyClaudePermissionMode(current, "plan")).toEqual({
      interactionMode: "plan",
      runtimeMode: "full-access",
    });
    expect(applyClaudePermissionMode(current, "auto")).toEqual({
      interactionMode: "auto",
      runtimeMode: "full-access",
    });
    expect(applyClaudePermissionMode(current, "bypassPermissions")).toEqual({
      interactionMode: "default",
      runtimeMode: "full-access",
    });
  });

  it("cycles Shift+Tab through the four normal CUI modes without cycling through bypass", () => {
    expect(getNextClaudePermissionMode("default")).toBe("acceptEdits");
    expect(getNextClaudePermissionMode("acceptEdits")).toBe("plan");
    expect(getNextClaudePermissionMode("plan")).toBe("auto");
    expect(getNextClaudePermissionMode("auto")).toBe("default");
    expect(getNextClaudePermissionMode("bypassPermissions")).toBe("default");
  });
});
