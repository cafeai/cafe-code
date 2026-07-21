import type { DesktopUpdateInstallMode } from "@cafecode/contracts";

export interface DesktopUpdateEligibilityInput {
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly appImage?: string | undefined;
  readonly disabledByEnv: boolean;
  readonly hasUpdateFeedConfig: boolean;
}

export function getAutoUpdateDisabledReason(args: DesktopUpdateEligibilityInput): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the CAFE_CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}

export function resolveUnsignedDesktopUpdateInstallMode(
  platform: NodeJS.Platform,
): DesktopUpdateInstallMode {
  // Squirrel.Mac rejects unsigned in-place updates. Keep detection available, but direct
  // users to the release DMG until Cafe has an Apple Developer ID signing identity.
  return platform === "darwin" ? "manual" : "in-app";
}
