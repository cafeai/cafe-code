// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspaceFiles = [
  "package.json",
  "yarn.lock",
  ".yarnrc.yml",
  ".yarn/patches/effect.patch",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "oxlint-plugin-cafecode/package.json",
  "packages/client-runtime/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "packages/effect-codex-app-server/package.json",
  "scripts/package.json",
  "packaging/desktop-runtime/package.json",
] as const;

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "latest-mac.yml");
  const x64Path = resolve(assetDirectory, "latest-mac-x64.yml");

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Cafe-Code-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: Cafe-Code-9.9.9-smoke.0-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: Cafe-Code-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Cafe-Code-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
  - url: Cafe-Code-9.9.9-smoke.0-x64.dmg
    sha512: x64dmg
    size: 138148807
path: Cafe-Code-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsManifestFixtures(
  targetRoot: string,
  channel: string,
): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, `${channel}-win-arm64.yml`);
  const x64Path = resolve(assetDirectory, `${channel}-win-x64.yml`);

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Cafe-Code-9.9.9-smoke.0-arm64.exe
    sha512: arm64exe
    size: 126621344
  - url: Cafe-Code-9.9.9-smoke.0-arm64.exe.blockmap
    sha512: arm64blockmap
    size: 152344
path: Cafe-Code-9.9.9-smoke.0-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Cafe-Code-9.9.9-smoke.0-x64.exe
    sha512: x64exe
    size: 132000112
  - url: Cafe-Code-9.9.9-smoke.0-x64.exe.blockmap
    sha512: x64blockmap
    size: 160112
path: Cafe-Code-9.9.9-smoke.0-x64.exe
sha512: x64exe
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsBuilderDebugFixtures(targetRoot: string): {
  arm64Path: string;
  x64Path: string;
} {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "builder-debug-win-arm64.yml");
  const x64Path = resolve(assetDirectory, "builder-debug-win-x64.yml");
  const debugFixture = `arm64:
  firstOrDefaultFilePatterns:
    - '**/*'
nsis:
  script: |-
    !include "example.nsh"
`;

  writeFileSync(arm64Path, debugFixture);
  writeFileSync(x64Path, debugFixture);

  return { arm64Path, x64Path };
}
function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertExists(path: string, message: string): void {
  if (!existsSync(path)) {
    throw new Error(message);
  }
}

function assertMissing(path: string, message: string): void {
  if (existsSync(path)) {
    throw new Error(message);
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "cafecode-release-smoke-"));

