import { describe, expect, it } from "vitest";
import type { DesktopReleaseUpdateState } from "@cafecode/contracts";

import { getReleaseUpdateTooltip, shouldShowReleaseUpdatePill } from "./desktopUpdate.logic";

function releaseState(overrides: Partial<DesktopReleaseUpdateState>): DesktopReleaseUpdateState {
  return {
    status: "idle",
    currentVersion: "0.0.51",
    latestVersion: null,
    releaseUrl: null,
    checkedAt: null,
    message: null,
    ...overrides,
  };
}

describe("shouldShowReleaseUpdatePill", () => {
  it("shows when an update is available with a release url", () => {
    expect(
      shouldShowReleaseUpdatePill(
        releaseState({
          status: "available",
          latestVersion: "0.0.52",
          releaseUrl: "https://github.com/cafeai/cafe-code/releases",
        }),
      ),
    ).toBe(true);
  });

  it("hides when up to date", () => {
    expect(shouldShowReleaseUpdatePill(releaseState({ status: "up-to-date" }))).toBe(false);
  });

  it("hides when available but missing a release url", () => {
    expect(
      shouldShowReleaseUpdatePill(releaseState({ status: "available", latestVersion: "0.0.52" })),
    ).toBe(false);
  });

  it("hides for null state", () => {
    expect(shouldShowReleaseUpdatePill(null)).toBe(false);
  });
});

describe("getReleaseUpdateTooltip", () => {
  it("names the version when available", () => {
    expect(
      getReleaseUpdateTooltip(
        releaseState({ status: "available", latestVersion: "0.0.52", releaseUrl: "x" }),
      ),
    ).toContain("0.0.52");
  });

  it("falls back to a generic message", () => {
    expect(getReleaseUpdateTooltip(null)).toBe("A new release is available");
  });
});
