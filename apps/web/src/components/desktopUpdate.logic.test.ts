import { describe, expect, it } from "vitest";

import type { DesktopUpdateState } from "@cafecode/contracts";

import {
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

function makeState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "latest",
    installMode: "in-app",
    currentVersion: "1.0.0",
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    availableVersion: "1.1.0",
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: "2026-07-21T00:00:00.000Z",
    message: null,
    errorContext: null,
    canRetry: false,
    ...overrides,
  };
}

describe("desktop update presentation", () => {
  it("keeps supported updates on the in-app download path", () => {
    expect(resolveDesktopUpdateButtonAction(makeState())).toBe("download");
  });

  it("routes unsigned macOS updates to the exact GitHub release", () => {
    const state = makeState({ installMode: "manual" });

    expect(resolveDesktopUpdateButtonAction(state)).toBe("manual");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("GitHub release");
    expect(getDesktopUpdateReleaseUrl(state.availableVersion)).toBe(
      "https://github.com/cafeai/cafe-code/releases/tag/v1.1.0",
    );
  });

  it("falls back to the releases index when no version is available", () => {
    expect(getDesktopUpdateReleaseUrl(null)).toBe("https://github.com/cafeai/cafe-code/releases");
  });
});
