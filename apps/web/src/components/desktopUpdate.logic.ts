import { uiText } from "@cafecode/shared/i18n";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@cafecode/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "manual" | "none";

const DESKTOP_RELEASES_URL = "https://github.com/cafeai/cafe-code/releases";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.installMode === "manual" && state.availableVersion) {
    return "manual";
  }
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function getDesktopUpdateReleaseUrl(version: string | null): string {
  if (!version) return DESKTOP_RELEASES_URL;
  return `${DESKTOP_RELEASES_URL}/tag/v${encodeURIComponent(version)}`;
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return uiText("This install is using the correct architecture.");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return uiText(
      "This Mac has Apple Silicon, but Cafe Code is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
    );
  }
  if (action === "install") {
    return uiText(
      "This Mac has Apple Silicon, but Cafe Code is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
    );
  }
  return uiText(
    "This Mac has Apple Silicon, but Cafe Code is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
  );
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    if (state.installMode === "manual") {
      return uiText("Update {version} can be installed from its GitHub release", {
        version: state.availableVersion ?? uiText("available"),
      });
    }
    return uiText("Update {version} ready to download", {
      version: state.availableVersion ?? uiText("available"),
    });
  }
  if (state.status === "downloading") {
    return uiText("Downloading update{known, select, yes { ({percent}%)} other {}}", {
      known: typeof state.downloadPercent === "number" ? "yes" : "no",
      percent: typeof state.downloadPercent === "number" ? Math.floor(state.downloadPercent) : 0,
    });
  }
  if (state.status === "downloaded") {
    return uiText("Update {version} downloaded. Click to restart and install.", {
      version: state.downloadedVersion ?? state.availableVersion ?? uiText("ready"),
    });
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return uiText("Download failed for {availableVersion}. Click to retry.", {
        availableVersion: state.availableVersion,
      });
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return uiText("Install failed for {downloadedVersion}. Click to retry.", {
        downloadedVersion: state.downloadedVersion,
      });
    }
    return state.message ?? uiText("Update failed");
  }
  return uiText("Up to date");
}

/** The About row must not describe an unchecked or unavailable updater as current. */
export function getDesktopUpdateStatus(state: DesktopUpdateState | null): string {
  if (!state) return uiText("Desktop update information is unavailable.");
  if (!state.enabled || state.status === "disabled") {
    return state.message ?? uiText("Update checks are unavailable for this installation.");
  }
  if (state.status === "idle") return uiText("Not checked yet.");
  if (state.status === "checking") return uiText("Checking…");
  if (state.status === "up-to-date") return uiText("Up to date.");
  return getDesktopUpdateButtonTooltip(state);
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return uiText(
    "Install update{known, select, yes { {version}} other {}} and restart Cafe Code?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
    { known: version ? "yes" : "no", version: version ?? "" },
  );
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "downloaded" &&
    state.status !== "disabled"
  );
}
