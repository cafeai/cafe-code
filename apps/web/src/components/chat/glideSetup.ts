import type { GlideControlResult, RuntimeMode } from "@cafecode/contracts";

/**
 * Pure policy for the Computer use (Glide) permission setup flow. The dialog
 * renders only what the trusted native status reports: opening System Settings
 * is never evidence that a permission was granted.
 */
export type GlidePermissionId = "accessibility" | "screen-recording";

export interface GlidePermissionRequirement {
  readonly id: GlidePermissionId;
  readonly granted: boolean;
  readonly settingsAction: "open-accessibility" | "open-screen-recording";
}

export function glidePermissionRequirements(
  status: Pick<GlideControlResult, "accessibility" | "screenRecording">,
): readonly GlidePermissionRequirement[] {
  return [
    { id: "accessibility", granted: status.accessibility, settingsAction: "open-accessibility" },
    {
      id: "screen-recording",
      granted: status.screenRecording,
      settingsAction: "open-screen-recording",
    },
  ];
}

export function glidePermissionsGranted(
  status: Pick<GlideControlResult, "accessibility" | "screenRecording"> | undefined,
): boolean {
  return status?.accessibility === true && status.screenRecording === true;
}

export type GlideClickIntent = "refresh" | "setup" | "toggle";

/**
 * What a click on the composer button does. Turning an enabled chat off never
 * waits for permissions, so revocation stays direct even with missing grants.
 * A disabled button (no desktop helper or no Full access) is handled by the
 * caller and never reaches this policy.
 */
export function glideClickIntent(input: {
  readonly error: boolean;
  readonly enabled: boolean;
  readonly status: GlideControlResult | undefined;
}): GlideClickIntent {
  if (input.enabled) return "toggle";
  if (input.error) return "refresh";
  return glidePermissionsGranted(input.status) ? "toggle" : "setup";
}

export function glideButtonDisabled(input: {
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly canTarget: boolean;
  readonly enabled: boolean;
  readonly error: boolean;
  readonly status: GlideControlResult | undefined;
  readonly runtimeMode: RuntimeMode;
}): boolean {
  if (input.disabled || input.pending || !input.canTarget) return true;
  if (input.enabled || input.error) return false;
  return !input.status?.available || input.runtimeMode !== "full-access";
}

/** macOS 27 renamed the Accessibility pane; macOS 15 renamed Screen Recording. */
export function glideAccessibilityPaneKind(
  osMajorVersion: number | undefined,
): "device-control" | "accessibility" {
  return osMajorVersion !== undefined && osMajorVersion >= 27 ? "device-control" : "accessibility";
}

export function glideScreenRecordingPaneKind(
  osMajorVersion: number | undefined,
): "screen-and-audio" | "screen" {
  return osMajorVersion !== undefined && osMajorVersion >= 15 ? "screen-and-audio" : "screen";
}

/**
 * The dialog polls only while it is open and permissions are still missing.
 * One status read is in flight at a time; after the bounded window the user
 * can resume checking explicitly instead of leaving an indefinite timer.
 */
export const GLIDE_SETUP_POLL_INTERVAL_MS = 2_000;
export const GLIDE_SETUP_POLL_WINDOW_MS = 10 * 60_000;

export function glideSetupShouldPoll(input: {
  readonly open: boolean;
  readonly granted: boolean;
  readonly startedAt: number;
  readonly now: number;
}): boolean {
  return input.open && !input.granted && input.now - input.startedAt < GLIDE_SETUP_POLL_WINDOW_MS;
}

/** Fixed, content-free setup failure categories; no native/provider text. */
export const GLIDE_SETUP_ERROR = {
  settings: "settings",
  reveal: "reveal",
  enable: "enable",
} as const;
export type GlideSetupError = (typeof GLIDE_SETUP_ERROR)[keyof typeof GLIDE_SETUP_ERROR];
