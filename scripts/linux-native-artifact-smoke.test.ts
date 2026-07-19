import { assert, describe, it } from "@effect/vitest";

import { isLinuxReleaseMetadataValid, selectLinuxAppImage } from "./linux-native-artifact-smoke.ts";

describe("Linux native artifact smoke", () => {
  it("selects one architecture-matched AppImage", () => {
    assert.equal(
      selectLinuxAppImage([
        "Cafe-Code-0.0.51-x86_64.AppImage",
        "latest-linux.yml",
        "builder-debug.yml",
      ]),
      "Cafe-Code-0.0.51-x86_64.AppImage",
    );
    assert.throws(() => selectLinuxAppImage([]), /exactly one/);
  });

  it("binds release metadata to the selected artifact and checksum", () => {
    const appImage = "Cafe-Code-0.0.51-x86_64.AppImage";
    assert.isTrue(
      isLinuxReleaseMetadataValid(
        `files:\n  - url: ${appImage}\n    sha512: abc\npath: ${appImage}\nsha512: ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop==\n`,
        appImage,
      ),
    );
    assert.isFalse(isLinuxReleaseMetadataValid("path: other.AppImage\n", appImage));
  });
});
