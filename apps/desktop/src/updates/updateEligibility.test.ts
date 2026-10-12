import { describe, expect, it } from "vitest";

import {
  getAutoUpdateDisabledReason,
  autoUpdateDisabledReasonForUi,
  resolveUnsignedDesktopUpdateInstallMode,
  type DesktopUpdateEligibilityInput,
} from "./updateEligibility.ts";

const eligibleInput: DesktopUpdateEligibilityInput = {
  isDevelopment: false,
  isPackaged: true,
  platform: "win32",
  disabledByEnv: false,
  hasUpdateFeedConfig: true,
};

describe("desktop update eligibility", () => {
  it("keeps finite disabled-reason presentation English and unknown evidence unchanged", () => {
    for (const input of [
      { ...eligibleInput, hasUpdateFeedConfig: false },
      { ...eligibleInput, isDevelopment: true },
      { ...eligibleInput, disabledByEnv: true },
      { ...eligibleInput, platform: "linux" as const },
    ]) {
      const canonical = getAutoUpdateDisabledReason(input)!;
      expect(autoUpdateDisabledReasonForUi(canonical)).toBe(canonical);
    }
    expect(autoUpdateDisabledReasonForUi("Received provider detail {value}")).toBe(
      "Received provider detail {value}",
    );
  });
  it("enables packaged Windows, macOS, and AppImage builds with a feed", () => {
    expect(getAutoUpdateDisabledReason(eligibleInput)).toBeNull();
    expect(getAutoUpdateDisabledReason({ ...eligibleInput, platform: "darwin" })).toBeNull();
    expect(
      getAutoUpdateDisabledReason({
        ...eligibleInput,
        platform: "linux",
        appImage: "/opt/Cafe-Code.AppImage",
      }),
    ).toBeNull();
  });

  it("keeps source builds, opt-outs, missing feeds, and non-AppImage Linux disabled", () => {
    expect(getAutoUpdateDisabledReason({ ...eligibleInput, hasUpdateFeedConfig: false })).toContain(
      "no update feed",
    );
    expect(getAutoUpdateDisabledReason({ ...eligibleInput, isDevelopment: true })).toContain(
      "packaged production builds",
    );
    expect(getAutoUpdateDisabledReason({ ...eligibleInput, isPackaged: false })).toContain(
      "packaged production builds",
    );
    expect(getAutoUpdateDisabledReason({ ...eligibleInput, disabledByEnv: true })).toContain(
      "CAFE_CODE_DISABLE_AUTO_UPDATE",
    );
    expect(getAutoUpdateDisabledReason({ ...eligibleInput, platform: "linux" })).toContain(
      "AppImage",
    );
  });

  it("uses manual installation only for unsigned macOS artifacts", () => {
    expect(resolveUnsignedDesktopUpdateInstallMode("darwin")).toBe("manual");
    expect(resolveUnsignedDesktopUpdateInstallMode("win32")).toBe("in-app");
    expect(resolveUnsignedDesktopUpdateInstallMode("linux")).toBe("in-app");
  });
});
