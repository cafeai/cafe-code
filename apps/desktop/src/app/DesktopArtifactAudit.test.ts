import { assert, describe, it } from "@effect/vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import {
  auditPackagedDesktopArtifact,
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

  it("uses the official target only when a build-time target is absent", () => {
    assert.isTrue(
      isDesktopUpdateMetadataValid("provider: github\nowner: cafeai\nrepo: cafe-code\n"),
    );
    assert.isFalse(
      isDesktopUpdateMetadataValid("provider: generic\nurl: https://updates.invalid\n"),
    );
    assert.isFalse(
      isDesktopUpdateMetadataValid("provider: github\nowner: cafeai\nrepo: cafe-code\n", null),
    );
  });

  it("matches the configured fork and accepts the builder's quoted cache and nightly fields", () => {
    const target = { provider: "github", owner: "John-Ryan21337", repo: "club-code" };
    const metadata =
      "owner: John-Ryan21337\nrepo: club-code\nprovider: github\nreleaseType: prerelease\nchannel: nightly\nupdaterCacheDirName: '@cafecodedesktop-runtime-updater'\n";
    assert.isTrue(isDesktopUpdateMetadataValid(metadata, target));
    assert.isFalse(isDesktopUpdateMetadataValid(metadata));
    assert.isFalse(isDesktopUpdateMetadataValid(metadata, { ...target, repo: "other" }));
    assert.isFalse(isDesktopUpdateMetadataValid(metadata, { ...target, owner: "other" }));
  });

  it("rejects ambiguous metadata and endpoint overrides even when matching lines are present", () => {
    const valid = "provider: github\nowner: cafeai\nrepo: cafe-code\n";
    for (const suffix of [
      "owner: attacker\n",
      "repo: other\n",
      "provider: generic\n",
      "host: updates.invalid\n",
      "url: https://updates.invalid\n",
      "protocol: http\n",
      "path: alternate\n",
      "<<: *override\n",
      "channel: unknown\n",
    ]) {
      assert.isFalse(isDesktopUpdateMetadataValid(valid + suffix), suffix);
    }
    assert.isFalse(isDesktopUpdateMetadataValid(valid + " ".repeat(16_384)));
    assert.isFalse(isDesktopRuntimeManifestValid({ ...validManifest, cafeCodeUpdateTarget: null }));
    assert.isFalse(
      isDesktopRuntimeManifestValid({
        ...validManifest,
        cafeCodeUpdateTarget: { provider: "github", owner: "cafeai", repo: "../other" },
      }),
    );
  });

  it("binds the packaged audit to the manifest instead of the current process environment", async () => {
    const resources = await mkdtemp(join(tmpdir(), "desktop-audit-target-"));
    const appArchive = join(resources, "app.asar");
    const target = { provider: "github", owner: "release-owner", repo: "desktop-releases" };
    try {
      await mkdir(join(appArchive, "apps"), { recursive: true });
      await writeFile(join(appArchive, "apps", "main.js"), "console.log('desktop');\n");
      await writeFile(
        join(appArchive, "package.json"),
        JSON.stringify({ ...validManifest, cafeCodeUpdateTarget: target }),
      );
      vi.stubEnv("GITHUB_REPOSITORY", "attacker/other");
      vi.stubEnv("CAFE_CODE_DESKTOP_UPDATE_REPOSITORY", "attacker/other");
      await writeFile(
        join(resources, "app-update.yml"),
        "provider: github\nowner: release-owner\nrepo: desktop-releases\n",
      );
      assert.isTrue(await auditPackagedDesktopArtifact(resources, "win32"));
      await writeFile(
        join(resources, "app-update.yml"),
        "provider: github\nowner: attacker\nrepo: other\n",
      );
      assert.isFalse(await auditPackagedDesktopArtifact(resources, "win32"));
    } finally {
      vi.unstubAllEnvs();
      await rm(resources, { recursive: true, force: true });
    }
  });
});
