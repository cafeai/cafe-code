import { assert, describe, it } from "@effect/vitest";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

import {
  isLinuxReleaseMetadataValid,
  linuxArtifactSmokeTempDirectory,
  resolveLinuxSandboxHelper,
  selectLinuxAppImage,
} from "./linux-native-artifact-smoke.ts";

describe("Linux native artifact smoke", () => {
  it("uses the runner filesystem for setuid fixtures without changing ordinary temporary paths", () => {
    const runnerTemp = join(tmpdir(), "synthetic-runner-temp");
    assert.equal(linuxArtifactSmokeTempDirectory({ RUNNER_TEMP: runnerTemp }), tmpdir());
    assert.equal(
      linuxArtifactSmokeTempDirectory({
        RUNNER_TEMP: runnerTemp,
        CAFE_CODE_LINUX_ARTIFACT_PREPARE_SANDBOX: "1",
      }),
      runnerTemp,
    );
    for (const RUNNER_TEMP of [undefined, "relative-temp"]) {
      assert.throws(
        () =>
          linuxArtifactSmokeTempDirectory({
            RUNNER_TEMP,
            CAFE_CODE_LINUX_ARTIFACT_PREPARE_SANDBOX: "1",
          }),
        /absolute runner temporary/,
      );
    }
  });

  it("admits only a regular fixture helper and refuses directory replacements", async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-sandbox-admission-"));
    try {
      const helper = join(root, "chrome-sandbox");
      await writeFile(helper, "synthetic helper");
      expect(await resolveLinuxSandboxHelper(root)).toMatch(/chrome-sandbox$/);
      await rm(helper);
      await mkdir(helper);
      await expect(resolveLinuxSandboxHelper(root)).rejects.toThrow("regular unshared helper");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a hard-linked helper before any privileged preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-sandbox-links-"));
    try {
      const original = join(root, "original");
      await writeFile(original, "synthetic helper");
      await link(original, join(root, "chrome-sandbox"));
      await expect(resolveLinuxSandboxHelper(root)).rejects.toThrow("regular unshared helper");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