try {
  copyWorkspaceManifestFixture(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const expectedLockfile = readFileSync(resolve(tempRoot, "yarn.lock"), "utf8");

  // A lockfile records concrete versions selected from open semver ranges. A
  // from-scratch resolution is therefore expected to change whenever an
  // upstream package publishes a matching release; comparing that result with
  // a previously committed lockfile tests registry timing, not reproducibility.
  // Immutable install is the release invariant Cafe actually needs: every
  // copied manifest and the patched dependency graph must agree exactly with
  // the committed lockfile after release package versions are rewritten.
  execFileSync("corepack", ["yarn", "install", "--immutable", "--mode=skip-build"], {
    cwd: tempRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const lockfile = readFileSync(resolve(tempRoot, "yarn.lock"), "utf8");
  if (lockfile !== expectedLockfile) {
    throw new Error("Expected immutable Yarn install to preserve the committed lockfile.");
  }
  assertContains(
    lockfile,
    "effect@patch:effect@npm%3A4.0.0-beta.59#./.yarn/patches/effect.patch",
    "Expected yarn.lock to retain the Effect RPC patch.",
  );
  assertContains(
    lockfile,
    '"@cafecode/desktop-runtime@workspace:packaging/desktop-runtime"',
    "Expected yarn.lock to contain the canonical desktop runtime workspace.",
  );

  const nightlyReleaseMetadata = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/resolve-nightly-release.ts"),
      "--date",
      "20260413",
      "--run-number",
      "321",
      "--sha",
      "abcdef1234567890",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assertContains(
    nightlyReleaseMetadata,
    "version=9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly version.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "tag=v9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly tag.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "name=Cafe Code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
    "Expected nightly metadata to include the short commit SHA in the release name.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/merge-update-manifests.ts"),
      "--platform",
      "mac",
      arm64Path,
      x64Path,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "Cafe-Code-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "Cafe-Code-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );

  const { arm64Path: winArm64Path, x64Path: winX64Path } = writeWindowsManifestFixtures(
    tempRoot,
    "latest",
  );
  const mergedWindowsManifestPath = resolve(tempRoot, "release-assets/latest.yml");
  const { arm64Path: nightlyWinArm64Path, x64Path: nightlyWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "nightly");
  const mergedNightlyWindowsManifestPath = resolve(tempRoot, "release-assets/nightly.yml");
  const { arm64Path: previewWinArm64Path, x64Path: previewWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "preview");
  const mergedPreviewWindowsManifestPath = resolve(tempRoot, "release-assets/preview.yml");
  const { arm64Path: winDebugArm64Path, x64Path: winDebugX64Path } =
    writeWindowsBuilderDebugFixtures(tempRoot);
  const releaseAssetsDir = resolve(tempRoot, "release-assets");
  const windowsX64Manifests = readdirSync(releaseAssetsDir)
    .filter((name) => name.endsWith("-win-x64.yml") && !name.startsWith("builder-debug-"))
    .map((name) => resolve(releaseAssetsDir, name));
  if (windowsX64Manifests.length === 0) {
    throw new Error("No Windows updater manifests found to merge.");
  }
  for (const x64Manifest of windowsX64Manifests) {
    const arm64Manifest = x64Manifest.replace(/-x64\.yml$/u, "-arm64.yml");
    const outputManifest = x64Manifest.replace(/-win-x64\.yml$/u, ".yml");
    assertExists(arm64Manifest, `Missing matching arm64 Windows manifest for ${x64Manifest}`);
    execFileSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/merge-update-manifests.ts"),
        "--platform",
        "win",
        arm64Manifest,
        x64Manifest,
        outputManifest,
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    rmSync(arm64Manifest, { force: true });
    rmSync(x64Manifest, { force: true });
  }

  const mergedWindowsManifest = readFileSync(mergedWindowsManifestPath, "utf8");
  assertContains(
    mergedWindowsManifest,
    "Cafe-Code-9.9.9-smoke.0-arm64.exe",
    "Merged Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedWindowsManifest,
    "Cafe-Code-9.9.9-smoke.0-x64.exe",
    "Merged Windows manifest is missing the x64 asset.",
  );
  const mergedNightlyWindowsManifest = readFileSync(mergedNightlyWindowsManifestPath, "utf8");
  assertContains(
    mergedNightlyWindowsManifest,
    "Cafe-Code-9.9.9-smoke.0-arm64.exe",
    "Merged nightly Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedNightlyWindowsManifest,
    "Cafe-Code-9.9.9-smoke.0-x64.exe",
    "Merged nightly Windows manifest is missing the x64 asset.",
  );
  const mergedPreviewWindowsManifest = readFileSync(mergedPreviewWindowsManifestPath, "utf8");
  assertContains(
    mergedPreviewWindowsManifest,
    "Cafe-Code-9.9.9-smoke.0-arm64.exe",
    "Merged preview Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedPreviewWindowsManifest,
    "Cafe-Code-9.9.9-smoke.0-x64.exe",
    "Merged preview Windows manifest is missing the x64 asset.",
  );
  assertMissing(
    winArm64Path,
    "Windows release smoke unexpectedly kept the arm64 updater manifest.",
  );
  assertMissing(winX64Path, "Windows release smoke unexpectedly kept the x64 updater manifest.");
  assertMissing(
    nightlyWinArm64Path,
    "Windows release smoke unexpectedly kept the nightly arm64 updater manifest.",
  );
  assertMissing(
    nightlyWinX64Path,
    "Windows release smoke unexpectedly kept the nightly x64 updater manifest.",
  );
  assertMissing(
    previewWinArm64Path,
    "Windows release smoke unexpectedly kept the preview arm64 updater manifest.",
  );
  assertMissing(
    previewWinX64Path,
    "Windows release smoke unexpectedly kept the preview x64 updater manifest.",
  );
  assertExists(
    winDebugArm64Path,
    "Windows release smoke unexpectedly removed the arm64 builder debug fixture.",
  );
  assertExists(
    winDebugX64Path,
    "Windows release smoke unexpectedly removed the x64 builder debug fixture.",
  );

  Effect.runSync(Console.log("Release smoke checks passed."));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
