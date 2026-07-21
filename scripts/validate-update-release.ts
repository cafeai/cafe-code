#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { parseUpdateManifest, type UpdateManifest } from "./lib/update-manifest.ts";

export type DesktopReleaseChannel = "latest" | "nightly";

export interface ValidateDesktopUpdateReleaseInput {
  readonly releaseDir: string;
  readonly version: string;
  readonly channel: DesktopReleaseChannel;
  readonly writeChecksums?: boolean;
}

export interface DesktopUpdateReleaseValidationResult {
  readonly version: string;
  readonly channel: DesktopReleaseChannel;
  readonly fileCount: number;
  readonly manifests: readonly string[];
}

function sha512Base64(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeManifestFileName(url: string, manifestName: string): string {
  let fileName: string;
  try {
    fileName = decodeURIComponent(url);
  } catch {
    throw new Error(`${manifestName} contains an invalid encoded asset URL: ${url}`);
  }

  if (!fileName || basename(fileName) !== fileName || fileName.includes("\\")) {
    throw new Error(`${manifestName} contains a non-local asset URL: ${url}`);
  }
  return fileName;
}

async function validateManifestFiles(
  releaseDir: string,
  manifestName: string,
  manifest: UpdateManifest,
  expectedVersion: string,
): Promise<Set<string>> {
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `${manifestName} has version ${manifest.version}; expected ${expectedVersion}.`,
    );
  }

  const referencedFiles = new Set<string>();
  for (const file of manifest.files) {
    const fileName = decodeManifestFileName(file.url, manifestName);
    if (referencedFiles.has(fileName)) {
      throw new Error(`${manifestName} references ${fileName} more than once.`);
    }
    referencedFiles.add(fileName);

    const filePath = join(releaseDir, fileName);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      throw new Error(`${manifestName} references missing asset ${fileName}.`);
    }
    if (fileStat.size !== file.size) {
      throw new Error(
        `${manifestName} records size ${file.size} for ${fileName}; actual size is ${fileStat.size}.`,
      );
    }
    const bytes = await readFile(filePath);
    if (sha512Base64(bytes) !== file.sha512) {
      throw new Error(`${manifestName} has an invalid SHA-512 checksum for ${fileName}.`);
    }
  }
  return referencedFiles;
}

function expectedReleaseFiles(version: string, channel: DesktopReleaseChannel): readonly string[] {
  return [
    `Cafe-Code-${version}-x64.exe`,
    `Cafe-Code-${version}-arm64.dmg`,
    `Cafe-Code-${version}-x64.dmg`,
    `Cafe-Code-${version}-arm64.zip`,
    `Cafe-Code-${version}-x64.zip`,
    `Cafe-Code-${version}-x86_64.AppImage`,
    `${channel}.yml`,
    `${channel}-mac.yml`,
    `${channel}-linux.yml`,
  ];
}

async function assertRequiredFiles(
  releaseDir: string,
  requiredFiles: readonly string[],
): Promise<void> {
  for (const fileName of requiredFiles) {
    const fileStat = await stat(join(releaseDir, fileName)).catch(() => null);
    if (!fileStat?.isFile()) {
      throw new Error(`Desktop release is missing required file ${fileName}.`);
    }
  }
}

function assertManifestPayloads(
  version: string,
  manifestFiles: Readonly<Record<string, ReadonlySet<string>>>,
): void {
  const expectedByManifest: Readonly<Record<string, readonly string[]>> = {
    windows: [`Cafe-Code-${version}-x64.exe`],
    mac: [`Cafe-Code-${version}-arm64.zip`, `Cafe-Code-${version}-x64.zip`],
    linux: [`Cafe-Code-${version}-x86_64.AppImage`],
  };

  for (const [platform, expectedFiles] of Object.entries(expectedByManifest)) {
    const actualFiles = manifestFiles[platform];
    if (!actualFiles) {
      throw new Error(`Desktop release validation did not load the ${platform} manifest.`);
    }
    for (const fileName of expectedFiles) {
      if (!actualFiles.has(fileName)) {
        throw new Error(`The ${platform} update manifest does not reference ${fileName}.`);
      }
    }
  }
}

async function writeReleaseChecksums(releaseDir: string): Promise<void> {
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS.txt")
    .map((entry) => entry.name)
    .toSorted();
  const lines: string[] = [];
  for (const fileName of fileNames) {
    lines.push(`${sha256Hex(await readFile(join(releaseDir, fileName)))}  ${fileName}`);
  }
  await writeFile(join(releaseDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
}

export async function validateDesktopUpdateRelease(
  input: ValidateDesktopUpdateReleaseInput,
): Promise<DesktopUpdateReleaseValidationResult> {
  const releaseDir = resolve(input.releaseDir);
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const unsupportedEntry = entries.find((entry) => !entry.isFile());
  if (unsupportedEntry) {
    throw new Error(
      `Desktop release directory contains a non-file entry: ${unsupportedEntry.name}.`,
    );
  }

  const manifestNames = [
    `${input.channel}.yml`,
    `${input.channel}-mac.yml`,
    `${input.channel}-linux.yml`,
  ] as const;
  await assertRequiredFiles(releaseDir, expectedReleaseFiles(input.version, input.channel));

  const manifestFiles: Record<string, ReadonlySet<string>> = {};
  for (const [index, manifestName] of manifestNames.entries()) {
    const raw = await readFile(join(releaseDir, manifestName), "utf8");
    const platform = ["windows", "mac", "linux"][index];
    if (!platform) throw new Error(`Unknown manifest index ${index}.`);
    const manifest = parseUpdateManifest(raw, manifestName, platform);
    manifestFiles[platform] = await validateManifestFiles(
      releaseDir,
      manifestName,
      manifest,
      input.version,
    );
  }
  assertManifestPayloads(input.version, manifestFiles);

  if (input.writeChecksums !== false) {
    await writeReleaseChecksums(releaseDir);
  }

  return {
    version: input.version,
    channel: input.channel,
    fileCount: entries.length,
    manifests: manifestNames,
  };
}

function readFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required ${name} argument.`);
  return value;
}

if (import.meta.main) {
  const channel = readFlag("--channel");
  if (channel !== "latest" && channel !== "nightly") {
    throw new Error(`Invalid --channel value '${channel}'.`);
  }
  const result = await validateDesktopUpdateRelease({
    releaseDir: readFlag("--release-dir"),
    version: readFlag("--version"),
    channel,
  });
  console.info(JSON.stringify(result));
}
