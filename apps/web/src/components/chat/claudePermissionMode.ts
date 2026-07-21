import type { ProviderInteractionMode, RuntimeMode } from "@cafecode/contracts";

/**
 * Claude Code's interactive permission modes as exposed by its current CUI.
 * `bypassPermissions` is not in the normal four-state cycle, but Cafe already
 * exposed the equivalent Full access policy. Keeping it explicit prevents an
 * existing full-access thread from being mislabeled as classifier-backed Auto.
 * `dontAsk` remains CLI-only upstream and is intentionally not presented by
 * Cafe's desktop-style composer control.
 */
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "bypassPermissions";

export interface ClaudePermissionModeState {
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
}

const CLAUDE_MANUAL_PERMISSION_MODE_OPTION = {
  id: "default",
  label: "Manual",
  description: "Ask before edits and commands.",
} as const;

export const CLAUDE_PERMISSION_MODE_OPTIONS: ReadonlyArray<{
  readonly id: ClaudePermissionMode;
  readonly label: string;
  readonly description: string;
}> = [
  CLAUDE_MANUAL_PERMISSION_MODE_OPTION,
  {
    id: "acceptEdits",
    label: "Accept edits",
    description: "Apply edits automatically and ask before other actions.",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Research and propose changes without editing files.",
  },
  {
    id: "auto",
    label: "Auto",
    description: "Run autonomously with Claude's background safety classifier.",
  },
  {
    id: "bypassPermissions",
    label: "Bypass permissions",
    description: "Run without permission checks. Use only in an isolated environment.",
  },
];

const CLAUDE_NORMAL_PERMISSION_MODE_CYCLE: ReadonlyArray<ClaudePermissionMode> = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
];

const CLAUDE_PERMISSION_MODE_IDS = new Set<ClaudePermissionMode>(
  CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => option.id),
);

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === "string" && CLAUDE_PERMISSION_MODE_IDS.has(value as ClaudePermissionMode);
}

export function getClaudePermissionModeOption(mode: ClaudePermissionMode): {
  readonly id: ClaudePermissionMode;
  readonly label: string;
  readonly description: string;
} {
  return (
    CLAUDE_PERMISSION_MODE_OPTIONS.find((option) => option.id === mode) ??
    CLAUDE_MANUAL_PERMISSION_MODE_OPTION
  );
}

/**
 * Match Claude Code's Shift+Tab cycle. Bypass permissions is an explicit
 * dangerous opt-in outside the normal four-state cycle; pressing Shift+Tab
 * while it is selected returns to Manual instead of silently cycling back
 * into an unrestricted mode later.
 */
export function getNextClaudePermissionMode(mode: ClaudePermissionMode): ClaudePermissionMode {
  const index = CLAUDE_NORMAL_PERMISSION_MODE_CYCLE.indexOf(mode);
  if (index < 0) {
    return "default";
  }
  return (
    CLAUDE_NORMAL_PERMISSION_MODE_CYCLE[(index + 1) % CLAUDE_NORMAL_PERMISSION_MODE_CYCLE.length] ??
    "default"
  );
}

export function deriveClaudePermissionMode(state: ClaudePermissionModeState): ClaudePermissionMode {
  if (state.interactionMode === "plan") {
    return "plan";
  }
  if (state.interactionMode === "auto") {
    return "auto";
  }
  switch (state.runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "full-access":
      return "bypassPermissions";
  }
}

/**
 * Translate one Claude CUI mode selection back into Cafe's durable pair.
 * Plan and Auto are upstream interaction modes, so they preserve the access
 * policy underneath them. This allows a session to leave Plan/Auto through a
 * live SDK `setPermissionMode` request without restarting merely to rewrite
 * the generic runtime policy. Selecting Manual, Accept edits, or Bypass is an
 * explicit access-policy choice and therefore updates both fields.
 */
export function applyClaudePermissionMode(
  current: ClaudePermissionModeState,
  nextMode: ClaudePermissionMode,
): ClaudePermissionModeState {
  switch (nextMode) {
    case "default":
      return { interactionMode: "default", runtimeMode: "approval-required" };
    case "acceptEdits":
      return { interactionMode: "default", runtimeMode: "auto-accept-edits" };
    case "plan":
      return { interactionMode: "plan", runtimeMode: current.runtimeMode };
    case "auto":
      return { interactionMode: "auto", runtimeMode: current.runtimeMode };
    case "bypassPermissions":
      return { interactionMode: "default", runtimeMode: "full-access" };
  }
}
