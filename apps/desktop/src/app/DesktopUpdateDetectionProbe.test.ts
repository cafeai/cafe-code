import { describe, expect, it } from "vitest";

import {
  collectDesktopUpdateDetectionProbeResult,
  isDesktopUpdateDetectionProbeEnabled,
  type DesktopUpdateDetectionProbeDependencies,
} from "./DesktopUpdateDetectionProbe.ts";

function makeDependencies(
  overrides: Partial<DesktopUpdateDetectionProbeDependencies> = {},
): DesktopUpdateDetectionProbeDependencies {
  return {
    platform: "linux",
    arch: "x64",
    isPackaged: true,
    currentVersion: "1.0.0-nightly.20260721.0",
    expectedVersion: "1.0.0-nightly.20260721.1",
    channel: "nightly",
    checkForUpdates: async () => ({
      updateAvailable: true,
      availableVersion: "1.0.0-nightly.20260721.1",
    }),
    ...overrides,
  };
}

describe("DesktopUpdateDetectionProbe", () => {
  it("enables only for the explicit detection switch", () => {
    expect(isDesktopUpdateDetectionProbeEnabled(["Cafe Code"])).toBe(false);
    expect(
      isDesktopUpdateDetectionProbeEnabled(["Cafe Code", "--cafe-update-detection-probe"]),
    ).toBe(true);
  });

  it("accepts the exact newer release reported by the updater", async () => {
    await expect(
      collectDesktopUpdateDetectionProbeResult(makeDependencies()),
    ).resolves.toMatchObject({
      ok: true,
      updateAvailable: true,
      availableVersion: "1.0.0-nightly.20260721.1",
      failure: null,
    });
  });

  it("fails closed for source runs, no update, wrong versions, and updater errors", async () => {
    await expect(
      collectDesktopUpdateDetectionProbeResult(makeDependencies({ isPackaged: false })),
    ).resolves.toMatchObject({ ok: false, failure: "not-packaged" });
    await expect(
      collectDesktopUpdateDetectionProbeResult(
        makeDependencies({
          checkForUpdates: async () => ({ updateAvailable: false, availableVersion: "1.0.0" }),
        }),
      ),
    ).resolves.toMatchObject({ ok: false, failure: "no-update" });
    await expect(
      collectDesktopUpdateDetectionProbeResult(
        makeDependencies({ expectedVersion: "1.0.0-nightly.20260721.2" }),
      ),
    ).resolves.toMatchObject({ ok: false, failure: "unexpected-version" });
    await expect(
      collectDesktopUpdateDetectionProbeResult(
        makeDependencies({
          checkForUpdates: async () => {
            throw new Error("secret feed URL must not escape");
          },
        }),
      ),
    ).resolves.toEqual(
      expect.not.objectContaining({ message: expect.stringContaining("secret feed URL") }),
    );
  });
});
