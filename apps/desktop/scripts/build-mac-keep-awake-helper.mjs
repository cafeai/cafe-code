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
const sourcePath = join(desktopDirectory, "native", "mac-keep-awake.swift");
const helperName = "mac-keep-awake";
const minimumMacOSVersion = "13.0";
const supportedArchitectures = new Set(["arm64", "x64", "universal"]);

export function sourceMacKeepAwakeHelperPath(architecture = process.arch) {
  return join(desktopDirectory, "native", "build", architecture, helperName);
}

function runNativeCompiler(command, args) {
  // Use the Apple toolchain directly. In particular, do not interpolate the
  // destination into a shell command or run any user-selected executable.
  const result = spawnSync("xcrun", [command, ...args], {
    cwd: desktopDirectory,
    stdio: "inherit",
    shell: false,
    timeout: 5 * 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`The macOS keep-awake helper ${command} build failed.`);
  }
}

function compileArchitecture(architecture, outputPath) {
  const target = architecture === "x64" ? "x86_64" : "arm64";
  runNativeCompiler("swiftc", [
    "-O",
    "-target",
    `${target}-apple-macosx${minimumMacOSVersion}`,
    sourcePath,
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
      (output.mode & 0o111) !== 0 &&
      output.mtimeMs >= Math.max(statSync(sourcePath).mtimeMs, statSync(scriptPath).mtimeMs)
    );
  } catch {
    return false;
  }
}

/**
 * Build a fixed, repo-owned Swift source into a fixed source-build location or
 * a release staging location. The output is renamed atomically after a fully
 * successful compile, so a killed build never leaves a partially written
 * executable that the desktop main process might trust.
 */
export function ensureMacKeepAwakeHelper({
  architecture = process.arch,
  outputPath = sourceMacKeepAwakeHelperPath(architecture),
  platform = process.platform,
  force = false,
} = {}) {
  if (platform !== "darwin") {
    return null;
  }
  if (!supportedArchitectures.has(architecture) || !isAbsolute(outputPath)) {
    throw new Error("Unsupported macOS keep-awake helper build target.");
  }
  if (!force && isFreshExecutable(outputPath, architecture)) {
    return outputPath;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  // The temporary directory belongs to this build only. Never remove a
  // caller-supplied path or a broad workspace directory during cleanup.
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "cafecode-mac-keep-awake-helper-"));
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
    // A build runner may put the staging directory on another volume, where
    // rename(2) cannot cross the device boundary. Copy into a sibling first.
    const siblingDirectory = mkdtempSync(join(dirname(outputPath), ".mac-keep-awake-"));
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
      ? sourceMacKeepAwakeHelperPath(architecture)
      : resolve(values.output);
  ensureMacKeepAwakeHelper({ architecture, outputPath, force: values.force ?? false });
}
