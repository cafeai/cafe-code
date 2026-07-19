import { assert, describe, it } from "@effect/vitest";

import {
  selectInstalledWindowsExecutables,
  selectWindowsInstaller,
} from "./windows-native-artifact-smoke.ts";

describe("Windows native artifact smoke", () => {
  it("selects the single x64 NSIS artifact", () => {
    assert.equal(
      selectWindowsInstaller([
        "Cafe-Code-0.0.51-x64.exe.blockmap",
        "Cafe-Code-0.0.51-x64.exe",
        "builder-debug.yml",
      ]),
      "Cafe-Code-0.0.51-x64.exe",
    );
  });

  it("rejects missing or ambiguous installers", () => {
    assert.throws(() => selectWindowsInstaller([]), /exactly one/);
    assert.throws(
      () => selectWindowsInstaller(["Cafe-Code-1.0.0-x64.exe", "Cafe-Code-2.0.0-x64.exe"]),
      /exactly one/,
    );
  });

  it("selects stable and channel-branded installed executable pairs", () => {
    assert.deepEqual(
      selectInstalledWindowsExecutables([
        "Cafe Code (Alpha).exe",
        "Uninstall Cafe Code (Alpha).exe",
        "resources",
      ]),
      {
        app: "Cafe Code (Alpha).exe",
        uninstaller: "Uninstall Cafe Code (Alpha).exe",
      },
    );
    assert.deepEqual(
      selectInstalledWindowsExecutables([
        "Cafe Code (Nightly).exe",
        "Uninstall Cafe Code (Nightly).exe",
      ]),
      {
        app: "Cafe Code (Nightly).exe",
        uninstaller: "Uninstall Cafe Code (Nightly).exe",
      },
    );
  });
});
