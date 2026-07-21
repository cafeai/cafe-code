import { describe, expect, it } from "vitest";

import {
  getAutoUpdateDisabledReason,
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
