import { describe, expect, it } from "vitest";

import { usesDesktopRestartSupervisor } from "./DesktopRelaunchPolicy.ts";

describe("desktop native source restart ownership", () => {
  it("hands a built Debug restart to the stable native parent", () => {
    expect(
      usesDesktopRestartSupervisor({
        isDevelopment: false,
        isPackaged: false,
        platform: "darwin",
        nativeHostVersion: "1",
      }),
    ).toBe(true);
  });

  it("preserves release and explicitly selected launch contexts", () => {
    for (const input of [
      { isPackaged: true, platform: "darwin" as const, nativeHostVersion: "1" },
      { isPackaged: false, platform: "darwin" as const, nativeHostVersion: undefined },
      { isPackaged: false, platform: "darwin" as const, nativeHostVersion: "unknown" },
      { isPackaged: false, platform: "linux" as const, nativeHostVersion: "1" },
      { isPackaged: false, platform: "win32" as const, nativeHostVersion: "1" },
    ]) {
      expect(usesDesktopRestartSupervisor({ isDevelopment: false, ...input })).toBe(false);
    }
  });

  it("retains the watched development supervisor", () => {
    expect(
      usesDesktopRestartSupervisor({
        isDevelopment: true,
        isPackaged: false,
        platform: "darwin",
        nativeHostVersion: undefined,
      }),
    ).toBe(true);
  });
});
