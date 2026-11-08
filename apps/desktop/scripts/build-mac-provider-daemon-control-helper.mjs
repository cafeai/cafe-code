#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopDirectory = resolve(dirname(scriptPath), "..");
const sourcePath = join(desktopDirectory, "native", "mac-provider-daemon-control.c");
const helperName = "mac-provider-daemon-control";
const minimumMacOSVersion = "12.0";
const supportedArchitectures = new Set(["arm64", "x64", "universal"]);

export function sourceMacProviderDaemonControlHelperPath(architecture = process.arch) {
  return join(desktopDirectory, "native", "build", architecture, helperName);
}

function runNativeCompiler(command, args) {
  // Compile only the checked-in C source with the Apple toolchain. No shell,
  // provider binary, downloaded executable or user-selected compiler is used.
  const result = spawnSync("xcrun", [command, ...args], {
    cwd: desktopDirectory,
    stdio: "inherit",
    shell: false,
    timeout: 5 * 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`The macOS provider daemon control helper ${command} build failed.`);
  }
}

function compileArchitecture(architecture, outputPath) {
  const target = architecture === "x64" ? "x86_64" : "arm64";
  runNativeCompiler("clang", [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-target",
    `${target}-apple-macosx${minimumMacOSVersion}`,
    sourcePath,
    "-lproc",
    "-lbsm",
    "-o",
    outputPath,
  ]);
}

function isFreshExecutable(outputPath, architecture) {
  if (architecture === "universal") return false;
  try {
    const output = lstatSync(outputPath);
    return (
      output.isFile() &&
      !output.isSymbolicLink() &&
      output.nlink === 1 &&
      output.uid === process.getuid() &&
      (output.mode & 0o7022) === 0 &&
      (output.mode & 0o111) !== 0 &&
      output.mtimeMs >= Math.max(statSync(sourcePath).mtimeMs, statSync(scriptPath).mtimeMs)
    );
  } catch {
    return false;
  }
}

/** Build the fixed native controller into its source location or a private
 * release stage. Atomic sibling publication prevents a failed compile from
 * replacing a complete helper with partial executable bytes. All cleanup is
 * restricted to fresh directories minted by this invocation. */
export function ensureMacProviderDaemonControlHelper({
  architecture = process.arch,
  outputPath = sourceMacProviderDaemonControlHelperPath(architecture),
  platform = process.platform,
  force = false,
} = {}) {
  if (platform !== "darwin") return null;
  if (!supportedArchitectures.has(architecture) || !isAbsolute(outputPath)) {
    throw new Error("Unsupported macOS provider daemon control helper build target.");
  }
  if (!force && isFreshExecutable(outputPath, architecture)) return outputPath;

  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "cafecode-mac-provider-daemon-control-"));
  try {
    const executable = join(temporaryDirectory, helperName);
    if (architecture === "universal") {
      const arm64 = join(temporaryDirectory, "arm64");
      const x64 = join(temporaryDirectory, "x64");
      compileArchitecture("arm64", arm64);
      compileArchitecture("x64", x64);
      runNativeCompiler("lipo", ["-create", "-output", executable, arm64, x64]);
    } else {
      compileArchitecture(architecture, executable);
    }
    chmodSync(executable, 0o755);
    // Staging may be on a different volume; publish through an owned sibling
    // so rename itself never crosses devices and never exposes partial bytes.
    const siblingDirectory = mkdtempSync(
      join(dirname(outputPath), ".mac-provider-daemon-control-"),
    );
    try {
      const siblingExecutable = join(siblingDirectory, helperName);
      copyFileSync(executable, siblingExecutable);
      chmodSync(siblingExecutable, 0o755);
      renameSync(siblingExecutable, outputPath);
    } finally {
      rmSync(siblingDirectory, { recursive: true, force: true });
    }
    return outputPath;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const { values } = parseArgs({
    options: {
      arch: { type: "string" },
      output: { type: "string" },
      force: { type: "boolean" },
    },
  });
  const architecture = values.arch ?? process.arch;
  const outputPath =
    values.output === undefined
      ? sourceMacProviderDaemonControlHelperPath(architecture)
      : resolve(values.output);
  ensureMacProviderDaemonControlHelper({ architecture, outputPath, force: values.force ?? false });
}
