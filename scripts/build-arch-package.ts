#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

interface CliOptions {
  readonly arch: DesktopArch;
  readonly install: boolean;
  readonly keepStage: boolean;
  readonly outputDir: string;
  readonly skipDesktopBuild: boolean;
  readonly verbose: boolean;
  readonly version: string | undefined;
}

type DesktopArch = "x64" | "arm64";
type PacmanArch = "x86_64" | "aarch64";

const repoRoot = realpathSync(new URL("..", import.meta.url));
const serverPackageJsonPath = join(repoRoot, "apps/server/package.json");
const desktopIconPath = join(repoRoot, "apps/desktop/resources/icon.png");
const licensePath = join(repoRoot, "LICENSE");

// Keep this list aligned with packaging/aur/cafe-code/PKGBUILD and .SRCINFO.
// The local package wraps the same AppImage as the AUR recipe, so declaring a
// smaller dependency set would make local install smokes pass only on machines
// that happened to have undeclared Electron runtime libraries already present.
export const ARCH_RUNTIME_DEPENDENCIES = [
  "alsa-lib",
  "at-spi2-core",
  "cairo",
  "dbus",
  "expat",
  "fuse2",
  "glib2",
  "glibc",
  "gtk3",
  "hicolor-icon-theme",
  "libcups",
  "libgcc",
  "libx11",
  "libxcb",
  "libxcomposite",
  "libxdamage",
  "libxext",
  "libxfixes",
  "libxkbcommon",
  "libxrandr",
  "mesa",
  "nspr",
  "nss",
  "openssl",
  "pango",
  "systemd-libs",
  "xdg-utils",
] as const;

function writeStdout(message: string) {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string) {
  process.stderr.write(`${message}\n`);
}

function fail(message: string): never {
  writeStderr(`error: ${message}`);
  process.exit(1);
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return result.status === 0;
}

