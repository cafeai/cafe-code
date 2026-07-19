import { assert, describe, it } from "@effect/vitest";

import { selectMacArtifacts } from "./macos-native-artifact-smoke.ts";

describe("macOS native artifact smoke", () => {
  it("selects architecture-matched DMG and ZIP artifacts", () => {
    assert.deepEqual(
      selectMacArtifacts(
        [
          "Cafe-Code-0.0.51-arm64.dmg",
          "Cafe-Code-0.0.51-arm64.zip",
          "Cafe-Code-0.0.51-x64.dmg",
          "Cafe-Code-0.0.51-x64.zip",
        ],
        "arm64",
      ),
      {
        dmg: "Cafe-Code-0.0.51-arm64.dmg",
        zip: "Cafe-Code-0.0.51-arm64.zip",
      },
    );
  });

  it("rejects incomplete architecture pairs", () => {
    assert.throws(
      () => selectMacArtifacts(["Cafe-Code-0.0.51-x64.dmg"], "x64"),
      /one x64 DMG and ZIP/,
    );
  });
});
