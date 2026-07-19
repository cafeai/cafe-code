import { assert, describe, it } from "@effect/vitest";

import {
  containsDesktopArtifactResidue,
  containsDesktopArtifactSecretMaterial,
  isDesktopRuntimeManifestValid,
  isDesktopUpdateMetadataValid,
} from "./DesktopArtifactAudit.ts";

const validManifest = {
  name: "@cafecode/desktop-runtime",
  private: true,
  main: "apps/desktop/dist-electron/main.cjs",
  dependencies: {
    effect: "4.0.0-beta.59",
    "node-pty": "^1.1.0",
  },
};

describe("DesktopArtifactAudit", () => {
  it("accepts only a portable, registry-resolved staged manifest", () => {
    assert.isTrue(isDesktopRuntimeManifestValid(validManifest));
    assert.isFalse(
      isDesktopRuntimeManifestValid({
        ...validManifest,
        dependencies: { effect: "catalog:" },
      }),
    );
    assert.isFalse(isDesktopRuntimeManifestValid({ ...validManifest, packageManager: "other@1" }));
    assert.isFalse(
      isDesktopRuntimeManifestValid({ ...validManifest, scripts: { start: "node app" } }),
    );
  });

  it("rejects obsolete toolchain artifacts and first-party command residue", () => {
    const retiredTool = String.fromCharCode(98, 117, 110);
    assert.isTrue(containsDesktopArtifactResidue(`config/${retiredTool}fig.toml`));
    assert.isTrue(
      containsDesktopArtifactResidue("dist/main.js", `const command = '${retiredTool} run app'`),
    );
    assert.isFalse(containsDesktopArtifactResidue("node_modules/vendor/package.json", "unrelated"));
  });

  it("rejects credential material without flagging ordinary syntax identifiers", () => {
    assert.isTrue(
      containsDesktopArtifactSecretMaterial(
        "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----",
      ),
    );
    assert.isTrue(containsDesktopArtifactSecretMaterial("token = ghp_1234567890abcdefghijkl"));
    assert.isTrue(containsDesktopArtifactSecretMaterial("key = sk-proj-live1234567890abcdef"));
    assert.isFalse(containsDesktopArtifactSecretMaterial("erilog-sk-prompt-state-selector"));
  });

  it("requires updater metadata to target the official release repository", () => {
    assert.isTrue(
      isDesktopUpdateMetadataValid("provider: github\nowner: cafeai\nrepo: cafe-code\n"),
    );
    assert.isFalse(
      isDesktopUpdateMetadataValid("provider: generic\nurl: https://updates.invalid\n"),
    );
  });
});
