import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeUpdateManifest, type UpdateManifest } from "./lib/update-manifest.ts";
import { validateDesktopUpdateRelease } from "./validate-update-release.ts";

const version = "1.2.3-nightly.20260721.1";
const releaseDirs: string[] = [];

function sha512(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

async function makeReleaseFile(releaseDir: string, fileName: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(`fixture:${fileName}`);
  await writeFile(join(releaseDir, fileName), bytes);
  return bytes;
}

async function writeManifest(
  releaseDir: string,
  fileName: string,
  assetNames: readonly string[],
): Promise<void> {
  const files: Array<UpdateManifest["files"][number]> = [];
  for (const assetName of assetNames) {
    const bytes = await readFile(join(releaseDir, assetName));
    files.push({ url: assetName, sha512: sha512(bytes), size: bytes.length });
  }
  await writeFile(
    join(releaseDir, fileName),
    serializeUpdateManifest(
      {
        version,
        releaseDate: "2026-07-21T00:00:00.000Z",
        files,
        extras: {},
      },
      { platformLabel: fileName },
    ),
  );
}

async function makeValidRelease(): Promise<string> {
  const releaseDir = await mkdtemp(join(tmpdir(), "cafe-update-release-"));
  releaseDirs.push(releaseDir);
  const assets = [
    `Cafe-Code-${version}-x64.exe`,
    `Cafe-Code-${version}-arm64.dmg`,
    `Cafe-Code-${version}-x64.dmg`,
    `Cafe-Code-${version}-arm64.zip`,
    `Cafe-Code-${version}-x64.zip`,
    `Cafe-Code-${version}-x86_64.AppImage`,
  ] as const;
  await Promise.all(assets.map((asset) => makeReleaseFile(releaseDir, asset)));
  await writeManifest(releaseDir, "nightly.yml", [assets[0]]);
  await writeManifest(releaseDir, "nightly-mac.yml", [assets[3], assets[4]]);
  await writeManifest(releaseDir, "nightly-linux.yml", [assets[5]]);
  return releaseDir;
}

afterEach(async () => {
  await Promise.all(releaseDirs.splice(0).map((releaseDir) => rm(releaseDir, { recursive: true })));
});

describe("validateDesktopUpdateRelease", () => {
  it("validates every platform feed and writes sorted manual-download checksums", async () => {
    const releaseDir = await makeValidRelease();

    await expect(
      validateDesktopUpdateRelease({ releaseDir, version, channel: "nightly" }),
    ).resolves.toMatchObject({ version, channel: "nightly", fileCount: 9 });

    const checksums = await readFile(join(releaseDir, "SHA256SUMS.txt"), "utf8");
    expect(checksums).toContain(`Cafe-Code-${version}-x86_64.AppImage`);
    expect(checksums).toContain("nightly-mac.yml");
  });

  it("rejects a missing required platform artifact", async () => {
    const releaseDir = await makeValidRelease();
    await rm(join(releaseDir, `Cafe-Code-${version}-arm64.dmg`));

    await expect(
      validateDesktopUpdateRelease({ releaseDir, version, channel: "nightly" }),
    ).rejects.toThrow("missing required file");
  });

  it("rejects manifest checksum tampering", async () => {
    const releaseDir = await makeValidRelease();
    await writeFile(join(releaseDir, `Cafe-Code-${version}-x86_64.AppImage`), "tampered");

    await expect(
      validateDesktopUpdateRelease({ releaseDir, version, channel: "nightly" }),
    ).rejects.toThrow(/size|SHA-512/);
  });
});
