import { uiText } from "@cafecode/shared/i18n";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  type ClaudePermissionMode,
  type ClaudePermissionModeState,
} from "./claudePermissionMode";

export const GEMINI_PERMISSION_MODE_OPTIONS: typeof CLAUDE_PERMISSION_MODE_OPTIONS =
  CLAUDE_PERMISSION_MODE_OPTIONS.map((option) =>
    option.id === "auto"
      ? {
          id: "auto",
          get label() {
            return uiText("Auto");
          },
          get description() {
            return uiText("Run autonomously with Antigravity CLI's Auto permission mode.");
          },
        }
      : option,
  );

export function deriveGeminiPermissionMode(
  state: ClaudePermissionModeState,
): ClaudePermissionMode | undefined {
  if (state.interactionMode === "default") {
    // Full access was Cafe's former carrier for Antigravity Default. An old
    // conversation using it keeps Default and cannot acquire bypass here.
    return state.runtimeMode === "auto-accept-edits" ? "acceptEdits" : "default";
  }
  switch (state.interactionMode) {
    case "plan":
      return "plan";
    case "auto":
      return "auto";
    case "gemini-bypass":
      return state.runtimeMode === "full-access" ? "bypassPermissions" : undefined;
  }
}

export function applyGeminiPermissionMode(mode: ClaudePermissionMode): ClaudePermissionModeState {
  switch (mode) {
    case "default":
      return { interactionMode: "default", runtimeMode: "approval-required" };
    case "acceptEdits":
      return { interactionMode: "default", runtimeMode: "auto-accept-edits" };
    case "plan":
    case "auto":
      return { interactionMode: mode, runtimeMode: "full-access" };
    case "bypassPermissions":
      return { interactionMode: "gemini-bypass", runtimeMode: "full-access" };
  }
}
