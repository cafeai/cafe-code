import type { ProviderDriverKind, ProviderInstanceId } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  deriveClaudePermissionMode,
  type ClaudePermissionMode,
  type ClaudePermissionModeState,
} from "./claudePermissionMode";

export const DEFAULT_GEMINI_PERMISSION_STATE: ClaudePermissionModeState = {
  interactionMode: "gemini-bypass",
  runtimeMode: "full-access",
};

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

/**
 * Translate permission modes cleanly when switching to/from Gemini or across
 * Gemini accounts so Full access / Bypass permissions carry across providers
 * consistently, while legacy Gemini `default` + `full-access` chats remain Ask
 * permissions and never escalate when switching providers.
 */
export function resolvePermissionModeForProviderSwitch(input: {
  readonly previousProvider: ProviderDriverKind | null | undefined;
  readonly previousInstanceId: ProviderInstanceId | null | undefined;
  readonly nextProvider: ProviderDriverKind | null | undefined;
  readonly nextInstanceId: ProviderInstanceId;
  readonly state: ClaudePermissionModeState;
  readonly geminiBypassInstanceId: ProviderInstanceId | null;
}): ClaudePermissionModeState | null {
  const {
    previousProvider,
    previousInstanceId,
    nextProvider,
    nextInstanceId,
    state,
    geminiBypassInstanceId,
  } = input;

  if (
    previousProvider !== "gemini" &&
    nextProvider !== "gemini" &&
    state.interactionMode !== "gemini-bypass"
  ) {
    return null;
  }

  if (
    previousProvider === "gemini" &&
    nextProvider === "gemini" &&
    previousInstanceId === nextInstanceId
  ) {
    if (state.interactionMode === "gemini-bypass" && geminiBypassInstanceId !== nextInstanceId) {
      return DEFAULT_GEMINI_PERMISSION_STATE;
    }
    return null;
  }

  if (nextProvider === "gemini") {
    if (previousProvider === "gemini") {
      const currentMode = deriveGeminiPermissionMode(state);
      return applyGeminiPermissionMode(currentMode ?? "default");
    }
    if (state.interactionMode === "gemini-bypass") {
      return DEFAULT_GEMINI_PERMISSION_STATE;
    }
    return applyGeminiPermissionMode(deriveClaudePermissionMode(state));
  }

  const geminiMode = deriveGeminiPermissionMode(state);
  switch (geminiMode) {
    case "bypassPermissions":
      return { interactionMode: "default", runtimeMode: "full-access" };
    case "acceptEdits":
      return { interactionMode: "default", runtimeMode: "auto-accept-edits" };
    case "plan":
      return { interactionMode: "plan", runtimeMode: "full-access" };
    case "auto":
      if (nextProvider === "claudeAgent") {
        return { interactionMode: "auto", runtimeMode: "full-access" };
      }
      if (nextProvider === "grok") {
        return { interactionMode: "auto", runtimeMode: "auto-accept-edits" };
      }
      return { interactionMode: "default", runtimeMode: "full-access" };
    case "default":
    case undefined:
      return { interactionMode: "default", runtimeMode: "approval-required" };
  }
}
