import { ProviderDriverKind, ProviderInstanceId } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  applyGeminiPermissionMode,
  DEFAULT_GEMINI_PERMISSION_STATE,
  deriveGeminiPermissionMode,
  resolvePermissionModeForProviderSwitch,
} from "./geminiPermissionMode";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const GROK_DRIVER = ProviderDriverKind.make("grok");
const GEMINI_DRIVER = ProviderDriverKind.make("gemini");

const CODEX_ID = ProviderInstanceId.make("codex");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");
const GROK_ID = ProviderInstanceId.make("grok");
const GEMINI_ID = ProviderInstanceId.make("gemini");
const GEMINI_WORK_ID = ProviderInstanceId.make("gemini-work");

describe("Gemini composer permission modes", () => {
  it.each([
    ["default", "approval-required", "default"],
    // Legacy persisted threads using full-access + default remain Ask permissions.
    ["default", "full-access", "default"],
    ["default", "auto-accept-edits", "acceptEdits"],
    ["plan", "full-access", "plan"],
    ["auto", "full-access", "auto"],
    ["gemini-bypass", "full-access", "bypassPermissions"],
    ["gemini-bypass", "approval-required", undefined],
  ] as const)("derives %s / %s as %s", (interactionMode, runtimeMode, expectedPermissionMode) => {
    expect(deriveGeminiPermissionMode({ interactionMode, runtimeMode })).toBe(
      expectedPermissionMode,
    );
  });

  it("maps all five Gemini permission choices into durable Cafe state", () => {
    expect(applyGeminiPermissionMode("default")).toEqual({
      interactionMode: "default",
      runtimeMode: "approval-required",
    });
    expect(applyGeminiPermissionMode("acceptEdits")).toEqual({
      interactionMode: "default",
      runtimeMode: "auto-accept-edits",
    });
    expect(applyGeminiPermissionMode("plan")).toEqual({
      interactionMode: "plan",
      runtimeMode: "full-access",
    });
    expect(applyGeminiPermissionMode("auto")).toEqual({
      interactionMode: "auto",
      runtimeMode: "full-access",
    });
    expect(applyGeminiPermissionMode("bypassPermissions")).toEqual(DEFAULT_GEMINI_PERMISSION_STATE);
  });

  it("maps Full access / Bypass permissions across provider switches to and from Gemini", () => {
    // Switching from Codex or Claude Full access / Bypass to Gemini selects Gemini Bypass.
    expect(
      resolvePermissionModeForProviderSwitch({
        previousProvider: CODEX_DRIVER,
        previousInstanceId: CODEX_ID,
        nextProvider: GEMINI_DRIVER,
        nextInstanceId: GEMINI_ID,
        state: { interactionMode: "default", runtimeMode: "full-access" },
        geminiBypassInstanceId: null,
      }),
    ).toEqual({
      interactionMode: "gemini-bypass",
      runtimeMode: "full-access",
    });

    // Switching from Supervised / Ask permissions to Gemini stays Ask permissions.
    expect(
      resolvePermissionModeForProviderSwitch({
        previousProvider: CLAUDE_DRIVER,
        previousInstanceId: CLAUDE_ID,
        nextProvider: GEMINI_DRIVER,
        nextInstanceId: GEMINI_ID,
        state: { interactionMode: "default", runtimeMode: "approval-required" },
        geminiBypassInstanceId: null,
      }),
    ).toEqual({
      interactionMode: "default",
      runtimeMode: "approval-required",
    });

    // Switching from Gemini Bypass back to Codex or Claude restores Full access / Bypass.
    expect(
      resolvePermissionModeForProviderSwitch({
        previousProvider: GEMINI_DRIVER,
        previousInstanceId: GEMINI_ID,
        nextProvider: CODEX_DRIVER,
        nextInstanceId: CODEX_ID,
        state: { interactionMode: "gemini-bypass", runtimeMode: "full-access" },
        geminiBypassInstanceId: GEMINI_ID,
      }),
    ).toEqual({
      interactionMode: "default",
      runtimeMode: "full-access",
    });

    // Switching from legacy Gemini default + full-access to Claude never escalates to Bypass.
    expect(
      resolvePermissionModeForProviderSwitch({
        previousProvider: GEMINI_DRIVER,
        previousInstanceId: GEMINI_ID,
        nextProvider: CLAUDE_DRIVER,
        nextInstanceId: CLAUDE_ID,
        state: { interactionMode: "default", runtimeMode: "full-access" },
        geminiBypassInstanceId: null,
      }),
    ).toEqual({
      interactionMode: "default",
      runtimeMode: "approval-required",
    });

    // Switching from Gemini Auto adapts per destination provider.
    expect(
      resolvePermissionModeForProviderSwitch({
        previousProvider: GEMINI_DRIVER,
        previousInstanceId: GEMINI_ID,
        nextProvider: GROK_DRIVER,
        nextInstanceId: GROK_ID,
        state: { interactionMode: "auto", runtimeMode: "full-access" },
        geminiBypassInstanceId: null,
      }),
    ).toEqual({
      interactionMode: "auto",
      runtimeMode: "auto-accept-edits",
    });
    expect(
      resolvePermissionModeForProviderSwitch({
        previousProvider: GEMINI_DRIVER,
        previousInstanceId: GEMINI_ID,
        nextProvider: CODEX_DRIVER,
        nextInstanceId: CODEX_ID,
        state: { interactionMode: "auto", runtimeMode: "full-access" },
        geminiBypassInstanceId: null,
      }),
    ).toEqual({
      interactionMode: "default",
      runtimeMode: "full-access",
    });
  });

  it("preserves Gemini mode across Gemini account switches and same-account model changes", () => {
    expect(
      resolvePermissionModeForProviderSwitch({
        previousProvider: GEMINI_DRIVER,
        previousInstanceId: GEMINI_ID,
        nextProvider: GEMINI_DRIVER,
        nextInstanceId: GEMINI_WORK_ID,
        state: { interactionMode: "gemini-bypass", runtimeMode: "full-access" },
        geminiBypassInstanceId: GEMINI_ID,
      }),
    ).toEqual({
      interactionMode: "gemini-bypass",
      runtimeMode: "full-access",
    });

    // Changing models within the same Gemini account keeps the user's current choice untouched.
    expect(
      resolvePermissionModeForProviderSwitch({
        previousProvider: GEMINI_DRIVER,
        previousInstanceId: GEMINI_ID,
        nextProvider: GEMINI_DRIVER,
        nextInstanceId: GEMINI_ID,
        state: { interactionMode: "default", runtimeMode: "approval-required" },
        geminiBypassInstanceId: null,
      }),
    ).toBeNull();

    // Non-Gemini to non-Gemini switches are left untouched.
    expect(
      resolvePermissionModeForProviderSwitch({
        previousProvider: CODEX_DRIVER,
        previousInstanceId: CODEX_ID,
        nextProvider: CLAUDE_DRIVER,
        nextInstanceId: CLAUDE_ID,
        state: { interactionMode: "default", runtimeMode: "full-access" },
        geminiBypassInstanceId: null,
      }),
    ).toBeNull();
  });
});
