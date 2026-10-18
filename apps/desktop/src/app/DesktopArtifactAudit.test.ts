import { assert, describe, it } from "@effect/vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  containsDesktopArtifactResidue,
  auditPackagedDesktopArtifact,
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
  it("audits actual staged files with supported macOS resources while rejecting extra files and locale secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-artifact-audit-"));
    const app = join(root, "app.asar");
    try {
      await mkdir(join(app, "apps", "desktop"), { recursive: true });
      await writeFile(join(app, "package.json"), JSON.stringify(validManifest));
      const generatedIdentifier = String.fromCharCode(98, 85, 110);
      await writeFile(
        join(app, "apps", "desktop", "main.js"),
        `var ${generatedIdentifier}=()=>{};${generatedIdentifier}();`,
      );
      await writeFile(
        join(root, "app-update.yml"),
        "provider: github\nowner: cafeai\nrepo: cafe-code\n",
      );
      await writeFile(join(root, "mac-dictation-target"), "synthetic native helper");
      await writeFile(join(root, "mac-glide"), "synthetic Glide helper");
      for (const locale of ["en", "ja", "ko"]) {
        await mkdir(join(root, `${locale}.lproj`));
        await writeFile(
          join(root, `${locale}.lproj`, "InfoPlist.strings"),
          '"usage" = "Microphone";',
        );
      }
      assert.isTrue(await auditPackagedDesktopArtifact(root, "darwin"));
      await rm(join(root, "mac-glide"));
      assert.isFalse(await auditPackagedDesktopArtifact(root, "darwin"));
      await writeFile(join(root, "mac-glide"), "synthetic Glide helper");
      assert.isFalse(await auditPackagedDesktopArtifact(root, "linux"));
      await writeFile(join(root, "extra-resource.txt"), "unexpected");
      assert.isFalse(await auditPackagedDesktopArtifact(root, "darwin"));
      await rm(join(root, "extra-resource.txt"));
      await writeFile(join(root, "ja.lproj", "InfoPlist.strings"), "-----BEGIN PRIVATE KEY-----");
      assert.isFalse(await auditPackagedDesktopArtifact(root, "darwin"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    for (const reference of [
      `"${retiredTool}"`,
      `'${retiredTool}:test'`,
      `'${retiredTool} run app'`,
    ]) {
      assert.isTrue(containsDesktopArtifactResidue("dist/main.js", reference));
    }
    // Actual renderer bundles contain these generated identifiers. Their
    // spelling is unrelated to an executable, import or packaged runtime.
    for (const identifier of [
      retiredTool,
      String.fromCharCode(98, 85, 110),
      String.fromCharCode(66, 85, 110),
      String.fromCharCode(66, 117, 110),
    ]) {
      assert.isFalse(
        containsDesktopArtifactResidue(
          "dist/sandboxDocument.js",
          `var ${identifier}=()=>{};${identifier}();`,
        ),
      );
    }
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