function run(command: string, args: ReadonlyArray<string>, options?: { readonly cwd?: string }) {
  const result = spawnSync(command, [...args], {
    cwd: options?.cwd ?? repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    fail(`failed to run ${command}: ${result.error.message}`);
  }
  if (result.signal) {
    fail(`${command} exited after signal ${result.signal}`);
  }
  if (result.status !== 0) {
    fail(`${command} exited with status ${String(result.status)}`);
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`expected JSON object at ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function readDefaultVersion(): string {
  const packageJson = readJsonObject(serverPackageJsonPath);
  const version = packageJson.version;
  if (typeof version !== "string" || version.length === 0) {
    fail(`missing version in ${serverPackageJsonPath}`);
  }
  return version;
}

function mapHostArch(): DesktopArch {
  if (process.arch === "arm64") return "arm64";
  return "x64";
}

function mapPacmanArch(arch: DesktopArch): PacmanArch {
  return arch === "arm64" ? "aarch64" : "x86_64";
}

function mapLinuxArtifactArch(arch: DesktopArch): string {
  return arch === "x64" ? "x86_64" : arch;
}

function toPacmanPkgver(version: string): string {
  return version.replaceAll("-", "_");
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  let arch: DesktopArch = mapHostArch();
  let install = false;
  let keepStage = false;
  let outputDir = "release/arch";
  let skipDesktopBuild = false;
  let verbose = false;
  let version: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--arch") {
      const value = argv[index + 1];
      if (value !== "x64" && value !== "arm64") {
        fail("--arch must be x64 or arm64");
      }
      arch = value;
      index += 1;
      continue;
    }
    if (arg === "--install") {
      install = true;
      continue;
    }
    if (arg === "--keep-stage") {
      keepStage = true;
      continue;
    }
    if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (!value) fail("--output-dir requires a path");
      outputDir = value;
      index += 1;
      continue;
    }
    if (arg === "--skip-desktop-build") {
      skipDesktopBuild = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--version") {
      const value = argv[index + 1];
      if (!value) fail("--version requires a value");
      version = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      writeStdout(`Build a local Arch Linux pacman package for Cafe Code.

Usage:
  yarn dist:arch:local [options]

Options:
  --arch x64|arm64          Desktop artifact architecture. Defaults to host arch.
  --install                 Run sudo pacman -U after building the package.
  --keep-stage              Keep the temporary package staging directory.
  --output-dir <path>       Package output directory. Defaults to release/arch.
  --skip-desktop-build      Reuse an existing AppImage from release/arch-appimage.
  --verbose                 Pass verbose output through to the desktop artifact build.
  --version <version>       Package version. Defaults to apps/server/package.json.
`);
      process.exit(0);
    }

    fail(`unknown argument: ${arg ?? ""}`);
  }

  return { arch, install, keepStage, outputDir, skipDesktopBuild, verbose, version };
}

function ensureAppImage(options: CliOptions, version: string): string {
  const appImageDir = join(repoRoot, "release/arch-appimage");
  const artifactArch = mapLinuxArtifactArch(options.arch);
  const appImagePath = join(appImageDir, `Cafe-Code-${version}-${artifactArch}.AppImage`);

  if (!options.skipDesktopBuild) {
    const buildArgs = [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "linux",
      "--target",
      "AppImage",
      "--arch",
      options.arch,
      "--build-version",
      version,
      "--output-dir",
      "release/arch-appimage",
    ];
    if (options.verbose) buildArgs.push("--verbose");
    run("node", buildArgs);
  }

  if (!existsSync(appImagePath)) {
    fail(`missing AppImage at ${appImagePath}; rerun without --skip-desktop-build`);
  }

  return appImagePath;
}

function ensureParent(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function writePackageFile(path: string, contents: string, mode: number) {
  ensureParent(path);
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function copyPackageFile(from: string, to: string, mode: number) {
  ensureParent(to);
  copyFileSync(from, to);
  chmodSync(to, mode);
}

function installedSize(path: string): number {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return Buffer.byteLength(readlinkSync(path));
  }
  if (stat.isFile()) {
    return stat.size;
  }
  if (!stat.isDirectory()) {
    return 0;
  }

  let total = 0;
  for (const entry of readdirSync(path)) {
    total += installedSize(join(path, entry));
  }
  return total;
}

function unixNowSeconds(): number {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch) {
    const parsed = Number(sourceDateEpoch);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return Math.floor(performance.timeOrigin / 1000);
}

function createStage(options: CliOptions, version: string, appImagePath: string): string {
  const stageRoot = mkdtempSync(join(tmpdir(), "cafecode-arch-package-"));
  const appImageTarget = join(stageRoot, "opt/cafe-code/cafe-code.AppImage");
  const wrapperTarget = join(stageRoot, "usr/bin/cafe-code");
  const desktopTarget = join(stageRoot, "usr/share/applications/cafecode.desktop");
  const iconTarget = join(stageRoot, "usr/share/icons/hicolor/1024x1024/apps/cafecode.png");
  const licenseTarget = join(stageRoot, "usr/share/licenses/cafe-code/LICENSE");

  copyPackageFile(appImagePath, appImageTarget, 0o755);
  writePackageFile(
    wrapperTarget,
    `#!/bin/sh
exec /opt/cafe-code/cafe-code.AppImage "$@"
`,
    0o755,
  );
  writePackageFile(
    desktopTarget,
    `[Desktop Entry]
Type=Application
Name=Cafe Code
Comment=Minimal desktop GUI for coding agents
Exec=cafe-code %U
Icon=cafecode
Terminal=false
Categories=Development;
StartupWMClass=cafecode
`,
    0o644,
  );
  copyPackageFile(desktopIconPath, iconTarget, 0o644);
  copyPackageFile(licensePath, licenseTarget, 0o644);

  const pkgver = toPacmanPkgver(version);
  const pacmanArch = mapPacmanArch(options.arch);
  const packageSize = installedSize(join(stageRoot, "opt")) + installedSize(join(stageRoot, "usr"));
  const pkgInfo = [
    "pkgname = cafe-code",
    "pkgbase = cafe-code",
    "xdata = pkgtype=pkg",
    `pkgver = ${pkgver}-1`,
    "pkgdesc = Desktop GUI for coding agents such as Codex, Claude, and OpenCode",
    "url = https://github.com/cafeai/cafe-code",
    `builddate = ${String(unixNowSeconds())}`,
    "packager = Cafe Code local package builder",
    `size = ${String(packageSize)}`,
    `arch = ${pacmanArch}`,
    "license = AGPL-3.0-or-later",
    ...ARCH_RUNTIME_DEPENDENCIES.map((dependency) => `depend = ${dependency}`),
    "",
  ].join("\n");
  writePackageFile(join(stageRoot, ".PKGINFO"), pkgInfo, 0o644);

  if (options.keepStage) {
    const linkPath = join(resolve(repoRoot, options.outputDir), "stage-latest");
    rmSync(linkPath, { recursive: true, force: true });
    ensureParent(linkPath);
    symlinkSync(stageRoot, linkPath);
    writeStdout(`[arch-package] Kept stage at ${stageRoot}`);
  }

  return stageRoot;
}

function createPacmanPackage(stageRoot: string, options: CliOptions, version: string): string {
  const outputDir = resolve(repoRoot, options.outputDir);
  const pkgver = toPacmanPkgver(version);
  const pacmanArch = mapPacmanArch(options.arch);
  const packagePath = join(outputDir, `cafe-code-${pkgver}-1-${pacmanArch}.pkg.tar.zst`);

  mkdirSync(outputDir, { recursive: true });
  rmSync(packagePath, { force: true });
  run("bsdtar", [
    "--zstd",
    "--uid",
    "0",
    "--gid",
    "0",
    "--uname",
    "root",
    "--gname",
    "root",
    "-C",
    stageRoot,
    "-cf",
    packagePath,
    ".PKGINFO",
    "opt",
    "usr",
  ]);

  return packagePath;
}

function installPackage(packagePath: string) {
  const pacmanArgs = ["pacman", "-U", "--needed", packagePath];
  if (process.getuid?.() === 0) {
    run("pacman", ["-U", "--needed", packagePath]);
    return;
  }
  run("sudo", pacmanArgs);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!commandExists("bsdtar")) {
    fail("bsdtar is required to create pacman packages");
  }

  const version = options.version ?? readDefaultVersion();
  const appImagePath = ensureAppImage(options, version);
  const stageRoot = createStage(options, version, appImagePath);

  try {
    const packagePath = createPacmanPackage(stageRoot, options, version);
    writeStdout(`[arch-package] Wrote ${packagePath}`);
    writeStdout(`[arch-package] Install with: sudo pacman -U ${packagePath}`);

    if (options.install) {
      installPackage(packagePath);
    }
  } finally {
    if (!options.keepStage) {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  main();
}
