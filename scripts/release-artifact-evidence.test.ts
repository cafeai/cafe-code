// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sealReleaseArtifacts, verifyReleaseArtifacts } from "./release-artifact-evidence.ts";

describe("release candidate artifact identity", () => {
  it("binds the complete matrix to its exact source and refuses changed bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-release-evidence-"));
    const source = "a".repeat(40);
    try {
      for (const target of ["windows-x64", "macos-arm64", "macos-x64", "linux-x64"]) {
        const directory = join(root, `cafe-code-release-${target}`);
        await mkdir(directory);
        await writeFile(join(directory, "asset.zip"), `qualified ${target}`);
        await sealReleaseArtifacts(directory, source, target);
      }
      await verifyReleaseArtifacts(root, source);
      await expect(verifyReleaseArtifacts(root, "b".repeat(40))).rejects.toThrow(
        "qualified source",
      );
      await writeFile(join(root, "cafe-code-release-windows-x64/asset.zip"), "different artifact");
      await expect(verifyReleaseArtifacts(root, source)).rejects.toThrow("qualified source");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
